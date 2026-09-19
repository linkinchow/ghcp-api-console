import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {initEnterpriseSqliteV3,validateEnterpriseSqliteV3} from '../../src/packages/shared/src/enterpriseStorageV3.js';
import {validateEnterpriseSqliteV4} from '../../src/packages/shared/src/enterpriseStorageV4.js';
import {sha256} from '../default-enterprise/sqlite.js';
import {registryV3,poolOptionsV3,A,B} from '../multi-enterprise/fixtures.js';
import {runEnterpriseCommandV4} from './commands.js';
import {parseEnterpriseManifestV4,type EnterpriseManifestV4,type SqliteServiceV4} from './manifest.js';
import {preflightEnterpriseSqliteV4,applyEnterpriseSqliteV4,verifyEnterpriseSqliteV4} from './sqlite.js';
function fixture(dir:string,layout:'direct'|'pool'='pool',two=true):EnterpriseManifestV4{
  const registry=registryV3(two),services:SqliteServiceV4[]=[];
  for(const component of ['proxy','sso','login'] as const){const source=join(dir,component+'-v3.sqlite'),db=new Database(source);try{
    initEnterpriseSqliteV3(db,component,registry,component==='proxy'?(layout==='pool'?poolOptionsV3():{layout}):{});
    if(component==='proxy'){
      db.prepare('UPDATE enterprise_profiles SET max_accounts=3 WHERE id=?').run(A);
      const identity=layout==='pool'?'aaliyah.abbott00':'known';
      db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,created_at,updated_at) VALUES(?,?,?,?,'2026-09-18','2026-09-18')`).run(A,randomUUID(),identity,layout==='pool'?identity:'User');
      db.prepare(`INSERT INTO proxy_request_stats(id,identity,requested_at,path,success,input_tokens) VALUES(?,?,?,'/x',1,9007199254740993)`).run('stat',identity,'2026-09-18');
      db.prepare(`INSERT INTO proxy_request_stats(id,identity,requested_at,path,success) VALUES('orphan','gone','2026-09-18','/x',0)`).run();
      if(layout==='pool'){
        db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,attempt_id,updated_at,generation,last_error) VALUES(?,0,'disabled',?,0,9007199254740993,?)`).run(identity,randomUUID(),' bytes \0 unchanged ');
        db.exec("UPDATE user_pool_settings SET next_ordinal=1 WHERE id=1");
        db.prepare("INSERT INTO user_pool_events(at,action,identity) VALUES(1800000000000,'old',?),(0,'old','gone'),(0,'global',NULL),(0,'before-recreated-account',?)").run(identity,identity);
        db.exec('DELETE FROM user_pool_events WHERE id=2');
        db.prepare(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,expires_at) VALUES(?,?,?,'active',1,9999999999999)`).run('sha256:'+'a'.repeat(64),identity,randomUUID());
      }
    }
  }finally{db.close();}services.push({component,driver:'sqlite',layout:component==='proxy'?layout:component,source,target:join(dir,component+'-v4.sqlite'),backup:{reference:component+'-backup',sha256:sha256(readFileSync(source))}});}
  return parseEnterpriseManifestV4({manifestVersion:4,sourceSchemaVersion:3,registry,services,attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true}});
}
for(const layout of ['direct','pool'] as const)test(`SQLite ${layout} migration preserves typed old rows/caps/incarnations, retains unknown history and v3 peers`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'phase4-sqlite-'));try{const manifest=fixture(dir,layout);const originals=manifest.services.map(s=>readFileSync((s as SqliteServiceV4).source!));
    const planOut=join(dir,'plan.json');assert.equal((await runEnterpriseCommandV4('preflight',manifest,{planOut,env:{}})).ready,false);
    const plan=JSON.parse(readFileSync(planOut,'utf8'));const applied=await runEnterpriseCommandV4('apply',plan,{env:{}});assert.equal(applied.ready,true);assert.deepEqual(applied.components.map(c=>c.schemaVersion),[4,3,3]);
    assert.equal((await runEnterpriseCommandV4('verify',plan,{env:{}})).pairedRegistry,true);assert.equal((await runEnterpriseCommandV4('apply',plan,{env:{}})).ready,true);
    const proxy=plan.services[0] as SqliteServiceV4,db=new Database(proxy.target);try{db.pragma('foreign_keys=ON');const state=validateEnterpriseSqliteV4(db,'proxy',plan.registry);assert.equal(state.maxAccounts,layout==='pool'?8:undefined);
      assert.deepEqual(db.prepare('SELECT enterprise_id,state,validation_kind FROM enterprise_pool_policy ORDER BY enterprise_id').all(),[{enterprise_id:A,state:'active',validation_kind:'migration_preserved_v3'},{enterprise_id:B,state:'draft',validation_kind:null}]);
      assert.deepEqual(db.prepare('SELECT id,enterprise_id FROM proxy_request_stats ORDER BY id').all(),[{id:'orphan',enterprise_id:null},{id:'stat',enterprise_id:A}]);
      assert.equal((db.prepare('SELECT input_tokens FROM proxy_request_stats WHERE id=\'stat\'').safeIntegers(true).get() as any).input_tokens,9007199254740993n);
      if(layout==='pool'){assert.equal((db.prepare('SELECT generation FROM user_pool_accounts').safeIntegers(true).get() as any).generation,9007199254740993n);assert.equal(db.prepare('SELECT * FROM user_pool_leases').all().length,1);assert.deepEqual(db.prepare('SELECT id,enterprise_id FROM user_pool_events ORDER BY id').all(),[{id:1,enterprise_id:A},{id:3,enterprise_id:null},{id:4,enterprise_id:null}]);assert.equal((db.prepare('SELECT seq FROM sqlite_sequence WHERE name=\'user_pool_events\'').get() as any).seq,4);}
      assert.throws(()=>db.exec('DELETE FROM enterprise_migration_receipt_v4'),/receipt_required/);
    }finally{db.close();}
    for(let i=0;i<plan.services.length;i++){const s=plan.services[i];assert.deepEqual(readFileSync(s.source),originals[i]);if(s.component!=='proxy')assert.deepEqual(readFileSync(s.target),originals[i]);}
    assert(!JSON.stringify(applied).includes('incarnation'));assert(!JSON.stringify(applied).includes('sourceSha256'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('SQLite v4 gate rejects forged migrated policy with no receipt and rejects malformed immutable receipt',()=>{
  const dir=mkdtempSync(join(tmpdir(),'phase4-sqlite-'));try{const m=fixture(dir),s=m.services[0] as SqliteServiceV4;preflightEnterpriseSqliteV4(s,m.registry);applyEnterpriseSqliteV4(s,m);const db=new Database(s.target);try{db.pragma('foreign_keys=ON');
    db.exec('DROP TRIGGER enterprise_migration_receipt_v4_no_update');assert.throws(()=>validateEnterpriseSqliteV4(db,'proxy',m.registry),/partial_or_unknown/);
  }finally{db.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});
test('pre-account and unparseable request timestamps remain unknown without changing old columns',()=>{
  const dir=mkdtempSync(join(tmpdir(),'phase4-history-'));try{const m=fixture(dir,'direct'),s=m.services[0] as SqliteServiceV4,source=new Database(s.source!);
    try{source.exec("INSERT INTO proxy_request_stats(id,identity,requested_at,path,success) VALUES('before','known','2020-01-01','/x',0),('bad-time','known','not-a-date','/x',0)");}finally{source.close();}
    s.backup!.sha256=sha256(readFileSync(s.source!));preflightEnterpriseSqliteV4(s,m.registry);applyEnterpriseSqliteV4(s,m);verifyEnterpriseSqliteV4(s,m);
    const target=new Database(s.target);try{assert.deepEqual(target.prepare("SELECT id,enterprise_id FROM proxy_request_stats WHERE id IN ('before','bad-time') ORDER BY id").all(),[{id:'bad-time',enterprise_id:null},{id:'before',enterprise_id:null}]);}finally{target.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('preflight stops unpaused, unresolved external work and source drift before output creation',()=>{
  for(const mutation of ["UPDATE user_pool_settings SET paused=0","UPDATE user_pool_accounts SET last_error='ambiguous upstream dispatch'","UPDATE proxy_accounts SET copilot_oauth_attempt_id='pending'"]){
    const dir=mkdtempSync(join(tmpdir(),'phase4-sqlite-'));try{const m=fixture(dir),s=m.services[0] as SqliteServiceV4,db=new Database(s.source!);try{db.exec(mutation);}finally{db.close();}s.backup!.sha256=sha256(readFileSync(s.source!));assert.throws(()=>preflightEnterpriseSqliteV4(s,m.registry));}finally{rmSync(dir,{recursive:true,force:true});}
  }
  const dir=mkdtempSync(join(tmpdir(),'phase4-sqlite-'));try{const m=fixture(dir),s=m.services[0] as SqliteServiceV4;preflightEnterpriseSqliteV4(s,m.registry);const db=new Database(s.source!);db.exec("UPDATE proxy_accounts SET sso_user='changed'");db.close();assert.throws(()=>applyEnterpriseSqliteV4(s,m),/backup_hash/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('mixed Proxy4 plus SSO/Login3 offline append preserves all previous rows including NULL history and caps',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'phase4-register-'));try{const m=fixture(dir,'pool',false),path=join(dir,'plan.json');await runEnterpriseCommandV4('preflight',m,{planOut:path,env:{}});const plan=JSON.parse(readFileSync(path,'utf8'));await runEnterpriseCommandV4('apply',plan,{env:{}});
    const next=registryV3();next.registryRevision=2;
    const registration={manifestVersion:4,sourceSchemaVersion:3,registry:next,previousRegistry:m.registry,attestations:m.attestations,services:plan.services.map((s:SqliteServiceV4)=>({component:s.component,driver:'sqlite',layout:s.layout,source:s.target,target:join(dir,s.component+'-append.sqlite'),backup:{reference:'append-backup',sha256:sha256(readFileSync(s.target))}}))};
    assert.equal((await runEnterpriseCommandV4('register',registration,{env:{}})).ready,true);assert.equal((await runEnterpriseCommandV4('verify',registration,{env:{}})).ready,true);
    const db=new Database(registration.services[0].target);try{db.pragma('foreign_keys=ON');assert.equal(validateEnterpriseSqliteV4(db,'proxy',next).maxAccounts,8);assert.equal((db.prepare('SELECT max_accounts FROM enterprise_profiles WHERE id=?').get(A) as any).max_accounts,3);assert.equal((db.prepare('SELECT state FROM enterprise_pool_policy WHERE enterprise_id=?').get(B) as any).state,'draft');}finally{db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
