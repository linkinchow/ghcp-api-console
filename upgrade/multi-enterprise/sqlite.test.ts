import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initEnterpriseSqlite } from '../../src/packages/shared/src/enterpriseStorage.js';
import { validateEnterpriseSqliteV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
import { readStandaloneSqlite,sha256 } from '../default-enterprise/sqlite.js';
import { applyEnterpriseSqliteV3,preflightEnterpriseSqliteV3,verifyEnterpriseSqliteV3,registerEnterpriseSqliteFileV3 } from './sqlite.js';
import { legacyProfileV2,type EnterpriseManifestV3,type SqliteServiceV3 } from './manifest.js';
import { registryV3,poolOptionsV3,A,B } from './fixtures.js';
const now='2026-09-18T00:00:00.000Z';
function fixture(root:string):EnterpriseManifestV3 {
  const registry=registryV3();
  const services:SqliteServiceV3[]=(['proxy','sso','login'] as const).map(component=>{
    const layout=component==='proxy'?'pool':component,db=new Database(':memory:');
    try {
      initEnterpriseSqlite(db,component,legacyProfileV2(registry),component==='proxy'?{...poolOptionsV3(),maxAccounts:7}:{});
      db.prepare(`INSERT INTO enterprise_migration_receipt VALUES(1,?,?,?,?,?)`).run('1'.repeat(64),'2'.repeat(64),'phase2-backup','8ad76d5','3'.repeat(64));
      if(component==='proxy') {
        db.prepare(`INSERT INTO proxy_accounts(enterprise_id,identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at)
          VALUES(?,'001','001','test_emu','synthetic-token','valid',?,?,?)`).run(A,now,now,now);
        db.prepare("UPDATE user_pool_settings SET next_ordinal=1").run();
        db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,sso_created_at,updated_at,verified_at,generation)
          VALUES('001',0,'ready','ready','historical-pool-attempt',?,1,1,17)`).run(now);
        db.prepare(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at)
          VALUES(?,'001','lease-preserved','active',1,2,9999999999999)`).run('sha256:'+'a'.repeat(64));
        db.prepare(`INSERT INTO user_pool_events(id,at,action) VALUES(99,1,'historical')`).run();
        db.prepare('DELETE FROM user_pool_events').run();
      }else if(component==='sso') {
        db.prepare(`INSERT INTO sso_users(enterprise_id,sso_user,password_hash,salt,email,created_at,updated_at) VALUES(?,'ALIce','hash-byte-preserved','salt-preserved','alice@example.test',?,?)`).run(A,now,now);
        db.prepare('INSERT INTO sso_pool_managed_users(enterprise_id,sso_user) VALUES(?,?)').run(A,'ALIce');
        db.prepare(`INSERT INTO sso_emu_import_plans(enterprise_id,id,status,created_at,updated_at) VALUES(?,'old-plan','ready',?,?)`).run(A,now,now);
        db.prepare(`INSERT INTO sso_emu_import_plan_rows(enterprise_id,plan_id,row_index,sso_user,status,detail,created_at,updated_at) VALUES(?,'old-plan',0,'ALIce','pending_update','old-preview',?,?)`).run(A,now,now);
      }else db.prepare(`INSERT INTO login_tasks(enterprise_id,id,identity,sso_user,oauth_attempt_id,sso_type,status,attempts,created_at)
        VALUES(?,'history','001','ALIce','legacy-arbitrary-nonce','custom','success',2,?)`).run(A,now);
      const source=join(root,`${component}.source.db`),target=join(root,`${component}.target.db`),bytes=db.serialize();writeFileSync(source,bytes);
      return {component,driver:'sqlite',layout,source,target,backup:{reference:`backup-${component}`,sha256:sha256(bytes)}};
    }finally{db.close();}
  });
  return {manifestVersion:3,sourceSchemaVersion:2,registry,services,attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true}};
}
test('schema2->3 standalone migration preserves all old columns, receipts, case, sequences and protected incarnation plan',()=>{
  const root=mkdtempSync(join(tmpdir(),'enterprise-v3-migration-'));try {
    const manifest=fixture(root),services=manifest.services as SqliteServiceV3[],sources=services.map(service=>readFileSync(service.source!));
    for(const service of services)preflightEnterpriseSqliteV3(service,manifest.registry);
    const mapping=JSON.stringify(services.map(service=>[service.accountIncarnations,service.userIncarnations]));
    for(const service of services)preflightEnterpriseSqliteV3(service,manifest.registry);
    assert.equal(JSON.stringify(services.map(service=>[service.accountIncarnations,service.userIncarnations])),mapping);
    for(const [i,service] of services.entries()) {
      assert.equal(applyEnterpriseSqliteV3(service,manifest).state,'complete');assert.equal(verifyEnterpriseSqliteV3(service,manifest).originalColumnsPreserved,true);
      assert.deepEqual(readFileSync(service.source!),sources[i]);assert.equal(applyEnterpriseSqliteV3(service,manifest).state,'already-complete');
      const {db}=readStandaloneSqlite(service.target);try {
        validateEnterpriseSqliteV3(db,service.component,manifest.registry);
        assert.equal((db.prepare('SELECT backup_reference FROM enterprise_migration_receipt').get() as {backup_reference:string}).backup_reference,'phase2-backup');
        if(service.component==='proxy') {
          assert.equal((db.prepare('SELECT generation FROM user_pool_accounts').get() as {generation:number}).generation,17);
          assert.equal((db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('user_pool_events') as {seq:number}).seq,99);
          assert.equal((db.prepare('SELECT max_accounts FROM enterprise_profiles WHERE id=?').get(A) as {max_accounts:number}).max_accounts,7);
          assert.equal((db.prepare('SELECT lease_id FROM user_pool_leases').get() as {lease_id:string}).lease_id,'lease-preserved');
        }else if(service.component==='sso') {
          assert.equal((db.prepare('SELECT sso_user FROM sso_users').get() as {sso_user:string}).sso_user,'ALIce');
          assert.equal((db.prepare('SELECT expected_user_incarnation FROM sso_emu_import_plan_rows').get() as {expected_user_incarnation:null}).expected_user_incarnation,null);
          assert.equal((db.prepare('SELECT COUNT(*) n FROM sso_users WHERE enterprise_id=?').get(B) as {n:number}).n,0);
        }else {
          const task=db.prepare('SELECT * FROM login_tasks').get() as Record<string,unknown>;assert.equal(task.binding_version,1);assert.equal(task.account_incarnation,null);
          db.prepare('DELETE FROM login_tasks').run();assert.equal((db.prepare('SELECT COUNT(*) n FROM login_legacy_nonce_tombstones').get() as {n:number}).n,1);
        }
      }finally{db.close();}
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('preflight rejects running tasks, case ambiguity, source drift and unprotected incarnation regeneration',()=>{
  const root=mkdtempSync(join(tmpdir(),'enterprise-v3-reject-'));try {
    const manifest=fixture(root),services=manifest.services as SqliteServiceV3[];
    const login=services.find(service=>service.component==='login')!,{db}=readStandaloneSqlite(login.source!);
    db.prepare("UPDATE login_tasks SET status='running'").run();writeFileSync(login.source!,db.serialize());db.close();login.backup!.sha256=sha256(readFileSync(login.source!));
    assert.throws(()=>preflightEnterpriseSqliteV3(login,manifest.registry),/pending_login_tasks/);
    const sso=services.find(service=>service.component==='sso')!,loaded=readStandaloneSqlite(sso.source!);
    loaded.db.prepare(`INSERT INTO sso_users(enterprise_id,sso_user,password_hash,salt,email,created_at,updated_at) VALUES(?,'alice','hash','salt','x@example.test',?,?)`).run(A,now,now);
    writeFileSync(sso.source!,loaded.db.serialize());loaded.db.close();sso.backup!.sha256=sha256(readFileSync(sso.source!));
    assert.throws(()=>preflightEnterpriseSqliteV3(sso,manifest.registry),/case_ambiguous/);
    const proxy=services[0];assert.throws(()=>applyEnterpriseSqliteV3(proxy,manifest),/bound_plan/);
    preflightEnterpriseSqliteV3(proxy,manifest.registry);proxy.originalColumnsSha256='0'.repeat(64);
    assert.throws(()=>preflightEnterpriseSqliteV3(proxy,manifest.registry),/source_fidelity/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('standalone registration writes a new exclusive output without copying users or rewriting source',()=>{
  const root=mkdtempSync(join(tmpdir(),'enterprise-v3-register-'));try {
    const manifest=fixture(root),sso=(manifest.services as SqliteServiceV3[]).find(service=>service.component==='sso')!;
    manifest.registry=registryV3(false);preflightEnterpriseSqliteV3(sso,manifest.registry);applyEnterpriseSqliteV3(sso,manifest);
    const source=sso.target,bytes=readFileSync(source),next=registryV3();next.registryRevision=2;
    const register:EnterpriseManifestV3={...manifest,registry:next,previousRegistry:manifest.registry};
    const service:SqliteServiceV3={component:'sso',driver:'sqlite',layout:'sso',source,target:join(root,'sso.registered.db'),backup:{reference:'pre-register',sha256:sha256(bytes)}};
    assert.equal(registerEnterpriseSqliteFileV3(service,register).state,'registered');assert.deepEqual(readFileSync(source),bytes);
    assert.equal(verifyEnterpriseSqliteV3(service,register).originalColumnsPreserved,true);
    const {db}=readStandaloneSqlite(service.target);try{
      assert.equal((db.prepare('SELECT COUNT(*) n FROM sso_users WHERE enterprise_id=?').get(B) as {n:number}).n,0);validateEnterpriseSqliteV3(db,'sso',next);
      db.prepare("UPDATE sso_users SET email='changed@example.test' WHERE enterprise_id=?").run(A);
      writeFileSync(service.target,db.serialize());
    }finally{db.close();}
    assert.throws(()=>verifyEnterpriseSqliteV3(service,register),/registration_business_rows_changed/);
    assert.throws(()=>registerEnterpriseSqliteFileV3(service,register),/output_exists/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
