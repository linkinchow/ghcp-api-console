import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, open, lstat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadFixtureConfig, MODEL_ID } from './mock-provider.mjs';
import { boundedInteger, HARD_LIMIT_MS, sleep } from './runtime-common.js';
export { boundedInteger, HARD_LIMIT_MS, sleep } from './runtime-common.js';

export const MAX_REQUESTS=3000;
export type Check = {name:string;status:'PASS'|'FAIL'|'SKIP';elapsedMs:number;details?:unknown};
async function responseTextBounded(response:Response):Promise<string>{
  const reader=response.body?.getReader();if(!reader)return '';const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw new Error('fixture_response_too_large');}chunks.push(value);}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
export function createClient(fixture:ReturnType<typeof loadFixtureConfig>,durationMs=HARD_LIMIT_MS) {
  boundedInteger(durationMs,1,HARD_LIMIT_MS,'duration');
  const {state}=fixture,deadline=Date.now()+durationMs;let requests=0;
  let lastOperation:{method:string;path:string;status?:number;requestNumber:number}|undefined;
  const allowed=new Set<string>([...Object.values(state.origins).filter(v=>typeof v==='string'),...state.origins.proxyReplicas] as string[]);
  const signal=AbortSignal.timeout(durationMs);
  async function call(origin:string,path:string,method='GET',body?:unknown,headers:Record<string,string>={},timeout=30_000) {
    if(!allowed.has(origin)||!path.startsWith('/')||path.startsWith('//')||new URL(path,origin).origin!==origin)throw new Error('fixture_request_route_rejected');
    if(++requests>MAX_REQUESTS)throw new Error('fixture_request_cap_exceeded');
    if(Date.now()>=deadline)throw new Error('fixture_deadline_exceeded');
    lastOperation={method,path:path.split('?')[0],requestNumber:requests};
    const response=await fetch(`${origin}${path}`,{method,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(Math.min(timeout,deadline-Date.now()))]),
      headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:body instanceof URLSearchParams ? body.toString() : JSON.stringify(body)})});
    lastOperation={method,path:path.split('?')[0],requestNumber:requests,status:response.status};
    const text=await responseTextBounded(response);
    let data:any;try{data=JSON.parse(text);}catch{data=undefined;}
    return {status:response.status,data,text,headers:response.headers};
  }
  const internalHeaders={'x-internal-token':state.credentials.internalApiToken};
  const fixtureHeaders={authorization:`Bearer ${state.credentials.fixtureToken}`};
  async function api(path:string,method='GET',body?:unknown,origin=state.origins.proxy) {
    const r=await call(origin,path,method,body,internalHeaders);
    if(r.status<200||r.status>=300)throw new Error(`api_${method}_${path.split('?')[0].replace(/[a-f0-9-]{36}/g,'uuid')}_http_${r.status}`);
    return r.data;
  }
  async function snapshot(){const r=await call(state.origins.provider,'/fixture/snapshot','GET',undefined,fixtureHeaders);assert.equal(r.status,200);return r.data;}
  async function control(enterpriseId:string,channel:string,mode:string,options:Record<string,number>={}){
    const r=await call(state.origins.provider,'/fixture/control','POST',{enterpriseId,channel,mode,...options},fixtureHeaders);assert.equal(r.status,200);
  }
  async function poll<T>(name:string,read:()=>Promise<T>,accept:(v:T)=>boolean,limit=90_000,interval=500):Promise<T>{
    const until=Math.min(Date.now()+limit,deadline);
    for(let i=0;i<240&&Date.now()<until;i++){
      const result=await read();if(accept(result))return result;
      await sleep(Math.min(interval,Math.max(0,until-Date.now())),signal);
    }
    throw new Error(`poll_${name}_deadline`);
  }
  const pool=(id:string)=>api(`/api/profiles/${id}/user-pool`);
  const policy=(id:string)=>api(`/api/profiles/${id}/pool-policy`);
  async function settings(changes:Record<string,number>){const old=await api('/api/management/pool/settings');return api('/api/management/pool/settings','PATCH',{expectedVersion:old.version,changes});}
  async function cap(id:string,maxAccounts:number){const old=await policy(id);return api(`/api/profiles/${id}/pool-policy`,'PATCH',{expectedVersion:old.policyVersion,maxAccounts});}
  async function action(id:string,action:string){const old=await policy(id);return api(`/api/profiles/${id}/pool-policy/${action}`,'POST',{expectedVersion:old.policyVersion,...(action==='validate'?{}:{confirm:true})});}
  async function activate(id:string){await action(id,'validate');return action(id,'activate');}
  async function inference(caller:string,marker:string,stream=false,origin=state.origins.proxy,path='/chat/completions') {
    return call(origin,path,'POST',{model:MODEL_ID,max_tokens:16,stream,
      ...(path==='/responses'?{input:`phase5-request:${marker}`}:{messages:[{role:'user',content:`phase5-request:${marker}`} ]})},
      {authorization:`Bearer ${state.credentials.apiKey}`,'x-user-identity':callerHash(caller),'x-claude-code-optimized':'false'});
  }
  return {state,fixture,deadline,signal,call,api,snapshot,control,poll,pool,policy,settings,cap,action,activate,inference,internalHeaders,fixtureHeaders,get requestCount(){return requests;},get lastOperation(){return lastOperation;}};
}
export type Client=ReturnType<typeof createClient>;
const byEnterprise=(snapshot:any,id:string)=>snapshot.enterprises.find((e:any)=>e.enterpriseId===id);
const markerCount=(snapshot:any,marker:string)=>snapshot.enterprises.reduce((n:number,e:any)=>n+(e.markers[`phase5-request:${marker}`]?.inference??0),0);
const callerHash=(caller:string)=>`sha256:${createHash('sha256').update(caller).digest('hex')}`;

export async function smoke(c:Client,step:(name:string,fn:()=>Promise<unknown>)=>Promise<void>){
  await step('all real services healthy behind isolated origins',async()=>{
    for(const origin of [c.state.origins.proxy,...c.state.origins.proxyReplicas,c.state.origins.sso,c.state.origins.login,c.state.origins.console,c.state.origins.provider]){
      await c.poll('health',async()=>{try{return (await c.call(origin,'/healthz')).status;}catch{return 0;}},n=>n===200,30_000);
    }
    return {services:5,proxyReplicas:c.state.origins.proxyReplicas.length};
  });
  await step('initial paused state is preserved and produces no external side effects',async()=>{
    const settings=await c.api('/api/management/pool/settings');assert.equal(settings.paused,1);
    const before=await c.snapshot();await sleep(1200,c.signal);assert.deepEqual(await c.snapshot(),before);
    const enterprises=await c.api('/api/management/enterprises');assert.equal(enterprises.enterprises.length,c.state.enterpriseIds.length);
    return {paused:true,enterprises:enterprises.enterprises.length};
  });
  await step('unauthenticated fixture/admin and wrong enterprise are rejected',async()=>{
    assert.equal((await c.call(c.state.origins.provider,'/fixture/snapshot')).status,401);
    assert.equal((await c.call(c.state.origins.proxy,'/api/management/enterprises')).status,401);
    const r=await c.call(c.state.origins.login,`/api/profiles/ffffffff-ffff-4fff-8fff-ffffffffffff/tasks`,'GET',undefined,c.internalHeaders);
    assert.ok(r.status>=400);return {rejected:true};
  });
}

export function assertMigratedPoolProjection(original:Record<string,unknown>,runtime:Record<string,unknown>,registry:{legacyEnterpriseId:string;profiles:Array<{id:string;maxAccounts:number}>}):void{
  const legacy=registry.profiles.find(profile=>profile.id===registry.legacyEnterpriseId);assert.ok(legacy,'migration_legacy_profile_missing');
  assert.equal(original.maxAccounts,legacy.maxAccounts,'migration_original_legacy_cap_changed');
  assert.equal(runtime.maxAccounts,registry.profiles.reduce((sum,profile)=>sum+profile.maxAccounts,0),'migration_runtime_global_cap_changed');
  const {maxAccounts:originalCap,...originalInvariants}=original;
  const {maxAccounts:runtimeCap,...runtimeInvariants}=runtime;
  assert.deepEqual(originalInvariants,runtimeInvariants,'migration_pool_config_invariants_changed');
}

export async function migratedSmoke(c:Client,step:(name:string,fn:()=>Promise<unknown>)=>Promise<void>){
  assert.equal(c.state.mode,'migration');
  let original:any;
  await step('adopted migration evidence binds original fixture and immutable state',async()=>{
    const [stateBytes,baselineBytes,evidenceBytes,receiptBytes]=await Promise.all([
      readFile('/fixture/state.json'),readFile('/fixture/chain/baseline.json'),readFile('/fixture/chain/adoption.json'),readFile('/fixture/adoption-receipt.json')]);
    const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
    const baseline=JSON.parse(baselineBytes.toString()),evidence=JSON.parse(evidenceBytes.toString()),receipt=JSON.parse(receiptBytes.toString());
    assert.equal(evidence.version,1);assert.equal(evidence.status,'PASS');assert.equal(evidence.stage,'verify');assert.equal(evidence.syntheticOnly,true);
    assert.equal(evidence.runId,c.state.runId);assert.equal(evidence.project,c.state.project);assert.equal(evidence.runtimeStarted,false);
    assert.equal(evidence.schema,c.state.database.name);assert.equal(evidence.sourceBundleSha256,c.state.source.bundleSha256);
    assert.equal(evidence.baselineSha256,hash(baselineBytes));assert.equal(evidence.stateSha256,hash(stateBytes));assert.equal(baseline.stateSha256,hash(stateBytes));
    assert.equal(receipt.version,1);assert.equal(receipt.status,'PASS');assert.equal(receipt.stage,'adopt-migrated');assert.equal(receipt.syntheticOnly,true);
    assert.equal(receipt.runId,c.state.runId);assert.equal(receipt.project,c.state.project);assert.equal(receipt.schema,evidence.schema);
    assert.equal(receipt.mysqlContainerId,evidence.mysqlContainerId);assert.equal(receipt.evidenceSha256,hash(evidenceBytes));assert.equal(receipt.stateSha256,hash(stateBytes));
    assert.equal(receipt.runtimeStarted,false);original=baseline.fixture;assert.equal(original.explicitPreseedRuntimeConfig,true);
    assertMigratedPoolProjection(original.poolConfig,c.state.poolConfig,c.fixture.registry);assert.equal(original.poolFingerprint,c.state.fingerprint);
    assert.match(original.caller,/^sha256:[a-f0-9]{64}$/);assert.equal(typeof original.identity,'string');assert.equal(typeof original.lease,'string');
    // Runtime startup may legitimately write SQLite; byte hashes were checked by adoption/app-up, not reasserted here.
    return {adoptionEvidenceBound:true,sourceOriginalFixtureBound:true,runtimeFileRehashRequired:false};
  });
  await smoke(c,step);
  const noProviderCalls=async()=>{const snapshot=await c.snapshot();for(const e of snapshot.enterprises){assert.equal(e.scimUsers,0);assert.equal(e.seats,0);assert.equal(e.issuedTokens,0);assert.ok(Object.values(e.counts).every(n=>n===0));}return snapshot;};
  const providerBefore=await noProviderCalls();
  function assertLegacy(pool:any){
    assert.equal(pool.settings.paused,1);assert.equal(pool.settings.version,7);assert.equal(pool.settings.idle_target,original.poolConfig.idleTarget);assert.equal(pool.settings.lease_seconds,original.poolConfig.leaseSeconds);
    assert.equal(pool.counts.total,1);assert.equal(pool.accounts.length,1);assert.equal(pool.leases.length,1);
    const member=pool.accounts[0],lease=pool.leases[0];assert.equal(member.identity,original.identity);assert.equal(member.ordinal,0);assert.equal(member.state,'ready');assert.equal(member.stage,'ready');
    assert.equal(member.verifiedAt,1700000000000);assert.equal(member.attempts,2);assert.equal(member.activeRequests,0);
    assert.equal(lease.leaseId,original.lease);assert.equal(lease.memberIdentity,original.identity);assert.equal(lease.callerKeyHash,original.caller);assert.equal(lease.phase,'active');
    assert.equal(lease.assignedAt,1700000000000);assert.equal(lease.lastSuccessAt,1700000000123);assert.equal(lease.expiresAt,4102444800000);assert.equal(lease.inUse,false);
  }
  await step('every real Proxy preserves original paused member lease TTL ordinal and cap',async()=>{
    const legacy=c.state.legacyEnterpriseId;
    for(const origin of [c.state.origins.proxy,...c.state.origins.proxyReplicas])assertLegacy(await c.api(`/api/profiles/${legacy}/user-pool`,'GET',undefined,origin));
    const summary=await c.api('/api/management/pool/summary');assert.equal(summary.names.nextOrdinal,1);
    const policies=await c.api('/api/management/enterprises');
    for(const policy of policies.enterprises){const profile=c.fixture.registry.profiles.find((p:any)=>p.id===policy.enterpriseId);assert.equal(policy.maxAccounts,profile.maxAccounts);assert.equal(policy.state,policy.enterpriseId===legacy?'active':'draft');}
    for(const id of c.state.enterpriseIds.filter((id:string)=>id!==legacy)){const empty=await c.pool(id);assert.equal(empty.counts.total,0);assert.equal(empty.leases.length,0);}
    return {proxyReplicas:c.state.origins.proxyReplicas.length,originalMembers:1,originalLeases:1,identityAndCallerPreserved:true,ttlAndTimesPreserved:true,nextOrdinal:1,capsPreserved:true,paused:true};
  });
  await step('preserved Console administrator authenticates and reads the adopted pool',async()=>{
    const origin=c.state.origins.console;
    const login=await c.call(origin,'/api/console/login','POST',{username:c.state.credentials.consoleUsername,password:c.state.credentials.consolePassword});assert.equal(login.status,200);assert.equal(login.data.username,c.state.credentials.consoleUsername);assert.equal(login.data.role,'admin');
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
    const me=await c.call(origin,'/api/console/me','GET',undefined,{cookie});assert.equal(me.status,200);assert.equal(me.data.username,c.state.credentials.consoleUsername);
    const view=await c.call(origin,`/api/console/proxy/profiles/${c.state.legacyEnterpriseId}/user-pool`,'GET',undefined,{cookie});assert.equal(view.status,200);assertLegacy(view.data);
    return {preservedAdminAuthenticated:true,consoleReadsOriginalPool:true};
  });
  await step('migrated smoke performed no provisioning authorization or inference',async()=>{
    assert.deepEqual(await noProviderCalls(),providerBefore);assertLegacy(await c.pool(c.state.legacyEnterpriseId));
    return {providerCalls:0,inferenceRequests:0,activationRequests:0,tokenRenewals:0,originalLeasePreserved:true};
  });
}

export async function lifecycle(c:Client,step:(name:string,fn:()=>Promise<unknown>)=>Promise<void>){
  const [a,b]=c.state.enterpriseIds;if(!a||!b)throw new Error('two_enterprises_required');
  const caller=`phase5-${c.state.runId}-lifecycle`;
  await step('activate A through real readiness and fill two accounts via SSO Login queue runner callback',async()=>{
    assert.equal((await c.api('/api/management/pool/settings')).paused,1);
    const pa=await c.pool(a),pb=await c.pool(b);assert.equal(pa.counts.total+pb.counts.total,0,'fresh_fullstack_fixture_required');
    await c.cap(a,4);await c.cap(b,2);await c.activate(a);await c.settings({idle_target:2,lease_seconds:60,paused:0});
    const ready=await c.poll('A_ready',()=>c.pool(a),v=>v.counts.ready_idle===2,120_000);
    const snap=byEnterprise(await c.snapshot(),a);assert.equal(snap.scimUsers,2);assert.equal(snap.seats,2);assert.equal(snap.counts.authorize,2);assert.equal(snap.counts['verify-user'],2);
    const tasks=await c.api(`/api/profiles/${a}/tasks`,'GET',undefined,c.state.origins.login);assert.ok(tasks.length>=2);assert.ok(tasks.every((t:any)=>t.status==='success'&&t.attempts===1));
    return {ready:ready.counts.ready_idle,realLoginSuccesses:tasks.length,independentGithubUserVerifications:snap.counts['verify-user']};
  });
  await step('activate B does not provision when global idle is sufficient; deficit chooses B',async()=>{
    await c.activate(b);const before=byEnterprise(await c.snapshot(),b);await sleep(1500,c.signal);assert.equal((await c.pool(b)).counts.total,0);assert.equal(byEnterprise(await c.snapshot(),b).scimUsers,before.scimUsers);
    await c.settings({idle_target:3});await c.poll('ratio_B_first',()=>c.pool(b),v=>v.counts.ready_idle===1,90_000);assert.equal((await c.pool(a)).counts.total,2);
    return {allocation:{a:2,b:1},noSpeculativeBProvision:true};
  });
  await step('real SSO password forms enforce enterprise cookie and credentials',async()=>{
    for(const id of [a,b]){
      const p=c.fixture.registry.profiles.find((p:any)=>p.id===id),subject=byEnterprise(await c.snapshot(),id).subjects[0];
      const origin=c.state.origins.sso,path=new URL(p.sso.loginUrl).pathname;
      const form=await c.call(origin,path);assert.equal(form.status,200);
      const tx=/name="tx" value="([^"]+)"/.exec(form.text)?.[1],csrf=/name="csrf" value="([^"]+)"/.exec(form.text)?.[1];assert.ok(tx&&csrf);
      const cookie=form.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
      // This is real SSO authentication, separate from the synthetic provider's device authorization substitute.
      const r=await c.call(origin,path,'POST',new URLSearchParams({username:subject.ssoUser,password:c.state.credentials.enterprises[id].defaultPassword??c.state.credentials.defaultPassword,tx,csrf}),{'content-type':'application/x-www-form-urlencoded',origin,cookie});
      assert.equal(r.status,200);assert.match(r.text,/Logged in as/);
      const wrong=id===a?b:a,wrongPath=new URL(c.fixture.registry.profiles.find((p:any)=>p.id===wrong).sso.loginUrl).pathname;
      const denied=await c.call(origin,wrongPath,'POST',new URLSearchParams({username:subject.ssoUser,password:'wrong',tx,csrf}),{'content-type':'application/x-www-form-urlencoded',origin,cookie});
      assert.equal(denied.status,400);
    }
    return {realPasswordSessions:2,crossEnterpriseRejected:true,realGithubDeviceFlow:false};
  });
  await step('fill exact enterprise caps in 4:2 allocation',async()=>{
    await c.settings({idle_target:6});await c.poll('cap_fill',async()=>[await c.pool(a),await c.pool(b)],v=>v[0].counts.ready_idle===4&&v[1].counts.ready_idle===2,120_000);
    const s=await c.snapshot();assert.equal(byEnterprise(s,a).scimUsers,4);assert.equal(byEnterprise(s,b).scimUsers,2);return {a:4,b:2};
  });
  await step('JSON SSE and one-upstream-per-request work through real round-robin Proxy',async()=>{
    for(const [i,path] of ['/chat/completions','/v1/messages','/responses'].entries()){
      for(const stream of [false,true]){const marker=`${c.state.runId}-protocol-${i}-${stream}`;const r=await c.inference(caller,marker,stream,c.state.origins.proxy,path);assert.equal(r.status,200);assert.match(r.text,/synthetic/);assert.equal(markerCount(await c.snapshot(),marker),1);}
    }
    const all=[...(await c.pool(a)).leases,...(await c.pool(b)).leases].filter((l:any)=>l.callerKeyHash===callerHash(caller));assert.equal(all.length,1);
    for(const origin of c.state.origins.proxyReplicas){const r=await c.call(origin,'/v1/models','GET',undefined,{authorization:`Bearer ${c.state.credentials.apiKey}`,'x-user-identity':callerHash(caller)});assert.equal(r.status,200);}
    return {protocolRequests:6,uniqueLease:1};
  });
  await step('429 is passed through once without rotation or replay, lease remains sticky',async()=>{
    const pools=[await c.pool(a),await c.pool(b)],lease=pools.flatMap(p=>p.leases).find((l:any)=>l.callerKeyHash===callerHash(caller));assert.ok(lease);
    await c.control(lease.enterpriseId,'inference','429');const marker=`${c.state.runId}-429`;const r=await c.inference(caller,marker);assert.equal(r.status,429);
    assert.equal(markerCount(await c.snapshot(),marker),1);
    const after=(await c.pool(lease.enterpriseId)).leases.find((l:any)=>l.callerKeyHash===callerHash(caller));assert.equal(after.memberIdentity,lease.memberIdentity);
    return {status:429,upstreamRequests:1,memberUnchanged:true};
  });
  await step('cap down retains accounts and still rents ready stock at capacity',async()=>{
    await c.cap(a,1);assert.equal((await c.pool(a)).counts.total,4);await c.settings({idle_target:0});
    const totalBefore=(await c.pool(a)).counts.total+(await c.pool(b)).counts.total;
    const r=await c.inference(`${caller}-second`,`${c.state.runId}-capdown`);assert.equal(r.status,200);
    assert.equal((await c.pool(a)).counts.total+(await c.pool(b)).counts.total,totalBefore);
    await c.cap(a,4);return {accountsPreserved:totalBefore,newAccountRequired:false};
  });
  await step('drain excludes new rent and revalidation restores activity without changing old accounts',async()=>{
    const before=(await c.pool(b)).accounts.map((x:any)=>x.identity);await c.action(b,'drain');
    const r=await c.inference(`${caller}-drain`,`${c.state.runId}-drain`);assert.equal(r.status,200);
    assert.ok(!(await c.pool(b)).leases.some((l:any)=>l.callerKeyHash===callerHash(`${caller}-drain`)));
    await c.activate(b);assert.deepEqual((await c.pool(b)).accounts.map((x:any)=>x.identity),before);return {retained:before.length};
  });
  await step('TTL expires real lease without database time edits',async()=>{
    const poolData=[await c.pool(a),await c.pool(b)],lease=poolData.flatMap(p=>p.leases).find((l:any)=>l.callerKeyHash===callerHash(caller));assert.ok(lease);
    await c.poll('TTL_expired',()=>c.pool(lease.enterpriseId),v=>!v.leases.some((l:any)=>l.leaseId===lease.leaseId),75_000,750);
    return {leaseSeconds:60,expired:true};
  });
  await step('in-flight delayed request holds its lease against release; unknown inference is not replayed',async()=>{
    const heldCaller=`${caller}-hold`,marker=`${c.state.runId}-hold`;
    assert.equal((await c.inference(heldCaller,`${marker}-prime`)).status,200);
    const lease=[...(await c.pool(a)).leases,...(await c.pool(b)).leases].find((l:any)=>l.callerKeyHash===callerHash(heldCaller));assert.ok(lease);
    await c.control(lease.enterpriseId,'inference','delay',{delayMs:2000});
    const pending=c.inference(heldCaller,marker);
    try {
      await c.poll('held_request_started',()=>c.snapshot(),s=>markerCount(s,marker)===1,5000,100);
      const release=await c.call(c.state.origins.proxy,`/api/profiles/${lease.enterpriseId}/user-pool/leases/${lease.leaseId}/release`,'POST',{confirm:true},c.internalHeaders);
      assert.equal(release.status,409);
    } finally {assert.equal((await pending).status,200);}
    await c.control(lease.enterpriseId,'inference','terminal-unknown',{delayMs:10});
    const uncertain=`${c.state.runId}-unknown-inference`;assert.equal((await c.inference(heldCaller,uncertain)).status,503);assert.equal(markerCount(await c.snapshot(),uncertain),1);
    return {heldReleaseRejected:true,unknownUpstreamRequests:1};
  });
  await step('401 schedules real Login reauthorization without inference replay or another SCIM account',async()=>{
    const repairCaller=`${caller}-repair`,marker=`${c.state.runId}-401`;
    assert.equal((await c.inference(repairCaller,`${marker}-prime`)).status,200);
    const lease=[...(await c.pool(a)).leases,...(await c.pool(b)).leases].find((l:any)=>l.callerKeyHash===callerHash(repairCaller));assert.ok(lease);
    const before=byEnterprise(await c.snapshot(),lease.enterpriseId);
    await c.control(lease.enterpriseId,'inference','401');assert.equal((await c.inference(repairCaller,marker)).status,401);assert.equal(markerCount(await c.snapshot(),marker),1);
    await c.poll('401_real_login_repair',()=>c.pool(lease.enterpriseId),v=>v.accounts.some((x:any)=>x.identity===lease.memberIdentity&&x.state==='ready'&&x.oauthStatus==='valid'),90_000);
    const after=byEnterprise(await c.snapshot(),lease.enterpriseId);assert.ok(after.counts.authorize>before.counts.authorize);assert.ok(after.counts['verify-user']>before.counts['verify-user']);assert.equal(after.scimUsers,before.scimUsers);
    return {inferenceUpstreamRequests:1,newLoginVerified:true,newScimAccounts:0};
  });
  await step('real Login API cancellation aborts only delayed synthetic authorization and closes authority',async()=>{
    await c.cap(b,3);await c.control(b,'authorize','delay',{delayMs:20_000,count:1});const baseline=byEnterprise(await c.snapshot(),b),tokens=baseline.issuedTokens;
    await c.settings({idle_target:7});
    const task=await c.poll('running_login',async()=>await c.api(`/api/profiles/${b}/tasks`,'GET',undefined,c.state.origins.login),tasks=>tasks.some((t:any)=>t.status==='running'),90_000,200).then(tasks=>tasks.find((t:any)=>t.status==='running'));
    await c.poll('authorize_started',()=>c.snapshot(),s=>(byEnterprise(s,b).counts.authorize??0)>(baseline.counts.authorize??0),10_000,100);
    const wrong=await c.call(c.state.origins.login,`/api/profiles/${a}/tasks/${task.id}/cancel`,'POST',{},c.internalHeaders);assert.equal(wrong.status,404);
    // Disable before closing authority so normal repair cannot dispatch another task.
    await c.api(`/api/profiles/${b}/user-pool/accounts/${encodeURIComponent(task.identity)}/disable`,'POST',{});
    const cancelled=await c.api(`/api/profiles/${b}/tasks/${task.id}/cancel`,'POST',{},c.state.origins.login);assert.equal(cancelled.outcome,'cancelled');
    await c.poll('cancelled_task',()=>c.api(`/api/profiles/${b}/tasks/${task.id}`,'GET',undefined,c.state.origins.login),v=>v.status==='cancelled',10_000);
    await c.settings({idle_target:0});await sleep(500,c.signal);assert.equal(byEnterprise(await c.snapshot(),b).issuedTokens,tokens);
    const released=await c.poll('cancelled_slot_released',()=>c.pool(b),v=>v.accounts.some((x:any)=>x.identity===task.identity&&x.state==='disabled'&&!['oauth-dispatch','oauth-wait'].includes(x.stage)),15_000);
    assert.ok(released.accounts.some((x:any)=>x.identity===task.identity&&x.state==='disabled'));
    const binding={enterpriseId:b,enterpriseRevision:task.enterpriseRevision,identity:task.identity,accountIncarnation:task.accountIncarnation,oauthAttemptId:task.oauthAttemptId,expectedGhLogin:task.expectedGhLogin,...(task.expectedGithubUserId?{expectedGithubUserId:task.expectedGithubUserId}:{})};
    const authority=await c.api(`/internal/profiles/${b}/accounts/${encodeURIComponent(task.identity)}/authorization-attempts/${task.oauthAttemptId}`);assert.equal(authority.status,'cancelled');
    const cross=await c.call(c.state.origins.proxy,`/internal/profiles/${a}/accounts/${encodeURIComponent(task.identity)}/authorization-attempts/${task.oauthAttemptId}/success`,'POST',{binding,copilotOauthToken:'phase5_rejected_synthetic'},c.internalHeaders);assert.ok(cross.status>=400);
    return {cancelled:true,loginSlotReleased:true,disabledPreserved:true,lateTokenNotIssued:true,crossEnterpriseCallbackRejected:true};
  });
  await step('SCIM committed lost ACK remains unknown and operator retry cannot replay creation',async()=>{
    await c.settings({paused:1,idle_target:0});await c.cap(b,4);const before=byEnterprise(await c.snapshot(),b).counts['scim-create']??0;
    await c.control(b,'scim-create','lost-ack');await c.settings({paused:0,idle_target:8});
    const failed=await c.poll('SCIM_unknown',()=>c.pool(b),v=>v.accounts.some((x:any)=>x.state==='failed'&&x.lastError==='scim_sync_unconfirmed'),90_000).then(v=>v.accounts.find((x:any)=>x.state==='failed'&&x.lastError==='scim_sync_unconfirmed'));
    await c.settings({idle_target:0,paused:1});
    assert.equal(byEnterprise(await c.snapshot(),b).counts['scim-create'],before+1);
    const retry=await c.call(c.state.origins.proxy,`/api/profiles/${b}/user-pool/accounts/${encodeURIComponent(failed.identity)}/retry`,'POST',{},c.internalHeaders);
    assert.ok([200,409].includes(retry.status));
    // SCIM unknown is a persisted stage, not one of the four HTTP manual-only error codes.
    // A permitted retry must re-read/quarantine; it must never POST the external create again.
    if(retry.status===200){await c.settings({paused:0});await c.poll('SCIM_unknown_after_retry',()=>c.pool(b),v=>v.accounts.some((x:any)=>x.identity===failed.identity&&x.state==='failed'&&x.lastError==='scim_sync_unconfirmed'),15_000);await c.settings({paused:1});}
    assert.equal(byEnterprise(await c.snapshot(),b).counts['scim-create'],before+1);
    return {mockCommitAckLost:true,externalCreateCalls:1,operatorRetryStatus:retry.status,noBlindExternalReplay:true};
  });
  await step('Proxy subject lookup failure leaves real Login callback uncertain until explicit reconciliation',async()=>{
    await c.cap(b,5);await c.control(b,'user','terminal-unknown',{delayMs:10,count:1});
    const before=byEnterprise(await c.snapshot(),b);await c.settings({idle_target:9,paused:0});
    const task=await c.poll('callback_uncertain',()=>c.api(`/api/profiles/${b}/tasks`,'GET',undefined,c.state.origins.login),tasks=>tasks.some((t:any)=>t.status==='uncertain'),90_000,200).then(tasks=>tasks.find((t:any)=>t.status==='uncertain'));
    await c.settings({idle_target:0,paused:1});
    const authority=await c.api(`/internal/profiles/${b}/accounts/${encodeURIComponent(task.identity)}/authorization-attempts/${task.oauthAttemptId}`);assert.equal(authority.status,'active');
    const account=await c.api(`/internal/profiles/${b}/accounts/${encodeURIComponent(task.identity)}`);assert.notEqual(account.copilotOauthStatus,'valid');
    const after=byEnterprise(await c.snapshot(),b);assert.equal(after.counts.authorize,before.counts.authorize+1);assert.equal(after.counts['verify-user'],before.counts['verify-user']+1);
    const reconciled=await c.api(`/api/profiles/${b}/tasks/${task.id}/reconcile`,'POST',{},c.state.origins.login);assert.equal(reconciled.outcome,'cancelled');
    await c.api(`/api/profiles/${b}/user-pool/accounts/${encodeURIComponent(task.identity)}/disable`,'POST',{});
    assert.equal(byEnterprise(await c.snapshot(),b).counts.authorize,after.counts.authorize);
    return {realCallbackUncertain:true,tokenNotAccepted:true,reconciled:'cancelled',authorizationExecutions:1};
  });
  await step('full SSO enterprise is excluded from new names despite spare pool cap',async()=>{
    await c.settings({paused:1,idle_target:0});
    const runtime=await c.api(`/api/profiles/${a}/settings/runtime`,'GET',undefined,c.state.origins.sso);
    await c.api(`/api/profiles/${a}/settings/runtime`,'PATCH',{expectedVersion:runtime.version,changes:{maxSsoUsers:4}},c.state.origins.sso);
    await c.cap(a,5);
    const capacity=await c.call(c.state.origins.sso,`/internal/profiles/${a}/creation-capacity`,'GET',undefined,{...c.internalHeaders,'x-enterprise-id':a,'x-enterprise-revision':'1'});
    assert.equal(capacity.status,200);assert.equal(capacity.data.currentUsers,4);assert.equal(capacity.data.maxUsers,4);assert.equal(capacity.data.canCreate,false);
    const before=await c.snapshot();await c.settings({paused:0,idle_target:10});await sleep(2500,c.signal);
    assert.equal((await c.pool(a)).counts.total,4);assert.equal((await c.pool(b)).counts.total,5);
    assert.equal(byEnterprise(await c.snapshot(),a).scimUsers,byEnterprise(before,a).scimUsers);
    await c.settings({paused:1,idle_target:0});await c.cap(a,4);
    const current=await c.api(`/api/profiles/${a}/settings/runtime`,'GET',undefined,c.state.origins.sso);
    await c.api(`/api/profiles/${a}/settings/runtime`,'PATCH',{expectedVersion:current.version,changes:{maxSsoUsers:runtime.maxSsoUsers}},c.state.origins.sso);
    const names=[...(await c.pool(a)).accounts,...(await c.pool(b)).accounts].map((x:any)=>x.identity);
    assert.equal(new Set(names).size,9);assert.equal(names.length,9);
    return {fullEnterpriseNewInventory:0,capacitySeparateFromReadiness:true,globalNamesUnique:true};
  });
}
export function safeFailure(error:unknown):Record<string,unknown>{
  const e=error as {name?:unknown;code?:unknown;operator?:unknown;actual?:unknown;expected?:unknown};
  const result:Record<string,unknown>={code:e?.code==='ERR_ASSERTION'?'assertion_failed':'fixture_operation_failed'};
  if(e?.name==='AbortError'||e?.name==='TimeoutError')result.code='fixture_deadline_exceeded';
  if(['strictEqual','deepStrictEqual','notStrictEqual','ok','match','fail'].includes(String(e?.operator)))result.operator=e.operator;
  for(const key of ['actual','expected'] as const)if(typeof e?.[key]==='number'&&Number.isFinite(e[key]))result[key]=e[key];
  return result;
}

/** Full detail stays in an exclusive 0600 file; never pass this object into the public report. */
export async function writePrivateDiagnostic(output:string,value:unknown):Promise<string>{
  const results=dirname(resolve(output));if(results!=='/results')throw new Error('private_diagnostic_output_rejected');
  const root=await lstat(results);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('private_diagnostic_root_rejected');
  const directory=`${results}/private`;await mkdir(directory,{mode:0o700,recursive:true});
  const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw new Error('private_diagnostic_directory_rejected');
  const file=`${directory}/${basename(output).replace(/[^a-zA-Z0-9._-]/g,'_')}.${Date.now()}.${randomUUID()}.json`;
  const handle=await open(file,'wx',0o600);
  try{await handle.chmod(0o600);await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
  return file;
}

/** Read-only snapshot: bounded, no credentials/config payload, no inference or authorization calls. */
export async function diagnoseCurrent(fixture:ReturnType<typeof loadFixtureConfig>):Promise<unknown>{
  const c=createClient(fixture,4000),rows:Record<string,unknown>={};
  const reads:Array<[string,()=>Promise<unknown>]>=[['settings',()=>c.api('/api/management/pool/settings')],['policies',()=>c.api('/api/management/enterprises')],['provider',()=>c.snapshot()]];
  for(const id of c.state.enterpriseIds){reads.push([`pool-${id}`,()=>c.pool(id)],[`tasks-${id}`,()=>c.api(`/api/profiles/${id}/tasks`,'GET',undefined,c.state.origins.login)]);}
  await Promise.all(reads.map(async([key,read])=>{try{rows[key]=await read();}catch(error){rows[key]={error:inspect(error,{depth:3})};}}));
  return rows;
}

/** Separate five-second budget even if the scenario deadline expired. At most two GET/PATCH pairs. */
export async function pauseAfterFailure(fixture:ReturnType<typeof loadFixtureConfig>):Promise<{paused:boolean;requests:number;code?:string}>{
  const c=createClient(fixture,5000);
  try{
    for(let attempt=0;attempt<2;attempt++){
      const current=await c.api('/api/management/pool/settings');
      if(current.paused===1&&current.idle_target===0)return {paused:true,requests:c.requestCount};
      const r=await c.call(c.state.origins.proxy,'/api/management/pool/settings','PATCH',{expectedVersion:current.version,changes:{paused:1,idle_target:0}},c.internalHeaders);
      if(r.status===200)return {paused:r.data?.paused===1&&r.data?.idle_target===0,requests:c.requestCount};
      if(r.status!==409)break;
    }
  }catch{/* Original scenario error remains authoritative. */}
  return {paused:false,requests:c.requestCount,code:'failure_pause_unconfirmed'};
}

export async function recordFailure(c:Client,output:string,name:string,error:unknown,overrides:{
  diagnose?:(fixture:ReturnType<typeof loadFixtureConfig>)=>Promise<unknown>;
  write?:(output:string,value:unknown)=>Promise<string>;
  pause?:(fixture:ReturnType<typeof loadFixtureConfig>)=>Promise<{paused:boolean;requests:number;code?:string}>;
}={}):Promise<Record<string,unknown>>{
  let privateDiagnosticWritten=false;let snapshot:unknown;
  try{snapshot=await (overrides.diagnose??diagnoseCurrent)(c.fixture);}catch(snapshotError){snapshot={captureError:inspect(snapshotError,{depth:3})};}
  try{await (overrides.write??writePrivateDiagnostic)(output,{syntheticOnly:true,runId:c.state.runId,at:new Date().toISOString(),check:name,
    error:inspect(error,{depth:8,showHidden:true}),stack:error instanceof Error?error.stack:undefined,lastOperation:c.lastOperation,requests:c.requestCount,current:snapshot});privateDiagnosticWritten=true;}catch{/* Still pause and preserve original failure. */}
  let pause:{paused:boolean;requests:number;code?:string};
  try{pause=await (overrides.pause??pauseAfterFailure)(c.fixture);}catch{pause={paused:false,requests:0,code:'failure_pause_unconfirmed'};}
  return {...safeFailure(error),privateDiagnosticWritten,pause};
}

export async function writeReport(path:string,report:unknown){await mkdir(dirname(path),{recursive:true});const temporary=`${path}.partial`;await writeFile(temporary,JSON.stringify(report,null,2),{mode:0o600});await rename(temporary,path);}
export function args(argv=process.argv.slice(2)){
  const values:Record<string,string>={};for(let i=0;i<argv.length;i+=2){if(!['--state','--output','--mode','--duration-ms','--max-inference-requests'].includes(argv[i])||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('invalid_arguments');values[argv[i].slice(2)]=argv[i+1];}return values;
}
export async function runCli(stableRunner?:typeof import('./stable-window.js').stableWindow){
  const options=args();if(!options.output)throw new Error('output_required');const mode=options.mode??'smoke';if(!['smoke','migrated-smoke','lifecycle','stable'].includes(mode))throw new Error('invalid_mode');
  const fixture=loadFixtureConfig(options.state);
  if(fixture.state.mode==='migration'&&mode!=='migrated-smoke')throw new Error('migration_requires_readonly_smoke');
  const c=createClient(fixture,mode==='migrated-smoke'?120_000:HARD_LIMIT_MS),checks:Check[]=[];
  const report={fixtureVersion:1,syntheticOnly:true,runId:c.state.runId,mode,startedAt:new Date().toISOString(),completed:false,status:'RUNNING',checks,requestCount:0,
    limitations:['Synthetic authorization only; no real GitHub/browser device flow.','Owner kill and database faults are main-controller operations, not performed by this HTTP runner.']};
  let handledFailure=false;
  const step=async(name:string,fn:()=>Promise<unknown>)=>{
    const start=Date.now();
    try{const details=await fn();checks.push({name,status:'PASS',elapsedMs:Date.now()-start,details});await writeReport(options.output,{...report,requestCount:c.requestCount});}
    catch(error){
      const details=await recordFailure(c,options.output,name,error);handledFailure=true;
      checks.push({name,status:'FAIL',elapsedMs:Date.now()-start,details});
      try{await writeReport(options.output,{...report,requestCount:c.requestCount});}catch{/* Do not replace original exception. */}
      throw error;
    }
  };
  try {
    if(mode==='smoke')await smoke(c,step);
    if(mode==='migrated-smoke')await migratedSmoke(c,step);
    if(mode==='lifecycle')await lifecycle(c,step);
    if(mode==='stable'){const runStable=stableRunner??(await import('./stable-window.js')).stableWindow;await runStable(c,step,{durationMs:boundedInteger(options['duration-ms']??120000,1000,HARD_LIMIT_MS,'duration'),maxInferenceRequests:boundedInteger(options['max-inference-requests']??120,1,600,'requests')});}
    report.completed=true;report.status='PASS';
  }catch(error){
    if(!handledFailure)checks.push({name:'runner failure',status:'FAIL',elapsedMs:0,details:await recordFailure(c,options.output,'runner failure',error)});
    report.completed=true;report.status='FAIL';process.exitCode=1;
  }
  finally{report.requestCount=c.requestCount;try{await writeReport(options.output,report);}catch{process.exitCode=1;}console.log(JSON.stringify({mode,status:report.status,checks:checks.length,requestCount:c.requestCount}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runCli();
