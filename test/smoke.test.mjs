/**
 * 冒烟测试：只覆盖「不依赖 DSH 运行时」的纯逻辑与注册契约。
 *
 * 背景：lib/index.js 依赖 @deepseek-ai/* 包，在容器里无法直接 import，
 * 所以对它的检查是「静态断言工具名存在」；真正的注册契约由 skill.js 与
 * episodes.js 这些无外部依赖的模块来保证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { episodeOf, qualityOf, parseEpisodes, diffEpisodes } from '../lib/episodes.js'
import { parseShareRoot, BaiduClient, BaiduError } from '../lib/baidu.js'
import { resolveInboxPath } from '../lib/transfer.js'
import { parseEntryConfig, splitEntries } from '../lib/profile.js'
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
    ['斗破苍穹 201 4K.mp4', 201],
    ['沧元图 92 2160p.mkv', 92],
    ['151 4K.mkv', 151],
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

test('episodeOf：19xx/20xx 一律当年份，不当集号', () => {
  // 这些曾经被解析成 E2023 / E2017，配合 normalize 的删除逻辑会误删
  for (const name of [
    '沧元图 2023 2160p.mkv',
    '仙逆 2023 4K.mp4',
    '斗破苍穹 2017 1080p.mp4',
    '2023.mkv', '2022.mkv', '2017.mp4', '2024.mkv', '2026.mkv',
  ]) {
    assert.equal(episodeOf(name), null, `${name} 不应解析出集号`)
  }
  // 真正的集号不受影响
  assert.equal(episodeOf('斗破苍穹 201 4K.mp4'), 201)
  assert.equal(episodeOf('沧元图 92 2160p.mkv'), 92)
  assert.equal(episodeOf('151 4K.mkv'), 151)
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

test('resolveInboxPath：拒绝路径穿越与绝对路径', () => {
  assert.equal(resolveInboxPath('/绿联下载', '沧元图'), '/绿联下载/沧元图')
  assert.equal(resolveInboxPath('/绿联下载', '第 3 季 - 2160p WEB-DL H265 AAC'), '/绿联下载/第 3 季 - 2160p WEB-DL H265 AAC')
  assert.equal(resolveInboxPath('/绿联下载', 'a/./b'), '/绿联下载/a/b')
  assert.equal(resolveInboxPath('/绿联下载', 'a//b'), '/绿联下载/a/b')
  // 名字里带 .. 但不是路径段，应当放行
  assert.equal(resolveInboxPath('/绿联下载', '..a'), '/绿联下载/..a')

  for (const bad of ['../影视/动漫/仙逆 (2023)', '..', 'a/../../b', '/etc/passwd', '.', '', '   ']) {
    assert.throws(() => resolveInboxPath('/绿联下载', bad), /已拒绝|不能为空/, `${bad} 应被拒绝`)
  }
  assert.throws(() => resolveInboxPath('', 'x'), /inboxRoot/)
  assert.throws(() => resolveInboxPath('/', 'x'), /inboxRoot/)
})

test('profile：按插件条目 id 取配置，不串到别的插件', () => {
  const patch = [
    '- id: dsh-ugreen-nas',
    '  name: dsh-ugreen-nas',
    '  config:',
    '    endpoint: https://nas:9443',
    '    timeoutMs: 15000',
    '- id: dsh-baidu-netdisk',
    '  name: dsh-baidu-netdisk',
    '  config:',
    '    bduss: abc',
    '    timeoutMs: 60000',
    '    inboxRoot: /绿联下载',
    '- id: web',
    '  name: "@deepseek-ai/dsh-web"',
    '  config:',
    '    searchProvider: commandcode',
  ].join('\n')

  assert.deepEqual(splitEntries(patch).map((e) => e.id), ['dsh-ugreen-nas', 'dsh-baidu-netdisk', 'web'])

  const bd = parseEntryConfig(patch, 'dsh-baidu-netdisk')
  assert.equal(bd.timeoutMs, '60000', '不能取到 NAS 的 15000')
  assert.equal(bd.bduss, 'abc')
  assert.equal(bd.inboxRoot, '/绿联下载')

  const nas = parseEntryConfig(patch, 'dsh-ugreen-nas')
  assert.equal(nas.timeoutMs, '15000')
  assert.equal(nas.endpoint, 'https://nas:9443')

  // 不存在的条目返回空对象，不抛
  assert.deepEqual(parseEntryConfig(patch, 'nope'), {})
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

test('scripts：在假 profile 下不崩（抓 ReferenceError 这类运行时错误）', () => {
  // 背景：copy_in.mjs 曾因漏了 `const media = ...` 在 HEAD 上必崩，
  // 而 CI 只跑 node --check，语法检查抓不到。这里真跑一遍。
  const dir = mkdtempSync(join(tmpdir(), 'bdn-test-'))
  const pkg = join(dir, 'node_modules', 'dsh-ugreen-nas', 'lib')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'protobuf.js'), 'export const encodeMessage = () => Buffer.alloc(0)\nexport const decodeMessage = () => ({})\n')
  writeFileSync(join(pkg, 'catalog.json'), '{}')
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: dsh-ugreen-nas',
    '  name: dsh-ugreen-nas',
    '  config:',
    '    endpoint: https://127.0.0.1:1',
    '    accessToken: fake',
    '- id: dsh-baidu-netdisk',
    '  name: dsh-baidu-netdisk',
    '  config:',
    '    bduss: fake',
    '    inboxRoot: /绿联下载',
  ].join('\n'))

  const scripts = [
    'ls.mjs', 'scan.mjs', 'normalize.mjs', 'copy_in.mjs', 'write_nfos.mjs',
    'create_file.mjs', 'wait_sync.mjs', 'cleanup_staging.mjs', 'pipeline.mjs', 'tmdb_season.mjs',
  ]
  for (const script of scripts) {
    const r = spawnSync(process.execPath, [join(ROOT, 'skills/media-ops/scripts', script)], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, DSH_PROFILE_DIR: dir },
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    assert.ok(
      !/ReferenceError|is not defined|Cannot read propert/.test(out),
      `${script} 运行时崩溃：\n${out.split('\n').slice(0, 6).join('\n')}`,
    )
  }
})
