/** 用 CreateFile（可带内容）写 NFO，替代只能覆盖已有文件的 WriteFile */
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { readNasConfig } from '../../../lib/profile.js'
// 路径可被环境变量覆盖，便于在别的机器上复用
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)
const catalog=JSON.parse(readFileSync(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/catalog.json`,'utf8'))
const { endpoint, accessToken } = readNasConfig()
if (!endpoint || !accessToken) {
  console.error('未读到 NAS 配置（dsh-ugreen-nas 的 endpoint / accessToken）')
  process.exit(1)
}
const url=new URL(endpoint)
const token=accessToken
const call=(method,req,res,payload)=>new Promise((r)=>{
  const body=encodeMessage(catalog,req,payload)
  const rq=https.request({hostname:url.hostname,port:url.port||443,method:'POST',rejectUnauthorized:false,
    path:`${url.pathname.replace(/\/$/,'')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/${method}`,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-protobuf',Accept:'application/x-protobuf','X-OpenCLI-Body-Format':'protobuf','Content-Length':body.length}},
    (s)=>{const cs=[];s.on('data',c=>cs.push(c));s.on('end',()=>{const b=Buffer.concat(cs)
      if(s.headers['x-grpc-code']!=='0') return r({err:b.toString('utf8').slice(0,200)})
      try{r(decodeMessage(catalog,res,b))}catch{r({ok:true})}})})
  rq.on('error',e=>r({err:String(e)})); rq.write(body); rq.end()
})
const path=process.argv[2]
if (!path) {
  console.error('用法: node create_file.mjs <NAS 绝对路径> [内容]')
  console.error('  例: node create_file.mjs "/volume1/影视/动漫/仙逆 (2023)/tvshow.nfo" "<tvshow>…</tvshow>"')
  process.exit(1)
}
// 不给内容时写一个最小可用的 tvshow.nfo 骨架，剧名/年份/TMDB id 由调用方补
const xml=process.argv[3] || `<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title></title>
  <year></year>
  <uniqueid type="tmdb" default="true"></uniqueid>
</tvshow>
`
const r=await call('CreateFile','ugidl.filesystem.cli.CreateFileRequest','ugidl.filesystem.cli.CreateFileResponse',
  { path, mode: 420, content: Buffer.from(xml,'utf8'), exclusive: false, is_dry_run: false })
console.log(r.err?`❌ 失败: ${r.err}`:`✅ 已创建: ${path}`)
