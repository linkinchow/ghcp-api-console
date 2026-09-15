import { control } from './stability-control.mjs';
import { auth, check, hash, inferOptions, successful, mock, sleep, connectDatabase, databaseState, invariants } from './mysql-smoke.mjs';
const business='http://127.0.0.1:18105',internal='http://127.0.0.1:18106';
async function call(root,path,options={}) {
 const response=await fetch(root+path,{...options,redirect:'error',headers:{...auth,...options.headers,'Content-Type':'application/json'},body:options.body?JSON.stringify(options.body):undefined,signal:AbortSignal.timeout(15000)});
 const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
 return {status:response.status,data,text,headers:response.headers};
}
async function summary(){const r=await call(internal,'/api/user-pool/summary');check(r.status===200,'lb_summary');return r.data;}
async function patch(changes){const old=await summary();const r=await call(internal,'/api/user-pool/settings',{method:'PATCH',body:{expectedVersion:old.settings.version,changes}});check(r.status===200,'lb_settings');}
async function wait(checker,ms=60000){const end=Date.now()+ms;do{try{if(await checker())return;}catch{}await sleep(500);}while(Date.now()<end);throw Error('lb_wait_timeout');}
let stopped=false,db;
try{
 for(const [root,service]of[[business,'businessLB'],[internal,'internalLB']]){const r=await call(root,'/__mysql/manifest');check(r.data?.fixture&&r.data?.service===service,'lb_manifest');}
 check((await call(business,'/api/user-pool/summary')).status===403,'business_rejects_internal');
 check((await call(internal,'/v1/models')).status===403,'internal_rejects_business');
 check((await call(internal,'/api/user-pool/summary',{headers:{'X-Internal-Token':'invalid'}})).status===401,'internal_still_authenticated');
 const current=await summary();check(current.counts.total===3&&current.settings.paused===1,'requires_smoke_three');
 const before=await mock();db=await connectDatabase();const prior=await databaseState(db);
 await control('stop-proxy');stopped=true;
 await wait(async()=>{const s=await databaseState(db);return s.owner_hash&&Number(s.owner_until)>Number(s.now_ms);},60000);
 await wait(async()=>{
   const r=await call('http://127.0.0.1:18107','/stats;csv');
   const lines=r.text.trim().split('\n').map(line=>line.trim().replace(/^# /,'').split(','));
   const header=lines.shift(),statusIndex=header.indexOf('status');
   const first=lines.find(row=>row[0]==='proxies'&&row[1]==='proxy');
   const second=lines.find(row=>row[0]==='proxies'&&row[1]==='proxy2');
   return first&&!first[statusIndex].startsWith('UP')&&second?.[statusIndex]==='UP';
 });
 await wait(async()=>{const r=await call(business,'/readyz');return r.status===200&&r.headers.get('x-fixture-backend')==='proxy2';});
 const caller=`sha256:${hash('lb-callback-caller')}`;
 const response=await call(business,'/v1/messages',inferOptions(caller,'/v1/messages','POOL_TEST:{"id":"lb-during-down"}'));
 successful(response,'/v1/messages',false);check(response.headers.get('x-fixture-backend')==='proxy2','lb_routes_survivor');
 await patch({max_accounts:4,idle_target:1,paused:0});
 await wait(async()=>{const s=await summary();return s.counts.total===4&&s.counts.ready_idle>=1&&s.counts.provisioning===0;},120000);
 await patch({paused:1,idle_target:0});
 const after=await mock();check(after.counters.scimCreates===before.counters.scimCreates+1&&after.counters.taskPosts===before.counters.taskPosts+1&&after.counters.callbacksSucceeded===before.counters.callbacksSucceeded+1&&after.counters.callbacksFailed===0,'callback_through_lb_exactly_once');
 await control('start-proxy');stopped=false;
 const seen=new Set();await wait(async()=>{const r=await call(business,'/v1/messages',inferOptions(caller,'/v1/messages',`POOL_TEST:{"id":"lb-restored-${seen.size}-${Date.now()}"}`));successful(r,'/v1/messages',false);seen.add(r.headers.get('x-fixture-backend'));return seen.has('proxy')&&seen.has('proxy2');});
 invariants(await databaseState(db));console.log('PASS lb_acl_authenticated_internal_survivor_new_provision_callback_and_backend_rejoin');
}catch(error){console.error('FAIL lb_qualification',error.fixtureCheck?error.message:'transport_or_prerequisite');process.exitCode=1;}
finally{if(stopped)await control('start-proxy').catch(()=>{});await db?.end();}
