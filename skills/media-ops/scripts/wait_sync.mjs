/**
 * 等待网盘工具把指定区间的集数同步到 NAS 完成。
 *
 * 判定标准：目标集全部出现，且不再有 `.baiduyun.p.downloading` 临时文件。
 * 作为后台任务运行时，完成即退出，会触发 DSH 的任务完成通知。
 *
 * 用法：
 *   node wait_sync.mjs --dir <NAS目录> --from 92 --to 103 [--interval 30] [--timeout 120]
 * 退出码：0=完成  2=超时（打印当前状态）
 */
import { readFileSync } from 'node:fs'
import https from 'node:https'

const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const CONFIG_FILE = process.env.DSH_PROFILE_CONFIG || `${PROFILE_DIR}/cordis.patch.yml`
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)
const catalog = JSON.parse(readFileSync(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/catalog.json`, 'utf8'))
const patch = readFileSync(CONFIG_FILE, 'utf8')
const url = new URL(patch.match(/endpoint:\s*(\S+)/)?.[1])
const token = patch.match(/accessToken:\s*(\S+)/)?.[1]

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const DIR = arg('--dir')
const FROM = Number(arg('--from'))
const TO = Number(arg('--to'))
const INTERVAL = Math.max(Number(arg('--interval', 30)), 10) * 1000
const TIMEOUT = Math.max(Number(arg('--timeout', 120)), 5) * 60 * 1000
if (!DIR || !Number.isFinite(FROM) || !Number.isFinite(TO)) {
  console.error('用法: --dir <目录> --from <起始集> --to <结束集> [--interval 30] [--timeout 120]')
  process.exit(1)
}

const ls = (path) => new Promise((resolve) => {
  const body = encodeMessage(catalog, 'ugidl.filesystem.cli.FileDirListRequest', { path, page: 1, limit: 1000 })
  const rq = https.request({
    hostname: url.hostname, port: url.port || 443, method: 'POST', rejectUnauthorized: false,
    path: `${url.pathname.replace(/\/$/, '')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/CategoryOrFileDirList`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-protobuf', Accept: 'application/x-protobuf', 'X-OpenCLI-Body-Format': 'protobuf', 'Content-Length': body.length },
  }, (r) => {
    const cs = []
    r.on('data', (c) => cs.push(c))
    r.on('end', () => {
      const b = Buffer.concat(cs)
      if (r.headers['x-grpc-code'] !== '0') return resolve([])
      resolve(decodeMessage(catalog, 'ugidl.filesystem.cli.FileDirListResponse', b)?.data?.file_list?.files || [])
    })
  })
  rq.on('error', () => resolve([]))
  rq.write(body); rq.end()
})

const episodeOf = (name) => {
  const m = String(name).match(/S\d{1,2}E(\d{1,4})/i)
  if (m) return Number(m[1])
  const m2 = String(name).match(/^(\d{1,4})\.(mkv|mp4|avi|ts|m4v)/i)
  if (m2) return Number(m2[1])
  const m3 = String(name).match(/(\d{1,4})/)
  return m3 ? Number(m3[1]) : null
}

const want = []
for (let i = FROM; i <= TO; i++) want.push(i)
const startedAt = Date.now()
const t0 = new Date().toLocaleTimeString('zh-CN')

console.log(`[${t0}] 开始等待同步：${DIR}  目标 E${FROM}–E${TO}（共 ${want.length} 集）`)

let lastDone = -1
for (;;) {
  const files = await ls(DIR)
  const done = new Set()
  let pending = 0
  let bytes = 0
  for (const f of files) {
    const ep = episodeOf(f.name)
    if (ep == null) continue
    if (/\.baiduyun\.p\.downloading$/i.test(f.name)) { pending++; bytes += Number(f.size) || 0 }
    else if (want.includes(ep)) done.add(ep)
  }
  const total = want.length
  const missing = want.filter((e) => !done.has(e))
  const elapsed = Math.round((Date.now() - startedAt) / 60000)

  if (done.size !== lastDone || pending) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 完成 ${done.size}/${total}｜下载中 ${pending} 个（已收 ${(bytes / 1024 ** 3).toFixed(1)}G）｜缺 ${missing.length ? missing.slice(0, 8).join(',') + (missing.length > 8 ? '…' : '') : '无'}｜已等 ${elapsed} 分钟`)
    lastDone = done.size
  }

  if (done.size === total && pending === 0) {
    console.log(`\n✅ 同步完成：E${FROM}–E${TO} 共 ${total} 集已全部就绪（耗时 ${elapsed} 分钟）`)
    console.log(`   下一步：node copy_in.mjs --src "${DIR}" --dst "<媒体目录>" --show "<剧名>" --year <年份>`)
    process.exit(0)
  }
  if (Date.now() - startedAt > TIMEOUT) {
    console.log(`\n⚠️ 等待超时（${TIMEOUT / 60000} 分钟）：完成 ${done.size}/${total}，仍在下载 ${pending} 个`)
    process.exit(2)
  }
  await new Promise((r) => setTimeout(r, INTERVAL))
}
