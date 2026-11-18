/**
 * 冒烟测试：只覆盖「不依赖 DSH 运行时」的纯逻辑与注册契约。
 *
 * 背景：lib/index.js 依赖 @deepseek-ai/* 包，在容器里无法直接 import，
 * 所以对它的检查是「静态断言工具名存在」；真正的注册契约由 skill.js 与
 * episodes.js 这些无外部依赖的模块来保证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { episodeOf, qualityOf, parseEpisodes, diffEpisodes } from '../lib/episodes.js'
import { parseShareRoot, BaiduClient, BaiduError } from '../lib/baidu.js'
import { skillProvider } from '../lib/skill.js'
import * as sources from '../lib/sources.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('episodeOf：常见命名都能认出集号', () => {
  const cases = [
    ['沧元图 S01E092 [2160p].mkv', 92],
    ['S01E5.mp4', 5],
    ['S01.E05.mkv', 5],
    ['S01 EP05.mp4', 5],
    ['Tomb of Fallen Gods S03E52 - 第 52 集 - 2160p.mkv', 52],
    ['第92集.mp4', 92],
    ['第5話.mkv', 5],
    ['EP05.mp4', 5],
    ['92.mkv', 92],
    ['05v2 - 标题.mp4', 5],
    ['[05].mp4', null],
  ]
  for (const [name, want] of cases) {
    assert.equal(episodeOf(name), want, `解析失败：${name}`)
  }
})

test('episodeOf：不把年份/分辨率当集号', () => {
  for (const name of ['2025.2160p.mkv', '2160p.mkv', '1920x1080.mp4', 'S01.2160p.mkv']) {
    const got = episodeOf(name)
    assert.ok(got === null || got <= 100 || got === 1, `${name} 误判为 ${got}`)
  }
  assert.equal(episodeOf('2025.2160p.mkv'), null)
  assert.equal(episodeOf('2160p.mkv'), null)
})

test('qualityOf：画质信号', () => {
  const q = qualityOf('永生 S05E014 [2160p].HDR10.HEVC.mp4')
  assert.equal(q.uhd, true)
  assert.equal(q.hdr, true)
  assert.equal(q.hevc, true)
  assert.equal(qualityOf('1080p.mp4').fhd, true)
  assert.equal(qualityOf('720p.mp4').hd, true)
})

test('parseEpisodes：区间与枚举', () => {
  assert.deepEqual(parseEpisodes('1-3,5'), [1, 2, 3, 5])
  assert.deepEqual(parseEpisodes('92-103').length, 12)
  assert.deepEqual(parseEpisodes(' 150，152 '), [150, 152])
  assert.deepEqual(parseEpisodes(''), [])
})

test('diffEpisodes：缺口计算', () => {
  const r = diffEpisodes([1, 2, 3, 5], [1, 2, 3, 4, 5])
  assert.deepEqual(r.covered, [1, 2, 3, 5])
  assert.deepEqual(r.missing, [4])
})

test('parseShareRoot：路径归一化为 sharelink0 前缀', () => {
  const html = 'xxx"path":"/sharelink1102156393439-1090385568457267/仙-34946494648","fs_id":1090385568457267,"server_filename":"仙-34946494648"yyy'
  const r = parseShareRoot(html)
  assert.equal(r.dir, '/sharelink0-1090385568457267/仙-34946494648')
  assert.equal(r.name, '仙-34946494648')
})

test('parseShareRoot：无 path 时用 fs_id + 文件名兜底', () => {
  const html = '"fs_id":196902462383877,"server_filename":"神墓 (2022)"'
  const r = parseShareRoot(html)
  assert.equal(r.dir, '/sharelink0-196902462383877/神墓 (2022)')
})

test('skill provider：满足 DSH 的候选契约', async () => {
  const [cand] = await skillProvider.list()
  assert.equal(typeof cand.name, 'string')
  assert.match(cand.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.ok(cand.description.length > 0)
  assert.equal(typeof cand.invocation.modelInvocable, 'boolean')
  assert.equal(typeof cand.invocation.userInvocable, 'boolean')
  assert.equal(cand.provider, skillProvider.name)
  assert.equal(typeof cand.rank, 'number')
  assert.ok(Number.isFinite(cand.rank))
  const detail = await skillProvider.get(cand)
  assert.ok(detail.content.includes('媒体库'), 'SKILL.md 内容应为操作手册')
  assert.ok(detail.content.length > 500)
})

test('sources：对外导出评分入口', () => {
  assert.equal(typeof sources.rankSources, 'function')
  assert.equal(typeof sources.collectEpisodes, 'function')
  assert.equal(typeof sources.episodeOf, 'function', '应重导出 episodes 模块的函数')
})

test('BaiduClient：参数边界与重试配置', () => {
  const c = new BaiduClient({ bduss: 'x', retries: 99 })
  assert.equal(c.configured, true)
  assert.equal(c.retries, 5, '重试次数上限应为 5')
  assert.equal(new BaiduClient({}).configured, false)
  const err = new BaiduError('boom', { errno: -6 })
  assert.equal(err.errno, -6)
  assert.equal(err.name, 'BaiduError')
})

test('index.js：声明的工具都存在（静态检查）', () => {
  const src = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
  for (const tool of [
    'baidu_whoami', 'baidu_quota', 'baidu_list', 'baidu_search',
    'baidu_share_info', 'baidu_transfer', 'pansou_search', 'baidu_rank_sources',
  ]) {
    assert.ok(src.includes(`name: '${tool}'`), `缺少工具定义：${tool}`)
  }
  // 安全红线：不该出现删除/移动/建分享的调用
  for (const forbidden of ['/api/filemanager?a=delete', 'create_share', 'share/create']) {
    assert.ok(!src.includes(forbidden), `出现危险调用：${forbidden}`)
  }
})
