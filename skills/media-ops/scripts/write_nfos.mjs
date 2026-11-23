/**
 * 给媒体库里的剧批量写 tvshow.nfo（钉住 TMDB 条目）。
 *
 * 用法：
 *   node write_nfos.mjs [--root <媒体根>] [--dry-run] [--force] [--show <剧名>]
 *
 * 数据来源：`shows.json` 登记表（由 register.mjs --scan 自动维护）。
 * 不再硬编码剧单——新增剧只需跑一次 register.mjs，无需改代码。
 *
 * 行为：
 *   - 默认**只补缺失或内容不对的** NFO；内容已正确的跳过（幂等，可反复跑）。
 *   - --force 强制重写全部。
 *   - --dry-run 只打印计划。
 *   - 写入后会回读校验，确认内容真的落盘——CreateFile 对已存在文件是静默 no-op，
 *     早期版本因此报告「✅ 成功」却从未更新过任何 NFO。
 *   - tmdbId 缺失的剧会跳过并提示，不会写入错误的 NFO。
 */
import { createNas } from '../../../lib/nas.js'
import {
  readRegistry, nfoXml, findShow, isAmbiguous, showDirPath, registryPath, LIBRARY_ROOT,
} from '../../../lib/shows.js'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes(k)
const ROOT = arg('--root', LIBRARY_ROOT)
const DRY = flag('--dry-run')
const FORCE = flag('--force')
const ONLY = arg('--show', '')
const REGISTRY = registryPath(arg('--registry'))

let registry
try {
  registry = readRegistry(REGISTRY)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
if (!registry.shows.length) {
  console.error('登记表为空。先跑：node scripts/register.mjs --scan')
  process.exit(1)
}

let targets
if (ONLY) {
  const hit = findShow(registry, ONLY)
  if (isAmbiguous(hit)) {
    console.error(`「${ONLY}」匹配到多部剧，请用完整目录名指定：`)
    for (const s of hit.ambiguous) console.error(`   ${s.dir}`)
    process.exit(1)
  }
  targets = hit ? [hit] : []
} else {
  targets = registry.shows
}
if (!targets.length) {
  console.error(`没有匹配的剧：${ONLY}\n可用：${registry.shows.map((s) => s.title).join(', ')}`)
  process.exit(1)
}

let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

/** 现有 NFO 是否已经是我们想要的内容（忽略空白差异）。 */
const sameNfo = (existing, want) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim()
  return norm(existing) === norm(want)
}

console.log(DRY ? '模式：dry-run（只看不改）\n' : '')
let created = 0; let updated = 0; let skipped = 0; let fail = 0

for (const s of targets) {
  if (!s.tmdbId) {
    console.log(`⏭ ${s.title} —— 缺 tmdbId，跳过（用 register.mjs --set-tmdb 补上再跑）`)
    skipped++
    continue
  }

  const dir = showDirPath(s, ROOT)
  const path = `${dir}/tvshow.nfo`
  const want = nfoXml(s)

  // 目录不存在就别写：CreateFile 会报 1302，提前给出更清楚的提示
  if (!(await nas.exists(dir))) {
    console.log(`⏭ ${s.title} —— 目录不存在：${dir}`)
    skipped++
    continue
  }

  const cur = await nas.readFile(path)
  const had = cur.ok && cur.bytes > 0

  if (had && !FORCE && sameNfo(cur.text, want)) {
    console.log(`↷ ${s.title} —— 已正确，跳过`)
    skipped++
    continue
  }

  const action = had ? '更新' : '新建'
  if (DRY) {
    console.log(`✎ 将${action} ${s.title} → tmdb:${s.tmdbId}`)
    if (had) updated++; else created++
    continue
  }

  const r = await nas.createFile(path, want)
  if (!r.ok) { fail++; console.log(`❌ ${s.title}: ${r.error}`); continue }

  // 回读校验：确认内容真的落盘了
  const back = await nas.readFile(path)
  if (!back.ok || !sameNfo(back.text, want)) {
    fail++
    console.log(`❌ ${s.title} —— 写入后校验失败（内容未生效）`)
    continue
  }

  if (had) { updated++; console.log(`✅ ${s.title} → tmdb:${s.tmdbId}（已更新）`) }
  else { created++; console.log(`✅ ${s.title} → tmdb:${s.tmdbId}（已新建）`) }
}

console.log(`\n完成：新建 ${created}，更新 ${updated}，跳过 ${skipped}，失败 ${fail}`)
if (DRY) console.log('(dry-run：去掉 --dry-run 才会真正执行)')
if (fail) process.exit(1)
