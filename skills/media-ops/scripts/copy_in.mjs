/**
 * 把下载目录里「已下载完成」的剧集复制进媒体库，并按规范改名。
 *   <剧名> S<SS>E<EEE>[ [画质]].<ext>
 *
 * 用法：
 *   node copy_in.mjs --src <下载目录> --dst <媒体目录> --show 仙逆 --year 2023 [--season 1]
 *                    [--episodes "16,18-20"] [--dry-run] [--move]
 *
 * 行为要点（都是踩过坑之后加的）：
 *   - --dst 可以是剧集根目录，也可以是 Season 目录。传根目录且 --season>1 时，
 *     自动定位/创建 Season NN 子目录，不会把文件平铺到根目录。
 *   - 季号优先从 --dst 的 Season NN 目录名推断，其次用 --season。
 *     两者冲突时直接报错，不猜。
 *   - 媒体库已有集数的判定会**递归看一层子目录**，避免「根目录看着是 0 集、
 *     实际 Season 04 里已有 15 集」导致重复入库。
 *   - 自愈改名**只作用于目标季**：扫到别的季的文件一律不动。
 *     （早期版本用固定的 --season 去算期望文件名，不传 --season 时会把
 *      Season 04 的 16 集全部改名成 S01——破坏性 bug，已修。）
 *   - 默认复制（源保留）；--move 才移动。CpMovePath 的 type=true 是移动，
 *     早期版本误用成复制，导致暂存区被悄悄清空。
 *   - --dry-run 只打印计划。
 */
import { episodeOf, qualityOf, parseEpisodes } from '../../../lib/episodes.js'
import { createNas, VIDEO_RE, isDownloading } from '../../../lib/nas.js'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes(k)

const SRC = arg('--src')
const DST = arg('--dst')
const SHOW = arg('--show')
const YEAR = arg('--year')
const SEASON_ARG = arg('--season')
const EPISODES = arg('--episodes', '')
const DRY = flag('--dry-run')
const MOVE = flag('--move')

if (!SRC || !DST || !SHOW) {
  console.error('用法: node copy_in.mjs --src <下载目录> --dst <媒体目录> --show <剧名> --year <年份> [--season 1] [--episodes "16,18-20"] [--dry-run] [--move]')
  process.exit(1)
}

const pad = (n, w) => String(n).padStart(w, '0')

/** 从路径里抠 Season 号：/x/Season 04 → 4 */
const seasonFromPath = (p) => {
  const m = String(p || '').match(/\/Season\s*(\d{1,2})\s*$/i)
  return m ? Number(m[1]) : null
}

const dstBase = DST.replace(/\/+$/, '')
const dstSeason = seasonFromPath(dstBase)

// 季号：--dst 的 Season 目录名 > --season > 1。冲突时报错，不猜。
let SEASON
if (dstSeason != null && SEASON_ARG != null && Number(SEASON_ARG) !== dstSeason) {
  console.error(`--season ${SEASON_ARG} 与 --dst 里的 Season ${pad(dstSeason, 2)} 冲突，请只保留一个`)
  process.exit(1)
}
SEASON = dstSeason ?? (SEASON_ARG != null ? Number(SEASON_ARG) : 1)

if (!Number.isFinite(SEASON) || SEASON < 1) {
  console.error(`--season 必须是正整数，收到：${SEASON_ARG}`)
  process.exit(1)
}

/** qualityOf 返回布尔信号对象，这里折算成文件名里的画质标签 */
const qualityLabel = (name) => {
  const q = qualityOf(name)
  if (q.uhd) return '2160p'
  if (q.fhd) return '1080p'
  if (q.hd) return '720p'
  return ''
}

/** 规范文件名。季号显式传入，避免用全局 SEASON 覆盖别的季。 */
const canonicalName = (season, ep, ext, srcName) => {
  const q = qualityLabel(srcName)
  return `${SHOW} S${pad(season, 2)}E${pad(ep, 3)}${q ? ` [${q}]` : ''}${ext}`
}

let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

/**
 * 定位媒体目录。
 * --dst 已经是 Season 目录就直接用；否则在 --season>1 时补 Season NN。
 */
const resolveMediaDir = () => {
  if (dstSeason != null) return { dir: dstBase, base: dstBase.replace(/\/Season\s*\d+$/i, '') }
  if (SEASON <= 1) return { dir: dstBase, base: dstBase }
  return { dir: `${dstBase}/Season ${pad(SEASON, 2)}`, base: dstBase }
}

const { dir: MEDIA, base: SHOW_ROOT } = resolveMediaDir()

/**
 * 收集媒体库已有的「季-集」，并记录目标季里命名不规范的文件。
 * 递归一层子目录：--dst 传剧集根目录时，Season NN 里的集也要算进来。
 */
const scanLibrary = async () => {
  const have = new Map()   // "season-ep" -> { dir, name, size, season, ep }
  const misnamed = []      // { dir, name, ep, season, want }
  const dirs = []
  const pushDir = (d) => { if (d && !dirs.includes(d)) dirs.push(d) }
  pushDir(MEDIA)
  pushDir(SHOW_ROOT)
  // 根目录下的 Season NN 子目录
  for (const f of await nas.ls(SHOW_ROOT)) {
    if (!f.ext && /^Season\s*\d+$/i.test(f.name)) pushDir(`${SHOW_ROOT}/${f.name}`)
  }

  for (const d of dirs) {
    const dirSeason = seasonFromPath(d)
    for (const f of await nas.ls(d)) {
      if (f.isDir || !f.ext || !VIDEO_RE.test(f.name)) continue
      const ep = episodeOf(f.name)
      if (ep == null) continue
      // 季号：文件名里的 S04 优先，其次目录名 Season 04，最后才用目标季
      const nameSeason = Number(String(f.name).match(/S(\d{1,2})\s*E\d/i)?.[1]) || null
      const season = nameSeason ?? dirSeason ?? SEASON
      const key = `${season}-${ep}`
      if (!have.has(key)) have.set(key, { dir: d, name: f.name, size: Number(f.size) || 0, season, ep })
      // 自愈改名只针对目标季，别的季一律不动
      if (season === SEASON) {
        const want = canonicalName(season, ep, f.name.match(VIDEO_RE)[0].toLowerCase(), f.name)
        if (f.name !== want) misnamed.push({ dir: d, name: f.name, ep, season, want })
      }
    }
  }
  return { have, misnamed }
}

const { have, misnamed } = await scanLibrary()

// 暂存区：目录不存在要报错，不能静默当成「0 个待入库」
const srcRes = await nas.lsEx(SRC)
if (!srcRes.ok) {
  console.error(`❌ 下载目录不可读：${SRC}\n   ${srcRes.error}`)
  process.exit(1)
}
const wantSet = EPISODES ? new Set(parseEpisodes(EPISODES)) : null
const ready = srcRes.files.filter((f) => {
  if (!f.ext || isDownloading(f.name) || !VIDEO_RE.test(f.name)) return false
  if (!wantSet) return true
  const ep = episodeOf(f.name)
  return ep != null && wantSet.has(ep)
})

const targetCount = [...have.values()].filter((x) => x.season === SEASON).length
console.log(`${SHOW} (${YEAR}) S${pad(SEASON, 2)} → ${MEDIA}`)
console.log(`媒体库 S${pad(SEASON, 2)} 已有 ${targetCount} 集 | 下载目录可用 ${ready.length} 个${wantSet ? `（已按 --episodes 过滤）` : ''}`)
if (dstSeason == null && SEASON > 1) console.log('（--dst 传的是剧集根目录，自动落到 Season 子目录）')
if (DRY) console.log('模式：dry-run（只看不改）\n')

let ok = 0; let skip = 0; let fail = 0; let renamed = 0

// 1) 先把目标季里命名不规范的已有文件改名（可逆，且能自愈历史遗留）
for (const m of misnamed) {
  if (DRY) { console.log(`  ✎ 将改名 ${m.name} → ${m.want}`); renamed++; continue }
  const r = await nas.rename(m.dir, m.name, m.want)
  if (r.ok) {
    renamed++
    const cur = have.get(`${m.season}-${m.ep}`)
    if (cur) have.set(`${m.season}-${m.ep}`, { ...cur, name: m.want })
    console.log(`  ✎ 已改名 ${m.name} → ${m.want}`)
  } else {
    console.log(`  ⚠️ 改名失败 ${m.name}: ${r.error}`)
  }
}

// 2) 复制/移动新集
for (const f of ready) {
  const ep = episodeOf(f.name)
  if (ep == null) { console.log(`  ⚠️ 无集号，跳过: ${f.name}`); skip++; continue }
  const key = `${SEASON}-${ep}`
  if (have.has(key)) { console.log(`  ↷ E${ep} 已存在，跳过`); skip++; continue }

  const ext = f.name.match(VIDEO_RE)[0].toLowerCase()
  const finalName = canonicalName(SEASON, ep, ext, f.name)

  if (DRY) { console.log(`  + 将入库 E${ep} → ${finalName}`); ok++; continue }

  const t0 = Date.now()
  // 目标目录必须先存在：不存在时 CpMovePath 报的是 "Insufficient permissions"，极易误判
  const mk = await nas.ensureDir(MEDIA)
  if (!mk.ok) { console.log(`  ❌ E${ep} 建目录失败: ${mk.error}`); fail++; continue }

  const r1 = MOVE ? await nas.move(`${SRC}/${f.name}`, MEDIA) : await nas.copy(`${SRC}/${f.name}`, MEDIA)
  if (!r1.ok) { console.log(`  ❌ E${ep} ${MOVE ? '移动' : '复制'}失败: ${r1.error}`); fail++; continue }

  // 校验：目标文件真的出现了，且字节数一致
  const landed = (await nas.ls(MEDIA)).find((x) => x.name === f.name)
  if (!landed) { console.log(`  ❌ E${ep} 复制后目标文件不存在（${f.name}）`); fail++; continue }
  if (Number(landed.size) !== Number(f.size)) {
    console.log(`  ❌ E${ep} 字节数不一致（源 ${f.size} vs 目标 ${landed.size}）`)
    fail++
    continue
  }

  const r2 = await nas.rename(MEDIA, f.name, finalName)
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  if (!r2.ok) {
    console.log(`  ⚠️ E${ep} 已复制但改名失败: ${r2.error}（留在原名 ${f.name}）`)
    fail++
    continue
  }
  have.set(key, { dir: MEDIA, name: finalName, size: Number(f.size), season: SEASON, ep })
  ok++
  console.log(`  ✅ E${ep} → ${finalName}  (${secs}s)`)
}

console.log(`\n完成：入库 ${ok}，改名 ${renamed}，跳过 ${skip}，失败 ${fail}`)
if (DRY) console.log('(dry-run：去掉 --dry-run 才会真正执行)')
if (fail) process.exit(1)
