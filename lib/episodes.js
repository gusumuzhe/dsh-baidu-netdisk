/**
 * 集号 / 画质解析 —— 全插件唯一实现。
 *
 * 单独成模块的理由：index.js、sources.js、copy_in.mjs 原本各写一份，
 * 改一处漏两处；集中后可以单测，也能被别处直接复用。
 */

/** 看起来像年份/分辨率/码率的数字，不应被当成集号 */
const DECOY = new Set(['2160', '1080', '720', '576', '480'])

/**
 * 是否是「像年份」的数字。19xx/20xx 一律当年份：
 * 集号极少超过 1000，而「沧元图 2023 2160p.mkv」这类命名很常见。
 * @param {string} digits 纯数字串
 */
const looksLikeYear = (digits) => {
  const n = Number(digits)
  return Number.isFinite(n) && n >= 1900 && n <= 2100
}

/** 该数字是否可用作集号（排除分辨率与年份）。 */
const usable = (digits) => !DECOY.has(digits) && !looksLikeYear(digits)

/**
 * 从文件名解析集号。按可靠性从高到低尝试：
 *   S01E005 / S01E05 / S01.E05 / S01 EP05
 *   第5集 / 第5话 / 第5話
 *   EP05 / E05（独立出现）
 *   92.mkv / 05v2 - 标题 / [05]
 */
export function episodeOf(name) {
  const s = String(name || '').trim()
  if (!s) return null

  let m = s.match(/S\d{1,2}[\s._-]*E(?:P)?[\s._-]*(\d{1,4})/i)
  if (m) return Number(m[1])

  m = s.match(/第\s*(\d{1,4})\s*[集话話]/)
  if (m) return Number(m[1])

  m = s.match(/(?:^|[\s._\-[(])(?:EP|E)[\s._-]*(\d{1,4})(?!\d)/i)
  if (m && usable(m[1])) return Number(m[1])

  m = s.match(/^(\d{1,4})(?:v\d+)?[\s._\-\]]/)
  if (m && usable(m[1]) && !/^\d{3,4}p/i.test(s)) return Number(m[1])

  m = s.match(/^\[?(\d{1,4})(?:v\d+)?\]?$/)
  if (m && usable(m[1])) return Number(m[1])

  // 剧名在前、集号在后：斗破苍穹 201 4K.mp4 / 沧元图 92 2160p.mkv
  m = s.match(/(?:^|[\s._\-[\]])(\d{1,4})(?:v\d+)?(?=[\s._\-]*(?:4k|8k|2160p|1080p|720p|hdr|hq|uhd|hevc|x265|h\.?264|h\.?265|web|blu-?ray|\.(?:mkv|mp4|avi|ts|m4v|mov|flv|wmv|rmvb)))/i)
  if (m && usable(m[1])) return Number(m[1])

  return null
}

/** 从文件名提取画质信号（不判断好坏，只给布尔标记，由调用方加权） */
export function qualityOf(name) {
  const s = String(name || '').toLowerCase()
  return {
    uhd: /2160p|\b4k\b/.test(s),
    fhd: /1080p/.test(s),
    hd: /720p/.test(s),
    hdr: /hdr10\+?|hdr|dolby.?vision|\bdovi\b/.test(s),
    hevc: /hevc|h\.?265|x265/.test(s),
  }
}

/** 解析 "1-29,52" 这类区间写法 → 升序集号数组 */
export function parseEpisodes(spec) {
  const out = new Set()
  for (const part of String(spec || '').split(/[,，、\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-~到]\s*(\d+)$/)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i)
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part))
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** 集号集合的缺口 / 覆盖统计，补集流程常用 */
export function diffEpisodes(have, want) {
  const haveSet = new Set(have)
  const wantSet = [...new Set(want)].sort((a, b) => a - b)
  return {
    covered: wantSet.filter((e) => haveSet.has(e)),
    missing: wantSet.filter((e) => !haveSet.has(e)),
  }
}
