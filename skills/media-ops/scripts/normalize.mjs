/**
 * 媒体库命名归一化（批量版）。
 * 规则：<剧名> (<年份>)/[Season NN/]<剧名> S<SS>E<EEE>[ [画质]].<ext>
 *
 * 三级开关（默认最保守）：
 *   无参数         dry-run，只打印计划
 *   --apply        执行改名（可逆），重复文件只列出、不删
 *   --apply --confirm  连重复文件一起删（进回收站）
 *
 * 删除闸门（对应 SKILL.md 第 10 条铁律）：
 *   - 必须显式 --confirm，且删除前逐条打印完整路径
 *   - 集号必须"可信"：用 lib/episodes.js 的 episodeOf（带年份/分辨率黑名单），
 *     再叠加一层合理性检查，解析不出或像年份的一律不参与去重
 *   - 只有「同季同集、且保留的那份严格更大」才删小的
 *
 * 用法：
 *   node normalize.mjs [--apply] [--confirm] [--root <媒体根>] [--show <剧名>]
 */
import { episodeOf, qualityOf } from '../../../lib/episodes.js'
import { createNas, VIDEO_RE } from '../../../lib/nas.js'
import { readRegistry, registryPath, LIBRARY_ROOT } from '../../../lib/shows.js'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const APPLY = argv.includes('--apply')
const CONFIRM = argv.includes('--confirm')
const ROOT = arg('--root', LIBRARY_ROOT)
const ONLY = arg('--show', '')

if (CONFIRM && !APPLY) {
  console.error('--confirm 必须和 --apply 一起用（单独 --confirm 不会做任何事）')
  process.exit(1)
}

let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const pad = (n, w) => String(n).padStart(w, '0')

/** 画质标签：复用 episodes.js 的布尔信号，避免两套正则 */
const qualityLabel = (name) => {
  const q = qualityOf(name)
  if (q.uhd) return '2160p'
  if (q.fhd) return '1080p'
  if (q.hd) return '720p'
  return ''
}

/**
 * 集号是否可信。episodeOf 已经过滤了 2160/1080/2024-2027 这类，
 * 但 19xx/20xx 的年份仍可能漏网（如「沧元图 2023 2160p.mkv」→ 2023）。
 * 这里再挡一层：年份区间、以及大得不像集号的数字都不参与去重。
 */
const plausibleEpisode = (n) => {
  if (n == null || !Number.isFinite(n)) return false
  if (n <= 0 || n > 3000) return false
  if (n >= 1900 && n <= 2100) return false
  return true
}

const seasonFromDirName = (n) => {
  const m = n.match(/S(\d{1,2})/i) || n.match(/Season\s*(\d{1,2})/i)
  return m ? Number(m[1]) : null
}

// 剧单来自共享登记表 shows.json（由 register.mjs --scan 自动维护），不再硬编码。
// 登记表里的 dir 已是 `<剧名> (<年份>)` 形式，layout 由磁盘结构推断。
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

const SHOWS = registry.shows.map((s) => ({
  dir: s.dir,
  title: s.title,
  year: s.year,
  layout: s.layout || 'flat',
  // 季号回退值，仅在「文件名和目录名都取不到季号」时使用。
  //   - 平铺剧（layout=flat）本身就是单季，回退到 1 无歧义
  //   - 多季剧一律回退到 null，让 collect 跳过该文件——
  //     早期用 seasons[0] 兜底，S6 里不带季号的文件会被误归到 S5，去重时可能删错
  season: (s.layout || 'flat') === 'flat'
    ? (s.seasons?.length === 1 ? s.seasons[0] : 1)
    : null,
}))

const targets = ONLY ? SHOWS.filter((s) => s.dir === ONLY || s.title === ONLY) : SHOWS
if (!targets.length) {
  console.error(`没有匹配的剧：${ONLY}。可用：${SHOWS.map((s) => s.title).join(', ')}`)
  process.exit(1)
}

console.log(APPLY
  ? (CONFIRM ? '模式：改名 + 删除重复（进回收站）\n' : '模式：只改名，重复文件仅列出（加 --confirm 才删）\n')
  : '模式：dry-run（只看不改，加 --apply 执行）\n')

let totalRenamed = 0
let totalDeleted = 0
let totalKeptDup = 0

for (const show of targets) {
  // 目录可能还是旧名（沧元图），也可能已经归一化过（沧元图 (2023)），两种都认
  const normalized = `${show.title} (${show.year})`
  const candidates = show.dir === normalized ? [show.dir] : [normalized, show.dir]
  let base = ''
  let entries = []
  for (const name of candidates) {
    const rows = await nas.ls(`${ROOT}/${name}`)
    if (rows.length) { base = `${ROOT}/${name}`; entries = rows; break }
  }
  if (!entries.length) {
    console.log(`\n## ${show.dir} —— 目录为空或不存在，跳过`)
    continue
  }

  const items = []   // { dir, name, size, ep, season }
  const skipped = [] // 集号不可信，不参与去重

  const collect = async (dir, seasonHint) => {
    for (const f of await nas.ls(dir)) {
      if (!f.ext || !VIDEO_RE.test(f.name)) continue
      const e = episodeOf(f.name)
      if (!plausibleEpisode(e)) { skipped.push({ dir, name: f.name, ep: e }); continue }
      const s = String(f.name).match(/S(\d{1,2})\s*E\d/i)?.[1]
      // 季号：文件名里的 S05 优先，其次目录名 Season 05，最后才用 seasonHint。
      // 多季剧若三者都取不到，宁可跳过也不猜——猜错会在去重时删掉另一季的集。
      const season = s ? Number(s) : (seasonHint ?? null)
      if (season == null) {
        skipped.push({ dir, name: f.name, ep: e, reason: '多季剧但取不到季号' })
        continue
      }
      items.push({ dir, name: f.name, size: Number(f.size) || 0, ep: e, season })
    }
  }

  if (show.layout === 'flat') {
    await collect(base, show.season)
  } else if (show.layout === 'seasonDir') {
    for (const s of entries.filter((x) => !x.ext)) await collect(`${base}/${s.name}`, seasonFromDirName(s.name))
  } else if (show.layout === 'arcDirs') {
    for (const s of entries.filter((x) => !x.ext)) await collect(`${base}/${s.name}`, show.season)
  }

  // 按「季-集」分组，组内按体积降序；第一名保留，其余是候选删除
  const groups = new Map()
  for (const it of items) {
    const k = `${it.season}-${it.ep}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(it)
  }

  const keep = []
  const drop = []
  for (const [, group] of groups) {
    group.sort((a, b) => b.size - a.size)
    keep.push(group[0])
    for (const dup of group.slice(1)) {
      // 只有严格更小才删；体积相同说明可能是同一文件的两份，保留不动更安全
      if (dup.size < group[0].size) drop.push({ ...dup, kept: group[0] })
      else skipped.push({ dir: dup.dir, name: dup.name, ep: dup.ep, reason: '与保留项体积相同' })
    }
  }
  keep.sort((a, b) => a.season - b.season || a.ep - b.ep)

  console.log(`\n## ${show.dir} → ${show.title} (${show.year})   保留 ${keep.length}，待删重复 ${drop.length}，跳过 ${skipped.length}`)

  for (const it of keep.slice(0, 3)) {
    const q = qualityLabel(it.name)
    const ext = it.name.match(VIDEO_RE)[0].toLowerCase()
    console.log(`   ${it.name}\n      → ${show.title} S${pad(it.season, 2)}E${pad(it.ep, 3)}${q ? ` [${q}]` : ''}${ext}`)
  }
  if (keep.length > 3) console.log(`   ... 还有 ${keep.length - 3} 个`)

  for (const it of drop) {
    console.log(`   🗑 重复: ${it.dir}/${it.name} (${(it.size / 1024 ** 3).toFixed(2)}G)`)
    console.log(`      保留: ${it.kept.name} (${(it.kept.size / 1024 ** 3).toFixed(2)}G)`)
  }
  for (const it of skipped) {
    console.log(`   ⏸ 跳过（集号不可信${it.reason ? `，${it.reason}` : `，解析为 ${it.ep ?? 'null'}`}）: ${it.name}`)
  }

  if (!APPLY) continue

  // 1) 改名（可逆）
  for (const it of keep) {
    const q = qualityLabel(it.name)
    const ext = it.name.match(VIDEO_RE)[0].toLowerCase()
    const newName = `${show.title} S${pad(it.season, 2)}E${pad(it.ep, 3)}${q ? ` [${q}]` : ''}${ext}`
    if (newName === it.name) continue
    const r = await nas.rename(it.dir, it.name, newName)
    if (!r.ok) console.log(`   ❌ 改名失败 ${it.name}: ${r.error}`)
    else { totalRenamed++; console.log(`   ✅ ${it.name} → ${newName}`) }
  }

  // 2) 删重复（不可逆，需 --confirm）
  if (!CONFIRM) {
    totalKeptDup += drop.length
    if (drop.length) console.log(`   ⏸ ${drop.length} 个重复未删除（加 --confirm 才删）`)
    continue
  }
  for (const it of drop) {
    const full = `${it.dir}/${it.name}`
    const r = await nas.del(full)
    if (!r.ok) console.log(`   ❌ 删除失败 ${full}: ${r.error}`)
    else { totalDeleted++; console.log(`   ✅ 已删除 ${full}`) }
  }

  // 3) 子目录改名为 Season NN
  if (show.layout === 'seasonDir') {
    for (const s of entries.filter((x) => !x.ext)) {
      const n = seasonFromDirName(s.name)
      if (n && s.name !== `Season ${pad(n, 2)}`) {
        const r = await nas.rename(base, s.name, `Season ${pad(n, 2)}`)
        if (!r.ok) console.log(`   ❌ 目录改名失败 ${s.name}: ${r.error}`)
        else console.log(`   ✅ 目录 ${s.name} → Season ${pad(n, 2)}`)
      }
    }
  }
  const targetDir = `${show.title} (${show.year})`
  const currentDir = base.slice(ROOT.length + 1)
  if (currentDir !== targetDir) {
    const r = await nas.rename(ROOT, currentDir, targetDir)
    if (!r.ok) console.log(`   ❌ 剧目录改名失败 ${currentDir}: ${r.error}`)
    else console.log(`   ✅ 剧目录 ${currentDir} → ${targetDir}`)
  }
}

console.log('')
if (!APPLY) console.log('(dry-run：加 --apply 执行改名；再加 --confirm 才会删重复)')
else console.log(`完成：改名 ${totalRenamed}，删除 ${totalDeleted}${totalKeptDup ? `，未删重复 ${totalKeptDup}（缺 --confirm）` : ''}`)
