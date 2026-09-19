import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { boundedInteger, HARD_LIMIT_MS, sleep } from './runtime-common.js';
import type { Client } from './fullstack.js';

/** A bounded functional observation, not a throughput benchmark or overnight soak. */
export async function stableWindow(c:Client,step:(name:string,fn:()=>Promise<unknown>)=>Promise<void>,options:{durationMs:number;maxInferenceRequests:number}) {
  const duration=boundedInteger(options.durationMs,1000,HARD_LIMIT_MS,'stable_duration');
  const max=boundedInteger(options.maxInferenceRequests,1,600,'stable_requests');
  // Leave room for the final audit under the parent's absolute ten-minute deadline.
  const until=Math.min(Date.now()+duration,c.deadline-2000);
  const ids=c.state.enterpriseIds,initial=await c.snapshot();
  await c.settings({idle_target:0,paused:0});
  const initialPools=await Promise.all(ids.map((id:string)=>c.pool(id)));
  const liveMembers=initialPools.flatMap((p:any)=>p.accounts).filter((a:any)=>a.state==='ready');
  assert.ok(liveMembers.length>=2,'stable_requires_two_ready_members');
  const callers=Array.from({length:Math.min(3,liveMembers.length)},(_,i)=>`phase5-${c.state.runId}-stable-${i}`);
  const samples:Array<{elapsedMs:number;requests:number;success:number;unavailable:number;owners:number}>=[];
  const started=Date.now();let requests=0,success=0,unavailable=0;let nextSample=started;
  const interval=Math.max(250,Math.ceil(duration/max));
  while(Date.now()<until&&requests<max){
    const marker=`${c.state.runId}-stable-${requests}`;
    const r=await c.inference(callers[requests%callers.length],marker,requests%2===1);requests++;
    if(r.status===200)success++;else if([202,409,429,503].includes(r.status))unavailable++;else throw new Error(`stable_unexpected_http_${r.status}`);
    const snap=await c.snapshot();
    const upstream=snap.enterprises.reduce((n:number,e:any)=>n+(e.markers[`phase5-request:${marker}`]?.inference??0),0);
    assert.ok(upstream<=1,'stable_request_replayed');if(r.status===200)assert.equal(upstream,1);
    if(Date.now()>=nextSample){
      const diagnostics=await Promise.all(c.state.origins.proxyReplicas.map(async(origin:string)=>{
        try{return await c.api(`/api/profiles/${ids[0]}/user-pool/diagnostics/local`,'GET',undefined,origin);}catch{return undefined;}
      }));
      const pools=await Promise.all(ids.map((id:string)=>c.pool(id))),leases=pools.flatMap((p:any)=>p.leases);
      assert.equal(new Set(leases.map((l:any)=>l.memberIdentity)).size,leases.length,'member_double_lease');
      assert.equal(new Set(leases.map((l:any)=>l.callerKeyHash)).size,leases.length,'caller_double_lease');
      const owners=diagnostics.filter((d:any)=>d?.localScheduler?.state==='owner').length;
      // A local stale owner observation is diagnostic, not proof of duplicate durable ownership.
      samples.push({elapsedMs:Date.now()-started,requests,success,unavailable,owners});
      await step(`stable window sample ${samples.length}`,async()=>samples[samples.length-1]);nextSample=Date.now()+60_000;
    }
    await sleep(Math.min(interval,Math.max(0,until-Date.now())),c.signal);
  }
  await step('stable final audit: no replay, no extra external account operations, ready stock retained',async()=>{
    assert.ok(success>0);const final=await c.snapshot();
    for(const id of ids){
      const before=initial.enterprises.find((e:any)=>e.enterpriseId===id),after=final.enterprises.find((e:any)=>e.enterpriseId===id);
      for(const key of ['scim-create','seat-assign'])assert.equal(after.counts[key]??0,before.counts[key]??0,`unexpected_${key}`);
    }
    return {elapsedMs:Date.now()-started,hardLimitMs:HARD_LIMIT_MS,requests,requestCap:max,success,unavailable,samples,
      externalOwnerFault:'NOT_INJECTED_BY_RUNNER; main controller must supply separate evidence'};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {runCli}=await import('./fullstack.js');
  if(!process.argv.includes('--mode'))process.argv.push('--mode','stable');await runCli(stableWindow);
}
