/**
 * PanSou 客户端（自建服务，bearer token 认证）。
 *
 * 认证契约（从前端代码逆向确认）：
 *   POST /api/auth/login   { username, password }  → { data: { token } }
 *   GET  /api/search?kw=x  Header: Authorization: Bearer <token>
 *
 * 这里只做两件事：登录换 token（401 时自动重登一次）、搜索并归一化结果。
 * 不做任何写操作。
 */

export class PansouError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = 'PansouError'
    this.status = status
    this.code = code
  }
}

const trimBase = (v) => String(v || '').trim().replace(/\/+$/, '')

export class PansouClient {
  constructor({ baseUrl = '', username = '', password = '', timeoutMs = 15000 } = {}) {
    this.baseUrl = trimBase(baseUrl)
    this.username = String(username || '')
    this.password = String(password || '')
    this.timeoutMs = Math.max(Number(timeoutMs) || 15000, 1000)
    this.token = ''
  }

  get configured() {
    return Boolean(this.baseUrl)
  }

  get canLogin() {
    return Boolean(this.baseUrl && this.username && this.password)
  }

  async request(path, { method = 'GET', body, token } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let json
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        throw new PansouError(`PanSou 返回非 JSON 响应（HTTP ${res.status}）`, { status: res.status })
      }
      if (res.status === 401) throw new PansouError('PanSou 认证失败（用户名/密码错误或 token 过期）', { status: 401, code: 'unauthorized' })
      if (!res.ok) throw new PansouError(`PanSou 接口错误 HTTP ${res.status}：${json.error || json.message || ''}`, { status: res.status })
      return json
    } catch (error) {
      if (error instanceof PansouError) throw error
      if (error.name === 'AbortError') throw new PansouError(`PanSou 请求超时（${this.timeoutMs}ms）`, { code: 'timeout' })
      throw new PansouError(`无法连接 PanSou：${error.message}（检查地址是否正确、服务是否在运行）`, { code: 'network' })
    } finally {
      clearTimeout(timer)
    }
  }

  async login() {
    if (!this.canLogin) throw new PansouError('尚未配置 PanSou 地址/用户名/密码', { code: 'not_configured' })
    const json = await this.request('/api/auth/login', {
      method: 'POST',
      body: { username: this.username, password: this.password },
    })
    const token = json?.data?.token || json?.token || ''
    if (!token) throw new PansouError('PanSou 登录未返回 token', { code: 'no_token' })
    this.token = token
    return token
  }

  /** 验证连通性 + 凭据是否有效，不发起搜索。 */
  async verify() {
    await this.login()
    return { ok: true, baseUrl: this.baseUrl }
  }

  async search(keyword, { limit = 30 } = {}) {
    const kw = String(keyword || '').trim()
    if (!kw) throw new PansouError('搜索关键词不能为空', { code: 'bad_arg' })
    if (!this.token) await this.login()

    const qs = new URLSearchParams({ kw, res: 'merge' })
    let json
    try {
      json = await this.request(`/api/search?${qs.toString()}`, { token: this.token })
    } catch (error) {
      if (error.code !== 'unauthorized') throw error
      await this.login()
      json = await this.request(`/api/search?${qs.toString()}`, { token: this.token })
    }

    return normalize(json?.data ?? json, limit)
  }
}

/**
 * PanSou 的响应结构在不同版本间有差异：
 *   - 老：{ total, results: [ { title, links: [{type,url,password}] } ] }
 *   - 新：{ total, merged_by_type: { baidu: [ { url, password, note, ... } ], aliyun: [...] } }
 * 这里统一成扁平列表，并且只保留百度网盘链接。
 */
export function normalize(payload, limit = 30) {
  const out = []
  const push = (item, channelHint) => {
    const url = item?.url || item?.link || ''
    if (!url) return
    if (!isBaiduLink(url) && !/baidu/i.test(String(channelHint || ''))) return
    out.push({
      title: clean(item?.note || item?.title || item?.name || ''),
      channel: channelHint || item?.channel || item?.source || '',
      panType: 'baidu',
      url,
      pwd: item?.password || item?.pwd || '',
      datetime: item?.datetime || item?.time || '',
    })
  }

  const merged = payload?.merged_by_type
  if (merged && typeof merged === 'object') {
    for (const [type, arr] of Object.entries(merged)) {
      if (!Array.isArray(arr)) continue
      for (const item of arr) push(item, type)
    }
  }

  const results = payload?.results
  if (Array.isArray(results)) {
    for (const row of results) {
      const links = Array.isArray(row?.links) ? row.links : []
      for (const link of links) {
        if (String(link?.type || '').toLowerCase() !== 'baidu') continue
        push({ url: link.url, password: link.password, note: row.title || link.note }, row.channel || link.type)
      }
    }
  }

  // 去重（同链接只留一条），并按标题长度粗略排序（信息多的靠前）
  const seen = new Set()
  const deduped = []
  for (const item of out) {
    const key = item.url
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }
  deduped.sort((a, b) => b.title.length - a.title.length)
  return deduped.slice(0, limit)
}

function isBaiduLink(url) {
  return /pan\.baidu\.com\/s\//.test(String(url))
}

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim()
}
