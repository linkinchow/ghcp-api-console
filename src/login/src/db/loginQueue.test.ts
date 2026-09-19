import assert from 'node:assert/strict';
import test from 'node:test';
import { initLoginFixture, loginRequest, SECOND_ENTERPRISE } from './enterpriseFixture.js';

const profile = initLoginFixture();
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('global concurrency responds immediately to increases/decreases across enterprises; every task claimed once',async () => {
  const {LoginQueue} = await import('../tasks/queue.js');
  const repo = await import('./tasksRepo.js');
  let concurrency = 1;
  const started:string[] = [],complete = new Map<string,() => void>();
  const queue = new LoginQueue({getConcurrency:() => concurrency,readAuthorizationAttempt:async binding => ({binding,status:'active'}),
    runLoginTask:async (task) => {
      started.push(task.id);
      await new Promise<void>(resolve => complete.set(task.id,resolve));
      repo.markCallbackPending(task.enterpriseId,task.id,'success');repo.resolveAuthority(task.enterpriseId,task.id,'succeeded');
    }});
  const requests = Array.from({length:4},(_,i) => loginRequest(profile,{enterpriseId:i % 2 ? SECOND_ENTERPRISE : profile.id}));
  const tasks = await Promise.all(requests.map(request => queue.enqueue(request))),ids = tasks.map(task => task.id);
  assert.deepEqual(started,[ids[0]]);
  concurrency = 3; queue.onRuntimeSettingsUpdated(); assert.deepEqual(started,ids.slice(0,3));
  concurrency = 1; queue.onRuntimeSettingsUpdated();
  complete.get(ids[0])!(); await settle(); assert.deepEqual(started,ids.slice(0,3));
  complete.get(ids[1])!(); await settle(); assert.deepEqual(started,ids.slice(0,3));
  complete.get(ids[2])!(); await settle(); assert.deepEqual(started,ids);
  complete.get(ids[3])!(); await settle();
  for (const task of tasks) assert.equal(repo.getTask(task.enterpriseId,task.id)?.attempts,1);
});

test('parallel nonce replay is one task/one browser; tuple mismatch and deletion replay stay fenced',async () => {
  const {LoginQueue} = await import('../tasks/queue.js');
  const repo = await import('./tasksRepo.js');
  const {getDb} = await import('./connection.js');
  let dispatched = 0;
  const queue = new LoginQueue({getConcurrency:() => 20,readAuthorizationAttempt:async binding => ({binding,status:'active'}),runLoginTask:async task => {
    dispatched++;repo.markCallbackPending(task.enterpriseId,task.id,'success');repo.resolveAuthority(task.enterpriseId,task.id,'succeeded');
  }});
  const request = loginRequest(profile);
  const results = await Promise.all(Array.from({length:12},() => queue.enqueue(request)));
  await settle(); assert.equal(new Set(results.map(t => t.id)).size,1);assert.equal(dispatched,1);
  for (const patch of [{accountIncarnation:request.oauthAttemptId},{expectedGhLogin:'wrong_test'},{expectedGithubUserId:'43'},{enterpriseId:SECOND_ENTERPRISE},{ssoUser:'different-name'}]) {
    await assert.rejects(queue.enqueue({...request,...patch}),/authorization_nonce_conflict/);
  }
  const task = repo.getTask(profile.id,results[0].id)!;
  assert.throws(() => queue.retry(profile.id,task.id),/new_proxy_attempt_required/);
  assert.equal(repo.deleteTask(profile.id,task.id),'deleted');
  await assert.rejects(queue.enqueue(request),/authorization_nonce_consumed/);
  assert.equal(dispatched,1);
  assert.throws(() => getDb().prepare('DELETE FROM login_nonce_ledger WHERE oauth_attempt_id=?').run(request.oauthAttemptId),/login_nonce_evidence_required/);
  assert.throws(() => getDb().prepare('UPDATE login_nonce_ledger SET expected_gh_login=? WHERE oauth_attempt_id=?').run('wrong',request.oauthAttemptId),/login_nonce_immutable/);
});

test('authority mismatch/revision/incarnation fail before ledger mutation',async () => {
  const {LoginQueue} = await import('../tasks/queue.js');
  const {getDb} = await import('./connection.js');
  let callbacks = 0;
  const request = loginRequest(profile);
  const queue = new LoginQueue({getConcurrency:() => 0,readAuthorizationAttempt:async binding => {
    callbacks++;return {binding:{...binding,accountIncarnation:request.oauthAttemptId},status:'active'};
  }});
  await assert.rejects(queue.enqueue(request),/authorization_binding_mismatch/);
  await assert.rejects(queue.enqueue({...request,enterpriseRevision:2}),/enterprise_revision_mismatch/);
  assert.equal(callbacks,1);
  assert.equal(getDb().prepare('SELECT 1 FROM login_nonce_ledger WHERE oauth_attempt_id=?').get(request.oauthAttemptId),undefined);
});

test('cancel running task aborts only its browser; acknowledged cancellation never overwritten by late success',async () => {
  const {LoginQueue} = await import('../tasks/queue.js');
  const repo = await import('./tasksRepo.js');
  const signals = new Map<string,AbortSignal>(),complete = new Map<string,() => void>();
  const queue = new LoginQueue({getConcurrency:() => 2,readAuthorizationAttempt:async binding => ({binding,status:'active'}),
    cancelAuthorizationAttempt:async (e,id) => ({binding:repo.taskBinding(repo.getTask(e,id)!),status:'cancelled'}),
    runLoginTask:async (task,_payload,signal) => {signals.set(task.id,signal!);await new Promise<void>(resolve => complete.set(task.id,resolve));
      repo.markCallbackPending(task.enterpriseId,task.id,'success');repo.resolveAuthority(task.enterpriseId,task.id,'succeeded');}});
  const a = await queue.enqueue(loginRequest(profile)),b = await queue.enqueue(loginRequest(profile,{enterpriseId:SECOND_ENTERPRISE}));
  const wrong = await queue.cancel(SECOND_ENTERPRISE,a.id);assert.equal(wrong,undefined);assert.equal(signals.get(a.id)?.aborted,false);
  const cancelled = await queue.cancel(profile.id,a.id);assert.equal(cancelled?.outcome,'cancelled');
  assert.equal(signals.get(a.id)?.aborted,true);assert.equal(signals.get(b.id)?.aborted,false);
  complete.get(a.id)!();await settle();assert.equal(repo.getTask(profile.id,a.id)?.status,'cancelled');
  complete.get(b.id)!();await settle();assert.equal(repo.getTask(SECOND_ENTERPRISE,b.id)?.status,'success');
});

test('cancel-success race acknowledges authority winner; unknown cancellation survives restart without browser replay',async () => {
  const {LoginQueue} = await import('../tasks/queue.js');
  const repo = await import('./tasksRepo.js');
  const request = loginRequest(profile);
  let state:'active'|'succeeded'|'cancelled' = 'active',unavailable = false,launched = 0;
  const queue = new LoginQueue({getConcurrency:() => 0,readAuthorizationAttempt:async binding => {
    if (unavailable) throw new Error('offline');return {binding,status:state};
  },cancelAuthorizationAttempt:async () => {throw new Error('conflict_or_offline');},runLoginTask:async () => {launched++;}});
  const task = await queue.enqueue(request);
  state = 'succeeded';
  assert.equal((await queue.cancel(profile.id,task.id))?.outcome,'already-succeeded');
  assert.equal(repo.getTask(profile.id,task.id)?.status,'success');
  state = 'active';
  const uncertain = await queue.enqueue(loginRequest(profile));
  unavailable = true;
  assert.equal((await queue.cancel(profile.id,uncertain.id))?.outcome,'unknown');
  assert.equal(repo.getTask(profile.id,uncertain.id)?.status,'uncertain');
  assert.equal(repo.deleteTask(profile.id,uncertain.id),'not_allowed');
  repo.recoverInterruptedTasks();
  await queue.reconcileInterruptedTasks(20);
  assert.equal(launched,0);
  unavailable = false;state = 'cancelled';
  assert.equal((await queue.reconcile(profile.id,uncertain.id))?.outcome,'cancelled');
});

test('restart preserves pending closure, never recovers password or reruns nonce; legacy tombstone blocks replay after deletion',async () => {
  const repo = await import('./tasksRepo.js');
  const {getDb} = await import('./connection.js');
  const a = repo.createTask(loginRequest(profile)).task,b = repo.createTask(loginRequest(profile)).task;
  repo.claimTask(profile.id,b.id);repo.markCallbackPending(profile.id,b.id,'success');
  repo.recoverInterruptedTasks();
  assert.equal(repo.getTask(profile.id,a.id)?.authorityCloseAction,'cancel');
  assert.equal(repo.getTask(profile.id,b.id)?.authorityCloseAction,'success');
  assert.equal(repo.claimTask(profile.id,b.id),undefined);
  const columns = getDb().prepare('PRAGMA table_info(login_tasks)').all() as Array<{name:string}>;
  assert.ok(!columns.some(c => /password|token/.test(c.name)));
  const request = loginRequest(profile);
  getDb().prepare('INSERT INTO login_legacy_nonce_tombstones(oauth_attempt_id,task_id,enterprise_id) VALUES (?,?,?)')
    .run(request.oauthAttemptId,'deleted-history',profile.id);
  assert.throws(() => repo.createTask(request),/authorization_nonce_consumed/);
});
