import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initEnterpriseSqliteV3, validateEnterpriseSqliteV3, registerEnterpriseSqliteV3, getExpectedEnterpriseSqliteV3,
  enterpriseRegistryHashV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
import { initEnterpriseSqlite } from '../../src/packages/shared/src/enterpriseStorage.js';
import { legacyProfileV2 } from './manifest.js';
import { registryV3, poolOptionsV3, A,B,incarnation } from './fixtures.js';
const now='2026-09-18T00:00:00.000Z';
function user(db:Database.Database,enterprise=A,name='Alice',uuid=incarnation()) {
  db.prepare(`INSERT INTO sso_users(enterprise_id,sso_user,user_incarnation,password_hash,salt,email,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(enterprise,name,uuid,'synthetic-hash','synthetic-salt','user@example.test',now,now);return uuid;
}
function account(db:Database.Database,id='id-a',enterprise=A) {
  const uuid=incarnation();db.prepare('INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(enterprise,uuid,id,'Alice',now,now);return uuid;
}
test('all four exact schema3 layouts init and gate read-only, reject schema2/shape drift',()=>{
  for(const layout of ['sso','login','direct','pool'] as const) {
    const component=layout==='direct'||layout==='pool'?'proxy':layout,db=new Database(':memory:');
    try {
      initEnterpriseSqliteV3(db,component,registryV3(),layout==='pool'?poolOptionsV3():{layout});
      const bytes=db.serialize();assert.equal(validateEnterpriseSqliteV3(db,component,registryV3()).layout,layout);assert.deepEqual(db.serialize(),bytes);
      assert.ok(getExpectedEnterpriseSqliteV3(layout).objects.length>5);
      db.exec('CREATE TABLE unknown_shadow(x TEXT)');assert.throws(()=>validateEnterpriseSqliteV3(db,component,registryV3()),/partial_or_unknown/);
    }finally{db.close();}
  }
  const db=new Database(':memory:');try{initEnterpriseSqlite(db,'sso',legacyProfileV2(registryV3()));assert.throws(()=>validateEnterpriseSqliteV3(db,'sso',registryV3()),/partial_or_unknown/);}finally{db.close();}
});
test('SSO case semantics preserve original text within enterprise and composite FKs isolate plans',()=>{
  const db=new Database(':memory:');try {
    initEnterpriseSqliteV3(db,'sso',registryV3());const uuid=user(db,A);user(db,B);
    assert.throws(()=>user(db,A,'aLICE'),/UNIQUE/);assert.equal((db.prepare('SELECT sso_user FROM sso_users WHERE enterprise_id=? AND sso_user=?').get(A,'alice') as {sso_user:string}).sso_user,'Alice');
    assert.throws(()=>db.prepare('UPDATE sso_users SET user_incarnation=? WHERE enterprise_id=?').run(incarnation(),A),/immutable/);
    assert.throws(()=>db.prepare("UPDATE sso_users SET sso_user='ALICE' WHERE enterprise_id=?").run(A),/immutable/);
    for(const id of [A,B]) {
      db.prepare('INSERT INTO sso_emu_import_plans(enterprise_id,id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'same-plan','ready',now,now);
      db.prepare(`INSERT INTO sso_emu_import_plan_rows(enterprise_id,plan_id,row_index,sso_user,status,detail,created_at,updated_at,expected_user_incarnation) VALUES(?,?,0,'Alice','pending_update','',?,?,?)`).run(id,'same-plan',now,now,uuid);
      db.prepare('INSERT INTO sso_budget_cache(enterprise_id,period_key,year,month,raw_json,fetched_at) VALUES(?,?,2026,9,?,?)').run(id,'2026-09','{}',now);
    }
    db.prepare('DELETE FROM sso_emu_import_plans WHERE enterprise_id=?').run(A);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM sso_emu_import_plan_rows WHERE enterprise_id=?').get(B) as {n:number}).n,1);
    assert.throws(()=>db.prepare('INSERT INTO sso_pool_managed_users VALUES(?,?)').run(B,'not-found'),/FOREIGN KEY/);
    validateEnterpriseSqliteV3(db,'sso',registryV3());
  }finally{db.close();}
});
test('legacy-only pool guard and immutable incarnations preserve credential generation fencing',()=>{
  const db=new Database(':memory:');try {
    initEnterpriseSqliteV3(db,'proxy',registryV3(),poolOptionsV3());account(db,'a',A);account(db,'b',B);
    const insert=db.prepare("INSERT INTO user_pool_accounts(identity,ordinal,state,attempt_id,updated_at) VALUES(?,?,'failed','try',1)");
    insert.run('a',0);assert.throws(()=>insert.run('b',1),/enterprise_pool_legacy_only/);
    assert.throws(()=>db.prepare('UPDATE proxy_accounts SET enterprise_id=? WHERE identity=?').run(B,'a'),/immutable/);
    assert.throws(()=>db.prepare('UPDATE proxy_accounts SET account_incarnation=? WHERE identity=?').run(incarnation(),'a'),/immutable/);
    db.prepare("UPDATE proxy_accounts SET copilot_oauth_token='synthetic-token' WHERE identity='a'").run();
    assert.equal((db.prepare("SELECT generation FROM user_pool_accounts WHERE identity='a'").get() as {generation:number}).generation,1);
    const before=enterpriseRegistryHashV3(registryV3());db.prepare('UPDATE enterprise_profiles SET max_accounts=4 WHERE id=?').run(A);
    const altered=registryV3();altered.profiles.find(row=>row.id===A)!.maxAccounts=6;
    assert.equal(enterpriseRegistryHashV3(altered),before);assert.equal(validateEnterpriseSqliteV3(db,'proxy',altered).maxAccounts,4);
  }finally{db.close();}
});
test('attempt evidence outlives accounts, is immutable after terminal and contains no raw token',()=>{
  const db=new Database(':memory:');try {
    initEnterpriseSqliteV3(db,'proxy',registryV3());const uuid=account(db),attempt=incarnation();
    db.prepare(`INSERT INTO proxy_authorization_attempts(oauth_attempt_id,enterprise_id,enterprise_revision,identity,account_incarnation,expected_gh_login,status,created_at,updated_at)
      VALUES(?,?,1,'id-a',?,'alice_emu','active',?,?)`).run(attempt,A,uuid,now,now);
    assert.throws(()=>db.prepare('UPDATE proxy_authorization_attempts SET account_incarnation=?').run(incarnation()),/immutable/);
    db.prepare("UPDATE proxy_authorization_attempts SET status='succeeded',result_fingerprint=?,result_gh_login='alice_emu'").run('a'.repeat(64));
    assert.throws(()=>db.prepare("UPDATE proxy_authorization_attempts SET status='active'").run(),/terminal/);
    db.prepare("DELETE FROM proxy_accounts WHERE identity='id-a'").run();
    assert.throws(()=>db.prepare('DELETE FROM proxy_authorization_attempts').run(),/evidence_required/);
    assert.ok(!(db.prepare('PRAGMA table_info(proxy_authorization_attempts)').all() as {name:string}[]).some(row=>row.name==='token'));
  }finally{db.close();}
});
test('new Login binding and persistent nonce ledger survive task deletion; old history cannot run',()=>{
  const db=new Database(':memory:');try {
    initEnterpriseSqliteV3(db,'login',registryV3());const uuid=incarnation(),nonce=incarnation();
    db.prepare(`INSERT INTO login_nonce_ledger(enterprise_id,oauth_attempt_id,enterprise_revision,identity,account_incarnation,expected_gh_login,task_id,created_at)
      VALUES(?,?,1,'id-a',?,'alice_emu','task',?)`).run(A,nonce,uuid,now);
    db.prepare(`INSERT INTO login_tasks(id,enterprise_id,binding_version,enterprise_revision,identity,account_incarnation,oauth_attempt_id,expected_gh_login,sso_user,sso_type,created_at)
      VALUES('task',?,2,1,'id-a',?,?,'alice_emu','Alice','custom',?)`).run(A,uuid,nonce,now);
    validateEnterpriseSqliteV3(db,'login',registryV3());
    assert.throws(()=>db.prepare('UPDATE login_tasks SET enterprise_revision=2').run(),/immutable/);
    db.prepare("DELETE FROM login_tasks WHERE id='task'").run();assert.throws(()=>db.prepare('DELETE FROM login_nonce_ledger').run(),/evidence_required/);
    assert.throws(()=>db.prepare(`INSERT INTO login_nonce_ledger(enterprise_id,oauth_attempt_id,enterprise_revision,identity,account_incarnation,expected_gh_login,task_id,created_at)
      VALUES(?,?,1,'id-b',?,'bob_emu','another',?)`).run(B,nonce,incarnation(),now),/UNIQUE/);
    db.prepare(`INSERT INTO login_tasks(id,enterprise_id,binding_version,identity,sso_user,sso_type,status,created_at) VALUES('old',?,1,'id-a','Alice','custom','success',?)`).run(A,now);
    assert.throws(()=>db.prepare("UPDATE login_tasks SET status='pending' WHERE id='old'").run(),/CHECK/);
    db.prepare(`INSERT INTO login_legacy_nonce_tombstones(oauth_attempt_id,task_id,enterprise_id) VALUES('old-arbitrary-nonce','old',?)`).run(A);
    db.prepare("DELETE FROM login_tasks WHERE id='old'").run();assert.throws(()=>db.prepare('DELETE FROM login_legacy_nonce_tombstones').run(),/evidence_required/);
  }finally{db.close();}
});
test('offline registry CAS adds only empty settings and refuses legacy/config changes',()=>{
  const db=new Database(':memory:');try {
    const one=registryV3(false),two=registryV3();two.registryRevision=2;
    initEnterpriseSqliteV3(db,'sso',one);user(db);
    registerEnterpriseSqliteV3(db,'sso',one,two);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM sso_users WHERE enterprise_id=?').get(B) as {n:number}).n,0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM sso_runtime_settings WHERE enterprise_id=?').get(B) as {n:number}).n,1);
    assert.throws(()=>registerEnterpriseSqliteV3(db,'sso',one,two),/registry_mismatch/);
    const broken=structuredClone(two);broken.legacyEnterpriseId=B;broken.registryRevision=3;
    assert.throws(()=>registerEnterpriseSqliteV3(db,'sso',two,broken));
    assert.throws(()=>db.prepare('UPDATE enterprise_registry SET legacy_enterprise_id=?,registry_revision=3,registry_sha256=?').run(B,'b'.repeat(64)),/cas_required/);
  }finally{db.close();}
});
