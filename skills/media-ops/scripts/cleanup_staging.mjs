/**
 * 清理下载暂存区：只有当媒体库里存在「同集、同大小」的文件时，才删除暂存副本。
 *
 * 默认 dry-run，必须显式 --confirm 才真正删除（删除进回收站，可恢复）。
 *
 * 用法：
 *   node cleanup_staging.mjs --src <下载目录> --dst <媒体目录>
 *   node cleanup_staging.mjs --src <下载目录> --dst <媒体目录> --confirm
 */
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { episodeOf } from '../../../lib/episodes.js'

const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const CONFIG_FILE = process.env.DSH_PROFILE_CONFIG || `${PROFILE_DIR}/cordis.patch.yml`
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)
const catalog = JSON.parse(readFileSync(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/catalog.json`, 'utf8'))
const patch = readFileSync(CONFIG_FILE, 'utf8')
const url = new URL(patch.match(/endpoint:\s*(\S+)/)?.[1])
const token = patch.match(/accessToken:\s*(\S+)/)?.[1]

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const SRC = arg('--src')
const DST = arg('--dst')
const CONFIRM = argv.includes('--confirm')
if (!SRC || !DST) {
  console.error('用法: --src <下载目录> --dst <媒体目录> [--confirm]')
  process.exit(1)
}

const post = (method, reqT, resT, payload) => new Promise((resolve) => {
  const body = encodeMessage(catalog, reqT, payload)
  const rq = https.request({
    hostname: url.hostname, port: url.port || 443, method: 'POST', rejectUnauthorized: false,
    path: `${url.pathname.replace(/\/$/, '')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/${method}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-protobuf', Accept: 'application/x-protobuf', 'X-OpenCLI-Body-Format': 'protobuf', 'Content-Length': body.length },
  }, (r) => {
    const cs = []
    r.on('data', (c) => cs.push(c))
    r.on('end', () => {
      const b = Buffer.concat(cs)
      if (r.headers['x-grpc-code'] !== '0') return resolve({ err: b.toString('utf8').slice(0, 140) })
      let d = {}
      try { d = decodeMessage(catalog, resT, b) } catch {}
      resolve({ ok: true, data: d })
    })
  })
  rq.setTimeout(60000, () => rq.destroy(new Error('timeout')))
  rq.on('error', (e) => resolve({ err: String(e.message || e) }))
  rq.write(body); rq.end()
})
const ls = (p) => post('CategoryOrFileDirList', 'ugidl.filesystem.cli.FileDirListRequest', 'ugidl.filesystem.cli.FileDirListResponse', { path: p, page: 1, limit: 1000 })
  .then((x) => x?.data?.data?.file_list?.files || [])

const GB = (b) => (Number(b) / 1024 ** 3).toFixed(2) + 'G'

const media = await ls(DST)
const byEpisode = new Map()
for (const f of media) {
  if (f.isDir || !/\.(mp4|mkv|avi|ts|m4v)$/i.test(f.name)) continue
  const e = episodeOf(f.name)
  if (e != null) byEpisode.set(e, f)
}

const staging = (await ls(SRC)).filter((f) => f.ext && !/\.downloading$/i.test(f.name))
console.log(`暂存区 ${staging.length} 个文件 | 媒体库已识别 ${byEpisode.size} 集`)
console.log(CONFIRM ? '模式：真实删除（进回收站）\n' : '模式：dry-run（只看不改，加 --confirm 才执行）\n')

let del = 0; let kept = 0; let bytes = 0
for (const f of staging) {
  const e = episodeOf(f.name)
  const target = e == null ? null : byEpisode.get(e)
  if (!target) {
    console.log(`  ⏸ 保留 ${f.name} —— 媒体库没有第 ${e ?? '?'} 集`)
    kept++
    continue
  }
  if (Number(target.size) !== Number(f.size)) {
    console.log(`  ⏸ 保留 ${f.name} —— 目标大小不一致（${GB(f.size)} vs ${GB(target.size)}）`)
    kept++
    continue
  }
  if (!CONFIRM) {
    console.log(`  🗑 将删除 ${f.name}（媒体库已有 ${target.name}，${GB(f.size)}）`)
    del++; bytes += Number(f.size)
    continue
  }
  const r = await post('DelPath', 'ugidl.filesystem.cli.DelPathRequest', 'ugidl.filesystem.cli.DelPathsResponse', { path: `${SRC}/${f.name}`, is_dry_run: false })
  if (r.err) { console.log(`  ❌ 删除失败 ${f.name}: ${r.err}`); kept++ }
  else { console.log(`  ✅ 已删除 ${f.name}（${GB(f.size)}）`); del++; bytes += Number(f.size) }
}
console.log(`\n${CONFIRM ? '已删除' : '可删除'} ${del} 个，保留 ${kept} 个，释放 ${GB(bytes)}`)
