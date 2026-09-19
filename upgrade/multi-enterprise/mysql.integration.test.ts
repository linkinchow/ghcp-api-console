import test from 'node:test';
import assert from 'node:assert/strict';
import {readEnterpriseMysqlTestGate,withEnterpriseMysqlTestSchema} from '../multi-enterprise-pool/mysqlHarness.js';
const gate=readEnterpriseMysqlTestGate();
const skip=!gate.enabled?'No explicit preprovided empty loopback MySQL8 test schema authorized; zero connection attempted':false;
for(const layout of ['direct','pool'] as const)test(`real MySQL8 schema2→3 ${layout}: frozen DDL, immutable binding, column fidelity and explicit resume`,{skip,timeout:120000},async()=>{
  await withEnterpriseMysqlTestSchema(gate,async h=>{
    const [{registryV3,poolOptionsV3,A,B},{initEnterpriseMysql},{enterpriseMysqlLegacyProfileV3,validateEnterpriseMysqlV3},{preflightEnterpriseMysqlV3,applyEnterpriseMysqlV3,verifyEnterpriseMysqlMigrationV3},{randomUUID}]=await Promise.all([
      import('./fixtures.js'),import('../../src/packages/shared/src/enterpriseMysql.js'),import('../../src/packages/shared/src/enterpriseMysqlV3.js'),import('./mysql.js'),import('node:crypto')]);
    const registry=registryV3(),legacy=enterpriseMysqlLegacyProfileV3(registry.profiles.find(p=>p.id===A)!),c=h.connection;
    await initEnterpriseMysql(c,'proxy',legacy,layout==='pool'?{...poolOptionsV3(),maxAccounts:5}:{});
    await c.query(`INSERT INTO proxy_accounts(identity,sso_user,enterprise_id,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at) VALUES('known','User',?,'User_acm',?,'valid',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[A,'  synthetic\0byte-sensitive  ']);
    if(layout==='pool'){
      await c.query(`INSERT INTO user_pool_accounts(identity,ordinal,state,attempt_id,updated_at,generation) VALUES('known',0,'disabled',?,0,9007199254740993)`,[randomUUID()]);await c.query('UPDATE user_pool_settings SET next_ordinal=1');
      await c.query(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,expires_at) VALUES(?,'known',?,'active',1,9999999999999)`,['sha256:'+'a'.repeat(64),randomUUID()]);
    }
    const before=await preflightEnterpriseMysqlV3(c,registry,layout),options={migrationId:'real-v3-synthetic',expectedDatabase:h.database,expectedSourceSha256:before.sourceSha256,manifestSha256:'a'.repeat(64),backupSha256:'b'.repeat(64),backupReference:'preprovided-empty-schema-fixture',accountIncarnations:before.accountIncarnations,confirmOffline:true,confirmBackup:true,confirmDrained:true,layout};
    let interrupted=false;const wrapped=new Proxy(c,{get(target,key){if(key==='query')return async(...args:any[])=>{if(!interrupted && typeof args[0]==='string' && args[0].includes("SET checkpoint_state='unknown'")){interrupted=true;throw new Error('synthetic-before-dispatch');}return Reflect.apply(target.query,target,args);};return Reflect.get(target,key,target);}});
    await assert.rejects(applyEnterpriseMysqlV3(wrapped,registry,options));const resumed=await h.openConnection();await applyEnterpriseMysqlV3(resumed,registry,{...options,resume:true});await verifyEnterpriseMysqlMigrationV3(resumed,registry,options);await validateEnterpriseMysqlV3(resumed,'proxy',registry);
    const [accounts]=await resumed.query<any[]>("SELECT account_incarnation,HEX(CAST(copilot_oauth_token AS BINARY)) AS bytes FROM proxy_accounts WHERE identity='known'");assert.equal(accounts[0].account_incarnation,before.accountIncarnations[0].accountIncarnation);assert.equal(accounts[0].bytes,Buffer.from('  synthetic\0byte-sensitive  ').toString('hex').toUpperCase());
    await assert.rejects(resumed.query("UPDATE proxy_accounts SET enterprise_id=? WHERE identity='known'",[B]));
    if(layout==='pool'){
      await resumed.query(`INSERT INTO proxy_accounts(identity,sso_user,enterprise_id,account_incarnation,created_at,updated_at) VALUES('second','User',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[B,randomUUID()]);
      await assert.rejects(resumed.query(`INSERT INTO user_pool_accounts(identity,ordinal,state,attempt_id,updated_at) VALUES('second',1,'disabled',?,0)`,[randomUUID()]));
      const [rows]=await resumed.query<any[]>('SELECT generation FROM user_pool_accounts');assert.equal(String(rows[0].generation),'9007199254740993');
    }
  });
});
