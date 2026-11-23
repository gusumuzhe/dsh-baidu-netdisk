/**
 * 清理下载暂存区：只有当媒体库里存在「同集、同大小」的文件时，才删除暂存副本。
 *
 * 默认 dry-run，必须显式 --confirm 才真正删除（删除进回收站，可恢复）。
 *
 * 用法：
 *   node cleanup_staging.mjs --src <下载目录> --dst <媒体目录>
 *   node cleanup_staging.mjs --src <下载目录> --dst <媒体目录> --confirm
 *
 * 注意：--dst 传剧集根目录时，会递归一层 Season NN 子目录去找对应集，
 * 否则「根目录下没有视频文件」会让所有暂存文件都被判为「媒体库没有」而保留。
 */
import { episodeOf } from '../../../lib/episodes.js'
import { createNas, VIDEO_RE, isDownloading, gb } from '../../../lib/nas.js'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const SRC = arg('--src')
const DST = arg('--dst')
const CONFIRM = argv.includes('--confirm')
if (!SRC || !DST) {
  console.error('用法: --src <下载目录> --dst <媒体目录> [--confirm]')
  process.exit(1)
}

let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

/** 从路径里抠 Season 号：/x/Season 04 → 4 */
const seasonFromPath = (p) => {
  const m = String(p || '').match(/\/Season\s*(\d{1,2})\s*$/i)
  return m ? Number(m[1]) : null
}

/**
 * 收集媒体库里「季-集 → 文件」的映射，递归一层 Season 子目录。
 *
 * key 必须带季号：多季剧里 Season 05 和 Season 06 都可能有 E001，
 * 只用集号做 key 会把不同季的同集号混为一谈，可能导致误删。
 */
const collectLibrary = async (root) => {
  const byKey = new Map()
  const dirs = [root]
  for (const f of await nas.ls(root)) {
    if (!f.ext && /^Season\s*\d+$/i.test(f.name)) dirs.push(`${root}/${f.name}`)
  }
  for (const d of dirs) {
    const dirSeason = seasonFromPath(d)
    for (const f of await nas.ls(d)) {
      if (f.isDir || !f.ext || !VIDEO_RE.test(f.name)) continue
      const e = episodeOf(f.name)
      if (e == null) continue
      const nameSeason = Number(String(f.name).match(/S(\d{1,2})\s*E\d/i)?.[1]) || null
      const season = nameSeason ?? dirSeason ?? 1
      const key = `${season}-${e}`
      if (!byKey.has(key)) byKey.set(key, { ...f, dir: d, season, ep: e })
    }
  }
  return byKey
}

const byKey = await collectLibrary(DST)
// 暂存区不存在要报错：静默当成「0 个文件」会让人以为已经清干净了
const srcRes = await nas.lsEx(SRC)
if (!srcRes.ok) {
  console.error(`❌ 暂存目录不可读：${SRC}\n   ${srcRes.error}`)
  process.exit(1)
}
const staging = srcRes.files.filter((f) => f.ext && !isDownloading(f.name))

console.log(`暂存区 ${staging.length} 个文件 | 媒体库已识别 ${byKey.size} 集`)
console.log(CONFIRM ? '模式：真实删除（进回收站）\n' : '模式：dry-run（只看不改，加 --confirm 才执行）\n')

let del = 0; let kept = 0; let bytes = 0
for (const f of staging) {
  const e = episodeOf(f.name)
  // 暂存文件的季号：文件名里的 S05 优先，否则按唯一候选季匹配
  const nameSeason = Number(String(f.name).match(/S(\d{1,2})\s*E\d/i)?.[1]) || null
  let target = null
  if (e != null) {
    if (nameSeason != null) {
      target = byKey.get(`${nameSeason}-${e}`) || null
    } else {
      // 文件名没写季号：只有在媒体库里该集号唯一时才认，避免跨季误判
      const hits = [...byKey.values()].filter((x) => x.ep === e)
      target = hits.length === 1 ? hits[0] : null
    }
  }
  if (!target) {
    console.log(`  ⏸ 保留 ${f.name} —— 媒体库没有第 ${e ?? '?'} 集`)
    kept++
    continue
  }
  if (Number(target.size) !== Number(f.size)) {
    console.log(`  ⏸ 保留 ${f.name} —— 目标大小不一致（${gb(f.size)} vs ${gb(target.size)}）`)
    kept++
    continue
  }
  if (!CONFIRM) {
    console.log(`  🗑 将删除 ${f.name}（媒体库已有 ${target.name}，${gb(f.size)}）`)
    del++; bytes += Number(f.size)
    continue
  }
  const r = await nas.del(`${SRC}/${f.name}`)
  if (!r.ok) { console.log(`  ❌ 删除失败 ${f.name}: ${r.error}`); kept++ }
  else { console.log(`  ✅ 已删除 ${f.name}（${gb(f.size)}）`); del++; bytes += Number(f.size) }
}
console.log(`\n${CONFIRM ? '已删除' : '可删除'} ${del} 个，保留 ${kept} 个，释放 ${gb(bytes)}`)
