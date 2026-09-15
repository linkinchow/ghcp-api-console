// Resume ONLY the retained failed mock failover fixture; not a fresh-fill acceptance.
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PROJECT, check, health, pool, mock, settings, connectDatabase, sleep, request, status,
  inferOptions, successful, hash, auth } from './mysql-smoke.mjs';
check(process.env.POOL_MYSQL_RECOVERY_CONFIRM === PROJECT, 'explicit_recovery_confirmation_required');
const report={kind:'retained_failover_recovery',passed:false,checks:[]};
let db,authorized=false;
const end=Date.now()+20*60*1000;
async function snapshot(){
 const [[r]]=await db.query(`SELECT (SELECT COUNT(*) FROM user_pool_accounts) members,
 (SELECT COUNT(*) FROM user_pool_accounts WHERE state='ready' AND stage='ready' AND verified_at>0) ready,
 (SELECT COUNT(*) FROM user_pool_accounts WHERE state='failed') failed,
 (SELECT COUNT(*) FROM user_pool_accounts WHERE stage IN ('oauth-dispatch','oauth-wait')) occupied,
 (SELECT COUNT(*) FROM user_pool_leases) leases,(SELECT COUNT(*) FROM user_pool_holds) holds,
 (SELECT COUNT(*) FROM user_pool_catalog_holds) catalogHolds`);
 return Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Number(v)]));
}
function auditTasks(m,limit){
 const seen=new Set();
 for(const task of m.tasks){const key=task.identity+'|'+task.oauthAttemptId;check(!seen.has(key),'same_nonce_duplicate_dispatch');seen.add(key);}
 check(m.counters.callbacksFailed===limit,'new_unplanned_callback_failure');
 check(m.counters.scimConflicts===0&&m.counters.scimUpdates===0&&m.counters.scimDeletes===0,'unexpected_scim_mutation');
 check(m.tasks.length<=2000+limit,'unbounded_authorization_retry');
 check(m.counters.scimCreates<=2000&&m.counters.seatAssignments<=2000,'account_or_seat_overcreation');
}
try{
 await health();db=await connectDatabase();
 const initial=await pool('proxy2',true),before=await snapshot(),m=await mock();
 check(initial.settings.paused===1&&initial.settings.idle_target===0&&initial.counts.total===2000&&before.ready<2000,'retained_failed_fixture_required');
 const failed=m.tasks.filter(t=>t.status==='failed');
 check(failed.length>0&&failed.length<=5&&failed.every(t=>t.error==='local_callback_failed')&&m.counters.callbacksFailed===failed.length,'known_callback_failure_only');
 check(before.leases===0&&before.holds===0&&before.catalogHolds===0,'no_active_caller_state');
 const failures=m.counters.callbacksFailed,started=Date.now();
 report.initial={...before,callbackFailures:failures};auditTasks(m,failures);authorized=true;
 await settings({idle_target:2000,paused:0},'proxy2');
 let latest,nextLog=0;
 for(;;){
  check(Date.now()<end,'recovery_deadline');latest=await snapshot();
  check(latest.members===2000&&latest.occupied<=5&&latest.leases===0&&latest.holds===0,'recovery_capacity_or_caller_state');
  if(Date.now()>nextLog){const state=await mock();auditTasks(state,failures);console.log(JSON.stringify({event:'recovery_progress',elapsedMs:Date.now()-started,...latest,callbackFailures:state.counters.callbacksFailed,tasks:state.tasks.length}));nextLog=Date.now()+30000;}
  if(latest.ready===2000&&latest.failed===0)break;
  await sleep(2000);
 }
 await settings({paused:1},'proxy2');
 const finalMock=await mock();auditTasks(finalMock,failures);
 check(finalMock.counters.scimCreates===2000&&finalMock.counters.seatAssignments===2000,'incomplete_entitlements');
 check(finalMock.tasks.length===2000+failures&&finalMock.tasks.filter(t=>t.status==='success').length===2000,'terminal_failure_new_attempt_count');
 for(const task of failed){
  const successor=finalMock.tasks.filter(t=>t.identity===task.identity&&t.status==='success');
  check(successor.length===1&&successor[0].oauthAttemptId!==task.oauthAttemptId,'original_member_new_nonce_recovery');
 }
 const [[invalid]]=await db.query(`SELECT COUNT(*) n FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
 WHERE p.state<>'ready' OR p.stage<>'ready' OR p.verified_at IS NULL OR a.copilot_oauth_status<>'valid' OR a.copilot_oauth_token IS NULL`);
 check(Number(invalid.n)===0,'invalid_ready_credential');
 const caller='sha256:'+hash(randomUUID()),marker='recovery-'+randomUUID();
 let lease;
 for(const service of ['proxy','proxy2']){
  successful(await request(service,'/v1/messages',inferOptions(caller,'/v1/messages',`POOL_TEST:${JSON.stringify({id:marker+'-'+service})}`)),'/v1/messages',false);
  const [rows]=await db.query('SELECT member_identity,lease_id FROM user_pool_leases WHERE caller_id=?',[caller]);
  check(rows.length===1&&(!lease||lease.lease_id===rows[0].lease_id&&lease.member_identity===rows[0].member_identity),'cross_replica_recovery_binding');lease=rows[0];
 }
 for(let i=0;i<100&&(await snapshot()).holds;i++)await sleep(100);
 status(await request('proxy2',`/api/user-pool/leases/${lease.lease_id}/release`,{method:'POST',headers:auth,body:{confirm:true}}),200,'release_recovery_canary');
 report.final=await snapshot();check(report.final.leases===0&&report.final.holds===0&&report.final.catalogHolds===0,'recovery_final_holds');
 report.wallMs=Date.now()-started;report.tasks=finalMock.tasks.length;report.callbackFailures=failures;report.successfulTasks=2000;
 report.checks=['one_post_per_identity_nonce','no_new_sso_scim_seat_for_retry','failed_callback_original_member_reauthorized','all_2000_ready_verified','two_replica_canary_no_replay','final_holds_drained'];report.passed=true;
}catch(e){report.failure=e?.fixtureCheck?e.message:'fixture_or_transport_failure';process.exitCode=1;}
finally{
 if(authorized)try{await settings({paused:1,...(report.passed?{}:{idle_target:0})},'proxy2');report.paused=true;}catch{report.passed=false;report.paused=false;process.exitCode=1;}
 db?.destroy();await writeFile('/opt/ghcp-test/results/matrix-failover-recovery-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
