import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadFixtureConfig } from '../enterprise-phase5/mock-provider.mjs';
import { createClient, sleep } from '../enterprise-phase5/fullstack.js';

export const CASES = ['login-accepted', 'sso-commit', 'proxy-owner'] as const;
type Case = typeof CASES[number];
const PROXIES = ['proxy-1', 'proxy-2', 'proxy-3'];
const fail = (code: string): never => { throw new Error(`phase5_process_${code}`); };
const check = (value: unknown, code: string) => { if (!value) fail(code); };
const count = (row: any, operation: string) => row.counts[operation] ?? 0;
const hash = (caller: string) => `sha256:${createHash('sha256').update(caller).digest('hex')}`;
export function onlyOwner(rows: any[], excluded?: string): string | undefined {
  check(rows.length === 3 && new Set(rows.map(r => r.service)).size === 3 && rows.every(r => PROXIES.includes(r.service)), 'diagnostics_shape');
  const owners = rows.filter(r => r.service !== excluded && r.status === 200 && r.state === 'owner');
  return owners.length === 1 ? owners[0].service : undefined;
}
export function successfulSurvivor(rows: any[], killed: string): string {
  check(PROXIES.includes(killed), 'killed_proxy');
  onlyOwner(rows); // Also validates exact cardinality and service membership.
  const survivor=rows.find(r=>r.service!==killed&&r.status===200&&['owner','standby'].includes(r.state));
  check(survivor, 'healthy_survivor_missing');return survivor.service;
}
export async function observeLbRecovery(read:(remainingMs:number)=>Promise<number>,options:{now?:()=>number;sleep?:(ms:number)=>Promise<void>}={}) {
  const now=options.now??Date.now,pause=options.sleep??(ms=>sleep(ms)),started=now();
  let streakStart:number|undefined,consecutive=0,observations=0,failures=0;
  while(observations<64&&now()-started<15_000){
    let status=0;try{status=await read(Math.max(1,15_000-(now()-started)));}catch{/* Transport failure resets convergence, never retries a POST. */}
    const observed=now();observations++;if(observed-started>15_000)break;
    if(status===200){streakStart??=observed;consecutive++;}
    else{streakStart=undefined;consecutive=0;failures++;}
    if(streakStart!==undefined&&consecutive>=20&&observed-streakStart>=5000){
      return{observations,failedObservations:failures,consecutiveHealthy:consecutive,healthySpanMs:observed-streakStart,elapsedMs:observed-started};
    }
    if(now()-started>=15_000)break;
    await pause(Math.min(250,Math.max(0,15_000-(now()-started))));
  }
  return fail('lb_recovery_deadline');
}
export function assertSameBinding(before: any, after: any) {
  for (const key of ['id','enterpriseId','enterpriseRevision','identity','accountIncarnation','oauthAttemptId','expectedGhLogin','expectedGithubUserId','attempts']) {
    assert.equal(after?.[key], before[key], `task_${key}_changed`);
  }
}
export function assertNoReplay(before: any, after: any) {
  for (const old of before.provider.enterprises) {
    const current = after.provider.enterprises.find((r: any) => r.enterpriseId === old.enterpriseId);
    check(current, 'missing_enterprise');
    for (const operation of ['scim-create','seat-assign','authorize']) assert.equal(count(current, operation), count(old, operation), `replayed_${operation}`);
    assert.equal(current.scimUsers, old.scimUsers); assert.equal(current.seats, old.seats);
  }
  assert.deepEqual(after.members.map((r: any) => [r.identity,r.enterprise_id,r.attempt_id,r.attempts,r.account_incarnation]),
    before.members.map((r: any) => [r.identity,r.enterprise_id,r.attempt_id,r.attempts,r.account_incarnation]), 'new_provision_attempt');
  assert.deepEqual(after.ledger.map((r: any) => [r.oauth_attempt_id,r.enterprise_id,r.identity,r.account_incarnation]),
    before.ledger.map((r: any) => [r.oauth_attempt_id,r.enterprise_id,r.identity,r.account_incarnation]), 'new_authority_attempt');
}

/** Runs only inside the already-owned provider tooling container. Host controller
 * supplies no URLs/SQL/credentials. All DB access here is fixed read-only queries. */
export async function probe(phase: string, scenario: Case, runId: string, nonce: string, prior?: any) {
  check(process.env.PHASE5_SYNTHETIC_ONLY === '1' && CASES.includes(scenario) && /^[a-f0-9-]{36}$/.test(nonce), 'probe_gate');
  check(['bootstrap','arm','verify','audit','pause','read'].includes(phase), 'probe_phase');
  const fixture = loadFixtureConfig('/fixture/state.json'), {state} = fixture;
  check(state.mode === 'init' && state.runId === runId && state.enterpriseIds.length === 2, 'probe_state');
  if (prior) check(prior.runId === runId && prior.nonce === nonce && prior.scenario === scenario, 'prior_binding');
  const c = createClient(fixture, phase === 'bootstrap' || phase === 'arm' ? 110_000 : 75_000);
  const [a,b] = state.enterpriseIds, caller = `phase7-${runId}-${nonce}-healthy-b`;
  const ns = (snap: any, id: string) => snap.provider.enterprises.find((e: any) => e.enterpriseId === id);
  const tasks = (id: string) => c.api(`/api/profiles/${id}/tasks`, 'GET', undefined, state.origins.login);
  let proxyReadOrigin=state.origins.proxy;
  let routingProof: any;
  const readPool=(id:string)=>c.api(`/api/profiles/${id}/user-pool`,'GET',undefined,proxyReadOrigin);
  async function diagnostics() {
    return Promise.all(state.origins.proxyReplicas.map(async (origin: string, i: number) => {
      try { const r = await c.call(origin, `/api/profiles/${a}/user-pool/diagnostics/local`, 'GET', undefined, c.internalHeaders, 1200);
        return {service: PROXIES[i], status: r.status, state: r.data?.localScheduler?.state ?? null}; }
      catch { return {service: PROXIES[i], status: 0, state: null}; }
    }));
  }
  async function snapshot(includeTasks = true) {
    const provider = await c.snapshot();
    const {createConnection} = await import('mysql2/promise');
    const db = await createConnection({host:'mysql',port:3306,user:state.database.username,password:state.database.password,
      database:state.database.name,connectTimeout:2500,multipleStatements:false,supportBigNumbers:true,bigNumberStrings:false});
    let members: any, ledger: any, owner: any;
    const query = async (sql: string) => (await db.query({sql, timeout:3000}))[0];
    try {
      await db.query('SET SESSION TRANSACTION READ ONLY');
      await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const settings = await query(`SELECT owner,owner_until,paused,next_ordinal,
        (TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',UTC_TIMESTAMP(3)) DIV 1000) AS now_ms FROM user_pool_settings WHERE id=1`) as any[];
      owner = settings[0];
      members = await query(`SELECT p.identity,p.state,p.stage,p.attempt_id,p.attempts,p.generation,p.task_id,p.oauth_attempt_id,
        p.last_error,a.enterprise_id,a.account_incarnation,a.copilot_oauth_status FROM user_pool_accounts p
        JOIN proxy_accounts a ON a.identity=p.identity ORDER BY p.ordinal`);
      ledger = await query(`SELECT oauth_attempt_id,enterprise_id,enterprise_revision,identity,account_incarnation,
        expected_gh_login,status FROM proxy_authorization_attempts ORDER BY oauth_attempt_id`);
      await db.commit();
    } finally { await db.end(); }
    const {default: Database} = await import('better-sqlite3');
    function sqlite(file: string, sql: string) {
      const local = new Database(file, {readonly:true, fileMustExist:true, timeout:2500});
      try { local.pragma('query_only = ON'); return local.prepare(sql).all(); } finally { local.close(); }
    }
    const sso = sqlite(state.paths.ssoDb, 'SELECT enterprise_id,sso_user,user_incarnation,operation_fence,gh_scim_id,gh_login FROM sso_users ORDER BY enterprise_id,sso_user');
    const nonces = sqlite(state.paths.loginDb, 'SELECT enterprise_id,oauth_attempt_id,identity,account_incarnation,task_id FROM login_nonce_ledger ORDER BY oauth_attempt_id');
    const pools = await Promise.all([readPool(a),readPool(b)]);
    const taskRows = includeTasks ? (await Promise.all([tasks(a),tasks(b)])).flat() : [];
    return {provider,members,ledger,owner,sso,nonces,pools,tasks:taskRows,diagnostics:await diagnostics()};
  }
  function healthyLease(snap: any) {
    const rows = snap.pools.flatMap((p: any) => p.leases).filter((l: any) => l.callerKeyHash === hash(caller));
    check(rows.length === 1 && rows[0].enterpriseId === b && rows[0].phase === 'active' && !rows[0].inUse, 'healthy_b_lease');
    return rows[0];
  }
  async function healthy(marker: string, original?: any,origin=state.origins.proxy) {
    const r = await c.inference(caller, `${nonce}-${marker}`,false,origin); assert.equal(r.status,200);
    const snap = await snapshot(false), lease = healthyLease(snap);
    if (original) for (const key of ['leaseId','memberIdentity','enterpriseId','callerKeyHash','assignedAt']) assert.equal(lease[key], healthyLease(original)[key]);
    assert.equal(ns(snap,b).markers[`phase5-request:${nonce}-${marker}`]?.inference,1);
    assert.equal(ns(snap,a).markers[`phase5-request:${nonce}-${marker}`]?.inference ?? 0,0);
    return snap;
  }
  if (phase === 'pause') { await c.settings({paused:1,idle_target:0}); return {runId,nonce,scenario,phase,paused:true}; }
  if (phase === 'read') return {runId,nonce,scenario,phase,snapshot:await snapshot()};
  if (phase === 'bootstrap') {
    for (const origin of [state.origins.proxy,...state.origins.proxyReplicas,state.origins.sso,state.origins.login,state.origins.provider])
      assert.equal((await c.call(origin,'/healthz')).status,200);
    const initial = await snapshot(); check(initial.owner.paused === 1 && initial.members.length === 0 && initial.ledger.length === 0 && initial.nonces.length === 0 && initial.sso.length === 0 && initial.tasks.length === 0, 'fresh_init_required');
    for (const id of [a,b]) { assert.equal((await c.policy(id)).state,'draft'); const row=ns(initial,id); check(row.scimUsers===0 && row.seats===0 && row.issuedTokens===0,'fresh_provider_required'); }
    await c.cap(a,1); await c.cap(b,scenario === 'proxy-owner' ? 2 : 1);
    await c.activate(b); await c.settings({idle_target:1,lease_seconds:600,paused:0});
    await c.poll('healthy_b_ready',()=>c.pool(b),p=>p.counts.ready_idle===1,70_000);
    await c.settings({idle_target:0,paused:1}); await healthy('prime');
    await c.activate(a);
    // Real Login runtime setting, not a replacement queue, lets the owner case hold A and B work concurrently.
    const settings = await c.api('/api/settings/runtime','GET',undefined,state.origins.login);
    await c.api('/api/settings/runtime','PATCH',{expectedVersion:settings.version,changes:{concurrency:2}},state.origins.login);
    return {runId,nonce,scenario,phase,snapshot:await snapshot()};
  }
  check(prior?.snapshot, 'baseline_required');
  if (phase === 'arm') {
    check(prior.phase === 'bootstrap', 'bootstrap_required');
    await c.control(a,scenario==='sso-commit'?'scim-create':'authorize',scenario==='sso-commit'?'commit-delay':'delay',{count:1,delayMs:25_000,ttlMs:90_000});
    if (scenario==='proxy-owner') await c.control(b,'authorize','delay',{count:1,delayMs:25_000,ttlMs:90_000});
    await c.settings({paused:0,idle_target:scenario==='proxy-owner'?2:1});
    let armed: any;
    if (scenario==='sso-commit') {
      await c.poll('scim_committed_barrier',()=>c.snapshot(),s=>s.enterprises.find((e:any)=>e.enterpriseId===a).barriers.some((r:any)=>r.channel==='scim-create'),60_000,100);
      await c.settings({idle_target:0});
      const affected=(await c.pool(a)).accounts;check(affected.length===1,'one_a_member');
      // Preserve the ambiguous operation for inspection instead of normal automatic repair.
      await c.api(`/api/profiles/${a}/user-pool/accounts/${encodeURIComponent(affected[0].identity)}/disable`,'POST',{});
      armed=await snapshot();
      const barrier=ns(armed,a).barriers.find((r:any)=>r.channel==='scim-create');
      check(barrier?.until > Date.now()+8000 && ns(armed,a).commits['scim-create']===1,'live_commit_barrier');
      const row=armed.sso.find((r:any)=>r.enterprise_id===a); check(row?.operation_fence && !row.gh_scim_id,'sso_not_locally_completed');
      check(armed.members.filter((r:any)=>r.enterprise_id===a).length===1,'one_a_member');
    } else {
      await c.poll('accepted_login_work',async()=>({t:(await Promise.all([tasks(a),tasks(b)])).flat(),p:await c.snapshot()}),s=>{
        const aTask=s.t.some((t:any)=>t.enterpriseId===a&&t.status==='running');
        const bTask=scenario!=='proxy-owner'||s.t.some((t:any)=>t.enterpriseId===b&&t.status==='running');
        const bCount=scenario!=='proxy-owner'||(s.p.enterprises.find((e:any)=>e.enterpriseId===b).counts.authorize??0)===2;
        return aTask&&bTask&&bCount&&(s.p.enterprises.find((e:any)=>e.enterpriseId===a).counts.authorize??0)===1;
      },60_000,100);
      await c.settings({idle_target:0});
      armed=await snapshot();
      const task=armed.tasks.find((t:any)=>t.enterpriseId===a&&t.status==='running'); check(task,'accepted_a_task');
      // A cross-enterprise cancellation must neither close authority nor free a slot.
      const wrong=await c.call(state.origins.login,`/api/profiles/${b}/tasks/${task.id}/cancel`,'POST',{},c.internalHeaders); assert.equal(wrong.status,404);
      if(scenario==='login-accepted') {
        // Prevent intentional normal repair from obscuring restart recovery. Only A is disabled;
        // its already-accepted authority and reservation remain durable until real Login closes them.
        await c.api(`/api/profiles/${a}/user-pool/accounts/${encodeURIComponent(task.identity)}/disable`,'POST',{});
      }
      armed=await snapshot();
      const aRow=armed.members.find((r:any)=>r.enterprise_id===a);
      check(['oauth-dispatch','oauth-wait'].includes(aRow?.stage),'accepted_slot_persisted');
      check(armed.ledger.find((r:any)=>r.oauth_attempt_id===task.oauthAttemptId)?.status==='active','authority_active_before_kill');
      for(const id of scenario==='proxy-owner'?[a,b]:[a]){
        check(ns(armed,id).barriers.some((r:any)=>r.channel==='authorize'&&r.phase==='before'&&r.until>Date.now()+8000),'live_authorize_barrier');
      }
      check(armed.nonces.find((r:any)=>r.oauth_attempt_id===task.oauthAttemptId)?.task_id===task.id,'nonce_ledger_before_kill');
      if(scenario==='proxy-owner') check(armed.tasks.filter((t:any)=>t.status==='running').length===2,'both_enterprises_working');
    }
    const owner=onlyOwner(armed.diagnostics); check(owner && armed.owner.owner && Number(armed.owner.owner_until)>Number(armed.owner.now_ms),'initial_owner');
    return {runId,nonce,scenario,phase,snapshot:armed,owner,target:scenario==='proxy-owner'?owner:scenario==='sso-commit'?'sso':'login'};
  }
  const before=prior.snapshot;
  if (phase === 'verify') {
    check(prior.phase==='arm','armed_required');
    // This runs while Proxy owner is still killed, or after Login/SSO restart.
    // HAProxy health removal is not instantaneous and POST retries are forbidden.
    // Immediate progress targets one directly confirmed survivor exactly once.
    if(scenario==='proxy-owner'){
      const service=successfulSurvivor(await diagnostics(),prior.target);
      proxyReadOrigin=state.origins.proxyReplicas[PROXIES.indexOf(service)];
      routingProof={survivorService:service,survivorInferenceOnce:true,zeroDowntimeClaimed:false};
      await healthy('during',before,proxyReadOrigin);
    }else await healthy('during',before);
    if(scenario==='login-accepted') {
      const task=before.tasks.find((t:any)=>t.enterpriseId===a&&t.status==='running');
      const closed=await c.poll('restart_authority_closure',()=>c.api(`/api/profiles/${a}/tasks/${task.id}`,'GET',undefined,state.origins.login),t=>t.status==='cancelled'&&t.authorityCloseState==='confirmed',45_000,250);
      assertSameBinding(task,closed);
      await c.poll('exact_a_slot_released',()=>c.pool(a),p=>p.accounts.some((r:any)=>r.identity===task.identity&&r.state==='disabled'&&!['oauth-dispatch','oauth-wait'].includes(r.stage)),15_000,250);
    } else if(scenario==='sso-commit') {
      const row=before.sso.find((r:any)=>r.enterprise_id===a);
      const retry=await c.call(state.origins.sso,`/api/profiles/${a}/users/batch`,'POST',{
        operation:'sync_emu',ssoUsers:[row.sso_user],createOnly:true,assignCopilotSeat:true,expectedIncarnations:{[row.sso_user]:row.user_incarnation}},c.internalHeaders);
      check(retry.status===200 || retry.status===409,'fenced_retry_http');
      await sleep(1500,c.signal);
    } else {
      // Read-only convergence observations are safe to repeat. A failed observation
      // resets the entire >=5-second healthy streak; no inference POST is retried.
      const lb=await observeLbRecovery(async remainingMs=>{
        const r=await c.call(state.origins.proxy,'/readyz','GET',undefined,{},Math.max(1,Math.min(750,remainingMs,c.deadline-Date.now())));
        return r.status;
      },{sleep:ms=>sleep(ms,c.signal)});
      await healthy('lb-recovered',before,state.origins.proxy);
      routingProof={...routingProof,lb,lbInferenceOnce:true};
      await c.poll('survivor_durable_takeover',()=>snapshot(),s=>Boolean(onlyOwner(s.diagnostics,prior.target))&&s.owner.owner!==before.owner.owner&&Number(s.owner.owner_until)>Number(s.owner.now_ms),50_000,500);
      await c.poll('both_original_tasks_ready',async()=>[await readPool(a),await readPool(b)],p=>p[0].counts.total===1&&p[0].accounts.every((r:any)=>r.state==='ready')&&p[1].counts.total===2&&p[1].accounts.every((r:any)=>r.state==='ready'),15_000,250);
    }
  }
  check(phase==='verify'||phase==='audit','audit_phase');
  const after=await snapshot(); assertNoReplay(before,after);
  for(const original of before.tasks) {
    const current=after.tasks.find((t:any)=>t.id===original.id); assertSameBinding(original,current);
    const ledger=after.ledger.find((r:any)=>r.oauth_attempt_id===original.oauthAttemptId);
    check(ledger && ledger.enterprise_id===original.enterpriseId && ledger.identity===original.identity && ledger.account_incarnation===original.accountIncarnation,'authority_binding');
    if(original.enterpriseId===a && scenario==='login-accepted') assert.equal(ledger.status,'cancelled');
    else assert.equal(current.status,'success');
  }
  assert.deepEqual(after.nonces,before.nonces,'nonce_ledger_changed');
  if(scenario==='sso-commit') {
    const old=before.sso.find((r:any)=>r.enterprise_id===a),current=after.sso.find((r:any)=>r.enterprise_id===a);
    assert.deepEqual(current,old,'durable_unknown_fence_changed'); check(current.operation_fence && !current.gh_scim_id,'unknown_fence_missing');
    assert.equal(count(ns(after,a),'scim-create'),1); assert.equal(count(ns(after,a),'seat-assign'),0); assert.equal(count(ns(after,a),'authorize'),0);
  }
  healthyLease(after);
  if(scenario==='proxy-owner'){
    check(after.owner.owner!==before.owner.owner && Number(after.owner.owner_until)>Number(after.owner.now_ms),'durable_owner_not_changed');
    for(const suffix of ['during','lb-recovered']){
      assert.equal(ns(after,b).markers[`phase5-request:${nonce}-${suffix}`]?.inference,1);
      assert.equal(ns(after,a).markers[`phase5-request:${nonce}-${suffix}`]?.inference??0,0);
    }
  }
  return {runId,nonce,scenario,phase,snapshot:after,checks:{noReplay:true,nonceLedger:true,authorityLedger:true,healthyBProgress:true,exactEnterpriseBindings:true,
    unknownFence:scenario==='sso-commit',actualLoginRestart:scenario==='login-accepted',durableOwnerChanged:scenario==='proxy-owner',...(routingProof?{routing:routingProof}:{})}};
}

async function main() {
  const [phase,scenario,runId,nonce]=process.argv.slice(2); check(process.argv.length===6,'arguments');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;check(size<=256*1024,'stdin_cap');chunks.push(chunk);}
  const text=Buffer.concat(chunks).toString(),prior=text?JSON.parse(text):undefined;
  const result=await probe(phase,scenario as Case,runId,nonce,prior); process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{
  // This entry is invoked ONLY via the host controller's captured private pipe.
  // Public controller output is fixed safeError; detail must survive for diagnosis.
  process.stderr.write(JSON.stringify({error:'phase5_process_probe_failed',message:String(error?.message??'').slice(0,4096),stack:String(error?.stack??'').slice(0,8192)})+'\n');
  process.stdout.write(JSON.stringify({error:'phase5_process_probe_failed'})+'\n');process.exitCode=1;
});
