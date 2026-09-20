import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoReplay, assertSameBinding, observeLbRecovery, onlyOwner, successfulSurvivor } from './process-probe.js';
import { registry, sqlBarrier, bounded } from './concurrency-fixture.js';

test('authoritative replay assertion rejects new SCIM seat Login and durable authorization attempts',()=>{
  const before={provider:{enterprises:[{enterpriseId:'a',counts:{'scim-create':1,'seat-assign':1,authorize:1},scimUsers:1,seats:1}]},
    members:[{identity:'synthetic',enterprise_id:'a',attempt_id:'p',attempts:0,account_incarnation:'i'}],
    ledger:[{oauth_attempt_id:'o',enterprise_id:'a',identity:'synthetic',account_incarnation:'i'}]};
  assertNoReplay(before,structuredClone(before));
  for(const operation of ['scim-create','seat-assign','authorize']){const after=structuredClone(before);after.provider.enterprises[0].counts[operation as 'authorize']++;assert.throws(()=>assertNoReplay(before,after));}
  for(const field of ['attempt_id','account_incarnation']){const after=structuredClone(before);after.members[0][field as 'attempt_id']='changed';assert.throws(()=>assertNoReplay(before,after));}
  const after=structuredClone(before);after.ledger.push({...after.ledger[0],oauth_attempt_id:'new'});assert.throws(()=>assertNoReplay(before,after));
});
test('task identity and enterprise are immutable across restart, local owner is not a durable DB proof',()=>{
  const task={id:'task',enterpriseId:'a',enterpriseRevision:1,identity:'synthetic',accountIncarnation:'i',oauthAttemptId:'o',expectedGhLogin:'u',attempts:1};
  assertSameBinding(task,{...task,status:'cancelled'});
  for(const field of Object.keys(task))assert.throws(()=>assertSameBinding(task,{...task,[field]:'changed'}));
  const rows=['proxy-1','proxy-2','proxy-3'].map((service,i)=>({service,status:200,state:i===1?'owner':'standby'}));
  assert.equal(onlyOwner(rows),'proxy-2');assert.equal(onlyOwner(rows,'proxy-2'),undefined);
  assert.equal(onlyOwner(rows.map(r=>({...r,state:'owner'}))),undefined);
  assert.throws(()=>onlyOwner(rows.slice(1)));
});
test('100-profile synthetic registry has unique valid profiles at sum 10000 without opening storage',async()=>{
  const reg=await registry(100,100);assert.equal(reg.profiles.length,100);assert.equal(reg.profiles.reduce((n,p)=>n+p.maxAccounts,0),10000);
  for(const key of ['id','slug','shortcode','accountDomain'] as const)assert.equal(new Set(reg.profiles.map(p=>p[key])).size,100);
  await assert.rejects(registry(101,100));await assert.rejects(registry(100,101));
});
test('SQL barrier waits only after actual result and always has a bounded exit',async()=>{
  const calls:string[]=[];const connection={async query(sql:string){calls.push(sql);return[[{n:1}]];},async execute(sql:string){calls.push(sql);return[{affectedRows:1}];},release(){}};
  const barrier=sqlBarrier({async getConnection(){return connection;}} as any,s=>s==='LOCK');
  const intercepted=await barrier.pool.getConnection();let done=false;
  const pending=intercepted.query('LOCK').then(result=>{done=true;return result;});
  try{await barrier.entered();assert.deepEqual(calls,['LOCK']);assert.equal(done,false);}finally{barrier.release();}
  assert.deepEqual(await pending,[[{n:1}]]);assert.equal(done,true);
  await assert.rejects(bounded(new Promise(()=>{}),10),/bounded_wait/);
});
test('survivor must be an exact nonkilled service with a successful direct diagnostic',()=>{
  const rows=[{service:'proxy-1',status:0,state:null},{service:'proxy-2',status:200,state:'standby'},{service:'proxy-3',status:200,state:'owner'}];
  assert.equal(successfulSurvivor(rows,'proxy-1'),'proxy-2');
  assert.equal(successfulSurvivor(rows,'proxy-2'),'proxy-3');
  assert.throws(()=>successfulSurvivor(rows,'mysql'));
  assert.throws(()=>successfulSurvivor(rows.map(r=>({...r,status:0})),'proxy-1'));
  assert.throws(()=>successfulSurvivor([rows[0],rows[1],rows[1]],'proxy-1'));
});
test('LB convergence requires twenty healthy GET observations spanning five seconds, not six lucky responses',async()=>{
  let now=0,calls=0;
  const result=await observeLbRecovery(async()=>{calls++;return 200;},{now:()=>now,sleep:async ms=>{now+=ms;}});
  assert.equal(calls,21);assert.equal(result.healthySpanMs,5000);assert.equal(result.consecutiveHealthy,21);assert.equal(result.failedObservations,0);
});
test('one failed LB observation resets full healthy window; finite persistent failures cannot pass',async()=>{
  let now=0,calls=0;
  const result=await observeLbRecovery(async()=>{calls++;return calls===10?503:200;},{now:()=>now,sleep:async ms=>{now+=ms;}});
  assert.equal(result.failedObservations,1);assert.equal(result.consecutiveHealthy,21);assert.equal(result.healthySpanMs,5000);assert.equal(now,7500);
  now=0;calls=0;
  await assert.rejects(observeLbRecovery(async()=>{calls++;throw new Error('unavailable');},{now:()=>now,sleep:async ms=>{now+=ms;}}),/lb_recovery_deadline/);
  assert.equal(now,15000);assert.ok(calls<=64);
});
