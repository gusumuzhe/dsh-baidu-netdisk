import { readFileSync } from 'node:fs'
import https from 'node:https'
// 路径可被环境变量覆盖，便于在别的机器上复用
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || '/root/.dsh/profiles/web'
const CONFIG_FILE = process.env.DSH_PROFILE_CONFIG || `${PROFILE_DIR}/cordis.patch.yml`
const { encodeMessage, decodeMessage } = await import(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/protobuf.js`)
const catalog=JSON.parse(readFileSync(`${PROFILE_DIR}/node_modules/dsh-ugreen-nas/lib/catalog.json`,'utf8'))
const patch=readFileSync(CONFIG_FILE,'utf8')
const endpoint=patch.match(/endpoint:\s*(\S+)/)?.[1]
const token=patch.match(/accessToken:\s*(\S+)/)?.[1]
const url=new URL(endpoint)
const call=(payload)=>new Promise((res)=>{
  const body=encodeMessage(catalog,'ugidl.filesystem.cli.FileDirListRequest',payload)
  const req=https.request({hostname:url.hostname,port:url.port||443,method:'POST',rejectUnauthorized:false,
    path:`${url.pathname.replace(/\/$/,'')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/CategoryOrFileDirList`,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-protobuf',Accept:'application/x-protobuf','X-OpenCLI-Body-Format':'protobuf','Content-Length':body.length}},
    (r)=>{const cs=[];r.on('data',c=>cs.push(c));r.on('end',()=>{const b=Buffer.concat(cs)
      if(r.headers['x-grpc-code']!=='0') return res({err:b.toString('utf8').slice(0,200)})
      res(decodeMessage(catalog,'ugidl.filesystem.cli.FileDirListResponse',b))})})
  req.on('error',e=>res({err:String(e)})); req.write(body); req.end()
})
const target=process.argv[2]||'/volume1/Downloads/BaiduNetDisk/仙逆'
const r=await call({path:target,page:1,limit:100})
const files=r?.data?.file_list?.files||[]
console.log('目录:', target, '| err:', r?.err||'无', '| 条目:', files.length)
for (const f of files) console.log('  ', f.ext?'FILE':'DIR ', f.name, f.size)
