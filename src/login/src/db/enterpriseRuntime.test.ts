import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initLoginFixture, loginRequest, SECOND_ENTERPRISE } from './enterpriseFixture.js';
import { runMigrations } from './migrations.js';

const UNKNOWN = '8ae5dfaa-f0a3-420f-98fe-99021a40aa00';
const profile = initLoginFixture();

test('Login gate rejects legacy WAL before recovery; task binding is immutable and persisted, history has no fabricated revision',async () => {
  const {config} = await import('../config.js');
  const {getDb,getEnterpriseProfile} = await import('./connection.js');
  const repo = await import('./tasksRepo.js');
  const target = config.dbPath;
  config.dbPath = `${target}.legacy`;
  const legacy = new Database(config.dbPath);
  runMigrations(legacy);
  legacy.pragma('journal_mode = WAL'); legacy.pragma('wal_autocheckpoint = 0');
  legacy.prepare(`INSERT INTO login_tasks (id,identity,sso_user,sso_type,status,attempts,created_at,oauth_attempt_id)
    VALUES ('old-id','old-identity','old-name','custom','pending',3,'2020-01-01','old-nonce')`).run();
  const before = readFileSync(config.dbPath),wal = readFileSync(`${config.dbPath}-wal`);
  assert.throws(repo.recoverInterruptedTasks,/enterprise_/);
  assert.deepEqual(readFileSync(config.dbPath),before); assert.deepEqual(readFileSync(`${config.dbPath}-wal`),wal);
  assert.equal((legacy.prepare('SELECT status FROM login_tasks').get() as {status:string}).status,'pending'); legacy.close();
  config.dbPath = `${target}.missing`;
  assert.throws(getDb,/enterprise_init_required/); assert.equal(existsSync(config.dbPath),false);
  config.dbPath = target;
  const db = getDb();
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  const input = loginRequest(profile);
  assert.throws(() => repo.createTask({...input,enterpriseId:UNKNOWN}),/enterprise_not_found/);
  assert.throws(() => repo.createTask({...input,enterpriseRevision:9}),/enterprise_revision_mismatch/);
  const {task} = repo.createTask(input);
  assert.equal(task.enterpriseId,profile.id); assert.equal(task.enterpriseRevision,1);
  assert.equal(repo.getTask(SECOND_ENTERPRISE,task.id),undefined);
  for (const [field,value] of [['enterprise_id',SECOND_ENTERPRISE],['enterprise_revision',2],['account_incarnation',input.oauthAttemptId],['expected_gh_login','another_test'],['oauth_attempt_id',input.accountIncarnation]]) {
    assert.throws(() => db.prepare(`UPDATE login_tasks SET ${field}=? WHERE id=?`).run(value,task.id),/enterprise_binding_immutable/);
  }
  const {LoginQueue} = await import('../tasks/queue.js');
  let lookups = 0;
  const queue = new LoginQueue({getConcurrency:() => 0,readAuthorizationAttempt:async binding => {lookups++;return {binding,status:'active'};}});
  await assert.rejects(queue.enqueue({...input,enterpriseId:UNKNOWN}),/enterprise_not_found/);
  await assert.rejects(queue.enqueue({...input,enterpriseRevision:2}),/enterprise_revision_mismatch/);
  assert.equal(lookups,0);
  const {runLoginTask} = await import('../tasks/runner.js');
  await assert.rejects(runLoginTask(task,{...input,taskId:task.id,profile:getEnterpriseProfile(profile.id),accountIncarnation:input.oauthAttemptId}),/enterprise_task_payload_mismatch/);
  assert.equal(repo.getTask(profile.id,task.id)?.attempts,0);

  db.prepare(`INSERT INTO login_tasks (enterprise_id,binding_version,id,identity,sso_user,sso_type,status,attempts,created_at,oauth_attempt_id)
    VALUES (?,1,'history','old','old','custom','failed',3,'2020-01-01','legacy-nonce')`).run(profile.id);
  db.prepare('INSERT INTO login_legacy_nonce_tombstones(oauth_attempt_id,task_id,enterprise_id) VALUES (?,?,?)')
    .run('legacy-nonce','history',profile.id);
  const history = repo.getTask(profile.id,'history')!;
  assert.equal(history.bindingVersion,1); assert.equal(history.enterpriseRevision,undefined); assert.equal(history.accountIncarnation,undefined);
  assert.throws(() => repo.taskBinding(history),/legacy_task_history_only/);
  assert.throws(() => queue.retry(profile.id,'history'),/legacy_task_history_only/);
  await assert.rejects(queue.cancel(profile.id,'history'),/legacy_task_history_only/);
  assert.equal(lookups,0);
});

test('callbacks use stored tuple and ignore mutable display login; request/body/legacy cannot override binding',async () => {
  const {getDb,getEnterpriseProfile} = await import('./connection.js');
  const repo = await import('./tasksRepo.js');
  const {saveCopilotOauthToken,markCopilotOauthFailed} = await import('../clients/proxyClient.js');
  const profile = getEnterpriseProfile();
  const request = loginRequest(profile);
  const {task} = repo.createTask(request);
  repo.claimTask(profile.id,task.id); repo.markCallbackPending(profile.id,task.id,'success');
  getDb().prepare("UPDATE login_tasks SET gh_login='display-only' WHERE id=?").run(task.id);
  const original = globalThis.fetch,sent:Array<{url:string;body:unknown}> = [];
  globalThis.fetch = async (url,init) => {
    assert.equal(init?.redirect,'error'); assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body)) as {binding:unknown};
    sent.push({url:String(url),body});
    return new Response(JSON.stringify({binding:body.binding,status:String(url).endsWith('/success') ? 'succeeded' : 'failed'}));
  };
  try {
    const binding = repo.taskBinding(task);
    const result = await saveCopilotOauthToken(profile.id,task.id,'synthetic-token');
    assert.equal(result.status,'succeeded');
    assert.deepEqual(sent[0].body,{binding,copilotOauthToken:'synthetic-token'});
    assert.ok(sent[0].url.includes(`/internal/profiles/${profile.id}/accounts/`));
    await assert.rejects(saveCopilotOauthToken(SECOND_ENTERPRISE,task.id,'synthetic-token'),/enterprise_task_missing/);
    await assert.rejects(saveCopilotOauthToken(profile.id,'history','synthetic-token'),/legacy_task_history_only/);
    await assert.rejects(markCopilotOauthFailed(profile.id,task.id,'unsafe failure details'),/authorization_failure_code_invalid/);
    assert.equal(sent.length,1);
  } finally {globalThis.fetch = original;}
});
