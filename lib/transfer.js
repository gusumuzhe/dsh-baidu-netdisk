/**
 * 转存编排：解析分享 → 按集号筛选 → 去重 → 调 /share/transfer。
 *
 * 从 index.js 抽出来，为了让「工具」和「命令行脚本」共用同一套逻辑与安全校验。
 * 本模块不依赖 DSH 运行时，可被 scripts/ 下任意脚本直接 import。
 */
import { BaiduError } from './baidu.js'
import { episodeOf, parseEpisodes } from './episodes.js'

/**
 * 把「暂存根 + 子目录名」拼成一个保证落在根目录之下的绝对路径。
 *
 * 只做 startsWith 前缀判断是不够的：`/绿联下载/../影视/动漫/x` 也以
 * `/绿联下载/` 开头，但实际指向媒体库。这里先规范化再逐段校验。
 *
 * @param {string} root 暂存根，如 "/绿联下载"
 * @param {string} sub  子目录名（可能来自模型参数或分享里的文件夹名）
 * @returns {string} 规范化后的目标目录
 */
export function resolveInboxPath(root, sub) {
  const base = String(root || '').trim().replace(/\/+$/, '')
  if (!base || base === '/') throw new BaiduError('inboxRoot 不能为空或根目录', { code: 'bad_arg' })

  const raw = String(sub || '').trim()
  if (!raw) throw new BaiduError('目标子目录不能为空', { code: 'bad_arg' })
  // 绝对路径会直接顶掉 base，必须先拒
  if (raw.startsWith('/')) throw new BaiduError('目标子目录不能是绝对路径，已拒绝', { code: 'bad_arg' })

  // 逐段规范化：丢弃空段与 "."，遇到 ".." 直接拒绝（不做"回退一级"的宽容处理）
  const parts = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new BaiduError('目标子目录不能包含 ".."，已拒绝', { code: 'bad_arg' })
    parts.push(part)
  }
  if (!parts.length) throw new BaiduError('目标子目录不能为空', { code: 'bad_arg' })

  const target = `${base}/${parts.join('/')}`
  // 兜底：规范化后仍必须严格位于 base 之下
  if (!target.startsWith(`${base}/`)) throw new BaiduError('目标目录越界，已拒绝', { code: 'bad_arg' })
  return target
}

/**
 * @param {object} baidu   BaiduClient 实例
 * @param {object} opts
 * @param {string} opts.shareUrl
 * @param {string} [opts.pwd]
 * @param {string} opts.episodes      集号表达式，如 "150,152-167"
 * @param {string} opts.inboxRoot     暂存根目录，如 "/绿联下载"
 * @param {string} [opts.subdir]      目标子目录名（落在 inboxRoot 下）
 * @param {string} [opts.shareSubdir] 源分享内的子目录（整季打包的源必填）
 */
export async function transferEpisodes(baidu, opts) {
  const root = String(opts.inboxRoot || '').replace(/\/+$/, '')
  if (!root) throw new BaiduError('inboxRoot 未配置', { code: 'bad_arg' })

  const wanted = parseEpisodes(opts.episodes)
  if (!wanted.length) throw new BaiduError('episodes 不能为空，例如 150,152-167', { code: 'bad_arg' })

  const info = await baidu.shareInfo(String(opts.shareUrl), String(opts.pwd || ''), String(opts.shareSubdir || ''))
  const byEpisode = new Map()
  for (const f of info.files) {
    if (f.isDir) continue
    const ep = episodeOf(f.name)
    if (ep != null && !byEpisode.has(ep)) byEpisode.set(ep, f)
  }

  const picked = wanted.filter((e) => byEpisode.has(e))
  const notFound = wanted.filter((e) => !byEpisode.has(e)).sort((a, b) => a - b)
  if (!picked.length) return { ok: false, error: '源里没有任何一个请求的集号', notFound }

  const sub = String(opts.subdir || '').trim() || (info.dir ? info.dir.split('/').pop() : 'inbox')
  const targetDir = resolveInboxPath(root, sub)

  const bdstoken = await baidu.getBdstoken()
  await baidu.ensureDir(targetDir, bdstoken)

  // 目标目录已存在的集直接跳过，避免重复转存
  let existing = new Set()
  try {
    existing = new Set((await baidu.listAll(targetDir, bdstoken)).map((f) => episodeOf(f.name)).filter((x) => x != null))
  } catch { /* 目录刚建，忽略 */ }

  const todo = picked.filter((e) => !existing.has(e))
  if (!todo.length) {
    return { ok: true, targetDir, transferred: 0, skipped: picked.length, notFound, episodes: [], message: '目标目录里已有这些集，本次没有转存任何文件' }
  }

  const res = await baidu.transfer({
    shareid: info.shareid,
    uk: info.uk,
    fsIds: todo.map((e) => byEpisode.get(e).fsId),
    toPath: targetDir,
    sekey: info.sekey || '',
    bdstoken,
  })

  return {
    ok: (res?.errno ?? 0) === 0,
    targetDir,
    transferred: todo.length,
    episodes: todo,
    skipped: picked.length - todo.length,
    notFound,
    errno: res?.errno ?? 0,
  }
}
