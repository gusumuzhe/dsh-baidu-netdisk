/**
 * 读取 DSH profile 的 cordis.patch.yml，按「插件条目 id」取配置。
 *
 * 为什么需要它：脚本里常见的写法是
 *   patch.match(/\n\s+timeoutMs:\s*(\S+)/)
 * 这取的是**整个文件里第一个**同名键。patch 里 `dsh-ugreen-nas` 排在
 * `dsh-baidu-netdisk` 前面，两边都有 `timeoutMs`，于是插件配的 60000
 * 会被 NAS 的 15000 顶掉。按 id 定位到具体条目再取键，才不会串。
 *
 * 只解析本仓库用到的极简 YAML 子集（顶层 `- id:` 列表 + `config:` 下的
 * 一层标量键），不引入 YAML 依赖。
 */
import { readFileSync } from 'node:fs'

const DEFAULT_PROFILE_DIR = '/root/.dsh/profiles/web'

/** profile 目录，可被 DSH_PROFILE_DIR 覆盖。 */
export function profileDir() {
  return process.env.DSH_PROFILE_DIR || DEFAULT_PROFILE_DIR
}

/** patch 文件路径，可被 DSH_PROFILE_CONFIG 覆盖。 */
export function profileConfigPath() {
  return process.env.DSH_PROFILE_CONFIG || `${profileDir()}/cordis.patch.yml`
}

/** 读 patch 原文；文件不存在时返回空串（脚本可继续用默认值）。 */
export function readProfilePatch() {
  try {
    return readFileSync(profileConfigPath(), 'utf8')
  } catch {
    return ''
  }
}

/** 去掉 YAML 标量两端的引号。 */
const unquote = (v) => {
  const s = String(v ?? '').trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * 把 patch 切成条目：每个 `- id: xxx` 开始一条，直到下一个 `- id:`。
 * @param {string} text patch 原文
 * @returns {Array<{ id: string, body: string }>}
 */
export function splitEntries(text) {
  const lines = String(text || '').split(/\r?\n/)
  const entries = []
  let current = null
  for (const line of lines) {
    const head = line.match(/^-\s+id:\s*(.+?)\s*$/)
    if (head) {
      if (current) entries.push(current)
      current = { id: unquote(head[1]), body: [] }
      continue
    }
    if (current) current.body.push(line)
  }
  if (current) entries.push(current)
  return entries.map((e) => ({ id: e.id, body: e.body.join('\n') }))
}

/**
 * 取某个插件条目的 config 段（`config:` 之下、缩进更深的一层标量键）。
 * @param {string} text patch 原文
 * @param {string} id   条目 id，例如 "dsh-baidu-netdisk"
 * @returns {Record<string, string>}
 */
export function parseEntryConfig(text, id) {
  const entry = splitEntries(text).find((e) => e.id === id)
  if (!entry) return {}

  const lines = entry.body.split(/\r?\n/)
  const out = {}
  let configIndent = -1
  for (const line of lines) {
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)[0].length
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!kv) continue

    if (configIndent < 0) {
      if (kv[1] === 'config') configIndent = indent
      continue
    }
    // 回到 config 同级或更浅 → config 段结束
    if (indent <= configIndent) break
    out[kv[1]] = unquote(kv[2])
  }
  return out
}

/**
 * 读某个插件条目的配置，带默认值。
 * @param {string} id 条目 id
 * @param {Record<string, string>} [defaults]
 * @returns {Record<string, string>}
 */
export function readPluginConfig(id, defaults = {}) {
  return { ...defaults, ...parseEntryConfig(readProfilePatch(), id) }
}

/**
 * 读 NAS 连接信息（endpoint / accessToken），按 `dsh-ugreen-nas` 条目取。
 * @returns {{ endpoint: string, accessToken: string }}
 */
export function readNasConfig() {
  const cfg = readPluginConfig('dsh-ugreen-nas')
  return {
    endpoint: cfg.endpoint || '',
    accessToken: cfg.accessToken || '',
  }
}
