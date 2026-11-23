/**
 * 绿联 NAS 文件 API 的唯一实现。
 *
 * 为什么要有这个模块：post/ls/rename/copy 这套 protobuf 调用样板原本在
 * ls、scan、normalize、copy_in、cleanup_staging、create_file、write_nfos、
 * wait_sync 八个脚本里各抄了一份。抄多份的代价是真实的：
 *   - copy_in 和 normalize 都把 Rename 的响应类型写成 FileStatus，
 *     而实际返回的是 RenameResponse；解码不报错、静默得到 {}，
 *     于是「改名失败」被当成成功打印 ✅。
 *   - cleanup_staging 把 ls 的返回值多剥了一层 .data，永远拿到空数组。
 * 集中到一处后，这类错误只需要修一次，也能被单测覆盖。
 *
 * 实测语义（2026-11，绿联 UGOS）：
 *   - CpMovePath 的 type=false 是「复制」（源保留），type=true 是「移动」（源删除）。
 *     响应 receipt.type 会如实给出 OPERATION_TYPE_COPY / OPERATION_TYPE_MOVE。
 *   - 目标目录不存在时，CpMovePath 报的是 "Insufficient permissions"，
 *     不是 "Path does not exist"——所以调用方必须先 ensureDir，别被错误信息带偏。
 *   - CreateDir 对已存在的目录报 1327 "A folder with the same name exists"，
 *     这里统一当作成功（幂等）。
 *   - WriteFile 只能覆盖已有文件，新建必须用 CreateFile。
 */
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { readNasConfig, profileDir } from './profile.js'

const SERVICE = 'ugidl.filesystem.Filesystem'
const GRPC_SERVICE = 'ugreen.filemgr.internal.grpc'

/** 每个方法对应的 protobuf 请求/响应类型。写错类型不会报错，只会静默解出 {}。 */
const TYPES = {
  list: ['ugidl.filesystem.cli.FileDirListRequest', 'ugidl.filesystem.cli.FileDirListResponse'],
  rename: ['ugidl.filesystem.cli.RenameRequest', 'ugidl.filesystem.cli.RenameResponse'],
  cpMove: ['ugidl.filesystem.cli.CpMovePathRequest', 'ugidl.filesystem.cli.CpMovePathResponse'],
  mkdir: ['ugidl.filesystem.cli.CreateDirRequest', 'ugidl.filesystem.cli.CreateDirResponse'],
  del: ['ugidl.filesystem.cli.DelPathRequest', 'ugidl.filesystem.cli.DelPathsResponse'],
  createFile: ['ugidl.filesystem.cli.CreateFileRequest', 'ugidl.filesystem.cli.CreateFileResponse'],
  writeFile: ['ugidl.filesystem.cli.WriteFileRequest', 'ugidl.filesystem.cli.WriteFileResponse'],
  readFile: ['ugidl.filesystem.cli.ReadFileRequest', 'ugidl.filesystem.cli.ReadFileResponse'],
}

/** 从 grpc 错误体里抠出可读信息。 */
const errorText = (buf) => {
  const raw = buf.toString('utf8')
  try {
    const j = JSON.parse(raw)
    return j.message || j.code || raw.slice(0, 200)
  } catch {
    return raw.slice(0, 200)
  }
}

/** 目录已存在（CreateDir 幂等用）。 */
const isAlreadyExists = (msg) => /same name exists|1327/i.test(String(msg || ''))

/**
 * 建一个 NAS 客户端。配置缺失时抛错，由脚本统一捕获后退出。
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function createNas(opts = {}) {
  const { endpoint, accessToken } = readNasConfig()
  if (!endpoint || !accessToken) {
    throw new Error('未读到 NAS 配置（dsh-ugreen-nas 的 endpoint / accessToken）')
  }
  const dir = profileDir()
  const { encodeMessage, decodeMessage } = await import(`${dir}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)
  const catalog = JSON.parse(readFileSync(`${dir}/node_modules/dsh-ugreen-nas/lib/catalog.json`, 'utf8'))

  const url = new URL(endpoint)
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000

  /**
   * 发一个 protobuf 请求。
   * @returns {Promise<{ ok: boolean, data: any, error?: string }>}
   */
  const call = (method, kind, payload) => new Promise((resolve) => {
    const types = TYPES[kind]
    if (!types) {
      return resolve({ ok: false, data: null, error: `未知的调用类型：${kind}` })
    }
    const [reqType, resType] = types
    let body
    try {
      body = encodeMessage(catalog, reqType, payload)
    } catch (e) {
      return resolve({ ok: false, data: null, error: `编码失败：${e.message}` })
    }
    const rq = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      method: 'POST',
      rejectUnauthorized: false,
      path: `${url.pathname.replace(/\/$/, '')}/ugreen/opencli/v1/${encodeURIComponent(GRPC_SERVICE)}/${SERVICE}/${method}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-protobuf',
        Accept: 'application/x-protobuf',
        'X-OpenCLI-Body-Format': 'protobuf',
        'Content-Length': body.length,
      },
    }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (r.headers['x-grpc-code'] !== '0') {
          return resolve({ ok: false, data: null, error: errorText(buf) })
        }
        try {
          resolve({ ok: true, data: decodeMessage(catalog, resType, buf) })
        } catch (e) {
          resolve({ ok: false, data: null, error: `解码失败：${e.message}` })
        }
      })
    })
    // 没有超时的话，NAS 卡住会让脚本永久挂起
    rq.setTimeout(timeoutMs, () => rq.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    rq.on('error', (e) => resolve({ ok: false, data: null, error: String(e.message || e) }))
    rq.write(body)
    rq.end()
  })

  /** 列目录，返回 { ok, files, error }。 */
  const lsEx = async (path) => {
    const r = await call('CategoryOrFileDirList', 'list', { path, page: 1, limit: 1000 })
    if (!r.ok) return { ok: false, files: [], error: r.error }
    return { ok: true, files: r.data?.data?.file_list?.files || [] }
  }

  /** 列目录，失败时返回空数组（只读统计场景用）。 */
  const ls = async (path) => (await lsEx(path)).files

  /**
   * 路径是否存在。
   *
   * 注意：对**文件**路径调 CategoryOrFileDirList 会返回 grpc 错误
   * "Path already exists"（而不是正常列表），所以不能只看 ok。
   * 这里把「目录可列」和「文件已存在」都算作存在。
   */
  const exists = async (path) => {
    const r = await lsEx(path)
    if (r.ok) return true
    return /already exists/i.test(String(r.error || ''))
  }

  /** 建目录（幂等）。 */
  const ensureDir = async (path) => {
    const r = await call('CreateDir', 'mkdir', { path, make_all: true, is_dry_run: false })
    if (r.ok) return { ok: true }
    if (isAlreadyExists(r.error)) return { ok: true, existed: true }
    return { ok: false, error: r.error }
  }

  /** 校验 receipt 是否真的成功——这是「假成功」的防线。 */
  const receiptOk = (r, label) => {
    if (!r.ok) return { ok: false, error: r.error }
    const status = r.data?.receipt?.status
    if (status && status !== 'RECEIPT_STATUS_DONE') {
      return { ok: false, error: `${label}未完成（${status}）` }
    }
    return { ok: true, receipt: r.data?.receipt }
  }

  /** 同目录改名。 */
  const rename = async (dir, oldName, newName) => {
    const r = await call('Rename', 'rename', { dir, old_name: oldName, new_name: newName, is_dry_run: false })
    return receiptOk(r, '改名')
  }

  /** 复制（源保留）。 */
  const copy = async (src, dst, { cover = false } = {}) => {
    const r = await call('CpMovePath', 'cpMove', { src, dst, type: false, cover, is_dry_run: false })
    return receiptOk(r, '复制')
  }

  /** 移动（源删除）。 */
  const move = async (src, dst, { cover = false } = {}) => {
    const r = await call('CpMovePath', 'cpMove', { src, dst, type: true, cover, is_dry_run: false })
    return receiptOk(r, '移动')
  }

  /** 删除（默认进回收站）。 */
  const del = async (path, { forever = false } = {}) => {
    const r = await call('DelPath', 'del', { path, forever, is_dry_run: false })
    return receiptOk(r, '删除')
  }

  /**
   * 新建文件（可带内容）。
   *
   * 注意 CreateFile 的语义：**文件已存在时它返回成功但什么都不做**（静默 no-op）。
   * 早期 write_nfos.mjs 因此报告「✅ 成功」却从未真正更新过任何 NFO。
   * 这里改成「存在则 WriteFile 覆盖，不存在则 CreateFile」，让调用方拿到真实结果。
   */
  const createFile = async (path, content, { mode = 420 } = {}) => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
    const already = await exists(path)
    if (already) {
      const r = await call('WriteFile', 'writeFile', {
        path,
        content: buf,
        mode: 'WRITE_FILE_MODE_OVERWRITE',
        offset: 0,
        is_dry_run: false,
        total_size: buf.length,
      })
      return r.ok ? { ok: true, overwritten: true } : { ok: false, error: r.error }
    }
    const r = await call('CreateFile', 'createFile', {
      path, mode, content: buf, exclusive: false, is_dry_run: false,
    })
    return r.ok ? { ok: true, created: true } : { ok: false, error: r.error }
  }

  /** 读文件内容（UTF-8 文本）。 */
  const readFile = async (path, { length = 262144 } = {}) => {
    const r = await call('ReadFile', 'readFile', { path, offset: 0, length, is_dry_run: false })
    if (!r.ok) return { ok: false, error: r.error }
    const data = r.data?.data ? Buffer.from(r.data.data, 'base64') : Buffer.alloc(0)
    return { ok: true, text: data.toString('utf8'), bytes: data.length }
  }

  return { call, ls, lsEx, exists, ensureDir, rename, copy, move, del, createFile, readFile }
}

/** 视频扩展名（全插件统一）。 */
export const VIDEO_RE = /\.(mp4|mkv|avi|ts|m4v|mov)$/i

/** 百度网盘同步中的临时文件。 */
export const isDownloading = (name) => /\.baiduyun\.p\.downloading$/i.test(String(name || ''))

/** 字节数转 GB 字符串。 */
export const gb = (b) => (Number(b) / 1024 ** 3).toFixed(2) + 'G'
