import { readFileSync } from 'node:fs'
import https from 'node:https'
// 路径可被环境变量覆盖，便于在别的机器上复用
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const CONFIG_FILE = process.env.DSH_PROFILE_CONFIG || `${PROFILE_DIR}/cordis.patch.yml`
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)
const catalog=JSON.parse(readFileSync(`${P}/lib/catalog.json`,'utf8'))
const patch=readFileSync(CONFIG_FILE,'utf8')
const url=new URL(patch.match(/endpoint:\s*(\S+)/)?.[1])
const token=patch.match(/accessToken:\s*(\S+)/)?.[1]
const ls=(path)=>new Promise((r)=>{
  const body=encodeMessage(catalog,'ugidl.filesystem.cli.FileDirListRequest',{path,page:1,limit:1000})
  const rq=https.request({hostname:url.hostname,port:url.port||443,method:'POST',rejectUnauthorized:false,
    path:`${url.pathname.replace(/\/$/,'')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/CategoryOrFileDirList`,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-protobuf',Accept:'application/x-protobuf','X-OpenCLI-Body-Format':'protobuf','Content-Length':body.length}},
    (s)=>{const cs=[];s.on('data',c=>cs.push(c));s.on('end',()=>{const b=Buffer.concat(cs)
      if(s.headers['x-grpc-code']!=='0') return r([])
      r(decodeMessage(catalog,'ugidl.filesystem.cli.FileDirListResponse',b)?.data?.file_list?.files||[])})})
  rq.on('error',()=>r([])); rq.write(body); rq.end()
})
const VIDEO=/\.(mp4|mkv|avi|ts|m4v|mov)$/i
const ROOT='/volume1/影视/动漫'
const walk=async(path,depth,label)=>{
  const items=await ls(path)
  const vids=items.filter(x=>x.ext&&VIDEO.test(x.name))
  const nonVid=items.filter(x=>x.ext&&!VIDEO.test(x.name))
  const dirs=items.filter(x=>!x.ext)
  if (vids.length||depth===0) {
    console.log(`${'  '.repeat(depth)}${label}  →  ${vids.length} 视频${nonVid.length?` (+${nonVid.length} 非视频)`:''}${dirs.length?` +${dirs.length} 子目录`:''}`)
  }
  for (const d of dirs) {
    if (depth<2) await walk(`${path}/${d.name}`,depth+1,`📁 ${d.name}`)
  }
}
const tops=(await ls(ROOT)).filter(x=>!x.ext)
for (const t of tops) await walk(`${ROOT}/${t.name}`,0,`## ${t.name}`)
