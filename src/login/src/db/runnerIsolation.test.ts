import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { initLoginFixture, loginRequest, SECOND_ENTERPRISE } from './enterpriseFixture.js';

const profile = initLoginFixture();
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('queue→runner uses immutable profile and stored tuple; same SSO names do not share configuration/log paths',async () => {
  const {LoginQueue} = await import('../tasks/queue.js');
  const {runLoginTask} = await import('../tasks/runner.js');
  const repo = await import('./tasksRepo.js');
  const {getEnterpriseProfile} = await import('./connection.js');
  const seen:Array<{enterpriseId:string;url?:string}> = [],finished:Promise<void>[] = [];
  const queue = new LoginQueue({getConcurrency:() => 2,readAuthorizationAttempt:async binding => ({binding,status:'active'}),
    runLoginTask:async (task,payload,signal) => {
      const run = runLoginTask(task,payload,signal,{
        readAuthorizationAttempt:async binding => ({binding,status:'active'}),
        authorize:async (options,p,logger,s) => {
          assert.equal(p.profile,getEnterpriseProfile(p.enterpriseId));assert.ok(Object.isFrozen(p.profile));assert.ok(Object.isFrozen(p.profile.login.selectors));
          assert.equal(options.selectors,p.profile.login.selectors);assert.equal(options.allowedLoginUrls,p.profile.login.allowedLoginUrls);
          assert.equal(s.aborted,false);seen.push({enterpriseId:p.enterpriseId,url:options.ssoUrl});
          assert.ok(logger.path.includes(p.enterpriseId));return 'synthetic-token-no-network';
        },saveCopilotOauthToken:async (e,id,token,signal) => {
          assert.equal(token,'synthetic-token-no-network');assert.ok(signal);return {binding:repo.taskBinding(repo.getTask(e,id)!),status:'succeeded'};
        },markCopilotOauthFailed:async () => {throw new Error('unexpected_failure');},
      });finished.push(run);await run;
    }});
  const tasks = await Promise.all([queue.enqueue(loginRequest(profile)),queue.enqueue(loginRequest(profile,{enterpriseId:SECOND_ENTERPRISE}))]);
  await Promise.all(finished);await settle();
  assert.equal(seen.length,2);assert.notEqual(seen[0].url,seen[1].url);
  const rows = tasks.map(t => repo.getTask(t.enterpriseId,t.id)!);
  assert.ok(rows.every(t => t.status === 'success' && t.attempts === 1));assert.notEqual(rows[0].logPath,rows[1].logPath);
  for (const row of rows) {const log = readFileSync(row.logPath!,'utf8');assert.ok(!log.includes('synthetic-password'));assert.ok(!log.includes('synthetic-token'));}
});

test('uncertain success callback never invokes failure or reopens browser; restart read resolves committed success',async () => {
  const {runLoginTask} = await import('../tasks/runner.js');
  const repo = await import('./tasksRepo.js');
  const {getEnterpriseProfile} = await import('./connection.js');
  const {LoginQueue} = await import('../tasks/queue.js');
  const request = loginRequest(profile),task = repo.createTask(request).task;
  const running = repo.claimTask(profile.id,task.id)!;
  let reads = 0,browsers = 0,failures = 0,callbacks = 0;
  await runLoginTask(running,{...request,taskId:task.id,profile:getEnterpriseProfile(profile.id)},undefined,{
    readAuthorizationAttempt:async binding => {reads++;return {binding,status:'active'};},
    authorize:async () => {browsers++;return 'mock-token';},saveCopilotOauthToken:async () => {callbacks++;throw new Error('network_commit_unknown');},
    markCopilotOauthFailed:async () => {failures++;throw new Error('must_not_invalidate_success');},
  });
  assert.equal(repo.getTask(profile.id,task.id)?.status,'uncertain');assert.equal(repo.getTask(profile.id,task.id)?.authorityCloseAction,'success');
  assert.equal(reads,2);assert.equal(browsers,1);assert.equal(callbacks,1);assert.equal(failures,0);
  assert.equal(repo.claimTask(profile.id,task.id),undefined);
  repo.recoverInterruptedTasks();
  const queue = new LoginQueue({readAuthorizationAttempt:async binding => ({binding,status:'succeeded'}),cancelAuthorizationAttempt:async () => {throw new Error('should_not_cancel_committed');},runLoginTask:async () => {browsers++;}});
  assert.equal((await queue.reconcile(profile.id,task.id))?.outcome,'already-succeeded');assert.equal(browsers,1);
});

test('late success callback completion cannot overwrite confirmed cancellation',async () => {
  const {runLoginTask} = await import('../tasks/runner.js');
  const repo = await import('./tasksRepo.js');
  const {getEnterpriseProfile} = await import('./connection.js');
  const request = loginRequest(profile),task = repo.createTask(request).task,running = repo.claimTask(profile.id,task.id)!;
  const controller = new AbortController();
  let finishCallback:() => void = () => {},enteredCallback:() => void = () => {};
  const entered = new Promise<void>(resolve => {enteredCallback = resolve;});
  const run = runLoginTask(running,{...request,taskId:task.id,profile:getEnterpriseProfile(profile.id)},controller.signal,{
    readAuthorizationAttempt:async binding => ({binding,status:'active'}),authorize:async () => 'synthetic-token',
    saveCopilotOauthToken:async () => {enteredCallback();await new Promise<void>(resolve => {finishCallback = resolve;});return {binding:repo.taskBinding(task),status:'succeeded'};},
  });
  await entered;
  repo.requestCancellation(profile.id,task.id);controller.abort();repo.resolveAuthority(profile.id,task.id,'cancelled');
  finishCallback();await run;
  assert.equal(repo.getTask(profile.id,task.id)?.status,'cancelled');
});

test('revoked attempt at execution never opens browser; failed auth persists only safe failure code',async () => {
  const {runLoginTask} = await import('../tasks/runner.js');
  const repo = await import('./tasksRepo.js');
  const {getEnterpriseProfile} = await import('./connection.js');
  for (const revoked of [true,false]) {
    const request = loginRequest(profile),task = repo.createTask(request).task,running = repo.claimTask(profile.id,task.id)!;
    let browser = 0;
    await runLoginTask(running,{...request,taskId:task.id,profile:getEnterpriseProfile(profile.id)},undefined,{
      readAuthorizationAttempt:async binding => ({binding,status:revoked ? 'cancelled' : 'active'}),
      authorize:async () => {browser++;throw new Error('password=synthetic-password token=synthetic-token');},
      markCopilotOauthFailed:async (e,id,reason) => {assert.equal(reason,'login_authorization_failed');return {binding:repo.taskBinding(repo.getTask(e,id)!),status:'failed'};},
    });
    assert.equal(browser,revoked ? 0 : 1);
    const current = repo.getTask(profile.id,task.id)!;
    assert.equal(current.failureReason,revoked ? 'authorization_attempt_closed' : 'login_authorization_failed');assert.equal(current.status,revoked ? 'cancelled' : 'failed');
    assert.ok(!readFileSync(current.logPath!,'utf8').includes('synthetic-password'));
  }
});
