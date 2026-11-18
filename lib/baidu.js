/**
 * 百度网盘（cookie 版）最小客户端。
 *
 * 设计约束（这是本插件的安全核心）：
 *   - 只用 BDUSS + STOKEN 走网页端接口，不依赖开放平台应用/资质。
 *   - 对外只暴露白名单方法；危险能力（删除、移动、创建分享）连方法都不存在。
 *   - 所有网络请求都有超时；所有错误都归一成可读文本，绝不把 cookie 带进错误信息。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const APP_ID = '250528'

export class BaiduError extends Error {
  constructor(message, { errno, code } = {}) {
    super(message)
    this.name = 'BaiduError'
    this.errno = errno
    this.code = code
  }
}

/** 把百度常见 errno 翻译成人话，便于模型/用户判断下一步。 */
const ERRNO_HINT = {
  '-6': '未授权或登录态失效（BDUSS 可能过期）',
  '-7': '文件或目录不存在',
  '2': '参数错误',
  '110': '权限不足',
  '112': '目录不存在',
  '31066': '文件不存在',
  '-62': '需要验证码，网页端被风控拦截',
}

export class BaiduClient {
  constructor({ bduss = '', stoken = '', timeoutMs = 15000 } = {}) {
    this.bduss = String(bduss || '').trim()
    this.stoken = String(stoken || '').trim()
    this.timeoutMs = Math.max(Number(timeoutMs) || 15000, 1000)
  }

  get configured() {
    return Boolean(this.bduss)
  }

  cookie(extra = '') {
    const parts = [`BDUSS=${this.bduss}`]
    if (this.stoken) parts.push(`STOKEN=${this.stoken}`)
    if (extra) parts.push(extra)
    return parts.join('; ')
  }

  async request(url, { method = 'GET', body, extraCookie = '', referer = 'https://pan.baidu.com/disk/home' } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          'User-Agent': UA,
          Referer: referer,
          Accept: 'application/json, text/plain, */*',
          Cookie: this.cookie(extraCookie),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
      })
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new BaiduError('百度返回了非 JSON 响应（可能被风控或需要登录）', { code: 'non_json' })
      }
      if (typeof json.errno === 'number' && json.errno !== 0) {
        const hint = ERRNO_HINT[String(json.errno)] || json.show_msg || json.errmsg || '未知错误'
        throw new BaiduError(`百度接口错误 errno=${json.errno}：${hint}`, { errno: json.errno })
      }
      return json
    } catch (error) {
      if (error instanceof BaiduError) throw error
      if (error.name === 'AbortError') throw new BaiduError(`请求超时（${this.timeoutMs}ms）`, { code: 'timeout' })
      // 绝不把 cookie 拼进错误信息
      throw new BaiduError(`网络请求失败：${error.message}`, { code: 'network' })
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------- 白名单方法（只读） ----------

  async quota() {
    const j = await this.request(`https://pan.baidu.com/api/quota?checkfree=1&checkexpire=1&web=1&t=${Date.now()}`)
    const total = Number(j.total) || 0
    const used = Number(j.used) || 0
    // 该接口有时不回 free 字段，自己算，避免把 total 当成 free 报出去
    const free = Number.isFinite(j.free) ? Number(j.free) : Math.max(total - used, 0)
    return { total, used, free }
  }

  async whoami() {
    const j = await this.request(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&web=1`)
    return { name: j.baidu_name || j.netdisk_name || '', uk: j.uk, vip: j.vip_type }
  }

  async list(dir = '/') {
    const d = String(dir || '/')
    const j = await this.request(
      `https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1&page=1&num=1000`
      + `&dir=${encodeURIComponent(d)}&t=${Date.now()}`,
    )
    return (j.list || []).map((f) => ({
      name: f.server_filename,
      path: f.path,
      isDir: Boolean(f.isdir),
      size: f.size,
      fsId: f.fs_id,
      mtime: f.server_mtime,
    }))
  }

  async search(keyword, dir = '/') {
    const k = String(keyword || '').trim()
    if (!k) throw new BaiduError('搜索关键词不能为空', { code: 'bad_arg' })
    const j = await this.request(
      `https://pan.baidu.com/api/search?clienttype=0&app_id=${APP_ID}&web=1`
      + `&keyword=${encodeURIComponent(k)}&dir=${encodeURIComponent(dir)}&t=${Date.now()}`,
    )
    return (j.list || []).map((f) => ({
      name: f.server_filename,
      path: f.path,
      isDir: Boolean(f.isdir),
      size: f.size,
      fsId: f.fs_id,
    }))
  }

  /**
   * 解析一条分享链接，返回其中的文件列表（只读，不转存）。
   *
   * 百度分享浏览的完整链路（逆向自网页端真实请求）：
   *   1. /api/gettemplatevariable 拿真实 bdstoken（不能传 "null"）
   *   2. 分享页解析 shareid / uk / 根层条目
   *   3. /share/verify 换 randsk（注意：返回值是 URL 编码的，必须先解码）
   *   4. 目录路径 = /sharelink<uk>-<根条目fsid>/<文件夹名>
   *   5. /share/list 带 sekey + BDCLND cookie + 真实 bdstoken，才能列子目录
   */
  async shareInfo(shareUrl, pwd = '', subdir = '') {
    const surl = extractSurl(shareUrl)
    if (!surl) throw new BaiduError('无法从链接中解析出短链（形如 https://pan.baidu.com/s/1xxxx）', { code: 'bad_arg' })
    // 页面路径是 /s/1xxxx，但 verify 的 surl 参数不带那个开头的 1
    const apiSurl = surl.startsWith('1') ? surl.slice(1) : surl
    const code = String(pwd || '').trim() || (new URL(shareUrl, 'https://pan.baidu.com').searchParams.get('pwd') || '')

    const bdstoken = await this.getBdstoken()

    // 顺序很重要：必须先 verify 拿到 sekey，再用 BDCLND 取页面，页面里才会有根层条目
    let sekey = ''
    if (code) {
      const qs = new URLSearchParams({
        surl: apiSurl, t: String(Date.now()), bdstoken,
        channel: 'chunlei', web: '1', clienttype: '0',
      })
      const v = await this.request(`https://pan.baidu.com/share/verify?${qs}`, {
        method: 'POST',
        body: `pwd=${encodeURIComponent(code)}&vcode=&vcode_str=`,
        referer: `https://pan.baidu.com/share/init?surl=${apiSurl}&pwd=${encodeURIComponent(code)}`,
      })
      // randsk 是 URL 编码的；双重编码会导致后续请求 -9
      sekey = v.randsk ? decodeURIComponent(v.randsk) : ''
    }

    const page = await this.rawHtml(`https://pan.baidu.com/s/${surl}`, sekey ? `BDCLND=${sekey}` : '')
    const shareid = page.match(/"shareid"\s*:\s*(\d+)/)?.[1]
    const uk = page.match(/"share_uk"\s*:\s*"?(\d+)"?/)?.[1] || page.match(/"uk"\s*:\s*"?(\d+)"?/)?.[1]
    if (!shareid || !uk) throw new BaiduError('分享页解析失败：链接可能已失效，或页面结构变了', { code: 'share_parse' })

    const rootInfo = parseShareRoot(page)
    const sub = String(subdir || '').trim()

    if (rootInfo?.dir || sub) {
      const dir = sub ? `${rootInfo.dir}/${sub}` : rootInfo.dir
      const files = await this.listSharedDir({ shareid, uk, dir, sekey, bdstoken, surl })
      const dirs = files.filter((f) => f.isDir).map((f) => f.name)
      return {
        shareid, uk, dir, sekey, sekeyUsed: Boolean(sekey), files,
        subdirs: dirs.length ? dirs : undefined,
      }
    }

    // 兜底：页面里没有 sharelink 路径时，退回根层条目
    const root = parseRootItems(page)
    return { shareid, uk, sekey, sekeyUsed: Boolean(sekey), files: root }
  }

  /** 真实 bdstoken：create/share/transfer/list 都要求它，传 "null" 会失败。 */
  async getBdstoken() {
    const fields = encodeURIComponent('["bdstoken","token","uk","isdocuser","servertime"]')
    const j = await this.request(
      `https://pan.baidu.com/api/gettemplatevariable?fields=${fields}&clienttype=0&app_id=${APP_ID}&web=1`,
      { referer: 'https://pan.baidu.com/disk/home' },
    )
    const token = j?.result?.bdstoken || ''
    if (!token) throw new BaiduError('获取 bdstoken 失败（BDUSS 可能已失效）', { code: 'no_bdstoken' })
    return token
  }

  /** 列出分享内某个目录的全部文件（分页拉取）。 */
  async listSharedDir({ shareid, uk, dir, sekey, bdstoken, surl, pageSize = 100, maxPages = 20 }) {
    const out = []
    for (let page = 1; page <= maxPages; page++) {
      const qs = new URLSearchParams({
        uk: String(uk), shareid: String(shareid), sekey,
        is_from_web: 'true', dir,
        page: String(page), num: String(pageSize),
        order: 'name', desc: '0', showempty: '0', view_mode: '1',
        web: '1', channel: 'chunlei', app_id: APP_ID, bdstoken, clienttype: '0',
      })
      const j = await this.request(`https://pan.baidu.com/share/list?${qs}`, {
        extraCookie: sekey ? `BDCLND=${sekey}` : '',
        referer: `https://pan.baidu.com/s/${surl}`,
      })
      const list = j.list || []
      for (const f of list) {
        out.push({
          name: f.server_filename,
          isDir: String(f.isdir) === '1',
          size: Number(f.size) || 0,
          fsId: f.fs_id,
          mtime: Number(f.server_mtime) || 0,
        })
      }
      if (list.length < pageSize) break
    }
    return out
  }

  /**
   * 转存指定 fs_id 到网盘目标目录（写操作）。
   * 只传需要的那几个 fs_id，所以不会把已存在的集重复转进来。
   */
  async transfer({ shareid, uk, fsIds, toPath, sekey, bdstoken }) {
    if (!Array.isArray(fsIds) || fsIds.length === 0) {
      throw new BaiduError('fsIds 不能为空', { code: 'bad_arg' })
    }
    const qs = new URLSearchParams({
      shareid: String(shareid), from: String(uk), bdstoken,
      channel: 'chunlei', web: '1', clienttype: '0', app_id: APP_ID,
    })
    const body = new URLSearchParams({
      fsidlist: `[${fsIds.map(String).join(',')}]`,
      path: toPath,
    }).toString()
    const j = await this.request(`https://pan.baidu.com/share/transfer?${qs}`, {
      method: 'POST',
      body,
      extraCookie: sekey ? `BDCLND=${sekey}` : '',
      referer: 'https://pan.baidu.com/disk/home',
    })
    return j
  }

  /** 确保网盘目录存在（逐级创建）。返回 true 表示已就绪。 */
  async ensureDir(path, bdstoken) {
    const target = String(path || '').replace(/\/+$/, '')
    if (!target || target === '/') return true
    const parts = target.split('/').filter(Boolean)
    let cur = ''
    for (const part of parts) {
      const parent = cur || '/'
      const next = `${cur}/${part}`
      const ls = await this.request(
        `https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1&page=1&num=1000`
        + `&dir=${encodeURIComponent(parent)}&bdstoken=${bdstoken}&t=${Date.now()}`,
      )
      const found = (ls.list || []).some((f) => f.server_filename === part && String(f.isdir) === '1')
      if (!found) {
        const qs = new URLSearchParams({ a: 'commit', bdstoken })
        await this.request(`https://pan.baidu.com/api/create?${qs}`, {
          method: 'POST',
          body: new URLSearchParams({ path: next, isdir: '1', block_list: '[]' }).toString(),
        })
      }
      cur = next
    }
    return true
  }

  /** 列出自己网盘目录（分页），返回扁平的 name/isDir/size 列表。 */
  async listAll(dir, bdstoken) {
    const qs = new URLSearchParams({
      order: 'name', desc: '0', showempty: '0', web: '1',
      page: '1', num: '1000', dir: String(dir), bdstoken: bdstoken || '', t: String(Date.now()),
    })
    const j = await this.request(`https://pan.baidu.com/api/list?${qs}`)
    return (j.list || []).map((f) => ({
      name: f.server_filename,
      isDir: String(f.isdir) === '1',
      size: Number(f.size) || 0,
      fsId: f.fs_id,
    }))
  }

  async rawHtml(url, extraCookie = '') {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Cookie: this.cookie(extraCookie), Referer: 'https://pan.baidu.com/' },
      })
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }
}

export function extractSurl(url) {
  const s = String(url || '').trim()
  const m = s.match(/pan\.baidu\.com\/s\/([A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]{6,})$/)
  return m ? m[1] : ''
}

/**
 * 从分享页解析「分享根」信息。
 * 页面里有两个可靠锚点：
 *   - "path":"/sharelink<uk>-<fsid>/<根目录名>"   ← 直接就是可用的 dir
 *   - "server_filename"（只有一个）+ 附近的 fs_id
 */
export function parseShareRoot(html) {
  const text = String(html || '')
  const path = text.match(/"path"\s*:\s*"(\/sharelink[^"]+)"/)?.[1]
  const fsId = text.match(/"fs_id"\s*:\s*"?(\d{8,})"?/)?.[1]
  const name = text.match(/"server_filename"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
  if (path) {
    // 统一成 sharelink0 前缀（实测通用），避免 uk 段差异
    const normalized = path.replace(/^\/sharelink[^-]*-/, '/sharelink0-')
    return { dir: normalized, fsId, name: name ? unescapeJson(name) : '' }
  }
  if (fsId && name) return { dir: `/sharelink0-${fsId}/${unescapeJson(name)}`, fsId, name: unescapeJson(name) }
  return null
}

/**
 * 从分享页解析根层条目。
 * 页面里的结构是内联 JSON，字段顺序不保证，所以分三次抽取再按序拼装（与 hxz393 的做法一致）。
 */
export function parseRootItems(html) {
  const text = String(html || '')
  const ids = [...text.matchAll(/"fs_id"\s*:\s*"?(\d+)"?/g)].map((m) => m[1])
  const names = [...text.matchAll(/"server_filename"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeJson(m[1]))
  const dirs = [...text.matchAll(/"isdir"\s*:\s*"?(\d)"?/g)].map((m) => m[1] === '1')
  const n = Math.min(ids.length, names.length, dirs.length)
  const items = []
  for (let i = 0; i < n; i++) items.push({ fsId: ids[i], name: names[i], isDir: dirs[i] })
  return items
}

function unescapeJson(s) {
  try { return JSON.parse(`"${s}"`) } catch { return s }
}
