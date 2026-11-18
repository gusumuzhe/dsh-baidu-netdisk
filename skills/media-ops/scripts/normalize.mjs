/**
 * 媒体库命名归一化（批量版）。
 * 规则：<剧名> (<年份>)/[Season NN/]<剧名> S<SS>E<EEE>[ [画质]].<ext>
 * 同集多份：保留体积最大的，其余删除（进回收站）。
 *
 * 用法：node normalize_all.mjs [--apply]
 */
import { readFileSync } from 'node:fs'
import https from 'node:https'
// 路径可被环境变量覆盖，便于在别的机器上复用
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const CONFIG_FILE = process.env.DSH_PROFILE_CONFIG || `${PROFILE_DIR}/cordis.patch.yml`
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)

const P = '/root/.dsh/profiles/web/node_modules/dsh-ugreen-nas'
const catalog = JSON.parse(readFileSync(`${P}/lib/catalog.json`, 'utf8'))
const patch = readFileSync(CONFIG_FILE, 'utf8')
const url = new URL(patch.match(/endpoint:\s*(\S+)/)?.[1])
const token = patch.match(/accessToken:\s*(\S+)/)?.[1]
const APPLY = process.argv.includes('--apply')

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
const del = (path) => post('DelPath', 'ugidl.filesystem.cli.DelPathRequest', 'ugidl.filesystem.cli.DelPathsResponse', { path, is_dry_run: false })

const ROOT = '/volume1/影视/动漫'
const VIDEO = /\.(mp4|mkv|avi|ts|m4v|mov)$/i
const epOf = (n) => {
  let m = String(n).match(/S(\d{1,2})\s*E(\d{1,4})/i)
  if (m) return { s: Number(m[1]), e: Number(m[2]) }
  m = String(n).match(/第\s*(\d{1,4})\s*[集话]/)
  if (m) return { s: null, e: Number(m[1]) }
  m = String(n).match(/^(\d{1,4})[.\s]/)
  if (m) return { s: null, e: Number(m[1]) }
  m = String(n).match(/(\d{1,4})/)
  if (m) return { s: null, e: Number(m[1]) }
  return { s: null, e: null }
}
const qOf = (n) => /2160p|4k/i.test(n) ? '2160p' : /1080p/i.test(n) ? '1080p' : ''
const pad = (n, w) => String(n).padStart(w, '0')

// 每部剧的配置：目录名 → { title, year, season（子目录映射） }
const SHOWS = [
  { dir: '沧元图', title: '沧元图', year: 2023, layout: 'flat', season: 1 },
  { dir: '斗破苍穹', title: '斗破苍穹', year: 2017, layout: 'seasonDir' },
  { dir: '神墓', title: '神墓', year: 2022, layout: 'seasonDir' },
  { dir: '永生', title: '永生', year: 2022, layout: 'arcDirs', season: 1 },
  { dir: '择天记', title: '择天记', year: 2026, layout: 'flat', season: 1 },
  { dir: '光阴之外', title: '光阴之外', year: 2025, layout: 'flat', season: 1 },
  { dir: '深空彼岸', title: '深空彼岸', year: 2026, layout: 'flat', season: 1 },
  { dir: '星辰变', title: '星辰变', year: 2018, layout: 'seasonDir' },
]

const seasonFromDirName = (n) => {
  let m = n.match(/S(\d{1,2})/i) || n.match(/Season\s*(\d{1,2})/i)
  return m ? Number(m[1]) : null
}

for (const show of SHOWS) {
  const base = `${ROOT}/${show.dir}`
  const entries = await ls(base)
  const items = []   // { dir, name, size, ep, season }

  const collect = async (dir, seasonHint) => {
    for (const f of await ls(dir)) {
      if (!f.ext) continue
      if (!VIDEO.test(f.name)) continue
      const { s, e } = epOf(f.name)
      if (e == null) continue
      items.push({ dir, name: f.name, size: f.size, ep: e, season: s ?? seasonHint ?? 1 })
    }
  }

  if (show.layout === 'flat') {
    await collect(base, show.season)
  } else if (show.layout === 'seasonDir') {
    const subs = entries.filter((x) => !x.ext)
    for (const s of subs) await collect(`${base}/${s.name}`, seasonFromDirName(s.name))
  } else if (show.layout === 'arcDirs') {
    const subs = entries.filter((x) => !x.ext)
    for (const s of subs) await collect(`${base}/${s.name}`, show.season)
  }

  // 去重：同季同集保留体积最大的
  const byKey = new Map()
  for (const it of items) {
    const k = `${it.season}-${it.ep}`
    const prev = byKey.get(k)
    if (!prev || it.size > prev.size) { if (prev) byKey.set(k + '_dup', prev); byKey.set(k, it) }
    else byKey.set(k + '_dup_' + it.name, it)
  }
  const keep = []
  const drop = []
  for (const [k, v] of byKey) { if (k.includes('_dup')) drop.push(v); else keep.push(v) }
  keep.sort((a, b) => a.season - b.season || a.ep - b.ep)

  console.log(`\n## ${show.dir} → ${show.title} (${show.year})   保留 ${keep.length}，删除 ${drop.length}`)
  for (const it of keep.slice(0, 3)) {
    const q = qOf(it.name)
    const ext = it.name.match(VIDEO)[0].toLowerCase()
    console.log(`   ${it.name}\n      → ${show.title} S${pad(it.season, 2)}E${pad(it.ep, 3)}${q ? ` [${q}]` : ''}${ext}`)
  }
  if (keep.length > 3) console.log(`   ... 还有 ${keep.length - 3} 个`)
  for (const it of drop) console.log(`   🗑 重复删除: ${it.name} (${(it.size / 1024 ** 3).toFixed(2)}G)`)

  if (!APPLY) continue

  // 执行：先删重复，再改名，最后改目录名
  for (const it of drop) await del(`${it.dir}/${it.name}`)
  for (const it of keep) {
    const q = qOf(it.name)
    const ext = it.name.match(VIDEO)[0].toLowerCase()
    const newName = `${show.title} S${pad(it.season, 2)}E${pad(it.ep, 3)}${q ? ` [${q}]` : ''}${ext}`
    if (newName !== it.name) await rename(it.dir, it.name, newName)
  }
  // 子目录改名为 Season NN
  if (show.layout === 'seasonDir') {
    for (const s of entries.filter((x) => !x.ext)) {
      const n = seasonFromDirName(s.name)
      if (n && s.name !== `Season ${pad(n, 2)}`) await rename(base, s.name, `Season ${pad(n, 2)}`)
    }
  }
  const targetDir = `${show.title} (${show.year})`
  if (show.dir !== targetDir) await rename(ROOT, show.dir, targetDir)
  console.log(`   ✅ 已应用`)
}

console.log(APPLY ? '\n全部应用完成' : '\n(dry-run：加 --apply 执行)')
