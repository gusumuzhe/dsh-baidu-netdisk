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
const post=(method,reqType,resType,payload)=>new Promise((res)=>{
  const body=encodeMessage(catalog,reqType,payload)
  const rq=https.request({hostname:url.hostname,port:url.port||443,method:'POST',rejectUnauthorized:false,
    path:`${url.pathname.replace(/\/$/,'')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/${method}`,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-protobuf',Accept:'application/x-protobuf','X-OpenCLI-Body-Format':'protobuf','Content-Length':body.length}},
    (r)=>{const cs=[];r.on('data',c=>cs.push(c));r.on('end',()=>{const b=Buffer.concat(cs)
      if(r.headers['x-grpc-code']!=='0') return res({err:b.toString('utf8').slice(0,160)})
      try{res(decodeMessage(catalog,resType,b))}catch{res({ok:true})}})})
  rq.on('error',e=>res({err:String(e)})); rq.write(body); rq.end()
})
const ls=(path)=>post('CategoryOrFileDirList','ugidl.filesystem.cli.FileDirListRequest','ugidl.filesystem.cli.FileDirListResponse',{path,page:1,limit:1000}).then(d=>d?.data?.file_list?.files||[])
const dir='/volume1/影视/动漫/仙逆 (2023)'
const files=await ls(dir)
console.log('待删文件:', files.map(f=>f.name))
for (const f of files) {
  const r=await post('DelPath','ugidl.filesystem.cli.DelPathRequest','ugidl.filesystem.cli.DelPathsResponse',{path:`${dir}/${f.name}`,is_dry_run:false})
  console.log(r.err?`❌ ${f.name}: ${r.err}`:`✅ 删除 ${f.name}`)
}
const rd=await post('DelPath','ugidl.filesystem.cli.DelPathRequest','ugidl.filesystem.cli.DelPathsResponse',{path:dir,is_dry_run:false})
console.log(rd.err?`❌ 删除目录: ${rd.err}`:'✅ 删除目录')
