// Exercise a built local application with an empty database and no provider access.
// This creates a new data/acceptance-* directory and preserves it for inspection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';

// Query the active network namespace through netlink; an inherited sysfs mount
// can still describe the host's interfaces after unshare --net.
let isolated=false;
if(process.platform==='linux')try{
 const links=JSON.parse(execFileSync('ip',['-j','link','show'],{encoding:'utf8',maxBuffer:65536}));
 isolated=links.length===1&&links[0].ifname==='lo';
}catch{}
if(process.env.FASTLANE_REQUIRE_NETWORK_ISOLATION==='1')assert(isolated,'Run inside an isolated network namespace with loopback enabled');
const root=process.cwd(),dataRoot=path.join(root,'data');
fs.mkdirSync(dataRoot,{recursive:true});
const data=fs.mkdtempSync(path.join(dataRoot,'acceptance-'));
const port=Number(process.env.FASTLANE_ACCEPTANCE_PORT??3197);
assert(Number.isSafeInteger(port)&&port>=1024&&port<=65535);
const origin=`http://127.0.0.1:${port}`;
const env={...process.env,FASTLANE_ROOT:root,FASTLANE_DATA_DIR:data,FASTLANE_LIVE:'off',FASTLANE_WORKER:'off',NEXT_TELEMETRY_DISABLED:'1',ANTHROPIC_API_KEY:'',KIE_API_KEY:'',ELEVENLABS_API_KEY:'',BLOB_READ_WRITE_TOKEN:''};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let server,serverLog='';
async function stop(){
 if(!server?.pid||server.exitCode!==null||server.signalCode!==null)return;
 const child=server,ended=once(child,'exit');
 child.kill('SIGTERM');
 await Promise.race([ended,delay(5000)]);
 if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}
}
async function start(){
 serverLog='';
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{serverLog=(serverLog+chunk.toString()).slice(-65536);});
 let spawnError;server.on('error',error=>{spawnError=error;});
 for(let i=0;i<60;i++){
  if(spawnError)throw spawnError;
  if(server.exitCode!==null||server.signalCode!==null)throw Error('Server exited during startup: '+serverLog);
  try{const r=await fetch(origin+'/api/status',{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}
  await delay(1000);
 }
 throw Error('Server readiness timed out: '+serverLog);
}
async function request(route,{body,status=200}={}){
 const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,status,route+': '+r.status);
 const text=await r.text();
 return {r,text,json:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null};
}
function noSpend(view){
 for(const key of ['spentCents','reservedCents','uncertainCents'])assert.equal(view.spend[key],0,key);
}
try{
 await start();
 const status=(await request('/api/status')).json;
 assert.equal(status.live,false);assert.equal(status.media.connected,false);assert.equal(status.worker.started,false);assert(Object.values(status.keys).every(value=>value===false));
 assert((await request('/')).text.includes('Fast Lane'));
 const created=(await request('/api/projects',{body:{idea:'A silent thirty-second film about waiting at an empty station.',kind:'film',duration:30,aspect:'16:9',autopilot:false,allowance:0}})).json;
 assert.equal(typeof created.id,'string');
 const own=(await request('/api/projects/'+created.id)).json;
 assert.equal(own.project.sample,false);assert.equal(own.mode,'off');noSpend(own);
 const sample=(await request('/api/sample',{body:{}})).json;
 assert.equal((await request('/api/sample',{body:{}})).json.id,sample.id);
 let view=(await request('/api/projects/'+sample.id)).json;
 assert.equal(view.project.sample,true);assert.equal(view.mode,'sample');assert(view.shots.items.length>0);noSpend(view);
 const pictures=view.assets.flatMap(asset=>asset.primary?.media?[asset.primary.media]:[]);
 assert(pictures.length>0);
 for(const picture of pictures){const response=await request(picture.url);assert.match(response.r.headers.get('content-type'),/image\/svg\+xml/);assert(response.text.includes('<svg'));}
 const shot=view.shots.items[0],route=`/api/projects/${sample.id}/shots/${shot.id}/blocking`;
 const before=(await request(route)).json;
 assert.equal(before.source,'Fast Lane');assert.equal(before.camera.fps,24);assert.equal(before.camera.samples.length,Math.round(before.scene.duration*24)+1);
 const lens=Math.abs(before.camera.samples[0].lensMm-50)>0.01?50:35;
 const edited=(await request(`/api/projects/${sample.id}/ops`,{body:{op:'direct_shot',input:{shotId:shot.id,commands:[{op:'set_lens',mm:lens}],summary:'Acceptance: adjust a reusable camera plan.'}}})).json;
 assert.equal(edited.ok,true);
 const after=(await request(route)).json;
 assert(after.shot.blockingRev>before.shot.blockingRev);assert.equal(after.camera.samples[0].lensMm,lens);assert.notEqual(hash(after),hash(before));
 await request(`/api/projects/${sample.id}/ops`,{body:{op:'direct_shot',input:{shotId:shot.id,commands:[{op:'invalid_command'}]}},status:422});
 assert.equal(hash((await request(route)).json),hash(after),'Invalid input must not change the exported scene');
 view=(await request('/api/projects/'+sample.id)).json;noSpend(view);
 await stop();await start();
 assert.equal(hash((await request(route)).json),hash(after),'The camera plan must survive a server restart');
 const restored=(await request('/api/projects/'+created.id)).json;assert.equal(restored.project.id,created.id);assert.equal(restored.mode,'off');noSpend(restored);
 const receipt={status:'passed',node:process.version,platform:os.platform(),network_isolated:isolated,project_created:true,illustrative_sample:true,sample_image_count:pictures.length,camera_edit_persisted:true,invalid_input_preserved_state:true,restart_persisted:true,export_sha256:hash(after),media_generation:'not_connected',paid_calls:0};
 fs.writeFileSync(path.join(data,'first-run.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
}finally{await stop();}
