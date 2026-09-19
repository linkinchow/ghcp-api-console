import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROXIES=Object.freeze(['proxy-1','proxy-2','proxy-3']);
const HARD_LIMIT_MS=90_000;
const TAKEOVER_LIMIT_MS=45_000;
const fail=code=>{throw new Error(`phase5_${code}`);};
const ensure=(condition,code)=>{if(!condition)fail(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolvePromise=>setTimeout(resolvePromise,ms));

export function selectOwner(rows,excluded){
  ensure(Array.isArray(rows)&&rows.length===3,'failover_diagnostics_shape');
  ensure(rows.every(r=>PROXIES.includes(r.service))&&new Set(rows.map(r=>r.service)).size===3,'failover_diagnostics_services');
  const owners=rows.filter(r=>r.service!==excluded&&r.status===200&&r.state==='owner');
  return owners.length===1?owners[0].service:undefined;
}
export function assertSameLease(before,after){
  for(const key of ['leaseId','memberIdentity','enterpriseId','callerKeyHash','assignedAt'])assert.equal(after?.[key],before?.[key],`lease_${key}_changed`);
  assert.equal(after.phase,'active');assert.ok(after.expiresAt>=before.expiresAt);assert.equal(after.inUse,false);
}
export function assertNoExternalReplay(before,after){
  for(const enterprise of before.enterprises){
    const current=after.enterprises.find(e=>e.enterpriseId===enterprise.enterpriseId);assert.ok(current);
    for(const key of ['scim-create','seat-assign','authorize','verify-user'])assert.equal(current.counts[key]??0,enterprise.counts[key]??0,`unexpected_${key}`);
  }
}

/** Stringified into a fixed `docker exec node` command; no user-supplied URL or executable. */
async function containerProbe(){
  const {createHash}=await import('node:crypto');
  const {loadFixtureConfig,MODEL_ID}=await import('/app/tests/enterprise-phase5/mock-provider.mjs');
  const {state}=loadFixtureConfig('/fixture/state.json');
  const [phase,nonce,expectedRunId]=process.argv.slice(1);
  if(state.mode!=='init'||state.runId!==expectedRunId||!/^[a-f0-9-]{36}$/.test(nonce)||!['prime','observe','after','audit'].includes(phase))throw new Error('probe_arguments');
  const signal=AbortSignal.timeout(6500),internal={'x-internal-token':state.credentials.internalApiToken};
  const caller=`sha256:${createHash('sha256').update(`phase5-${state.runId}-owner-failover-${nonce}`).digest('hex')}`;
  const marker=suffix=>`phase5-request:${nonce}-${suffix}`;
  let httpRequests=0;
  async function request(origin,path,method='GET',body,headers=internal){
    const allowed=[state.origins.proxy,state.origins.provider,...state.origins.proxyReplicas];
    if(!allowed.includes(origin)||!path.startsWith('/')||path.startsWith('//'))throw new Error('probe_route');
    if(++httpRequests>20)throw new Error('probe_http_cap');
    const r=await fetch(`${origin}${path}`,{method,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(2500)]),headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const reader=r.body?.getReader(),chunks=[];let size=0;
    if(reader){try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw new Error('probe_body_cap');}chunks.push(value);}}finally{reader.releaseLock();}}
    const text=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(text);}catch{}
    return {status:r.status,data};
  }
  const path=`/api/profiles/${state.legacyEnterpriseId}/user-pool/diagnostics/local`;
  async function diagnostics(){return Promise.all(state.origins.proxyReplicas.map(async(origin,i)=>{
    try{const r=await request(origin,path);return {service:`proxy-${i+1}`,status:r.status,state:r.data?.localScheduler?.state??null,acquisitions:r.data?.localScheduler?.ownershipAcquisitions??null,losses:r.data?.localScheduler?.ownershipLosses??null};}
    catch{return {service:`proxy-${i+1}`,status:0,state:null};}
  }));}
  async function pools(){return Promise.all(state.enterpriseIds.map(async id=>{const r=await request(state.origins.proxy,`/api/profiles/${id}/user-pool`);if(r.status!==200)throw new Error('pool_http');return r.data;}));}
  async function snapshot(){const r=await request(state.origins.provider,'/fixture/snapshot','GET',undefined,{authorization:`Bearer ${state.credentials.fixtureToken}`});if(r.status!==200)throw new Error('snapshot_http');return r.data;}
  const count=(snapshot,suffix)=>snapshot.enterprises.reduce((n,e)=>n+(e.markers[marker(suffix)]?.inference??0),0);
  async function inference(suffix){return request(state.origins.proxy,'/chat/completions','POST',{model:MODEL_ID,max_tokens:8,stream:false,messages:[{role:'user',content:marker(suffix)}]},
    {authorization:`Bearer ${state.credentials.apiKey}`,'x-user-identity':caller,'x-claude-code-optimized':'false'});}
  const rows=await diagnostics();
  if(phase==='observe')return {runId:state.runId,phase,diagnostics:rows,httpRequests};
  const initialPools=await pools(),settings=initialPools[0].settings;
  if(settings.idle_target!==0)throw new Error('idle_target_must_be_zero');
  const initialLeases=initialPools.flatMap(p=>p.leases).filter(l=>l.callerKeyHash===caller);
  let upstreamStatus;
  if(phase==='prime'){
    if(initialLeases.length!==0||initialPools.flatMap(p=>p.accounts).filter(a=>a.state==='ready').length<2)throw new Error('fresh_caller_and_ready_stock_required');
    const r=await inference('before');upstreamStatus=r.status;if(r.status!==200)throw new Error('prime_http');
  }else if(phase==='after'){
    if(initialLeases.length!==1||initialLeases[0].phase!=='active'||initialLeases[0].expiresAt<=Date.now()+3000)throw new Error('original_lease_not_live');
    const r=await inference('after');upstreamStatus=r.status;if(r.status!==200)throw new Error('after_http');
  }
  let latest=await pools(),leases=latest.flatMap(p=>p.leases).filter(l=>l.callerKeyHash===caller);
  for(let i=0;i<6&&leases.some(l=>l.inUse);i++){await new Promise(resolvePromise=>setTimeout(resolvePromise,50));latest=await pools();leases=latest.flatMap(p=>p.leases).filter(l=>l.callerKeyHash===caller);}
  if(leases.length!==1||leases[0].phase!=='active'||leases[0].inUse)throw new Error('lease_not_settled');
  const provider=await snapshot();
  if(count(provider,'before')!==1||count(provider,'after')!==(phase==='prime'?0:1))throw new Error('inference_replayed');
  const all=latest.flatMap(p=>p.leases);
  if(new Set(all.map(l=>l.memberIdentity)).size!==all.length||new Set(all.map(l=>l.callerKeyHash)).size!==all.length)throw new Error('duplicate_lease');
  return {runId:state.runId,phase,diagnostics:rows,lease:leases[0],provider,settings:latest[0].settings,httpRequests,upstreamStatus,
    markerCounts:{before:count(provider,'before'),after:count(provider,'after')},memberCount:latest.reduce((n,p)=>n+p.counts.total,0)};
}
const PROBE=`(${containerProbe.toString()})().then(value=>process.stdout.write(JSON.stringify(value)+'\\n')).catch(()=>{process.stdout.write(JSON.stringify({error:'phase5_failover_probe_failed'})+'\\n');process.exitCode=1;});`;

export async function ownerFailover(stateFile,output){
  // Imports delayed: --self-test never loads host controllers or touches Docker.
  const safety=await import('./safety.mjs');
  const {loadState,absolutePath,within,noSymlinkPath,assertOwnedContainer,exclusiveJson,safeError}=safety;
  const state=loadState(stateFile),started=Date.now(),deadline=started+HARD_LIMIT_MS,nonce=randomUUID();
  ensure(process.env.PHASE5_SYNTHETIC_ONLY==='1'&&state.mode==='init','failover_synthetic_init_only');
  ensure(!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT,'failover_remote_docker_refused');
  ensure(dirname(stateFile)===state.hostPaths.fixture,'failover_host_state_required');
  ensure(realpathSync(join(state.hostPaths.source,'tests/enterprise-phase5'))===dirname(fileURLToPath(import.meta.url)),'failover_source_location');
  absolutePath(output);within(state.hostPaths.results,output);noSymlinkPath(output);ensure(!existsSync(output),'failover_output_exists');
  const envBytes=readFileSync(join(state.hostPaths.fixture,'compose.env'));
  ensure(hash(envBytes)===JSON.parse(readFileSync(join(state.hostPaths.fixture,'file-hashes.json'),'utf8')).composeEnv,'failover_compose_env_changed');
  ensure(PROXIES.every(s=>state.ownership.containers[s])&&state.ownership.containers.provider,'failover_ownership_missing');
  const privateDir=join(state.hostPaths.results,'private');noSymlinkPath(privateDir);mkdirSync(privateDir,{recursive:true,mode:0o700});
  const privateFile=join(privateDir,`owner-failover-${nonce}.json`),events=[];
  const environment=Object.fromEntries(['PATH','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','TMP','TEMP','DOCKER_CONFIG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  let operationDeadline=deadline-20_000;
  const remaining=limit=>{const ms=Math.min(limit,operationDeadline-Date.now());ensure(ms>0,'failover_deadline');return ms;};
  function child(executable,args,limit,extraEnv={}){
    const result=spawnSync(executable,args,{encoding:'utf8',timeout:remaining(limit),maxBuffer:3*1024*1024,env:{...environment,...extraEnv},killSignal:'SIGKILL'});
    events.push({kind:'child',executable,operation:args[0],status:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr});
    ensure(!result.error&&result.status===0,'failover_command_failed');return String(result.stdout).trim();
  }
  const docker=(args,limit=2500)=>child('docker',['--context','default',...args],limit);
  function inspectOwned(services){
    const rows=JSON.parse(docker(['inspect',...services.map(s=>state.ownership.containers[s].id)]));
    ensure(Array.isArray(rows)&&rows.length===services.length,'failover_inspect_cardinality');
    for(const service of services){const matches=rows.filter(r=>r.Id===state.ownership.containers[service].id);assertOwnedContainer(state,matches,service);}
    return rows;
  }
  function probe(phase){
    const row=inspectOwned(['provider'])[0];ensure(row.State?.Running===true,'failover_provider_not_running');
    const text=docker(['exec',state.ownership.containers.provider.id,'node','--input-type=module','-e',PROBE,phase,nonce,state.runId],8000);
    const result=JSON.parse(text);ensure(result.runId===state.runId&&result.phase===phase,'failover_probe_binding');events.push({kind:'probe',result});return result;
  }
  function control(command,service){
    ensure(['kill','restart'].includes(command)&&PROXIES.includes(service),'failover_fault_target');inspectOwned([service]);
    return child(process.execPath,[join(state.hostPaths.source,'tests/enterprise-phase5/run.mjs'),command,'--state',stateFile,'--service',service],8000,{PHASE5_SYNTHETIC_ONLY:'1'});
  }
  const report={version:1,syntheticOnly:true,runId:state.runId,stage:'owner-failover',status:'FAIL',completed:false,elapsedMs:0,
    oldOwner:null,newOwner:null,restarted:false,inferenceRequests:0,upstreamRequests:0,sameLease:false,
    durableOwnerFenceVerified:false,localOwnerObservationOnly:true,hardLimitMs:HARD_LIMIT_MS,error:undefined};
  let target,killAttempted=false,originalFailure,prime,after;
  try{
    const initial=inspectOwned([...PROXIES,'provider']);ensure(initial.every(r=>r.State?.Running===true),'failover_initial_container_not_running');
    prime=probe('prime');target=selectOwner(prime.diagnostics);ensure(target,'failover_initial_owner_not_unique');
    report.oldOwner=target;report.inferenceRequests=1;report.upstreamRequests=1;
    killAttempted=true;control('kill',target);ensure(inspectOwned([target])[0].State?.Running===false,'failover_owner_not_stopped');
    const takeoverUntil=Math.min(Date.now()+TAKEOVER_LIMIT_MS,deadline-18_000);
    while(Date.now()<takeoverUntil){
      const observed=probe('observe'),owner=selectOwner(observed.diagnostics,target);
      const survivors=observed.diagnostics.filter(r=>r.service!==target);
      if(owner&&survivors.every(r=>r.status===200)&&observed.diagnostics.find(r=>r.service===target)?.status===0){report.newOwner=owner;break;}
      await delay(Math.min(750,Math.max(0,takeoverUntil-Date.now())));
    }
    ensure(report.newOwner,'failover_takeover_deadline');
    after=probe('after');report.inferenceRequests=2;
    assertSameLease(prime.lease,after.lease);assertNoExternalReplay(prime.provider,after.provider);assert.equal(after.memberCount,prime.memberCount);
    assert.deepEqual(after.markerCounts,{before:1,after:1});report.upstreamRequests=2;report.sameLease=true;
  }catch(error){originalFailure=error;report.error=safeError(error);events.push({kind:'failure',message:error?.message,stack:error?.stack});}
  finally{
    operationDeadline=deadline-500; // Reserved cleanup budget; still inside the original ninety-second limit.
    if(killAttempted&&target){
      try{control('restart',target);report.restarted=inspectOwned([target])[0].State?.Running===true;ensure(report.restarted,'failover_restart_unconfirmed');}
      catch(error){report.error??=safeError(error);events.push({kind:'restart-failure',message:error?.message,stack:error?.stack});}
    }
  }
  if(!originalFailure&&report.restarted){
    try{
      const until=Math.min(Date.now()+10_000,deadline-1000);let audited=false;
      while(Date.now()<until){
        const observed=probe('observe');
        if(observed.diagnostics.every(r=>r.status===200)&&selectOwner(observed.diagnostics)){
          const final=probe('audit');assertSameLease(after.lease,final.lease);assertNoExternalReplay(prime.provider,final.provider);assert.deepEqual(final.markerCounts,{before:1,after:1});audited=true;break;
        }
        await delay(500);
      }
      ensure(audited,'failover_restart_health_deadline');report.status='PASS';
    }catch(error){report.error=safeError(error);events.push({kind:'audit-failure',message:error?.message,stack:error?.stack});}
  }
  report.elapsedMs=Date.now()-started;report.completed=true;
  // Raw HTTP summaries and controller output stay private, never stdout/public report.
  exclusiveJson(privateFile,{version:1,syntheticOnly:true,runId:state.runId,events});
  exclusiveJson(output,report);return report;
}

export function selfTest(){
  const rows=[{service:'proxy-1',status:200,state:'standby'},{service:'proxy-2',status:200,state:'owner'},{service:'proxy-3',status:200,state:'standby'}];
  assert.equal(selectOwner(rows),'proxy-2');assert.equal(selectOwner(rows,'proxy-2'),undefined);
  assert.equal(selectOwner(rows.map(r=>({...r,state:'owner'}))),undefined);
  assert.throws(()=>selectOwner([{service:'mysql',status:200,state:'owner'},...rows.slice(1)]));
  const lease={leaseId:'id',memberIdentity:'member',enterpriseId:'enterprise',callerKeyHash:'hashed',assignedAt:1,phase:'active',expiresAt:2,inUse:false};
  assertSameLease(lease,{...lease,expiresAt:3});assert.throws(()=>assertSameLease(lease,{...lease,memberIdentity:'other'}));
  const counters={enterprises:[{enterpriseId:'a',counts:{'scim-create':1,'seat-assign':1,authorize:1,'verify-user':1}}]};
  assertNoExternalReplay(counters,structuredClone(counters));assert.throws(()=>assertNoExternalReplay(counters,{enterprises:[{enterpriseId:'a',counts:{...counters.enterprises[0].counts,authorize:2}}]}));
  assert.doesNotThrow(()=>new Function(PROBE)); // Parse fixed probe without executing it.
  assert.ok(!PROBE.includes('state.credentials,')&&!PROBE.includes('console.log'));
  ensure(HARD_LIMIT_MS===90_000&&TAKEOVER_LIMIT_MS===45_000,'selftest_bounds');
  return {status:'PASS',syntheticOnly:true,checks:11,dockerExecuted:false};
}
async function main(){
  const args=process.argv.slice(2);if(args.length===1&&args[0]==='--self-test'){console.log(JSON.stringify(selfTest()));return;}
  ensure(args.length===4&&args[0]==='--state'&&args[2]==='--output','failover_arguments');
  const result=await ownerFailover(resolve(args[1]),resolve(args[3]));console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error(JSON.stringify({status:'FAIL',error:'phase5_owner_failover_failed'}));process.exitCode=1;});
