/**
 * 多源评分：给定关键词和需要补的集号，横向比较多个分享源。
 *
 * 评分维度（都是转存前就能拿到的信号）：
 *   1. 覆盖度   —— 能提供多少个需要的集（权重最高）
 *   2. 每集体积 —— 码率代理，4GB/集 和 1GB/集 是本质差别
 *   3. 分辨率   —— 文件名里的 2160p / 4k / 1080p
 *   4. HDR/编码 —— HDR10、HEVC/H265 加分
 *   5. 时效     —— 搜索结果里的更新时间
 */

import { episodeOf, qualityOf, parseEpisodes } from './episodes.js'

// 兼容旧调用方：这些解析函数原本定义在本文件里
export { episodeOf, qualityOf, parseEpisodes }

const GB = (n) => Number(n) / 1024 ** 3

/** 从一个分享里构建 集号 → 文件 的映射（必要时钻入子目录）。 */
export async function collectEpisodes(baidu, share, needSet) {
  let files = share.files || []
  let subdirUsed = null

  // 整季打包：根层没有视频文件（只有季目录/海报等）→ 挑一个子目录下钻
  const hasVideo = files.some((f) => !f.isDir && /\.(mkv|mp4|avi|ts|m4v|mov)$/i.test(f.name))
  if (!hasVideo && files.some((f) => f.isDir)) {
    const subs = share.subdirs || files.map((f) => f.name)
    let best = null
    for (const sub of subs) {
      try {
        const inner = await baidu.shareInfo(share.url, share.pwd, sub)
        const vids = (inner.files || []).filter((f) => !f.isDir)
        const hit = vids.filter((f) => needSet.has(episodeOf(f.name))).length
        if (!best || hit > best.hit) best = { sub, files: inner.files, hit }
      } catch { /* 忽略无法下钻的子目录 */ }
    }
    if (best) { files = best.files; subdirUsed = best.sub }
  }

  const map = new Map()
  for (const f of files) {
    if (f.isDir) continue
    const e = episodeOf(f.name)
    if (e == null) continue
    const prev = map.get(e)
    // 同一集多份时留体积大的
    if (!prev || (f.size || 0) > (prev.size || 0)) map.set(e, f)
  }
  return { map, subdirUsed }
}

/**
 * 横向评分。返回按推荐度降序的数组。
 * @param {object} params
 * @param {object} params.pansou  PansouClient
 * @param {object} params.baidu   BaiduClient
 * @param {string} params.keyword 搜索词
 * @param {number[]} params.need  需要补的集号
 * @param {number} [params.limit] 最多评估多少个源
 */
export async function rankSources({ pansou, baidu, keyword, need, limit = 8 }) {
  const needSet = new Set(need)
  const results = await pansou.search(keyword, { limit })
  const rows = []

  for (const r of results) {
    const row = {
      title: r.title, url: r.url, pwd: r.pwd, datetime: r.datetime,
      coverage: 0, covered: [], missing: [], subdir: null,
      avgSizeGB: 0, uhdRatio: 0, hdrRatio: 0, score: 0, error: null,
    }
    try {
      const share = await baidu.shareInfo(r.url, r.pwd)
      share.url = r.url; share.pwd = r.pwd
      const { map, subdirUsed } = await collectEpisodes(baidu, share, needSet)
      row.subdir = subdirUsed
      const covered = need.filter((e) => map.has(e))
      row.covered = covered
      row.missing = need.filter((e) => !map.has(e))
      row.coverage = covered.length

      if (covered.length) {
        const files = covered.map((e) => map.get(e))
        row.avgSizeGB = files.reduce((s, f) => s + GB(f.size || 0), 0) / files.length
        const q = files.map((f) => qualityOf(f.name))
        row.uhdRatio = q.filter((x) => x.uhd).length / q.length
        row.hdrRatio = q.filter((x) => x.hdr).length / q.length
        row.sample = files[0].name
      }

      // 评分：覆盖度为主，画质为辅
      const coverageScore = need.length ? (covered.length / need.length) * 100 : 0
      const sizeScore = Math.min(row.avgSizeGB / 4, 1.5) * 20      // 4GB/集 记满额
      const uhdScore = row.uhdRatio * 10
      const hdrScore = row.hdrRatio * 5
      row.score = Math.round(coverageScore + sizeScore + uhdScore + hdrScore)
    } catch (e) {
      row.error = e.message
    }
    rows.push(row)
  }

  rows.sort((a, b) => b.score - a.score)
  return rows
}
