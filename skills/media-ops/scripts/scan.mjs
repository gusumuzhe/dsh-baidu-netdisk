/**
 * 深度扫描媒体库，统计每部剧的集数。
 * 用法：node scan.mjs [--root <媒体根>]
 */
import { createNas, VIDEO_RE } from '../../../lib/nas.js'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const ROOT = arg('--root', '/volume1/影视/动漫')

let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const walk = async (path, depth, label) => {
  const items = await nas.ls(path)
  const vids = items.filter((x) => x.ext && VIDEO_RE.test(x.name))
  const nonVid = items.filter((x) => x.ext && !VIDEO_RE.test(x.name))
  const dirs = items.filter((x) => !x.ext)
  if (vids.length || depth === 0) {
    console.log(`${'  '.repeat(depth)}${label}  →  ${vids.length} 视频${nonVid.length ? ` (+${nonVid.length} 非视频)` : ''}${dirs.length ? ` +${dirs.length} 子目录` : ''}`)
  }
  for (const d of dirs) {
    if (depth < 2) await walk(`${path}/${d.name}`, depth + 1, `📁 ${d.name}`)
  }
}

const tops = (await nas.ls(ROOT)).filter((x) => !x.ext)
if (!tops.length) {
  console.error(`媒体库为空或不可读：${ROOT}`)
  process.exit(1)
}
for (const t of tops) await walk(`${ROOT}/${t.name}`, 0, `## ${t.name}`)
