/**
 * 从 TMDB 抓某季的「已播出集数」，作为补集的权威基准。
 *
 * 用法：
 *   node tmdb_season.mjs <tmdbId> <seasonNumber> [--json]
 * 输出：
 *   总集数 / 已播出集数 / 已播出的集号列表 / 未播出集号
 *
 * 说明：TMDB 页面用中文 locale，日期形如 "2025 年 08 月 08 日"。
 * 只依赖公开页面，不需要 API key。
 */
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const id = argv[0]
const season = argv[1]
const asJson = argv.includes('--json')
if (!id || !season) {
  console.error('用法: node tmdb_season.mjs <tmdbId> <seasonNumber> [--json]')
  process.exit(1)
}

const url = `https://www.themoviedb.org/tv/${id}/season/${season}`
// 直接用 curl：TMDB 对 Node fetch 的默认头会返回 403
let html = ''
try {
  html = execFileSync('curl', [
    '-sSL', '--max-time', '30',
    '-H', 'Accept-Language: zh-CN,zh;q=0.9',
    '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    url,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
} catch (e) {
  console.error(`抓取失败：${e.message}`)
  process.exit(1)
}
if (!html || html.length < 2000) {
  console.error('TMDB 返回内容过短，可能被拦截或该季不存在')
  process.exit(1)
}

// 集号：data-episode-number 会出现多次（列表 + 锚点），去重
const numbers = [...new Set([...html.matchAll(/data-episode-number="(\d+)"/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
// 日期：按出现顺序，与集号一一对应
const dates = [...html.matchAll(/(\d{4}) 年 (\d{2}) 月 (\d{2}) 日/g)].map((m) => `${m[1]}-${m[2]}-${m[3]}`)

if (!numbers.length) {
  console.error('没有解析到任何集号：页面结构可能变了，或该季不存在')
  process.exit(1)
}

const today = new Date().toISOString().slice(0, 10)
const aired = []
const upcoming = []
numbers.forEach((n, i) => {
  const d = dates[i] || ''
  if (d && d > today) upcoming.push({ episode: n, airDate: d })
  else aired.push({ episode: n, airDate: d })
})

const result = {
  tmdbId: id,
  season: Number(season),
  total: numbers.length,
  airedCount: aired.length,
  aired: aired.map((x) => x.episode),
  upcoming: upcoming.map((x) => x.episode),
  lastAired: aired.length ? aired[aired.length - 1] : null,
  nextUpcoming: upcoming.length ? upcoming[0] : null,
  parsedDates: dates.length,
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`TMDB ${id} 第 ${season} 季：共 ${result.total} 集，已播出 ${result.airedCount} 集`)
  if (result.lastAired) console.log(`  最新已播出：E${result.lastAired.episode}（${result.lastAired.airDate}）`)
  if (result.nextUpcoming) console.log(`  下一集未播：E${result.nextUpcoming.episode}（${result.nextUpcoming.airDate}）`)
  if (result.parsedDates !== result.total) console.log(`  ⚠️ 只解析到 ${result.parsedDates}/${result.total} 个日期，按期数判断可能有偏差`)
}
