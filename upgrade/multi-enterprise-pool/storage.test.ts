import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initEnterpriseSqliteV4, validateEnterpriseSqliteV4, registerEnterpriseSqliteV4, getExpectedEnterpriseSqliteV4 } from '../../src/packages/shared/src/enterpriseStorageV4.js';
import { getExpectedEnterpriseSqliteV3, initEnterpriseSqliteV3, validateEnterpriseSqliteV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
import { getExpectedEnterpriseMysqlV3 } from '../../src/packages/shared/src/enterpriseMysqlSchemaV3.js';
import { getExpectedEnterpriseMysqlV4 } from '../../src/packages/shared/src/enterpriseMysqlSchemaV4.js';
import { enterpriseProfileIdentityHashV4 } from '../../src/packages/shared/src/enterpriseRuntimeV4.js';
import { registryV3, poolOptionsV3, A, B } from '../multi-enterprise/fixtures.js';

test('SQLite v4 fresh direct/pool are strict derived v3, all draft, independently bounded target',()=>{
  for(const layout of ['direct','pool'] as const){const db=new Database(':memory:');try{
    const options=poolOptionsV3();options.pool.settings.idle_target=10000;
    const state=initEnterpriseSqliteV4(db,'proxy',registryV3(),layout==='pool'?options:{layout});assert.equal(state.layout,layout);
    assert.deepEqual(db.prepare('SELECT state,validation_kind,validated_at FROM enterprise_pool_policy').all(),[
      {state:'draft',validation_kind:null,validated_at:null},{state:'draft',validation_kind:null,validated_at:null}]);
    if(layout==='pool'){assert.equal(state.maxAccounts,10);assert.equal((db.prepare('SELECT paused FROM user_pool_settings').get() as any).paused,1);}
    const before=db.serialize();validateEnterpriseSqliteV4(db,'proxy',registryV3());assert.deepEqual(db.serialize(),before);
    assert.throws(()=>validateEnterpriseSqliteV3(db,'proxy',registryV3()));assert.throws(()=>db.prepare('DELETE FROM enterprise_pool_policy WHERE enterprise_id=?').run(A));
    db.exec('CREATE TABLE unexpected(x)');assert.throws(()=>validateEnterpriseSqliteV4(db,'proxy',registryV3()),/partial_or_unknown/);
  }finally{db.close();}}
});
test('v4 never reinterprets or automatically migrates v3; paused init mandatory',()=>{
  const db=new Database(':memory:');try{initEnterpriseSqliteV3(db,'proxy',registryV3(),poolOptionsV3());const original=db.serialize();
    assert.throws(()=>validateEnterpriseSqliteV4(db,'proxy',registryV3()),/partial_or_unknown/);assert.deepEqual(db.serialize(),original);
  }finally{db.close();}
  const empty=new Database(':memory:');try{const o=poolOptionsV3();(o.pool.settings as any).paused=0;assert.throws(()=>initEnterpriseSqliteV4(empty,'proxy',registryV3(),o),/empty_paused/);assert.equal(empty.prepare('SELECT name FROM sqlite_schema').all().length,0);}finally{empty.close();}
});
test('offline append preserves old DB cap and policy rows',()=>{
  const db=new Database(':memory:');try{const before=registryV3(false),next=registryV3();next.registryRevision=2;
    initEnterpriseSqliteV4(db,'proxy',before,poolOptionsV3());db.prepare('UPDATE enterprise_profiles SET max_accounts=2 WHERE id=?').run(A);
    const policy=db.prepare('SELECT * FROM enterprise_pool_policy').get();registerEnterpriseSqliteV4(db,'proxy',before,next);
    assert.deepEqual(db.prepare('SELECT * FROM enterprise_pool_policy WHERE enterprise_id=?').get(A),policy);
    assert.equal((db.prepare('SELECT max_accounts FROM enterprise_profiles WHERE id=?').get(A) as any).max_accounts,2);
    assert.equal((db.prepare('SELECT state FROM enterprise_pool_policy WHERE enterprise_id=?').get(B) as any).state,'draft');
    assert.equal(validateEnterpriseSqliteV4(db,'proxy',next).maxAccounts,7);
  }finally{db.close();}
});
test('v4 shapes preserve all old objects except marker and legacy guards; nullable scopes restrict without account cascade',()=>{
  for(const layout of ['direct','pool'] as const){
    const old=getExpectedEnterpriseSqliteV3(layout),next=getExpectedEnterpriseSqliteV4(layout);
    for(const o of old.objects.filter(o=>!['enterprise_schema','proxy_request_stats','user_pool_events','user_pool_legacy_only_insert','user_pool_legacy_only_update'].includes(o.name)))assert.deepEqual(next.objects.find(n=>n.name===o.name),o);
    const mysqlOld=getExpectedEnterpriseMysqlV3(layout),mysqlNext=getExpectedEnterpriseMysqlV4(layout);
    assert(!mysqlNext.triggers.enterprise_pool_legacy_insert);assert(!mysqlNext.triggers.enterprise_pool_legacy_update);
    for(const [name,tr]of Object.entries(mysqlOld.triggers).filter(([n])=>!n.startsWith('enterprise_pool_legacy_')))assert.deepEqual(mysqlNext.triggers[name],tr);
    for(const t of ['proxy_request_stats',...(layout==='pool'?['user_pool_events']:[])]){
      assert.equal(mysqlNext.schema[t].columns.enterprise_id,'VARCHAR(36) COLLATE ascii_bin');assert.deepEqual(mysqlNext.schema[t].foreign,[['enterprise_id','enterprise_profiles','id','RESTRICT']]);
      for(const [k,v]of Object.entries(mysqlOld.schema[t].columns))assert.equal(mysqlNext.schema[t].columns[k],v);
    }
  }
});
test('v4 gate rejects forged migration-preserved active state without receipt',()=>{
  const db=new Database(':memory:');try{initEnterpriseSqliteV4(db,'proxy',registryV3(),poolOptionsV3());
    db.prepare("UPDATE enterprise_pool_policy SET state='active',validation_kind='migration_preserved_v3',validated_at=updated_at WHERE enterprise_id=?").run(A);
    assert.throws(()=>validateEnterpriseSqliteV4(db,'proxy',registryV3()),/migration_evidence_missing/);
  }finally{db.close();}
});
test('profile identity hash excludes only cap, includes every parsed trusted config change',()=>{
  const p=registryV3().profiles[0],h=enterpriseProfileIdentityHashV4(p);assert.equal(h,enterpriseProfileIdentityHashV4({...p,maxAccounts:9999}));
  assert.notEqual(h,enterpriseProfileIdentityHashV4({...p,revision:2}));assert.notEqual(h,enterpriseProfileIdentityHashV4({...p,sso:{...p.sso,signingKeyRef:{env:'OTHER_KEY'}}}));
  assert.notEqual(h,enterpriseProfileIdentityHashV4({...p,login:{...p.login,selectors:{...p.login.selectors,user:'#different'}}}));
});
