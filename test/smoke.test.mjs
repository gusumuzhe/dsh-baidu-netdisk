/**
 * 冒烟测试：只覆盖「不依赖 DSH 运行时」的纯逻辑与注册契约。
 *
 * 背景：lib/index.js 依赖 @deepseek-ai/* 包，在容器里无法直接 import，
 * 所以对它的检查是「静态断言工具名存在」；真正的注册契约由 skill.js 与
 * episodes.js 这些无外部依赖的模块来保证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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

test('nas：模块导出与常量', async () => {
  const nas = await import('../lib/nas.js')
  assert.equal(typeof nas.createNas, 'function')
  assert.ok(nas.VIDEO_RE.test('a.mp4'))
  assert.ok(nas.VIDEO_RE.test('a.MKV'), '扩展名大小写不敏感')
  assert.ok(!nas.VIDEO_RE.test('a.nfo'))
  assert.ok(nas.isDownloading('S04E16.mp4.baiduyun.p.downloading'))
  assert.ok(!nas.isDownloading('S04E16.mp4'))
  assert.equal(nas.gb(1073741824), '1.00G')
})

test('nas：配置缺失时 createNas 抛可读错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bdn-nas-'))
  const prev = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  try {
    const { createNas } = await import('../lib/nas.js')
    await assert.rejects(() => createNas(), /未读到 NAS 配置/)
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
  }
})

test('nas：Rename 响应类型必须是 RenameResponse（不是 FileStatus）', () => {
  // 回归测试：写成 FileStatus 时解码不报错、静默得到 {}，
  // 于是「改名失败」被当成成功打印 ✅。这里静态断言类型表。
  const src = readFileSync(join(ROOT, 'lib/nas.js'), 'utf8')
  assert.ok(src.includes("'ugidl.filesystem.cli.RenameResponse'"), 'Rename 必须解 RenameResponse')
  assert.ok(!src.includes("'ugidl.filesystem.cli.FileStatus'"), '不应再出现 FileStatus')
  // receipt 状态校验必须在
  assert.ok(src.includes('RECEIPT_STATUS_DONE'), '必须校验 receipt.status')
})

test('nas：CpMovePath 的 type 语义（false=复制，true=移动）', () => {
  // 回归测试：早期 copy_in 用 type:true 当复制，实际是移动，把暂存区悄悄清空了
  const src = readFileSync(join(ROOT, 'lib/nas.js'), 'utf8')
  const copyFn = src.match(/const copy = async[\s\S]*?\n  \}/)?.[0] || ''
  const moveFn = src.match(/const move = async[\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(copyFn.includes('type: false'), 'copy 必须用 type:false')
  assert.ok(moveFn.includes('type: true'), 'move 必须用 type:true')
})

test('copy_in：不再把 ls 结果多剥一层 .data', () => {
  // 回归测试：cleanup_staging 曾写 x?.data?.data?.file_list，永远拿到空数组
  for (const f of ['copy_in.mjs', 'cleanup_staging.mjs', 'normalize.mjs', 'scan.mjs', 'wait_sync.mjs']) {
    const src = readFileSync(join(ROOT, 'skills/media-ops/scripts', f), 'utf8')
    assert.ok(!src.includes('.data?.data'), `${f} 不应出现 .data?.data`)
    assert.ok(!src.includes('file_list'), `${f} 不应自己解 file_list（交给 lib/nas.js）`)
  }
})

test('copy_in：支持 --dry-run / --episodes / --move', () => {
  const src = readFileSync(join(ROOT, 'skills/media-ops/scripts/copy_in.mjs'), 'utf8')
  for (const flag of ['--dry-run', '--episodes', '--move']) {
    assert.ok(src.includes(flag), `copy_in 应支持 ${flag}`)
  }
  // 必须自动建 Season 子目录
  assert.ok(src.includes('Season ${pad(SEASON, 2)}'), '应自动拼 Season NN')
  assert.ok(src.includes('ensureDir'), '复制前必须 ensureDir')
})

test('copy_in：季号从 --dst 的 Season 目录推断，且不误改别的季', () => {
  const src = readFileSync(join(ROOT, 'skills/media-ops/scripts/copy_in.mjs'), 'utf8')
  // 回归：早期用全局 SEASON 算期望文件名，不传 --season 时会把 Season 04 的
  // 16 集全部改名成 S01（破坏性）。现在 canonicalName 必须显式接收 season。
  assert.ok(/const canonicalName = \(season, ep, ext, srcName\)/.test(src),
    'canonicalName 必须显式接收 season 参数')
  assert.ok(src.includes('seasonFromPath'), '应从 --dst 路径推断季号')
  assert.ok(src.includes('season === SEASON'), '自愈改名必须限定目标季')
  assert.ok(src.includes('冲突'), '--season 与 --dst 冲突时应报错')
})

test('copy_in / cleanup_staging：源目录不可读时必须报错退出，不能静默 0 个', () => {
  for (const f of ['copy_in.mjs', 'cleanup_staging.mjs']) {
    const src = readFileSync(join(ROOT, 'skills/media-ops/scripts', f), 'utf8')
    assert.ok(src.includes('lsEx'), `${f} 应用 lsEx 检查目录可读性`)
    assert.ok(/不可读/.test(src), `${f} 目录不可读时应有明确报错`)
  }
})

test('cleanup_staging：按「季-集」匹配，避免跨季同集号误删', () => {
  const src = readFileSync(join(ROOT, 'skills/media-ops/scripts/cleanup_staging.mjs'), 'utf8')
  assert.ok(src.includes('seasonFromPath'), '应解析季号')
  assert.ok(/`\$\{season\}-\$\{e\}`/.test(src), 'key 必须是 季-集')
  assert.ok(src.includes('hits.length === 1'), '无季号时只有集号唯一才认')
})

test('nas：createFile 对已存在文件必须真正覆盖（CreateFile 是静默 no-op）', () => {
  // 回归：CreateFile 对已存在文件返回成功但什么都不做，
  // write_nfos 因此报告「✅ 成功」却从未更新过任何 NFO。
  const src = readFileSync(join(ROOT, 'lib/nas.js'), 'utf8')
  assert.ok(src.includes('writeFile'), '必须支持 WriteFile')
  assert.ok(src.includes('WRITE_FILE_MODE_OVERWRITE'), '已存在时应走覆盖模式')
  assert.ok(src.includes('overwritten'), '应区分「覆盖」与「新建」')
  // exists() 必须把 "Path already exists" 也算作存在
  assert.ok(/already exists/i.test(src), 'exists() 需识别文件路径的 already exists 错误')
})

test('nas：未知调用类型不应抛 TypeError', () => {
  const src = readFileSync(join(ROOT, 'lib/nas.js'), 'utf8')
  assert.ok(src.includes('未知的调用类型'), 'call() 应对未知 kind 返回错误而非崩溃')
})

test('write_nfos：幂等 + 回读校验 + dry-run', () => {
  const src = readFileSync(join(ROOT, 'skills/media-ops/scripts/write_nfos.mjs'), 'utf8')
  assert.ok(src.includes('--dry-run'), '应支持 dry-run')
  assert.ok(src.includes('--force'), '应支持强制重写')
  assert.ok(src.includes('sameNfo'), '应比对现有内容，已正确则跳过')
  assert.ok(src.includes('回读校验'), '写入后必须回读校验')
  // XML 转义已抽到 lib/shows.js 的 nfoXml，这里断言它被复用
  assert.ok(src.includes('nfoXml'), '应复用 lib/shows.js 的 nfoXml')
  assert.ok(src.includes('tmdbId'), '缺 tmdbId 时应跳过而非写入错误 NFO')
})

test('shows：目录名解析与 NFO 生成', async () => {
  const { parseShowDir, tmdbIdFromNfo, nfoXml } = await import('../lib/shows.js')
  assert.deepEqual(parseShowDir('诛仙 (2022)'), { title: '诛仙', year: 2022 })
  assert.deepEqual(parseShowDir('斗破苍穹 (2017)'), { title: '斗破苍穹', year: 2017 })
  assert.equal(parseShowDir('没有年份'), null)
  assert.equal(parseShowDir('Season 04'), null)

  assert.equal(tmdbIdFromNfo('<uniqueid type="tmdb" default="true">206484</uniqueid>'), 206484)
  assert.equal(tmdbIdFromNfo('<uniqueid type="imdb">tt123</uniqueid>'), null)
  assert.equal(tmdbIdFromNfo(''), null)

  const xml = nfoXml({ title: 'A&B <C>', year: 2022, tmdbId: 1 })
  assert.ok(xml.includes('A&amp;B &lt;C&gt;'), '特殊字符必须转义')
  assert.ok(xml.includes('<uniqueid type="tmdb" default="true">1</uniqueid>'))
})

test('shows：登记表读写往返', async () => {
  const { readRegistry, writeRegistry } = await import('../lib/shows.js')
  const dir = mkdtempSync(join(tmpdir(), 'bdn-reg-'))
  const p = join(dir, 'shows.json')
  assert.deepEqual(readRegistry(p), { shows: [] }, '文件不存在时返回空表')

  writeRegistry({ shows: [
    { dir: '乙 (2022)', title: '乙', year: 2022, tmdbId: 2, layout: 'flat' },
    { dir: '甲 (2021)', title: '甲', year: 2021, tmdbId: 1, layout: 'seasonDir' },
  ] }, p)
  const back = readRegistry(p)
  assert.equal(back.shows.length, 2)
  // 按 zh 拼音排序（甲 jiǎ < 乙 yǐ），保证 diff 稳定
  assert.equal(back.shows[0].dir, '甲 (2021)')
  assert.equal(back.shows[1].dir, '乙 (2022)')
})

test('shows：示例文件合法且字段完整', async () => {
  const { readRegistry, EXAMPLE_REGISTRY_PATH } = await import('../lib/shows.js')
  const reg = readRegistry(EXAMPLE_REGISTRY_PATH)
  assert.ok(reg.shows.length >= 2, '示例应含平铺与多季两种布局')
  for (const s of reg.shows) {
    assert.ok(s.dir && s.title && Number(s.year), `${s.dir} 字段不完整`)
    assert.match(s.dir, /^.+ \(\d{4}\)$/, `${s.dir} 目录名应为 <剧名> (<年份>)`)
    assert.ok(['flat', 'seasonDir'].includes(s.layout), `${s.dir} layout 非法`)
  }
})

test('shows：个人数据不进仓库、不进 npm 包', async () => {
  const { registryPath, EXAMPLE_REGISTRY_PATH } = await import('../lib/shows.js')
  const p = registryPath()
  // 默认落在 profile 目录，而不是插件仓库里
  assert.ok(!p.startsWith(ROOT), `登记表不应放在仓库内：${p}`)
  assert.ok(p.includes('.dsh') || process.env.DSH_MEDIA_REGISTRY, `应在 profile 目录：${p}`)
  // 仓库里只允许有示例文件
  assert.ok(EXAMPLE_REGISTRY_PATH.startsWith(ROOT), '示例文件应在仓库内')
  assert.ok(!existsSync(join(ROOT, 'skills/media-ops/shows.json')),
    '仓库内不应存在真实登记表 shows.json')
  // .gitignore 必须挡住真实数据
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  assert.ok(gi.includes('media-shows.json'), '.gitignore 应忽略 media-shows.json')
  assert.ok(gi.includes('skills/media-ops/shows.json'), '.gitignore 应忽略仓库内的 shows.json')
})

test('shows：registryPath 支持 --registry 与环境变量覆盖', async () => {
  const { registryPath } = await import('../lib/shows.js')
  assert.equal(registryPath('/tmp/x.json'), '/tmp/x.json', '显式路径优先')
  const prev = process.env.DSH_MEDIA_REGISTRY
  process.env.DSH_MEDIA_REGISTRY = '/tmp/env.json'
  try {
    assert.equal(registryPath(), '/tmp/env.json', '环境变量次之')
  } finally {
    if (prev === undefined) delete process.env.DSH_MEDIA_REGISTRY
    else process.env.DSH_MEDIA_REGISTRY = prev
  }
})

test('脚本不再硬编码剧单（改由 shows.json 驱动）', () => {
  // 回归：normalize 和 write_nfos 曾各有一份 SHOWS 硬编码列表，加剧要改两处代码
  for (const f of ['normalize.mjs', 'write_nfos.mjs']) {
    const src = readFileSync(join(ROOT, 'skills/media-ops/scripts', f), 'utf8')
    assert.ok(src.includes('readRegistry'), `${f} 应从登记表读剧单`)
    assert.ok(!/const SHOWS = \[\s*\{ dir:/.test(src), `${f} 不应再有硬编码剧单`)
  }
})

test('shows：parseShowDir 接受全角括号', async () => {
  const { parseShowDir } = await import('../lib/shows.js')
  // 中文输入法下全角括号很常见，早期只认半角会导致这类目录永远登记不上
  assert.deepEqual(parseShowDir('剧名 （2022）'), { title: '剧名', year: 2022 })
  assert.deepEqual(parseShowDir('剧名 (2022)'), { title: '剧名', year: 2022 })
  assert.deepEqual(parseShowDir('剧名（2022）'), { title: '剧名', year: 2022 })
})

test('shows：同名不同年份的剧按剧名匹配应报歧义', async () => {
  const { findShow, isAmbiguous } = await import('../lib/shows.js')
  const reg = { shows: [
    { dir: '诛仙 (2022)', title: '诛仙', year: 2022, tmdbId: 1 },
    { dir: '诛仙 (2024)', title: '诛仙', year: 2024, tmdbId: 2 },
  ] }
  const hit = findShow(reg, '诛仙')
  assert.ok(isAmbiguous(hit), '同名应返回歧义而非随便挑一个')
  assert.equal(hit.ambiguous.length, 2)
  // 完整目录名仍能精确命中
  assert.equal(findShow(reg, '诛仙 (2024)').tmdbId, 2)
  // 唯一剧名正常返回
  assert.equal(findShow({ shows: [{ dir: '甲 (2020)', title: '甲' }] }, '甲').dir, '甲 (2020)')
})

test('shows：scanLibrary 不覆盖人工 layout / 自定义字段', async () => {
  const { scanLibrary } = await import('../lib/shows.js')
  const fakeNas = {
    ls: async (p) => (p === '/root' ? [{ name: '测试剧 (2020)', ext: '' }] : [{ name: 'a.mp4', ext: 'mp4' }]),
    readFile: async () => ({ ok: false }),
  }
  // 磁盘上是 flat，但人工锁定为 seasonDir 并留了备注
  const r = await scanLibrary(fakeNas, { root: '/root', registry: { shows: [
    { dir: '测试剧 (2020)', title: '测试剧', year: 2020, tmdbId: 111, layout: 'seasonDir', layoutLocked: true, note: '人工' },
  ] } })
  assert.equal(r.shows[0].layout, 'seasonDir', 'layoutLocked 时应尊重人工设定')
  assert.equal(r.shows[0].note, '人工', '自定义字段应保留')
  assert.equal(r.shows[0].tmdbId, 111, 'tmdbId 应保留')

  // 未锁定则跟随磁盘
  const r2 = await scanLibrary(fakeNas, { root: '/root', registry: { shows: [
    { dir: '测试剧 (2020)', title: '测试剧', year: 2020, tmdbId: 111, layout: 'seasonDir' },
  ] } })
  assert.equal(r2.shows[0].layout, 'flat', '未锁定时以磁盘为准')
})

test('normalize：多季剧不把 seasons[0] 当全局季号', () => {
  // 回归：早期 season: s.seasons?.[0] ?? 1，S6 里不带季号的文件会被误归到 S5，
  // 去重时可能删掉另一季的集。
  const src = readFileSync(join(ROOT, 'skills/media-ops/scripts/normalize.mjs'), 'utf8')
  assert.ok(src.includes('多季剧但取不到季号'), '多季剧取不到季号时应跳过而非猜')
  assert.ok(!/season:\s*s\.seasons\?\.\[0\]\s*\?\?\s*1/.test(src), '不应再用 seasons[0] 兜底')
  // 平铺剧是单季，回退到 1 无歧义；多季剧回退 null
  assert.ok(/layout \|\| 'flat'\) === 'flat'/.test(src), '平铺剧应回退到 1')
  assert.ok(!src.includes('multiSeason'), '不应留死代码')
})

test('shows：示例文件包含 layoutLocked 说明', async () => {
  const { EXAMPLE_REGISTRY_PATH } = await import('../lib/shows.js')
  const raw = JSON.parse(readFileSync(EXAMPLE_REGISTRY_PATH, 'utf8'))
  assert.ok(raw._fields?.layoutLocked, '示例应说明 layoutLocked 用法')
  assert.ok(raw._fields?.tmdbId, '示例应说明 tmdbId 需人工确认')
})

test('shows：writeRegistry 保留顶层元数据', async () => {
  const { writeRegistry, readRegistry } = await import('../lib/shows.js')
  const dir = mkdtempSync(join(tmpdir(), 'bdn-meta-'))
  const p = join(dir, 'r.json')
  writeRegistry({ shows: [{ dir: 'A (2020)', title: 'A', year: 2020, tmdbId: 1, layout: 'flat' }] }, p)
  // 手工加说明字段，再写一次不应被冲掉
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  raw._comment = '说明'
  raw._fields = { a: 'b' }
  writeFileSync(p, JSON.stringify(raw, null, 2))
  writeRegistry(readRegistry(p), p)
  const after = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(after._comment, '说明', '_comment 应保留')
  assert.deepEqual(after._fields, { a: 'b' }, '_fields 应保留')
  assert.equal(after.shows.length, 1)
})

test('shows：scanLibrary 支持 prune 清理幽灵条目', async () => {
  const { scanLibrary } = await import('../lib/shows.js')
  const fakeNas = {
    ls: async (p) => (p === '/root' ? [{ name: '新名字 (2020)', ext: '' }] : [{ name: 'a.mp4', ext: 'mp4' }]),
    readFile: async () => ({ ok: false }),
  }
  const reg = { shows: [{ dir: '旧名字 (2020)', title: '旧名字', year: 2020, tmdbId: 1, layout: 'flat' }] }

  const noPrune = await scanLibrary(fakeNas, { root: '/root', registry: reg })
  assert.equal(noPrune.shows.length, 2, '默认不删，旧条目保留')
  assert.equal(noPrune.removed.length, 0)

  const pruned = await scanLibrary(fakeNas, { root: '/root', registry: reg, prune: true })
  assert.deepEqual(pruned.shows.map((s) => s.dir), ['新名字 (2020)'])
  assert.deepEqual(pruned.removed.map((s) => s.dir), ['旧名字 (2020)'])
})

test('shows：scanLibrary 返回 scanned，供调用方识别 NAS 不可达', async () => {
  const { scanLibrary } = await import('../lib/shows.js')
  const deadNas = { ls: async () => [], readFile: async () => ({ ok: false }) }
  const r = await scanLibrary(deadNas, { root: '/x', registry: { shows: [{ dir: 'A (2020)', title: 'A' }] } })
  assert.equal(r.scanned, 0, '扫不到目录时 scanned 应为 0')
  // register.mjs 必须据此报错，而不是静默「无需改动」
  const src = readFileSync(join(ROOT, 'skills/media-ops/scripts/register.mjs'), 'utf8')
  assert.ok(src.includes('scanned === 0'), 'register 应检查 scanned')
  assert.ok(src.includes('NAS 是否可达'), '应提示 NAS 可达性')
})
