import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readEnterpriseMysqlTestGate, withEnterpriseMysqlTestSchema } from '../../upgrade/multi-enterprise-pool/mysqlHarness.js';
import { bounded, registry, sqlBarrier, stores } from './concurrency-fixture.js';
const gate=readEnterpriseMysqlTestGate();

test('phase7 real MySQL concurrent caps and creation at the global boundary (no HTTP)',{
  skip:gate.enabled?false:'No explicit dedicated MySQL schema authorization; real MySQL not executed.',timeout:540_000,
},async t=>withEnterpriseMysqlTestSchema(gate,async h=>{
  const reg=await registry(2,4999),[a,b]=reg.profiles.map(p=>p.id),f=await stores(h,reg,0),sql=h.connection;
  const totals=async()=>{const [rows]=await sql.query<any[]>('SELECT id,max_accounts FROM enterprise_profiles ORDER BY id');return rows.map(r=>({id:r.id,cap:Number(r.max_accounts)}));};
  await t.test('two different enterprise cap rises serialize and cannot oversubscribe sum 10000',async()=>{
    // Each update fits the original 9998 snapshot; together they do not.
    const outcomes=await bounded(Promise.allSettled([f.first.updateEnterprisePolicy(a,1,{type:'cap',maxAccounts:5001}),f.second.updateEnterprisePolicy(b,1,{type:'cap',maxAccounts:5001})]));
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    const rejected=outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.code,'invalid_enterprise_policy');
    assert.equal((await totals()).reduce((n,r)=>n+r.cap,0),10000);
    assert.equal((await f.first.counts()).total,0,'capacity-only test must not create thousands of users');
    const policies=await f.first.enterprisePolicies();assert.deepEqual(policies.map(p=>p.policyVersion).sort(),[1,2]);
  });
  await t.test('same-policy cap CAS rejects stale version rather than consuming a second increment',async()=>{
    const policy=(await f.first.enterprisePolicy(a))!;
    const outcomes=await bounded(Promise.allSettled([f.first.updateEnterprisePolicy(a,policy.policyVersion,{type:'cap',maxAccounts:4998}),f.second.updateEnterprisePolicy(a,policy.policyVersion,{type:'cap',maxAccounts:4997})]));
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'policy_version_conflict');
    assert.equal((await f.first.enterprisePolicy(a))!.policyVersion,policy.policyVersion+1);
    assert.ok((await totals()).reduce((n,r)=>n+r.cap,0)<=10000);
  });
  await t.test('cap-down wins while reservation waits: one bounded transaction sees the new cap',async()=>{
    await f.cap(a,2);await f.cap(b,2);await f.active();await f.drain(b);await f.settings({paused:0,idle_target:4});
    const barrier=sqlBarrier(f.pool,sql=>sql.includes('UPDATE enterprise_profiles SET max_accounts='));
    const writer=new f.MysqlPoolStore(barrier.pool,f.options,reg);await writer.initialize();
    const policy=(await writer.enterprisePolicy(a))!;
    const capDown=writer.updateEnterprisePolicy(a,policy.policyVersion,{type:'cap',maxAccounts:1});
    let pending:Promise<unknown>|undefined,done=false;
    try{await barrier.entered();pending=f.second.reserve().then(row=>{done=true;return row;});await new Promise(r=>setTimeout(r,100));assert.equal(done,false,'reserve must wait on real settings lock');}
    finally{barrier.release();await bounded(Promise.allSettled([capDown,...(pending?[pending]:[])]));}
    await capDown;await pending;
    await bounded(Promise.all([f.first.reserve(),f.second.reserve()]));
    assert.equal((await f.first.counts(a)).total,1);assert.equal((await f.first.counts(b)).total,0);
    assert.equal((await f.first.enterprisePolicy(a))!.maxAccounts,1);
  });
  await t.test('creation wins before drain: row retained, no later registration or dispatch escapes drained A',async()=>{
    await f.cap(a,2);
    const barrier=sqlBarrier(f.pool,sql=>/^INSERT INTO user_pool_accounts\b/.test(sql.trim()));
    const reserving=new f.MysqlPoolStore(barrier.pool,f.options,reg);await reserving.initialize();
    const reserve=reserving.reserve();let drain:Promise<unknown>|undefined,done=false;
    try{await barrier.entered();drain=f.drain(a).then(row=>{done=true;return row;});await new Promise(r=>setTimeout(r,100));assert.equal(done,false);}
    finally{barrier.release();await bounded(Promise.allSettled([reserve,...(drain?[drain]:[])]));}
    const created=await reserve;assert.ok(created);await drain;
    assert.equal((await f.first.counts(a)).total,2,'drain must not evict the committed row');
    assert.equal(await f.second.reserve(),undefined);assert.equal(await f.first.canProvision(created.identity,'advance'),false);
    const row=await f.first.inventory(created.identity);assert.ok(row);assert.equal(row.enterprise_id,a);assert.equal(row.stage,'new');
  });
  await t.test('owner handoff fences stale creation and survives a concurrent cap change',async()=>{
    await f.active();await f.settings({idle_target:5});await f.cap(a,2);await f.cap(b,3);
    const old=randomUUID(),next=randomUUID();assert.equal(await f.first.claimOwner(old),true);
    // Explicit synthetic lease expiry in the dedicated DB test, not a process crash claim.
    await sql.query('UPDATE user_pool_settings SET owner_until=0 WHERE id=1');
    const [claim]=await bounded(Promise.all([f.second.claimOwner(next),f.cap(b,1)]));assert.equal(claim,true);
    assert.equal(await f.first.reserveDeficit(old),0);assert.equal(await f.first.renewOwner(old),false);
    const created=await f.second.reserveDeficit(next,[b]);assert.equal(created,1);
    assert.equal((await f.second.counts(b)).total,1);assert.equal((await f.second.counts(a)).total,2);
    assert.equal(await f.second.reserveDeficit(next,[b]),0);await f.second.releaseOwner(next);
  });
  await t.test('global login capacity and exact generation fences never release another enterprise slot',async()=>{
    const [aRows]=await sql.query<any[]>('SELECT identity FROM proxy_accounts WHERE enterprise_id=? ORDER BY identity',[a]);
    const [bRows]=await sql.query<any[]>('SELECT identity FROM proxy_accounts WHERE enterprise_id=? ORDER BY identity',[b]);
    const aRow=aRows[0],bRow=bRows[0];assert.ok(aRow&&bRow);
    const owner=randomUUID();assert.equal(await f.first.claimOwner(owner),true);
    const originalA=(await f.first.inventory(aRow.identity))!,originalB=(await f.first.inventory(bRow.identity))!;
    await f.first.update(originalA.identity,{state:'provisioning',stage:'oauth-starting'});
    await f.first.update(originalB.identity,{state:'provisioning',stage:'oauth-starting'});
    const fa=(await f.first.inventory(originalA.identity))!,fb=(await f.first.inventory(originalB.identity))!;
    const claimed=await bounded(Promise.all([f.first.claimLoginDispatch(fa.identity,fa,owner,1),f.second.claimLoginDispatch(fb.identity,fb,owner,1)]));
    assert.equal(claimed.filter(Boolean).length,1);
    const winner=claimed[0]?fa:fb,loser=claimed[0]?fb:fa;
    await f.first.update(winner.identity,{state:'disabled',task_id:randomUUID(),oauth_attempt_id:randomUUID()});
    const held=(await f.first.inventory(winner.identity))!;
    assert.equal(await f.second.releaseLoginReservation(loser.identity,held,owner,'failed'),false);
    assert.equal(await f.second.releaseLoginReservation(winner.identity,held,'stale-owner','failed'),false);
    assert.equal((await f.first.inventory(winner.identity))!.stage,'oauth-dispatch');
    assert.equal(await f.first.releaseLoginReservation(winner.identity,held,owner,'failed'),true);
    assert.equal(await f.second.releaseLoginReservation(winner.identity,held,owner,'failed'),false,'fence cannot release twice');
    const other=(await f.first.inventory(loser.identity))!;
    assert.equal(await f.second.claimLoginDispatch(other.identity,other,owner,1),true,'healthy other enterprise progresses only after exact closure');
    assert.equal((await f.first.inventory(loser.identity))!.enterprise_id,loser.enterprise_id);
    await f.first.releaseOwner(owner);
  });
}));
