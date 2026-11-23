/** 用 CreateFile（可带内容）写 NFO，替代只能覆盖已有文件的 WriteFile */
import { createNas } from '../../../lib/nas.js'

const path = process.argv[2]
if (!path) {
  console.error('用法: node create_file.mjs <NAS 绝对路径> [内容]')
  console.error('  例: node create_file.mjs "/volume1/影视/动漫/仙逆 (2023)/tvshow.nfo" "<tvshow>…</tvshow>"')
  process.exit(1)
}

// 不给内容时写一个最小可用的 tvshow.nfo 骨架，剧名/年份/TMDB id 由调用方补
const xml = process.argv[3] || `<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title></title>
  <year></year>
  <uniqueid type="tmdb" default="true"></uniqueid>
</tvshow>
`

let nas
try {
  nas = await createNas()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const r = await nas.createFile(path, xml)
if (!r.ok) {
  console.error(`❌ 失败: ${r.error}`)
  process.exit(1)
}
console.log(`✅ 已创建: ${path}`)
