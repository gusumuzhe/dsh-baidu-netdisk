/**
 * dsh-baidu-netdisk — 百度网盘 + PanSou 搜索连接器（DSH 插件）。
 *
 * 安全模型（三重）：
 *   1. 能力白名单：只注册只读工具。删除/移动/创建分享/转存等写能力**不存在**，
 *      模型不是"不该调"，而是"调不到"。
 *   2. 门控：未配置凭据时，对应工具不注册。
 *   3. 凭据不外泄：BDUSS/STOKEN/密码存为 secret 字段，永不回传给模型或浏览器；
 *      错误信息里也不会出现凭据。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BaiduClient, BaiduError } from './baidu.js'
import { PansouClient, PansouError } from './pansou.js'
import { BaiduGateway } from './gateway.js'
import { registerSkill } from './skill.js'
import { rankSources } from './sources.js'
import { parseEpisodes, episodeOf } from './episodes.js'
import { transferEpisodes } from './transfer.js'

export const name = 'dsh-baidu-netdisk'
export const inject = ['tools']

const NS = 'dsh-baidu-netdisk'

const asText = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
const J = (v) => JSON.stringify(v, null, 2)

export const Config = z.object({
  bduss: z.string().role('secret').default('').volatile()
    .description('百度网盘 BDUSS。只保存在设置页，不进入对话'),
  stoken: z.string().role('secret').default('').volatile()
    .description('百度网盘 STOKEN（可选，解析分享需要）。只保存在设置页'),
  pansouUrl: z.string().default('').volatile()
    .description('PanSou 地址，例如 http://192.168.5.100:9080'),
  pansouUser: z.string().default('').volatile()
    .description('PanSou 用户名'),
  pansouPass: z.string().role('secret').default('').volatile()
    .description('PanSou 密码。只保存在设置页，不进入对话'),
  timeoutMs: z.natural().default(15000).volatile()
    .description('单次请求超时（毫秒）'),
  inboxRoot: z.string().default('/绿联下载').volatile()
    .description('转存暂存目录。转存工具只允许写这个前缀下的路径'),
  allowTransfer: z.boolean().default(false).volatile()
    .description('允许转存（写操作）。默认关闭，开启后才会注册 baidu_transfer'),
})

/**
 * cordis 的配置值可能是 getter 对象（带 .get()），不是裸字符串。
 * 不拆这一层，String(value) 会得到 "[object Object]"。
 */
const readConfigValue = (value) => {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get() } catch { return undefined }
  }
  return value
}

const resolveSettings = (config = {}) => {
  const src = config || {}
  const field = (key) => readConfigValue(src[key])
  return {
    bduss: String(field('bduss') || '').trim(),
    stoken: String(field('stoken') || '').trim(),
    pansouUrl: String(field('pansouUrl') || '').trim(),
    pansouUser: String(field('pansouUser') || '').trim(),
    pansouPass: String(field('pansouPass') || ''),
    timeoutMs: Number(field('timeoutMs')) || 15000,
    inboxRoot: String(field('inboxRoot') || '/绿联下载').trim().replace(/\/+$/, '') || '/绿联下载',
    allowTransfer: field('allowTransfer') === true || field('allowTransfer') === 'true',
  }
}

const failure = (error) => {
  if (error instanceof BaiduError || error instanceof PansouError) {
    return J({ ok: false, error: error.message, ...(error.errno !== undefined ? { errno: error.errno } : {}) })
  }
  return J({ ok: false, error: `未预期错误：${error?.message || error}` })
}


const TOOLS = [
  {
    name: 'baidu_whoami',
    description: '查询当前百度网盘账号（昵称、uk、会员类型），用于验证 BDUSS 是否有效',
    parameters: {},
    gate: 'baidu',
    run: ({ baidu }) => baidu.whoami(),
  },
  {
    name: 'baidu_quota',
    description: '查询百度网盘容量（总量/已用/剩余，单位字节）',
    parameters: {},
    gate: 'baidu',
    run: ({ baidu }) => baidu.quota(),
  },
  {
    name: 'baidu_list',
    description: '列出百度网盘某个目录下的文件与子目录（只读）',
    parameters: {
      dir: { type: 'string', required: true, description: '绝对路径，例如 / 或 /动漫/仙逆' },
    },
    gate: 'baidu',
    run: ({ baidu }, args) => baidu.list(String(args.dir)),
  },
  {
    name: 'baidu_search',
    description: '按文件名关键词在百度网盘内搜索（只读）',
    parameters: {
      keyword: { type: 'string', required: true, description: '要搜索的文件名关键词' },
      dir: { type: 'string', description: '搜索起始目录，默认 /' },
    },
    gate: 'baidu',
    run: ({ baidu }, args) => baidu.search(String(args.keyword), String(args.dir || '/')),
  },
  {
    name: 'baidu_share_info',
    description: '解析一条百度网盘分享链接，列出其中包含的文件（只读，不会转存）',
    parameters: {
      shareUrl: { type: 'string', required: true, description: '分享链接，形如 https://pan.baidu.com/s/1xxxx' },
      pwd: { type: 'string', description: '提取码，没有就留空' },
      subdir: { type: 'string', description: '分享内的子目录名（整季打包的源要用，可先不传看 subdirs 列表）' },
    },
    gate: 'baidu',
    run: ({ baidu }, args) => baidu.shareInfo(String(args.shareUrl), String(args.pwd || ''), String(args.subdir || '')),
  },

  {
    name: 'baidu_rank_sources',
    description: '多源对比：横向评分多个分享源，覆盖度+画质（分辨率/HDR/每集体积），选出最该用的源',
    parameters: {
      keyword: { type: 'string', required: true, description: '搜索关键词，例如 神墓 第三季' },
      needEpisodes: { type: 'string', required: true, description: '需要补的集号，例如 1-29,52' },
      limit: { type: 'number', description: '最多评估几个源，默认 8' },
    },
    gate: 'baidu',
    run: async ({ baidu, pansou }, args) => {
      if (!pansou.configured) throw new Error('需要配置 PanSou 才能多源对比')
      const need = parseEpisodes(String(args.needEpisodes))
      if (!need.length) throw new Error('needEpisodes 不能为空，例如 1-29,52')
      const rows = await rankSources({ pansou, baidu, keyword: String(args.keyword), need, limit: Math.min(Math.max(Number(args.limit) || 8, 1), 15) })
      const usable = rows.filter((r) => r.covered.length > 0)
      const skipped = rows.length - usable.length
      return (usable.length ? usable : rows).map((r) => ({
        score: r.score,
        title: r.title,
        coverage: `${r.covered.length}/${need.length}`,
        subdir: r.subdir || undefined,
        avgSizeGB: Number(r.avgSizeGB.toFixed(2)),
        uhd: `${Math.round(r.uhdRatio * 100)}%`,
        hdr: `${Math.round(r.hdrRatio * 100)}%`,
        url: r.url,
        pwd: r.pwd,
        sample: r.sample,
        error: r.error || undefined,
      })).concat(usable.length ? [{ note: `另有 ${skipped} 个源无任何需要的集，已略过` }] : [])
    },
  },
  {
    name: 'pansou_search',
    description: '用 PanSou 搜索网盘资源，只返回百度网盘链接（标题、频道、链接、提取码）',
    parameters: {
      keyword: { type: 'string', required: true, description: '搜索关键词，例如 仙逆 150集' },
      limit: { type: 'number', description: '最多返回条数，默认 20' },
    },
    gate: 'pansou',
    run: ({ pansou }, args) => pansou.search(String(args.keyword), { limit: Math.min(Math.max(Number(args.limit) || 20, 1), 100) }),
  },

  {
    name: 'baidu_transfer',
    description: '把分享里指定的集转存到网盘暂存目录（写操作，仅 /绿联下载 前缀内，必须显式列出集号）',
    parameters: {
      shareUrl: { type: 'string', required: true, description: '分享链接' },
      pwd: { type: 'string', description: '提取码，链接自带可省略' },
      episodes: { type: 'string', required: true, description: '集号，例如 150,152-167' },
      subdir: { type: 'string', description: '目标子目录名（落在暂存目录下），默认用分享里的文件夹名' },
      shareSubdir: { type: 'string', description: '源分享内的子目录名（整季打包的源必填，例如 "第 3 季 - 2160p WEB-DL H265 AAC"）' },
    },
    gate: 'transfer',
    run: ({ baidu, settings }, args) => transferEpisodes(baidu, { ...args, inboxRoot: settings.inboxRoot }),
  },
]

export function apply(ctx, config = {}) {
  let settings = resolveSettings(config)
  let baidu = new BaiduClient(settings)
  let pansou = new PansouClient({
    baseUrl: settings.pansouUrl,
    username: settings.pansouUser,
    password: settings.pansouPass,
    timeoutMs: settings.timeoutMs,
  })
  let account = null
  let lastError = ''

  const status = () => ({
    configured: Boolean(settings.bduss),
    hasToken: Boolean(settings.bduss),
    hasStoken: Boolean(settings.stoken),
    pansouConfigured: Boolean(settings.pansouUrl),
    pansouUrl: settings.pansouUrl,
    pansouUser: settings.pansouUser,
    timeoutMs: settings.timeoutMs,
    inboxRoot: settings.inboxRoot,
    allowTransfer: settings.allowTransfer,
    account,
    error: lastError || undefined,
  })

  let settingsService = null
  ctx.inject(['settings'], (sctx) => { settingsService = sctx.settings })

  const update = async (patch) => {
    if (!settingsService || typeof settingsService.update !== 'function') {
      throw new Error('宿主设置服务不可用，请重启 DSH 后重试')
    }
    await settingsService.update(NS, patch)
    settings = resolveSettings({ ...settings, ...patch })
    if (!settings.bduss) account = null
    baidu = new BaiduClient(settings)
    pansou = new PansouClient({
      baseUrl: settings.pansouUrl,
      username: settings.pansouUser,
      password: settings.pansouPass,
      timeoutMs: settings.timeoutMs,
    })
    return status()
  }

  const test = async () => {
    if (!settings.bduss) return { ok: false, error: '尚未配置 BDUSS' }
    try {
      const me = await baidu.whoami()
      const q = await baidu.quota().catch(() => null)
      account = { name: me.name, uk: me.uk, vip: me.vip }
      lastError = ''
      return { ok: true, ...account, quota: q }
    } catch (error) {
      lastError = error?.message || String(error)
      account = null
      return { ok: false, error: lastError }
    }
  }

  const testPansou = async () => {
    if (!settings.pansouUrl) return { ok: false, error: '尚未配置 PanSou 地址' }
    try {
      const r = await pansou.verify()
      return { ok: true, baseUrl: r.baseUrl }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  ctx.plugin(BaiduGateway, { owner: { status, update, test, testPansou } })

  // 自带 skill：影视自动化流程（pansou 找源 → 转存 → 同步 → 归档命名）
  ctx.inject(['skills'], (sctx) => { registerSkill(sctx) })

  for (const tool of TOOLS) {
    // 真·门控：未配置就不注册（ctx.tools.register 只有一个参数，没有 when 选项）
    // 转存工具：只要配了 BDUSS 就注册，开关状态由执行层实时判断，
    // 这样切换「允许转存」不需要重载插件。
    const configured = tool.gate === 'pansou' ? pansou.configured : baidu.configured
    if (!configured) continue

    ctx.effect(
      () => ctx.tools.register(defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: { schema: { type: 'string' }, render: asText },
        async execute(args = {}) {
          // 执行层兜底：即使注册了，凭据缺失也不放行
          const ready = tool.gate === 'pansou'
            ? pansou.configured
            : tool.gate === 'transfer'
              ? (baidu.configured && settings.allowTransfer)
              : baidu.configured
          if (!ready) {
            const why = tool.gate === 'pansou'
              ? '尚未配置 PanSou：请在 设置 → 插件 → dsh-baidu-netdisk 中填写'
              : tool.gate === 'transfer'
                ? '转存未开启：需要先配置 BDUSS，并在设置里打开「允许转存」'
                : '尚未配置 BDUSS：请在 设置 → 插件 → dsh-baidu-netdisk 中填写'
            return J({ ok: false, error: why })
          }
          try {
            return J(await tool.run({ baidu, pansou, settings }, args))
          } catch (error) {
            return failure(error)
          }
        },
      })),
    )
  }
}
