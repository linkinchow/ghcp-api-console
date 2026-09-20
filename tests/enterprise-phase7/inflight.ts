import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '../enterprise-phase5/fullstack.js';
import { loadFixtureConfig } from '../enterprise-phase5/mock-provider.mjs';
import { absolutePath, assertOwnedContainer, exclusiveJson, loadState, noSymlinkPath, safeError, within } from '../enterprise-phase5/safety.mjs';

export const INFLIGHT_HARD_LIMIT_MS=120_000;
const hash=(value:string)=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const check=(value:unknown,code:string)=>{if(!value)throw new Error(`phase5_inflight_${code}`);};
const statCount=(snapshot:any,id:string,key:string)=>snapshot.enterprises.find((e:any)=>e.enterpriseId===id).counts[key]??0;
const markerCount=(snapshot:any,id:string,marker:string)=>snapshot.enterprises.find((e:any)=>e.enterpriseId===id).markers[`phase5-request:${marker}`]?.inference??0;
export function assertLeaseStable(before:any,after:any){
  check(before&&after,'lease_missing');
  for(const key of ['leaseId','memberIdentity','enterpriseId','callerKeyHash','assignedAt'])assert.equal(after[key],before[key],`lease_${key}_changed`);
}
export function assertNoProvisionReplay(before:any,after:any,ids:string[]){
  for(const id of ids)for(const key of ['scim-create','seat-assign','authorize'])assert.equal(statCount(after,id,key),statCount(before,id,key),`replayed_${key}`);
}
export async function inflightScenario(c:Client,nonce:string,step:(name:string,fn:()=>Promise<unknown>)=>Promise<void>){
  const [a,b]=c.state.enterpriseIds,callA=`phase7-inflight-${c.state.runId}-${nonce}-a`,callB=`phase7-inflight-${c.state.runId}-${nonce}-b`;
  const lease=async(id:string,caller:string)=>(await c.pool(id)).leases.find((l:any)=>l.callerKeyHash===hash(caller));
  let originalA:any,originalB:any,baseline:any;
  await step('fresh init bootstrap: one actual SSO Login Proxy account per enterprise',async()=>{
    const initial=await c.api('/api/management/pool/settings');assert.equal(initial.paused,1);
    const pools=await Promise.all([c.pool(a),c.pool(b)]);assert.equal(pools.reduce((n,p)=>n+p.counts.total,0),0);
    for(const id of [a,b]){assert.equal((await c.policy(id)).state,'draft');await c.cap(id,1);}
    const empty=await c.snapshot();for(const e of empty.enterprises)check(e.scimUsers===0&&e.seats===0&&e.issuedTokens===0,'fresh_provider_required');
    await c.activate(a);await c.settings({paused:0,idle_target:1,lease_seconds:600});
    await c.poll('a_ready',()=>c.pool(a),p=>p.counts.ready_idle===1,35_000,200);
    await c.settings({idle_target:0});assert.equal((await c.inference(callA,`${nonce}-prime-a`)).status,200);
    originalA=await lease(a,callA);check(originalA?.enterpriseId===a,'a_lease_binding');
    await c.activate(b);await c.settings({idle_target:1});
    await c.poll('b_ready',()=>c.pool(b),p=>p.counts.ready_idle===1,35_000,200);
    await c.settings({idle_target:0});assert.equal((await c.inference(callB,`${nonce}-prime-b`)).status,200);
    originalB=await lease(b,callB);check(originalB?.enterpriseId===b,'b_lease_binding');
    baseline=await c.snapshot();for(const id of [a,b])for(const key of ['scim-create','seat-assign','authorize'])assert.equal(statCount(baseline,id,key),1);
    return{accounts:2,realLoginQueue:true,realBrowserDeviceFlow:false};
  });
  await step('drain A while real SSE request is held before headers; healthy B progresses',async()=>{
    // Existing fault delays BEFORE headers. This is an actual streamed HTTP request,
    // not a claim about partial-body backpressure, mid-body disconnect, or slow readers.
    await c.control(a,'inference','delay',{count:1,delayMs:8000,ttlMs:15000});
    const marker=`${nonce}-held-sse`;let completed=false;
    const pending=c.inference(callA,marker,true,c.state.origins.proxyReplicas[0]).then(value=>{completed=true;return value;});
    let response:Awaited<ReturnType<Client['inference']>>|undefined;
    try{
      await c.poll('upstream_held',()=>c.snapshot(),s=>markerCount(s,a,marker)===1,4000,50);
      const held=await lease(a,callA);assertLeaseStable(originalA,held);assert.equal(held.inUse,true);assert.equal(completed,false);
      await c.action(a,'drain');assert.equal((await c.policy(a)).state,'draining');
      const release=await c.call(c.state.origins.proxy,`/api/profiles/${a}/user-pool/leases/${originalA.leaseId}/release`,'POST',{confirm:true},c.internalHeaders);assert.equal(release.status,409);
      const healthy=await c.inference(callB,`${nonce}-b-during`,false,c.state.origins.proxyReplicas[1]);assert.equal(healthy.status,200);
      assertLeaseStable(originalB,await lease(b,callB));assert.equal(completed,false,'B must finish while A request is still held');
    }finally{response=await pending;}
    assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/text\/event-stream/);assert.match(response.text,/data: \[DONE\]/);assert.match(response.text,/synthetic-ok/);
    const settled=await c.poll('a_hold_released',()=>lease(a,callA),r=>r?.inUse===false,4000,50);assertLeaseStable(originalA,settled);
    assert.equal(settled.phase,'active');
    const s=await c.snapshot();assert.equal(markerCount(s,a,marker),1);assert.equal(markerCount(s,b,marker),0);assertNoProvisionReplay(baseline,s,[a,b]);
    return{streamed:true,delayPhase:'before-headers',midBodyStallTested:false,drainWhileHeld:true,releaseRejected:true,bCompletedBeforeA:true,upstreamRequests:1};
  });
  await step('post-drain upstream 401 is one-shot, invalidates A only, never rotates caller into B',async()=>{
    // Pause the scheduler before intentional 401 so a new repair authorization is
    // not confused with a forbidden replay of the failed inference request.
    await c.settings({paused:1,idle_target:0});await c.control(a,'inference','401',{count:1,ttlMs:10000});
    const marker=`${nonce}-a-401`;const rejected=await c.inference(callA,marker,false,c.state.origins.proxyReplicas[2]);assert.equal(rejected.status,401);
    const s=await c.snapshot();assert.equal(markerCount(s,a,marker),1);assert.equal(markerCount(s,b,marker),0);
    const aPool=await c.pool(a),member=aPool.accounts.find((r:any)=>r.identity===originalA.memberIdentity);check(member,'a_member_retained');
    assert.notEqual(member.oauthStatus,'valid');assert.equal(aPool.counts.total,1);
    const maybeLease=aPool.leases.find((r:any)=>r.callerKeyHash===hash(callA));if(maybeLease)assertLeaseStable(originalA,maybeLease);
    const bPool=await c.pool(b);assert.ok(!bPool.leases.some((r:any)=>r.callerKeyHash===hash(callA)));assert.equal(bPool.counts.total,1);
    assert.equal((await c.inference(callB,`${nonce}-b-after-401`,false,c.state.origins.proxyReplicas[1])).status,200);
    assertLeaseStable(originalB,await lease(b,callB));assertNoProvisionReplay(baseline,await c.snapshot(),[a,b]);
    return{upstreamStatus:401,upstreamRequests:1,aCredentialInvalidated:true,crossEnterpriseRotation:false,bStillHealthy:true,repairIntentionallyPaused:true};
  });
}

export async function runInflight(stateFile:string,inspectFile:string,output:string){
  const started=Date.now(),state=loadState(stateFile);
  check(process.env.PHASE5_SYNTHETIC_ONLY==='1'&&stateFile==='/fixture/state.json'&&state.mode==='init','fresh_container_gate');
  absolutePath(inspectFile);within('/results',inspectFile);noSymlinkPath(inspectFile);
  const age=Date.now()-statSync(inspectFile).mtimeMs;check(age>=-30000&&age<300000,'stale_inspection');
  const rows=JSON.parse(readFileSync(inspectFile,'utf8'));
  const services=['provider','sso','login','proxy-1','proxy-2','proxy-3'];
  check(Array.isArray(rows)&&rows.length===services.length,'inspection_cardinality');
  for(const service of services){const id=state.ownership.containers[service]?.id;const matches=rows.filter((r:any)=>r.Id===id);const row=assertOwnedContainer(state,matches,service);check(row.State?.Running===true&&row.State?.Health?.Status==='healthy','initial_health');}
  absolutePath(output);within('/results',output);noSymlinkPath(output);check(dirname(output)==='/results'&&!existsSync(output),'exclusive_output');
  const privateDir=join('/results','private');noSymlinkPath(privateDir);mkdirSync(privateDir,{recursive:true,mode:0o700});
  const nonce=randomUUID(),checks:any[]=[],privateEvents:any[]=[];
  exclusiveJson('/results/inflight-scenario-started.json',{version:1,runId:state.runId,nonce,startedAt:started});
  const c=createClient(loadFixtureConfig(stateFile),INFLIGHT_HARD_LIMIT_MS-8000);
  const step=async(name:string,fn:()=>Promise<unknown>)=>{const at=Date.now();try{const details=await fn();checks.push({name,status:'PASS',elapsedMs:Date.now()-at,details});}catch(error){checks.push({name,status:'FAIL',elapsedMs:Date.now()-at});throw error;}};
  let error:unknown,paused=false;
  try{await inflightScenario(c,nonce,step);}
  catch(caught){error=caught;privateEvents.push({message:(caught as Error)?.message,stack:(caught as Error)?.stack,lastOperation:c.lastOperation});}
  finally{
    const remaining=Math.max(1,INFLIGHT_HARD_LIMIT_MS-(Date.now()-started)-500);
    try{const cleanup=createClient(loadFixtureConfig(stateFile),Math.min(7000,remaining));await cleanup.settings({paused:1,idle_target:0});paused=true;}
    catch(caught){error??=caught;privateEvents.push({cleanupMessage:(caught as Error)?.message,stack:(caught as Error)?.stack});}
  }
  exclusiveJson(join(privateDir,`inflight-${nonce}.json`),{version:1,runId:state.runId,events:privateEvents});
  const report={version:1,runId:state.runId,stage:'inflight-drain-sse',syntheticOnly:true,status:!error&&paused?'PASS':'FAIL',checks,paused,
    hardLimitMs:INFLIGHT_HARD_LIMIT_MS,elapsedMs:Date.now()-started,httpRequests:c.requestCount,realUsers:0,realBrowserDeviceFlow:false,
    preHeaderDelay:true,midBodyStallTested:false,retained:true,error:error?safeError(error):undefined};
  exclusiveJson(output,report);return report;
}
async function main(){const args=process.argv.slice(2);check(args.length===6&&args[0]==='--state'&&args[2]==='--inspect'&&args[4]==='--output','arguments');const result=await runInflight(args[1],args[3],args[5]);process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='PASS')process.exitCode=1;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write(JSON.stringify({status:'FAIL',error:'phase5_inflight_failed'})+'\n');process.exitCode=1;});
