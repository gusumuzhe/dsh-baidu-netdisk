/**
 * 把下载目录里「已下载完成」的剧集复制进媒体库，并按规范改名。
 *   <剧名> S<SS>E<EEE>[ [画质]].<ext>
 * 跳过 .baiduyun.p.downloading 临时文件；跳过媒体库里已存在的集。
 *
 * 用法：node copy_in.mjs --src <下载目录> --dst <媒体目录> --show 仙逆 --year 2023 [--season 1]
 */
import { readFileSync } from 'node:fs'
import { episodeOf, qualityOf } from '../../../lib/episodes.js'
import { readNasConfig } from '../../../lib/profile.js'
import https from 'node:https'
// 路径可被环境变量覆盖，便于在别的机器上复用
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)

const catalog = JSON.parse(readFileSync(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/catalog.json`, 'utf8'))
const { endpoint, accessToken } = readNasConfig()
if (!endpoint || !accessToken) {
  console.error('未读到 NAS 配置（dsh-ugreen-nas 的 endpoint / accessToken）')
  process.exit(1)
}
const url = new URL(endpoint)
const token = accessToken

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const SRC = arg('--src'); const DST = arg('--dst'); const SHOW = arg('--show')
const YEAR = arg('--year'); const SEASON = Number(arg('--season', '1'))

if (!SRC || !DST || !SHOW) {
  console.error('用法: node copy_in.mjs --src <下载目录> --dst <媒体目录> --show <剧名> --year <年份> [--season 1]')
  process.exit(1)
}
if (!Number.isFinite(SEASON) || SEASON < 1) {
  console.error(`--season 必须是正整数，收到：${arg('--season')}`)
  process.exit(1)
}

const post = (method, reqType, resType, payload) => new Promise((res) => {
  const body = encodeMessage(catalog, reqType, payload)
  const rq = https.request({
    hostname: url.hostname, port: url.port || 443, method: 'POST', rejectUnauthorized: false,
    path: `${url.pathname.replace(/\/$/, '')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/${method}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-protobuf', Accept: 'application/x-protobuf', 'X-OpenCLI-Body-Format': 'protobuf', 'Content-Length': body.length },
  }, (r) => {
    const cs = []
    r.on('data', (c) => cs.push(c))
    r.on('end', () => {
      const b = Buffer.concat(cs)
      if (r.headers['x-grpc-code'] !== '0') return res({ err: b.toString('utf8').slice(0, 160) })
      try { res(decodeMessage(catalog, resType, b)) } catch { res({ ok: true }) }
    })
  })
  rq.on('error', (e) => res({ err: String(e) }))
  rq.write(body); rq.end()
})

const ls = (path) => post('CategoryOrFileDirList', 'ugidl.filesystem.cli.FileDirListRequest', 'ugidl.filesystem.cli.FileDirListResponse', { path, page: 1, limit: 1000 })
  .then((d) => d?.data?.file_list?.files || [])
const rename = (dir, oldName, newName) => post('Rename', 'ugidl.filesystem.cli.RenameRequest', 'ugidl.filesystem.cli.FileStatus', { dir, old_name: oldName, new_name: newName, is_dry_run: false })
const copy = (src, dst) => post('CpMovePath', 'ugidl.filesystem.cli.CpMovePathRequest', 'ugidl.filesystem.cli.CpMovePathResponse', { src, dst, type: true, cover: false, is_dry_run: false })

const pad = (n, w) => String(n).padStart(w, '0')

/** qualityOf 返回布尔信号对象，这里折算成文件名里的画质标签 */
const qualityLabel = (name) => {
  const q = qualityOf(name)
  if (q.uhd) return '2160p'
  if (q.fhd) return '1080p'
  if (q.hd) return '720p'
  return ''
}

const media = await ls(DST)
const have = new Set(media.map((f) => episodeOf(f.name)).filter((x) => x != null))
const src = await ls(SRC)
const ready = src.filter((f) => f.ext && !/\.downloading$/i.test(f.name) && /\.(mp4|mkv|avi|ts|m4v)$/i.test(f.name))

console.log(`${SHOW} (${YEAR}) S${pad(SEASON, 2)} → ${DST}`)
console.log(`媒体库已有 ${have.size} 集 | 下载目录可用 ${ready.length} 个`)
let ok = 0; let skip = 0; let fail = 0
for (const f of ready) {
  const ep = episodeOf(f.name)
  if (ep == null) { console.log(`  ⚠️ 无集号，跳过: ${f.name}`); skip++; continue }
  if (have.has(ep)) { console.log(`  ↷ E${ep} 已存在，跳过`); skip++; continue }
  const ext = f.name.match(/\.(mp4|mkv|avi|ts|m4v)$/i)[0].toLowerCase()
  const q = qualityLabel(f.name)
  const finalName = `${SHOW} S${pad(SEASON, 2)}E${pad(ep, 3)}${q ? ` [${q}]` : ''}${ext}`
  const t0 = Date.now()
  const r1 = await copy(`${SRC}/${f.name}`, DST)
  if (r1.err) { console.log(`  ❌ E${ep} 复制失败: ${r1.err}`); fail++; continue }
  const r2 = await rename(DST, f.name, finalName)
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  if (r2.err) { console.log(`  ⚠️ E${ep} 已复制但改名失败: ${r2.err}（留在原名）`); fail++; continue }
  have.add(ep); ok++
  console.log(`  ✅ E${ep} → ${finalName}  (${secs}s)`)
}
console.log(`\n完成：复制 ${ok}，跳过 ${skip}，失败 ${fail}`)
