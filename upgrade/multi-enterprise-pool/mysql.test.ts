import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mysqlFixtureV4} from './mysql.fixture.js';
import {registryV3,poolOptionsV3,A,B} from '../multi-enterprise/fixtures.js';
import {initEnterpriseMysqlV4,validateEnterpriseMysqlV4,registerEnterpriseMysqlV4} from '../../src/packages/shared/src/enterpriseMysqlV4.js';
import {preflightEnterpriseMysqlV4,applyEnterpriseMysqlV4,verifyEnterpriseMysqlMigrationV4,inspectEnterpriseMysqlV4,type EnterpriseMysqlPreflightV4} from './mysql.js';
const plan=(s:EnterpriseMysqlPreflightV4)=>({migrationId:'phase4-synthetic',confirmOffline:true,confirmBackup:true,confirmDrained:true,expectedSourceSha256:s.sourceSha256,manifestSha256:'a'.repeat(64),backupReference:'synthetic-backup',backupSha256:'b'.repeat(64),expectedDatabase:'ghcp_enterprise_test_unit',layout:s.layout});
function seed(f:ReturnType<typeof mysqlFixtureV4>,layout:'direct'|'pool'){
  f.data.enterprise_profiles[0].max_accounts=3;
  f.data.proxy_accounts=[{enterprise_id:A,account_incarnation:randomUUID(),identity:'known',sso_user:'User',gh_login:'User_acm',copilot_oauth_token:'  bytes\0unchanged  ',copilot_oauth_status:'valid',copilot_oauth_updated_at:'2026-09-18 00:00:00.123',copilot_oauth_attempt_id:null,created_at:'2026-09-18 00:00:00.000',updated_at:'2026-09-18 00:00:00.000'}];
  f.data.proxy_request_stats=[{id:'stat',identity:'known',gh_login:null,requested_at:'2026-09-18 00:00:00.123',path:'/x',model:null,success:1,failure_reason:null,input_tokens:'9007199254740993',output_tokens:null,cache_tokens:null,cache_input_tokens:null,cache_write_tokens:null,caller_id:null,lease_id:null},
    {id:'orphan',identity:'gone',gh_login:null,requested_at:'2026-09-18 00:00:00.123',path:'/x',model:null,success:0,failure_reason:'unchanged',input_tokens:null,output_tokens:null,cache_tokens:null,cache_input_tokens:null,cache_write_tokens:null,caller_id:null,lease_id:null}];
  if(layout==='pool'){
    f.data.user_pool_settings[0].next_ordinal=1;
    f.data.user_pool_accounts=[{identity:'known',ordinal:0,state:'disabled',stage:'new',attempt_id:randomUUID(),oauth_attempt_id:null,sso_created_at:null,task_id:null,attempts:2,retry_at:0,last_error:'manual',updated_at:0,cooldown_until:0,verified_at:null,generation:'9007199254740993',reauth_count:0,reauth_window_at:0}];
    f.data.user_pool_leases=[{caller_id:'sha256:'+'c'.repeat(64),member_identity:'known',lease_id:randomUUID(),phase:'active',assigned_at:1,last_success_at:2,expires_at:9999999999999}];
    f.data.user_pool_events=[{id:10,at:1800000000000,action:'history',identity:'known',caller_id:null,lease_id:null,detail:' keep '},{id:11,at:2,action:'global',identity:null,caller_id:null,lease_id:null,detail:null}];
    // This is a real pool member fixture, not an arbitrary direct account.
    for(const rows of Object.values(f.data))for(const row of rows){if(row.identity==='known')row.identity='aaliyah.abbott00';if(row.member_identity==='known')row.member_identity='aaliyah.abbott00';}
    f.data.proxy_accounts[0].sso_user='aaliyah.abbott00';
  }
}
for(const layout of ['direct','pool'] as const){
  test(`SQL simulation ${layout}: v4 gate SELECT-only; init draft/paused; cap DB authoritative`,async()=>{
    const f=mysqlFixtureV4(layout,4);f.data.enterprise_profiles[0].max_accounts=2;const result=await validateEnterpriseMysqlV4(f.connection,'proxy',registryV3());assert.equal(result.maxAccounts,layout==='pool'?7:undefined);assert.equal(f.mutations.length,0);
    const empty=mysqlFixtureV4(layout,0);await initEnterpriseMysqlV4(empty.connection,'proxy',registryV3(),layout==='pool'?poolOptionsV3():{});assert(empty.data.enterprise_pool_policy.every(p=>p.state==='draft'));assert.equal(empty.data.enterprise_upgrade_v4.length,0);
  });
  test(`SQL simulation ${layout}: 3→4 fidelity, nullable durable history, no incarnation generation, exact resume`,async()=>{
    const f=mysqlFixtureV4(layout);seed(f,layout);const before=structuredClone(f.data);const source=await preflightEnterpriseMysqlV4(f.connection,registryV3()),options=plan(source);assert(f.statements.every(s=>s.startsWith('SELECT')));
    const result=await applyEnterpriseMysqlV4(f.connection,registryV3(),options);assert.equal(result.resumed,false);assert.deepEqual(f.data.proxy_accounts,before.proxy_accounts);assert.deepEqual(f.data.enterprise_profiles,before.enterprise_profiles);
    for(const [table,rows]of Object.entries(before)){if(['enterprise_schema','proxy_request_stats','user_pool_events'].includes(table))continue;assert.deepEqual(f.data[table],rows);}
    assert.deepEqual(f.data.proxy_request_stats.map(({enterprise_id,...row})=>row),before.proxy_request_stats);assert.deepEqual(f.data.proxy_request_stats.map(r=>r.enterprise_id),[A,null]);
    if(layout==='pool'){assert.deepEqual(f.data.user_pool_events.map(({enterprise_id,...row})=>row),before.user_pool_events);assert.deepEqual(f.data.user_pool_events.map(r=>r.enterprise_id),[A,null]);}
    assert.equal(f.data.enterprise_pool_policy.find(p=>p.enterprise_id===A)!.state,'active');assert.equal(f.data.enterprise_pool_policy.find(p=>p.enterprise_id===B)!.state,'draft');
    await verifyEnterpriseMysqlMigrationV4(f.connection,registryV3(),options);assert.equal((await inspectEnterpriseMysqlV4(f.connection,registryV3())).state,'v4');const count=f.mutations.length;
    await applyEnterpriseMysqlV4(f.connection,registryV3(),{...options,resume:true});assert.equal(f.mutations.length,count);assert(!f.mutations.some(s=>s.includes('account_incarnation')));
    f.data.proxy_accounts[0].copilot_oauth_token+='changed';await assert.rejects(verifyEnterpriseMysqlMigrationV4(f.connection,registryV3(),options),/source_changed/);
  });
}
for(const interrupted of ['CREATE TABLE `enterprise_pool_policy`','INSERT INTO enterprise_pool_policy','ALTER TABLE proxy_request_stats','UPDATE proxy_request_stats h','DROP TRIGGER enterprise_pool_legacy_insert','DROP TABLE enterprise_schema','INSERT INTO enterprise_schema','CREATE TRIGGER enterprise_events_scope_immutable'])test(`SQL simulation unknown checkpoint fails closed without replay: ${interrupted}`,async()=>{
  const f=mysqlFixtureV4();seed(f,'pool');const options=plan(await preflightEnterpriseMysqlV4(f.connection,registryV3()));f.loseWhen(s=>s.startsWith(interrupted));await assert.rejects(applyEnterpriseMysqlV4(f.connection,registryV3(),options));f.reconnect();assert(f.mutations.some(s=>s.startsWith(interrupted)), 'target interruption statement must have executed');assert.equal(f.data.enterprise_upgrade_v4[0].checkpoint_state,'unknown');const writes=f.mutations.length;
  await assert.rejects(applyEnterpriseMysqlV4(f.connection,registryV3(),{...options,resume:true}),/unknown_manual_inspection/);assert.equal(f.mutations.length,writes);
});
test('SQL simulation exact before/after checkpoints resume; mutated old bytes refuse',async()=>{
  for(const kind of ['before','after'] as const){const f=mysqlFixtureV4();seed(f,'pool');const options=plan(await preflightEnterpriseMysqlV4(f.connection,registryV3()));
    f.failWhen(s=>kind==='before'?s.includes("SET checkpoint_state='unknown'")&&f.data.enterprise_upgrade_v4[0].step===5:s.includes("SET step=?,checkpoint_state='before'")&&f.data.enterprise_upgrade_v4[0].step===4);
    await assert.rejects(applyEnterpriseMysqlV4(f.connection,registryV3(),options));f.reconnect();assert.equal(f.data.enterprise_upgrade_v4[0].checkpoint_state,kind);await applyEnterpriseMysqlV4(f.connection,registryV3(),{...options,resume:true});assert.equal(f.mutations.filter(s=>s.startsWith('UPDATE proxy_request_stats h')).length,1);
  }
});
test('SQL simulation offline append preserves existing policy, NULL history, stored cap and receipts',async()=>{
  const old=registryV3(false),next=registryV3();next.registryRevision=2;const f=mysqlFixtureV4('pool',4,old);seed(f,'pool');f.data.proxy_request_stats.forEach(r=>r.enterprise_id=r.identity==='aaliyah.abbott00'?A:null);f.data.user_pool_events.forEach(r=>r.enterprise_id=r.identity==='aaliyah.abbott00'?A:null);const previous=structuredClone(f.data);
  const result=await registerEnterpriseMysqlV4(f.connection,old,next,{confirmOffline:true,confirmDrained:true,expectedRegistryRevision:1});assert.equal(result.maxAccounts,8);assert.deepEqual(f.data.enterprise_pool_policy[0],previous.enterprise_pool_policy[0]);assert.deepEqual(f.data.proxy_request_stats,previous.proxy_request_stats);assert.deepEqual(f.data.enterprise_profiles[0],previous.enterprise_profiles[0]);assert.equal(f.data.enterprise_pool_policy[1].state,'draft');
});
test('SQL simulation history older than current incarnation remains NULL',async()=>{
  const f=mysqlFixtureV4();seed(f,'pool');f.data.proxy_request_stats.push({...f.data.proxy_request_stats[0],id:'before',requested_at:'2020-01-01 00:00:00.000'});
  f.data.user_pool_events.push({...f.data.user_pool_events[0],id:12,at:0});const options=plan(await preflightEnterpriseMysqlV4(f.connection,registryV3()));await applyEnterpriseMysqlV4(f.connection,registryV3(),options);
  assert.equal(f.data.proxy_request_stats.find(r=>r.id==='before')!.enterprise_id,null);assert.equal(f.data.user_pool_events.find(r=>r.id===12)!.enterprise_id,null);await verifyEnterpriseMysqlMigrationV4(f.connection,registryV3(),options);
});
test('SQL simulation strict v4 gate rejects missing policy, forged migration evidence, malformed cap and nullable-scope orphan',async()=>{
  for(const mutate of [(f:ReturnType<typeof mysqlFixtureV4>)=>{f.data.enterprise_pool_policy.pop();},(f:ReturnType<typeof mysqlFixtureV4>)=>{Object.assign(f.data.enterprise_pool_policy[0],{state:'active',validation_kind:'migration_preserved_v3',validated_at:1});},(f:ReturnType<typeof mysqlFixtureV4>)=>{f.data.enterprise_profiles[0].max_accounts=10000;},(f:ReturnType<typeof mysqlFixtureV4>)=>{f.data.proxy_request_stats=[{enterprise_id:randomUUID()}];}]){
    const f=mysqlFixtureV4('pool',4);mutate(f);await assert.rejects(validateEnterpriseMysqlV4(f.connection,'proxy',registryV3()));assert.equal(f.mutations.length,0);
  }
});
