/**
 * 列出 NAS 目录（含隐藏项）。
 * 用法：node ls.mjs <目录>
 */
import { createNas, gb } from '../../../lib/nas.js'

const target = process.argv[2]
if (!target) {
  console.error('用法: node ls.mjs <NAS 绝对路径>')
  process.exit(1)
}

let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const r = await nas.lsEx(target)
console.log('目录:', target, '| err:', r.ok ? '无' : r.error, '| 条目:', r.files.length)
for (const f of r.files) {
  console.log('  ', f.ext ? 'FILE' : 'DIR ', f.name, f.ext ? `${f.size} (${gb(f.size)})` : '')
}
if (!r.ok) process.exit(1)
