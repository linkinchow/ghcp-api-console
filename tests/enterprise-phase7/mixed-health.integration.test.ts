import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readEnterpriseMysqlTestGate, withEnterpriseMysqlTestSchema } from '../../upgrade/multi-enterprise-pool/mysqlHarness.js';
import { bounded, registry, stores } from './concurrency-fixture.js';
const gate=readEnterpriseMysqlTestGate();

test('phase7 100 real DB policies: bounded mixed-readiness scans reach healthy tail and reserve/admit only there',{
  skip:gate.enabled?false:'No explicit dedicated MySQL schema authorization; real MySQL not executed.',timeout:120_000,
},async t=>withEnterpriseMysqlTestSchema(gate,async h=>{
  const reg=await registry(100,100),f=await stores(h,reg,3),owner=randomUUID();
  const {realProvisioner}=await import('../../src/proxy/src/userPool/provisioner.js');
  await f.active();await f.settings({paused:0});assert.equal(await f.first.claimOwner(owner),true);
  const policies=await f.first.enterprisePolicies();assert.equal(policies.length,100);
  const ids=policies.map(p=>p.enterpriseId),hung=new Set(ids.slice(0,16)),healthy=ids[99],unavailable=ids[0];
  // One synthetic inventory row in an unavailable enterprise must not turn an
  // empty eligibility set into an unrestricted creation pass. No SCIM is run.
  await f.settings({idle_target:1});
  assert.equal(await f.first.reserveDeficit(owner,[unavailable]),1);
  await f.settings({idle_target:3});
  const called=new Set<string>(),capacityRead=new Set<string>();let concurrent=0,maxConcurrent=0,aborted=0,httpCalls=0;
  const adapter=realProvisioner(f.first,f.options,{
    enterpriseProfile:id=>reg.profiles.find(p=>p.id===id)!,
    async verifyReadiness(profile,signal){
      called.add(profile.id);concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
      try{
        if(hung.has(profile.id))await new Promise<void>((_resolve,reject)=>{
          const abort=()=>{aborted++;reject(new Error('synthetic_readiness_timeout'));};
          if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
        });
        else if(ids.indexOf(profile.id)%3===0 && profile.id!==healthy)throw new Error('synthetic_unavailable');
      }finally{concurrent--;}
    },
    async creationCapacity(profile){
      capacityRead.add(profile.id);
      if(profile.id===healthy)return true;
      if(ids.indexOf(profile.id)%2===0)throw new Error('synthetic_capacity_unknown');
      return false;
    },
    fetch:async()=>{httpCalls++;throw new Error('phase7_network_forbidden');},
  });
  const started=performance.now();
  const first=await bounded(adapter.eligibleEnterprises!(AbortSignal.timeout(5500),owner),6000);
  assert.deepEqual(first,[]);assert.equal(await f.first.reserveDeficit(owner,first),0);
  assert.equal((await f.first.counts()).total,1);assert.equal(concurrent,0);
  assert.equal(await f.first.renewOwner(owner),true);
  const second=await bounded(adapter.eligibleEnterprises!(AbortSignal.timeout(5500),owner),6000);
  assert.deepEqual(second,[healthy],'second scan must reach the healthy tail past permanently stalled prefix');
  assert.ok(called.has(healthy));assert.ok(capacityRead.has(healthy));assert.ok(aborted>=16);assert.ok(maxConcurrent<=4);assert.equal(concurrent,0);
  assert.ok(performance.now()-started<14000,'two production scans stay in the bounded functional window');
  assert.equal(await f.second.reserveDeficit(owner,second),2);
  const [rows]=await h.connection.query<any[]>(`SELECT p.identity,p.state,a.enterprise_id FROM user_pool_accounts p
    JOIN proxy_accounts a ON a.identity=p.identity ORDER BY p.ordinal`);
  assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.enterprise_id===unavailable).length,1);
  const healthyRows=rows.filter(r=>r.enterprise_id===healthy);assert.equal(healthyRows.length,2);
  assert.ok(rows.every(r=>r.enterprise_id===healthy||r.enterprise_id===unavailable));
  for(const row of healthyRows){
    await h.connection.query("UPDATE proxy_accounts SET copilot_oauth_token=?,copilot_oauth_status='valid' WHERE identity=?",[`synthetic-phase7-${row.identity}`,row.identity]);
    assert.equal(await f.first.update(row.identity,{state:'ready',stage:'ready',verified_at:await f.first.now()}),true);
  }
  const caller=(n:number)=>`sha256:${n.toString(16).padStart(64,'0')}`;
  const admitted=await bounded(Promise.all([f.first.acquire(caller(771)),f.second.acquire(caller(772))]));
  assert.equal(new Set(admitted.map(r=>r.member_identity)).size,2);assert.ok(admitted.every(r=>r.enterprise_id===healthy));
  for(const held of admitted)await f.first.finish(held,true);
  const leases=await f.first.leases();assert.equal(leases.length,2);
  const [attempts]=await h.connection.query<any[]>('SELECT COUNT(*) n FROM proxy_authorization_attempts');assert.equal(Number(attempts[0].n),0);
  assert.equal(httpCalls,0);await f.first.releaseOwner(owner);
  t.diagnostic('100 real MySQL profiles; mocked readiness/capacity only; two bounded scans; 1 unavailable retained row, 2 healthy-tail reservations/admissions; zero SCIM/HTTP; not a fullstack or performance test.');
}));
