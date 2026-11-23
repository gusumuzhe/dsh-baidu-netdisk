/**
 * 媒体库的「剧集登记表」——全插件唯一的一份。
 *
 * 为什么要有它：`normalize.mjs` 和 `write_nfos.mjs` 原本各有一份硬编码的
 * SHOWS 列表，加剧要改两处代码，而且两份容易不同步（实测已经出现过：
 * normalize 里没有诛仙，write_nfos 里有）。
 *
 * 设计原则：**能从磁盘推断的，就不要写进配置**。
 *   - title / year  ← 目录名 `<剧名> (<年份>)` 直接解析
 *   - 布局（平铺 / Season NN）← 看目录里有没有 Season 子目录
 *   - 季号          ← 从 Season 目录名或文件名里的 S04 解析
 * 只有**推断不出来的**才需要登记：
 *   - tmdbId：目录名里没有，但一旦写过 tvshow.nfo 就能读回来
 *   - layout 覆盖：极少数剧的目录结构不规整（如按「篇章」分目录）
 *
 * 所以新增一部剧的常规流程是：
 *   1. 把剧集放进 `/volume1/影视/动漫/<剧名> (<年份>)/`
 *   2. 跑 `node scripts/register.mjs --scan` —— 自动发现新目录并登记
 *   3. 跑 `node scripts/write_nfos.mjs` —— 补 NFO（tmdbId 需先填）
 * 只有 tmdbId 必须人工确认一次（撞名风险，见 SKILL.md 第 8 条）。
 *
 * 数据存放位置见下方 registryPath()：**不进仓库、不进 npm 包**。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileDir } from './profile.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 登记表位置解析。
 *
 * 这是**个人数据**，不是代码：里面是「我有哪些剧、各自的 TMDB id」。
 * 早期版本把它放在插件仓库里（skills/media-ops/shows.json），后果是
 * 它会随 npm 包和公开 GitHub 一起分发——别人装了这个包，一开始就带着
 * 我的剧单，他自己的剧再追加进来，两份数据混在一起。
 *
 * 所以改成放在 DSH profile 的持久目录下（与插件代码分离）：
 *   1. --registry <路径>        显式指定
 *   2. $DSH_MEDIA_REGISTRY      环境变量
 *   3. <profileDir>/media-shows.json   默认
 *
 * 仓库里只保留 shows.example.json 作为格式示例，真实数据被 .gitignore 忽略。
 */
export function registryPath(explicit) {
  if (explicit) return explicit
  if (process.env.DSH_MEDIA_REGISTRY) return process.env.DSH_MEDIA_REGISTRY
  return join(profileDir(), 'media-shows.json')
}

/** 仓库内的格式示例（只读，供参考/初始化）。 */
export const EXAMPLE_REGISTRY_PATH = join(HERE, '..', 'skills', 'media-ops', 'shows.example.json')

/** 媒体库根目录。 */
export const LIBRARY_ROOT = '/volume1/影视/动漫'

/**
 * 目录名 → { title, year }。解析不出返回 null。
 *
 * 同时接受半角 `(2022)` 与全角 `（2022）`——中文输入法下全角括号很常见，
 * 早期只认半角，导致这类目录被静默跳过、永远登记不上。
 */
export function parseShowDir(name) {
  const m = String(name || '').trim().match(/^(.+?)\s*[(（](\d{4})[)）]$/)
  if (!m) return null
  return { title: m[1].trim(), year: Number(m[2]) }
}

/** 从 NFO 文本里读 tmdbId。 */
export function tmdbIdFromNfo(text) {
  const m = String(text || '').match(/<uniqueid[^>]*type\s*=\s*["']tmdb["'][^>]*>\s*(\d+)\s*<\/uniqueid>/i)
  return m ? Number(m[1]) : null
}

/** 生成 NFO 内容。title/year/id 都做 XML 转义，避免剧名里的 & < > 破坏 XML。 */
export function nfoXml({ title, year, tmdbId }) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>${esc(title)}</title>
  <year>${esc(year)}</year>
  <uniqueid type="tmdb" default="true">${esc(tmdbId)}</uniqueid>
</tvshow>
`
}

/**
 * 读登记表。文件不存在时返回空表（不报错，便于首次使用）。
 * 传了 path 就用 path；不传则用 registryPath() 的解析结果。
 */
export function readRegistry(path) {
  const p = path || registryPath()
  if (!existsSync(p)) return { shows: [] }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return { shows: Array.isArray(raw.shows) ? raw.shows : [] }
  } catch (e) {
    throw new Error(`登记表解析失败：${p}\n${e.message}`)
  }
}

/**
 * 写登记表（按 dir 排序，保证 diff 稳定）。
 *
 * 保留文件里已有的顶层元数据（`_comment` / `_fields` 等）——早期实现只写
 * `{ shows }`，会把用户手写的说明字段冲掉。
 */
export function writeRegistry(reg, path) {
  const p = path || registryPath()
  const shows = [...(reg.shows || [])].sort((a, b) => a.dir.localeCompare(b.dir, 'zh'))

  // 读回已有顶层字段（除 shows 外），避免覆盖掉说明性元数据
  let extra = {}
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const { shows: _ignored, ...rest } = raw
        extra = rest
      }
    } catch {
      // 旧文件损坏时忽略，直接覆盖写
    }
  }

  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ ...extra, shows }, null, 2) + '\n', 'utf8')
  return { shows }
}

/**
 * 从磁盘扫描媒体库，合并进登记表。
 *
 * 只做「发现 + 补全」，默认**不删除**已有登记（避免误删人工填的 tmdbId）。
 * 但目录改名/删除后会留下「幽灵条目」，所以提供 `prune` 选项显式清理。
 *
 * 字段归属：
 *   - 磁盘能推断的（title / year / layout / seasons）→ 以磁盘为准
 *   - 人工填的（tmdbId）→ 以登记表为准，磁盘读不到时才回填
 *   - 其它自定义字段（如 note）→ 原样保留
 *
 * 例外：登记项里显式写了 `layoutLocked: true` 时，layout 以登记表为准。
 * 用于目录结构不规整、磁盘推断会判错的剧（如按「篇章」分目录）。
 *
 * @param {object} opts
 * @param {string} opts.root 媒体库根目录
 * @param {object} opts.registry 现有登记表
 * @param {boolean} opts.prune 为 true 时移除磁盘上已不存在的条目
 * @returns {{shows: object[], added: object[], updated: object[], removed: object[], scanned: number}}
 *   `scanned` 是磁盘上实际扫到的剧目录数——调用方据此区分「真的没变化」和「NAS 不可达」。
 */
export async function scanLibrary(nas, { root = LIBRARY_ROOT, registry = { shows: [] }, prune = false } = {}) {
  const byDir = new Map(registry.shows.map((s) => [s.dir, { ...s }]))
  const added = []
  const updated = []
  const removed = []
  const seenDirs = new Set()

  const tops = (await nas.ls(root)).filter((x) => !x.ext)
  for (const d of tops) {
    const parsed = parseShowDir(d.name)
    if (!parsed) continue // 不符合 <剧名> (<年份>) 的目录不登记
    seenDirs.add(d.name)

    const files = await nas.ls(`${root}/${d.name}`)
    const seasonDirs = files.filter((f) => !f.ext && /^Season\s*\d+$/i.test(f.name)).map((f) => f.name)

    // 布局：有 Season 子目录 → seasonDir；否则平铺
    const inferredLayout = seasonDirs.length ? 'seasonDir' : 'flat'

    const prev = byDir.get(d.name)

    // tmdbId：登记表已有就用，否则从 NFO 读
    let tmdbId = prev?.tmdbId ?? null
    if (!tmdbId) {
      const nfo = await nas.readFile(`${root}/${d.name}/tvshow.nfo`)
      if (nfo.ok) tmdbId = tmdbIdFromNfo(nfo.text)
    }

    const next = {
      ...(prev || {}),          // 保留自定义字段（note 等）
      dir: d.name,
      title: parsed.title,
      year: parsed.year,
      tmdbId,
      // layoutLocked 时尊重人工设定，否则以磁盘为准
      layout: prev?.layoutLocked ? prev.layout : inferredLayout,
      ...(seasonDirs.length
        ? { seasons: seasonDirs.map((s) => Number(s.match(/\d+/)[0])).sort((a, b) => a - b) }
        : { seasons: undefined }),
    }
    if (next.seasons === undefined) delete next.seasons

    if (!prev) {
      byDir.set(d.name, next)
      added.push(next)
    } else if (JSON.stringify(next) !== JSON.stringify(prev)) {
      byDir.set(d.name, next)
      updated.push(next)
    }
  }

  // 幽灵条目：登记表里有、磁盘上已不存在
  if (prune) {
    for (const [dir, show] of byDir) {
      if (!seenDirs.has(dir)) {
        byDir.delete(dir)
        removed.push(show)
      }
    }
  }

  return { shows: [...byDir.values()], added, updated, removed, scanned: seenDirs.size }
}

/**
 * 取某部剧的登记项。支持按目录名或剧名匹配。
 *
 * 同名不同年份的剧（如「诛仙 (2022)」和「诛仙 (2024)」）按剧名匹配会有歧义，
 * 这时返回 `{ ambiguous: [...] }` 而不是随便挑一个——调用方应提示用户
 * 改用完整目录名，避免改错剧。
 *
 * @returns {object|null|{ambiguous: object[]}}
 */
export function findShow(registry, key) {
  const k = String(key || '').trim()
  if (!k) return null
  const exact = registry.shows.find((s) => s.dir === k)
  if (exact) return exact
  const byTitle = registry.shows.filter((s) => s.title === k)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) return { ambiguous: byTitle }
  return null
}

/** 判断 findShow 的结果是否是「有歧义」。 */
export const isAmbiguous = (r) => Boolean(r && Array.isArray(r.ambiguous))

/** 登记项 → 媒体目录绝对路径。 */
export function showDirPath(show, root = LIBRARY_ROOT) {
  return `${root}/${show.dir}`
}
