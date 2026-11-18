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
const call=(method,req,res,payload)=>new Promise((r)=>{
  const body=encodeMessage(catalog,req,payload)
  const rq=https.request({hostname:url.hostname,port:url.port||443,method:'POST',rejectUnauthorized:false,
    path:`${url.pathname.replace(/\/$/,'')}/ugreen/opencli/v1/${encodeURIComponent('ugreen.filemgr.internal.grpc')}/ugidl.filesystem.Filesystem/${method}`,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-protobuf',Accept:'application/x-protobuf','X-OpenCLI-Body-Format':'protobuf','Content-Length':body.length}},
    (s)=>{const cs=[];s.on('data',c=>cs.push(c));s.on('end',()=>{const b=Buffer.concat(cs)
      if(s.headers['x-grpc-code']!=='0') return r({err:b.toString('utf8').slice(0,150)})
      try{r(decodeMessage(catalog,res,b))}catch{r({ok:true})}})})
  rq.on('error',e=>r({err:String(e)})); rq.write(body); rq.end()
})
const SHOWS=[
  {dir:'仙逆 (2023)',     title:'仙逆',   year:2023, id:223911},
  {dir:'沧元图 (2023)',   title:'沧元图', year:2023, id:229192},
  {dir:'择天记 (2026)',   title:'择天记', year:2026, id:282158},
  {dir:'光阴之外 (2025)', title:'光阴之外', year:2025, id:281233},
  {dir:'深空彼岸 (2026)', title:'深空彼岸', year:2026, id:283119},
  {dir:'神墓 (2022)',     title:'神墓',   year:2022, id:206343},
  {dir:'斗破苍穹 (2017)', title:'斗破苍穹', year:2017, id:79481},
  {dir:'星辰变 (2018)',   title:'星辰变', year:2018, id:83708},
  {dir:'永生 (2022)',     title:'永生',   year:2022, id:156571},
]
for (const s of SHOWS) {
  const xml=`<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>${s.title}</title>
  <year>${s.year}</year>
  <uniqueid type="tmdb" default="true">${s.id}</uniqueid>
</tvshow>
`
  const path=`/volume1/影视/动漫/${s.dir}/tvshow.nfo`
  const r=await call('CreateFile','ugidl.filesystem.cli.CreateFileRequest','ugidl.filesystem.cli.CreateFileResponse',
    { path, mode:420, content:Buffer.from(xml,'utf8'), exclusive:false, is_dry_run:false })
  console.log(r.err?`❌ ${s.title}: ${r.err}`:`✅ ${s.title} → tmdb:${s.id}`)
}
