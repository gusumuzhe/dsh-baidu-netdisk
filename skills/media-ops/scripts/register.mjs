/**
 * 维护剧集登记表 `shows.json`。
 *
 * 用法：
 *   node register.mjs --scan              # 扫描媒体库，发现新剧 / 更新布局
 *   node register.mjs --scan --dry-run    # 只看会改什么
 *   node register.mjs --list              # 打印当前登记表
 *   node register.mjs --set-tmdb "诛仙" 206484   # 给某部剧填 TMDB id
 *   node register.mjs --remove "某剧 (2020)"     # 从登记表移除（不动磁盘文件）
 *
 * 设计：能从磁盘推断的都不写进配置。
 *   - title / year  ← 目录名 `<剧名> (<年份>)`
 *   - layout        ← 有没有 Season 子目录
 *   - tmdbId        ← 优先沿用已有登记，否则从 tvshow.nfo 读回
 * 只有 tmdbId 推断不出来时必须人工确认一次（撞名风险，见 SKILL.md 第 8 条）。
 */
import { createNas } from '../../../lib/nas.js'
import {
  readRegistry, writeRegistry, scanLibrary, findShow, isAmbiguous,
  registryPath, LIBRARY_ROOT,
} from '../../../lib/shows.js'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes(k)
const ROOT = arg('--root', LIBRARY_ROOT)
// 登记表是个人数据，默认放 profile 目录；--registry 可显式覆盖
const REGISTRY = registryPath(arg('--registry'))

const SCAN = flag('--scan')
const LIST = flag('--list')
const DRY = flag('--dry-run')
const PRUNE = flag('--prune')
const SET_TMDB = arg('--set-tmdb')
const REMOVE = arg('--remove')

if (!SCAN && !LIST && !SET_TMDB && !REMOVE) {
  console.error(`用法：
  node register.mjs --scan [--dry-run] [--prune]  扫描媒体库，发现新剧 / 更新布局
                                              --prune 同时移除磁盘上已不存在的条目
  node register.mjs --list                    打印当前登记表
  node register.mjs --set-tmdb "<剧名>" <id>  给某部剧填 TMDB id
  node register.mjs --remove "<目录名>"       从登记表移除（不动磁盘文件）`)
  process.exit(1)
}

let registry
try {
  registry = readRegistry(REGISTRY)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const printTable = (shows) => {
  if (!shows.length) { console.log('（空）'); return }
  const w = Math.max(...shows.map((s) => s.dir.length), 4)
  for (const s of shows) {
    const id = s.tmdbId ? `tmdb:${s.tmdbId}` : '⚠️ 缺 tmdbId'
    const seasons = s.seasons?.length ? `  S${s.seasons.join(',S')}` : ''
    console.log(`  ${s.dir.padEnd(w)}  ${String(s.year)}  ${s.layout.padEnd(9)}  ${id}${seasons}`)
  }
}

if (LIST) {
  console.log(`登记表：${REGISTRY}\n共 ${registry.shows.length} 部\n`)
  printTable(registry.shows)
  const missing = registry.shows.filter((s) => !s.tmdbId)
  if (missing.length) console.log(`\n⚠️ ${missing.length} 部缺 tmdbId：${missing.map((s) => s.title).join(', ')}`)
  process.exit(0)
}

if (SET_TMDB) {
  const id = Number(arg('--set-tmdb-id') || argv[argv.indexOf('--set-tmdb') + 2])
  if (!Number.isFinite(id) || id <= 0) {
    console.error('用法: node register.mjs --set-tmdb "<剧名>" <tmdbId>')
    process.exit(1)
  }
  const show = findShow(registry, SET_TMDB)
  if (isAmbiguous(show)) {
    console.error(`「${SET_TMDB}」匹配到多部剧，请用完整目录名指定：`)
    for (const s of show.ambiguous) console.error(`   ${s.dir}`)
    process.exit(1)
  }
  if (!show) {
    console.error(`登记表里没有：${SET_TMDB}\n先跑 --scan，或检查剧名`)
    process.exit(1)
  }
  show.tmdbId = id
  if (DRY) { console.log(`(dry-run) 将设置 ${show.dir} → tmdb:${id}`); process.exit(0) }
  writeRegistry(registry, REGISTRY)
  console.log(`✅ ${show.dir} → tmdb:${id}`)
  process.exit(0)
}

if (REMOVE) {
  const show = findShow(registry, REMOVE)
  if (isAmbiguous(show)) {
    console.error(`「${REMOVE}」匹配到多部剧，请用完整目录名指定：`)
    for (const s of show.ambiguous) console.error(`   ${s.dir}`)
    process.exit(1)
  }
  if (!show) { console.error(`登记表里没有：${REMOVE}`); process.exit(1) }
  if (DRY) { console.log(`(dry-run) 将移除 ${show.dir}`); process.exit(0) }
  registry.shows = registry.shows.filter((s) => s.dir !== show.dir)
  writeRegistry(registry, REGISTRY)
  console.log(`✅ 已从登记表移除 ${show.dir}（磁盘文件未动）`)
  process.exit(0)
}

// --scan
let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const { shows, added, updated, removed, scanned } = await scanLibrary(nas, { root: ROOT, registry, prune: PRUNE })

// 磁盘上一部剧都没扫到 → 多半是路径写错或 NAS 不可达，不能静默报「无需改动」
if (scanned === 0) {
  console.error(`❌ 在 ${ROOT} 下没有扫到任何符合 <剧名> (<年份>) 的目录`)
  console.error('   请检查 --root 是否正确、NAS 是否可达')
  process.exit(1)
}

console.log(`扫描 ${ROOT}`)
console.log(`  磁盘上扫到 ${scanned} 部`)
console.log(`  登记表原有 ${registry.shows.length} 部`)
console.log(`  新发现 ${added.length} 部${added.length ? '：' + added.map((s) => s.dir).join(', ') : ''}`)
console.log(`  有变化 ${updated.length} 部${updated.length ? '：' + updated.map((s) => s.dir).join(', ') : ''}`)
if (PRUNE) console.log(`  已移除 ${removed.length} 部${removed.length ? '：' + removed.map((s) => s.dir).join(', ') : ''}`)
else if (registry.shows.some((s) => !shows.find((x) => x.dir === s.dir))) {
  console.log('  （有条目在磁盘上已不存在，加 --prune 可清理）')
}

if (DRY) {
  console.log('\n(dry-run，未写入)')
  if (added.length || updated.length || removed.length) printTable([...added, ...updated])
  process.exit(0)
}

if (!added.length && !updated.length && !removed.length) {
  console.log('\n登记表已是最新，无需改动')
  process.exit(0)
}

writeRegistry({ shows }, REGISTRY)
console.log(`\n✅ 已写入 ${REGISTRY}`)

const missing = shows.filter((s) => !s.tmdbId)
if (missing.length) {
  console.log(`\n⚠️ 以下 ${missing.length} 部缺 tmdbId，需人工确认后补上：`)
  for (const s of missing) console.log(`   node scripts/register.mjs --set-tmdb "${s.title}" <tmdbId>`)
}
