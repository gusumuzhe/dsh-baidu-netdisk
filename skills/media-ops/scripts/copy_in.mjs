/**
 * 把下载目录里「已下载完成」的剧集复制进媒体库，并按规范改名。
 *   <剧名> S<SS>E<EEE>[ [画质]].<ext>
 * 跳过 .baiduyun.p.downloading 临时文件；跳过媒体库里已存在的集。
 *
 * 用法：node copy_in.mjs --src <下载目录> --dst <媒体目录> --show 仙逆 --year 2023 [--season 1]
 */
import { readFileSync } from 'node:fs'
import https from 'node:https'
// 路径可被环境变量覆盖，便于在别的机器上复用
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const CONFIG_FILE = process.env.DSH_PROFILE_CONFIG || `${PROFILE_DIR}/cordis.patch.yml`
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)

const P = '/root/.dsh/profiles/web/node_modules/dsh-ugreen-nas'
const catalog = JSON.parse(readFileSync(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/catalog.json`, 'utf8'))
const patch = readFileSync(CONFIG_FILE, 'utf8')
const url = new URL(patch.match(/endpoint:\s*(\S+)/)?.[1])
const token = patch.match(/accessToken:\s*(\S+)/)?.[1]

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const SRC = arg('--src'); const DST = arg('--dst'); const SHOW = arg('--show')
const YEAR = arg('--year'); const SEASON = Number(arg('--season', '1'))

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

// 支持三种集号写法：SxxExx / 92.mkv / 第92集
const episodeOf = (n) => {
  const s = String(n)
  let m = s.match(/S\d{1,2}\s*E(\d{1,4})/i)
  if (m) return Number(m[1])
  m = s.match(/第\s*(\d{1,4})\s*[集话]/)
  if (m) return Number(m[1])
  m = s.match(/^(\d{1,4})\.(mkv|mp4|avi|ts|m4v|mov)$/i)
  if (m) return Number(m[1])
  return null
}
const qualityOf = (n) => /2160p|4k/i.test(n) ? '2160p' : /1080p/i.test(n) ? '1080p' : ''
const pad = (n, w) => String(n).padStart(w, '0')

const media = await ls(DST)
const have = new Set(media.map((f) => episodeOf(f.name)).filter((x) => x != null))
const src = await ls(SRC)
const ready = src.filter((f) => f.ext && !/\.downloading$/i.test(f.name) && /\.(mp4|mkv|avi|ts|m4v)$/i.test(f.name))

console.log(`媒体库已有 ${have.size} 集 | 下载目录可用 ${ready.length} 个`)
let ok = 0; let skip = 0; let fail = 0
for (const f of ready) {
  const ep = episodeOf(f.name)
  if (ep == null) { console.log(`  ⚠️ 无集号，跳过: ${f.name}`); skip++; continue }
  if (have.has(ep)) { console.log(`  ↷ E${ep} 已存在，跳过`); skip++; continue }
  const ext = f.name.match(/\.(mp4|mkv|avi|ts|m4v)$/i)[0].toLowerCase()
  const q = qualityOf(f.name)
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
