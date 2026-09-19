import test from 'node:test';
import assert from 'node:assert/strict';
import {readEnterpriseMysqlTestGate,withEnterpriseMysqlTestSchema} from './mysqlHarness.js';
import {accountName} from '../../src/packages/shared/src/poolNames.js';
const gate=readEnterpriseMysqlTestGate();
const skip=!gate.enabled?'No explicit preprovided empty loopback MySQL8 test schema authorized; zero connection attempted':false;
for(const layout of ['direct','pool'] as const)test(`real MySQL8 v4 ${layout}: DDL, durable history, policy immutability, checkpoint resume`,{skip,timeout:120000},async()=>{
  await withEnterpriseMysqlTestSchema(gate,async h=>{
    const [{registryV3,poolOptionsV3,A,B},{initEnterpriseMysqlV3},{validateEnterpriseMysqlV4},{preflightEnterpriseMysqlV4,applyEnterpriseMysqlV4,verifyEnterpriseMysqlMigrationV4},{randomUUID}]=await Promise.all([
      import('../multi-enterprise/fixtures.js'),import('../../src/packages/shared/src/enterpriseMysqlV3.js'),import('../../src/packages/shared/src/enterpriseMysqlV4.js'),import('./mysql.js'),import('node:crypto')]);
    const registry=registryV3(),c=h.connection,identity=layout==='pool'?accountName(0):'known';
    await initEnterpriseMysqlV3(c,'proxy',registry,layout==='pool'?poolOptionsV3():{});
    await c.query('UPDATE enterprise_profiles SET max_accounts=3 WHERE id=?',[A]);
    const incarnation=randomUUID();await c.query(`INSERT INTO proxy_accounts(identity,sso_user,enterprise_id,account_incarnation,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at) VALUES(?,?,?,?, 'User_acm',?,'valid',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[identity,layout==='pool'?identity:'User',A,incarnation,'  sensitive\0bytes  ']);
    await c.query(`INSERT INTO proxy_request_stats(id,identity,requested_at,path,success,input_tokens) VALUES('known-stat',?,UTC_TIMESTAMP(3),'/synthetic',1,9007199254740993),('unknown-stat','deleted',UTC_TIMESTAMP(3),'/synthetic',0,NULL)`,[identity]);
    if(layout==='pool'){
      await c.query(`INSERT INTO user_pool_accounts(identity,ordinal,state,attempt_id,updated_at,generation) VALUES(?,0,'disabled',?,0,9007199254740993)`,[identity,randomUUID()]);await c.query('UPDATE user_pool_settings SET next_ordinal=1');
      await c.query(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,expires_at) VALUES(?,?,?,'active',1,9999999999999)`,['sha256:'+'a'.repeat(64),identity,randomUUID()]);
      await c.query("INSERT INTO user_pool_events(at,action,identity) VALUES(1800000000000,'known',?),(2,'unknown','deleted'),(3,'global',NULL),(0,'before-recreated',?)",[identity,identity]);
    }
    const [accountBefore]=await c.query<any[]>("SELECT HEX(CAST(copilot_oauth_token AS BINARY)) AS bytes,account_incarnation FROM proxy_accounts WHERE identity=?",[identity]);
    const source=await preflightEnterpriseMysqlV4(c,registry,layout),options={migrationId:'real-v4-synthetic',expectedDatabase:h.database,expectedSourceSha256:source.sourceSha256,manifestSha256:'a'.repeat(64),backupSha256:'b'.repeat(64),backupReference:'preprovided-empty-schema-fixture',confirmOffline:true,confirmBackup:true,confirmDrained:true,layout};
    // Persist an exact known-before stage, interrupt before the next statement, then explicitly resume.
    let interrupted=false;const wrapped=new Proxy(c,{get(target,key){if(key==='query')return async(...args:any[])=>{if(!interrupted && typeof args[0]==='string' && args[0].includes("SET checkpoint_state='unknown'")){interrupted=true;throw new Error('synthetic-before-dispatch');}return Reflect.apply(target.query,target,args);};return Reflect.get(target,key,target);}});
    await assert.rejects(applyEnterpriseMysqlV4(wrapped,registry,options));const resumed=await h.openConnection();await applyEnterpriseMysqlV4(resumed,registry,{...options,resume:true});await verifyEnterpriseMysqlMigrationV4(resumed,registry,options);
    const state=await validateEnterpriseMysqlV4(resumed,'proxy',registry);assert.equal(state.maxAccounts,layout==='pool'?8:undefined);
    const [after]=await resumed.query<any[]>("SELECT HEX(CAST(copilot_oauth_token AS BINARY)) AS bytes,account_incarnation FROM proxy_accounts WHERE identity=?",[identity]);assert.deepEqual(after,accountBefore);
    const [stats]=await resumed.query<any[]>('SELECT id,enterprise_id,input_tokens FROM proxy_request_stats ORDER BY id');assert.deepEqual(stats.map(r=>r.enterprise_id),[A,null]);assert.equal(String(stats[0].input_tokens),'9007199254740993');
    await assert.rejects(resumed.query('DELETE FROM enterprise_pool_policy WHERE enterprise_id=?',[A]));await assert.rejects(resumed.query('UPDATE enterprise_pool_policy SET enterprise_id=? WHERE enterprise_id=?',[randomUUID(),A]));
    await assert.rejects(resumed.query("UPDATE proxy_request_stats SET enterprise_id=? WHERE id='known-stat'",[B]));
    if(layout==='pool'){
      const [inventory]=await resumed.query<any[]>('SELECT generation FROM user_pool_accounts');assert.equal(String(inventory[0].generation),'9007199254740993');
      const nextIdentity=accountName(1);
      await resumed.query(`INSERT INTO proxy_accounts(identity,sso_user,enterprise_id,account_incarnation,created_at,updated_at) VALUES(?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[nextIdentity,nextIdentity,B,randomUUID()]);
      await resumed.query(`INSERT INTO user_pool_accounts(identity,ordinal,state,attempt_id,updated_at) VALUES(?,1,'disabled',?,0)`,[nextIdentity,randomUUID()]);
      await resumed.query('UPDATE user_pool_settings SET next_ordinal=2');
      const second=await h.openConnection();await resumed.query('START TRANSACTION');await resumed.query('SELECT * FROM user_pool_settings WHERE id=1 FOR UPDATE');await resumed.query('SELECT * FROM enterprise_pool_policy WHERE enterprise_id=? FOR UPDATE',[A]);
      let admitted=false;const pending=second.query('SELECT * FROM enterprise_pool_policy WHERE enterprise_id=? FOR SHARE',[A]).then(()=>{admitted=true;});await new Promise(resolve=>setTimeout(resolve,40));assert.equal(admitted,false);
      await resumed.query("UPDATE enterprise_pool_policy SET state='draining',policy_version=policy_version+1 WHERE enterprise_id=?",[A]);await resumed.query('COMMIT');await pending;
    }
  });
});
