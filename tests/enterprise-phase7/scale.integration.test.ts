import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readEnterpriseMysqlTestGate, withEnterpriseMysqlTestSchema } from '../../upgrade/multi-enterprise-pool/mysqlHarness.js';
import { bounded, registry, stores } from './concurrency-fixture.js';
const gate=readEnterpriseMysqlTestGate();

test('phase7 real MySQL 100-profile bounded functional qualification, not a performance benchmark',{
  skip:gate.enabled?false:'No explicit dedicated MySQL schema authorization; real MySQL not executed.',timeout:540_000,
},async t=>withEnterpriseMysqlTestSchema(gate,async h=>{
  const reg=await registry(100,100),f=await stores(h,reg,100),owner=randomUUID();
  await f.active();await f.settings({paused:0});assert.equal(await f.first.claimOwner(owner),true);
  await t.test('100 profiles fit sum 10000; bounded batches create 100 synthetic local rows, no SCIM',async()=>{
    const batches:number[]=[];
    // Five bounded calls are enough at production reservation batch=32; no open-ended fill loop.
    for(let n=0;n<5;n++){
      assert.equal(await f.first.renewOwner(owner),true);
      const count=await f.first.reserveDeficit(owner);assert.ok(count>=0&&count<=32);batches.push(count);
    }
    assert.equal(batches.reduce((n,v)=>n+v,0),100);assert.equal((await f.first.counts()).total,100);
    const [rows]=await h.connection.query<any[]>(`SELECT a.enterprise_id,COUNT(*) n FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity GROUP BY a.enterprise_id`);
    assert.equal(rows.length,100);assert.ok(rows.every(r=>Number(r.n)===1),'equal profiles receive one global-name reservation each');
    const [names]=await h.connection.query<any[]>('SELECT identity,ordinal FROM user_pool_accounts ORDER BY ordinal');
    assert.equal(new Set(names.map(r=>r.identity)).size,100);assert.deepEqual(names.map(r=>Number(r.ordinal)),Array.from({length:100},(_,i)=>i));
    const [attempts]=await h.connection.query<any[]>('SELECT COUNT(*) n FROM proxy_authorization_attempts');assert.equal(Number(attempts[0].n),0);
  });
  await t.test('overview remains exact after draining ten profiles and reducing caps',async()=>{
    // Small groups limit concurrency; these are functional assertions, not timing/throughput metrics.
    for(let start=0;start<10;start+=2)await bounded(Promise.all(reg.profiles.slice(start,start+2).map(p=>f.drain(p.id))));
    for(const p of reg.profiles.slice(10,15))await f.cap(p.id,1);
    const overview=await f.first.enterpriseOverview();assert.equal(overview.enterprises.length,100);
    assert.equal(overview.enterprises.filter(p=>p.state==='draining').length,10);
    assert.equal(overview.enterprises.reduce((n,p)=>n+p.counts.total,0),100);
    assert.equal(overview.names.nextOrdinal,100);assert.equal(overview.names.remainingPositions,9900);
    assert.equal(overview.settings.max_accounts,9505);assert.equal(overview.settings.active_max_accounts,8505);
    for(const p of reg.profiles.slice(0,10)){
      const [rows]=await h.connection.query<any[]>('SELECT identity FROM proxy_accounts WHERE enterprise_id=?',[p.id]);
      assert.equal(rows.length,1);assert.equal(await f.first.canProvision(rows[0].identity,'advance'),false);
    }
    const before=await f.first.counts();assert.equal(before.total,100,'capacity edits/drain never evict inventory');
  });
  await t.test('a restarted real store preserves all profile and global name state without network work',async()=>{
    const restarted=new f.MysqlPoolStore(f.pool,f.options,reg);await restarted.initialize();
    const a=await f.first.enterpriseOverview(),b=await restarted.enterpriseOverview();
    assert.deepEqual(b.enterprises,a.enterprises);assert.deepEqual(b.names,a.names);assert.deepEqual(b.settings,a.settings);
    assert.equal((await restarted.accounts()).length,100);
    assert.equal(await restarted.reserveDeficit('stale-owner'),0);
  });
  await f.first.releaseOwner(owner);
}));
