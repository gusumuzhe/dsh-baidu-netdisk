/**
 * 补集一条龙：转存 → 等同步 → 归位 → 清暂存。
 *
 * 用法：
 *   node pipeline.mjs --show 沧元图 --year 2023 --episodes 104-110 \
 *     --share "https://pan.baidu.com/s/1xxx" --pwd 8888 [--share-subdir "第 3 季 - 2160p..."] \
 *     [--season 1] [--subdir 沧元图] [--clean] [--dry-run]
 *
 * 约定：
 *   - 网盘暂存根 = 插件配置里的 inboxRoot（默认 /绿联下载）
 *   - NAS 下载区 = <downloads>/<subdir>（默认 /volume1/Downloads/BaiduNetDisk）
 *   - 媒体目录   = <library>/<show> (<year>)[/Season NN]
 *   - --clean 才会在最后清理下载区（删除前仍会做「同集同字节」校验）
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BaiduClient } from '../../../lib/baidu.js'
import { transferEpisodes } from '../../../lib/transfer.js'
import { parseEpisodes } from '../../../lib/episodes.js'
import { readPluginConfig } from '../../../lib/profile.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes(k)

// 按插件条目 id 取配置：全局正则抓第一个同名键会被 dsh-ugreen-nas 的 timeoutMs 顶掉
const CFG = readPluginConfig('dsh-baidu-netdisk', { inboxRoot: '/绿联下载', timeoutMs: '15000' })
const cfg = (k, d) => CFG[k] ?? d

const SHOW = arg('--show')
const YEAR = arg('--year')
const EPISODES = arg('--episodes')
const SHARE = arg('--share')
const PWD = arg('--pwd', '')
const SEASON = arg('--season')
const SUBDIR = arg('--subdir', SHOW)
const SHARE_SUBDIR = arg('--share-subdir', '')
const INBOX = arg('--inbox', cfg('inboxRoot', '/绿联下载'))
const DOWNLOADS = arg('--downloads', '/volume1/Downloads/BaiduNetDisk')
const LIBRARY = arg('--library', '/volume1/影视/动漫')
const CLEAN = flag('--clean')
const DRY = flag('--dry-run')
const SKIP_TRANSFER = flag('--skip-transfer')

if (!SHOW || !YEAR || !EPISODES) {
  console.error('用法: --show <剧名> --year <年份> --episodes <集号> [--share <链接>] [--pwd <码>] [--share-subdir <源内子目录>] [--season <N>] [--clean] [--dry-run]')
  process.exit(1)
}
if (!SKIP_TRANSFER && !SHARE) {
  console.error('缺少 --share（或用 --skip-transfer 表示已转存）')
  process.exit(1)
}

const want = parseEpisodes(EPISODES)
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 媒体目录布局：单季剧平铺，多季剧才加 Season NN 子目录。
 * 之前只要传了 --season 就拼 Season NN，导致单季剧（沧元图）被塞进
 * 一个并不存在的 Season 01 目录，刮削会认不出来。
 * 用 --season-dir / --flat 可以显式覆盖自动判断。
 */
const LAYOUT = flag('--season-dir') ? 'seasonDir' : flag('--flat') ? 'flat' : 'auto'
const useSeasonDir = LAYOUT === 'seasonDir' || (LAYOUT === 'auto' && Number(SEASON) > 1)
const mediaDir = [LIBRARY, `${SHOW} (${YEAR})`, useSeasonDir ? `Season ${pad2(SEASON)}` : ''].filter(Boolean).join('/')
const downloadDir = `${DOWNLOADS}/${SUBDIR}`
const netdiskDir = `${INBOX}/${SUBDIR}`

console.log('=== 计划 ===')
console.log(`  剧集      ${SHOW} (${YEAR})${SEASON ? ` S${pad2(SEASON)}` : ''}`)
console.log(`  集号      ${want.length} 集：${want.join(',')}`)
console.log(`  网盘暂存  ${netdiskDir}`)
console.log(`  NAS 下载  ${downloadDir}`)
console.log(`  媒体目录  ${mediaDir}${LAYOUT === 'auto' ? `（${useSeasonDir ? '多季，用 Season 子目录' : '单季，平铺'}；可用 --season-dir / --flat 覆盖）` : ''}`)
console.log(`  清理暂存  ${CLEAN ? '是' : '否'}`)
if (DRY) { console.log('\n(dry-run，不做任何改动)'); process.exit(0) }

const run = (label, file, args) => {
  console.log(`\n=== ${label} ===`)
  const r = spawnSync(process.execPath, [join(HERE, file), ...args], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n❌ ${label} 失败（退出码 ${r.status}），后续步骤中止`)
    process.exit(r.status || 1)
  }
}

let transferred = 0
if (SKIP_TRANSFER) {
  // 已经转存过：后三步照跑，不能因为 transferred=0 就整段跳过
  console.log('\n=== 1/4 转存 ===\n   已跳过（--skip-transfer，假定网盘里已有这些集）')
  transferred = want.length
} else {
  console.log('\n=== 1/4 转存 ===')
  const baidu = new BaiduClient({ bduss: cfg('bduss', ''), stoken: cfg('stoken', ''), timeoutMs: Number(cfg('timeoutMs', 15000)) })
  const res = await transferEpisodes(baidu, {
    shareUrl: SHARE, pwd: PWD, episodes: EPISODES,
    inboxRoot: INBOX, subdir: SUBDIR, shareSubdir: SHARE_SUBDIR,
  })
  if (!res.ok) { console.error('❌ 转存失败:', res.error || `errno=${res.errno}`); process.exit(1) }
  transferred = res.transferred || 0
  console.log(`   转存 ${res.transferred} 集，跳过 ${res.skipped} 集${res.notFound?.length ? `，源里没有：${res.notFound.join(',')}` : ''}`)
  if (!transferred) console.log('   没有新文件需要下载，跳过等待与归位')
}

if (transferred > 0) {
  run('2/4 等待同步', 'wait_sync.mjs', ['--dir', downloadDir, '--episodes', EPISODES, '--interval', arg('--interval', '60'), '--timeout', arg('--timeout', '180')])
  // 传 --episodes 限定范围：暂存区里残留的别的集不该被顺手搬进媒体库
  run('3/4 归位入库', 'copy_in.mjs', ['--src', downloadDir, '--dst', mediaDir, '--show', SHOW, '--year', YEAR, '--episodes', EPISODES, ...(SEASON ? ['--season', String(SEASON)] : [])])
  if (CLEAN) run('4/4 清理暂存', 'cleanup_staging.mjs', ['--src', downloadDir, '--dst', mediaDir, '--confirm'])
  else console.log('\n=== 4/4 清理暂存 ===\n   已跳过（加 --clean 启用）')
}

console.log('\n✅ 完成')
