/**
 * 本插件自带的 skill：media-ops（影视自动化）。
 *
 * 注册方式照抄官方 `@deepseek-ai/dsh-skill-badge`：
 * 在 ctx.skills 上注册一个 provider，内容来自本包 skills/ 目录。
 * 这样 skill 跟着插件走 —— 换会话、换机器都还在。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PROVIDER_NAME = 'dsh-baidu-netdisk'
const SKILL_NAME = 'media-ops'
const SKILL_BODY_URL = new URL('../skills/media-ops/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/media-ops/', import.meta.url)),
}

const CANDIDATE = {
  name: SKILL_NAME,
  description: '影视自动化：用 pansou 找源、百度网盘转存、同步到 NAS、按规范命名归档到媒体库。当用户要补集、整理影视库、找片源、修命名或处理刮削问题时使用。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  locator: SKILL_BODY_URL,
}

export const skillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get() {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** 在插件 apply 里调用：把 provider 挂到 ctx.skills 上。 */
export function registerSkill(ctx) {
  try {
    if (ctx.skills && typeof ctx.skills.registerProvider === 'function') {
      ctx.skills.registerProvider(() => skillProvider)
      return true
    }
  } catch { /* skills 服务不可用时不阻塞插件 */ }
  return false
}
