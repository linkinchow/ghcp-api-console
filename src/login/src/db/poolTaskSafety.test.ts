import assert from 'node:assert/strict';
import test from 'node:test';
import { initLoginFixture, loginRequest, SECOND_ENTERPRISE } from './enterpriseFixture.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

test('scoped Login API protects pool history, excludes other profiles, pins legacy and fails closed before side effects',async t => {
  process.env.INTERNAL_API_TOKEN = 'login-protection-test';
  process.env.LOG_LEVEL = 'error';
  const profile = initLoginFixture();
  const {createTasksApiRouter} = await import('../routes/tasksApi.js');
  const {LoginQueue} = await import('../tasks/queue.js');
  const repo = await import('./tasksRepo.js');
  const {requireInternalToken} = await import('../auth/internalAuth.js');
  const {getDb} = await import('./connection.js');
  const queue = new LoginQueue({getConcurrency:() => 0});
  const router = createTasksApiRouter(queue),app = express();
  app.use(express.json());
  app.use('/api/profiles/:enterpriseId',requireInternalToken,router);
  app.use('/api',requireInternalToken,router);
  const server = app.listen(0,'127.0.0.1');await once(server,'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const original = globalThis.fetch;
  let protection:unknown = {managed:true,referenced:true},unavailable = false,lookups = 0,authorityLookups = 0;
  const bindings = new Map<string,ReturnType<typeof repo.taskBinding>>();
  globalThis.fetch = async (input,init) => {
    const url = new URL(String(input));
    if (url.origin === base) return original(input,init);
    assert.equal(url.origin,'https://proxy.test');assert.ok(url.pathname.startsWith('/internal/profiles/'));
    assert.equal(new Headers(init?.headers).get('X-Internal-Token'),'login-protection-test');assert.equal(init?.redirect,'error');
    if (url.pathname.endsWith('/login-task-protection')) {
      lookups++;if (unavailable) throw new Error('private upstream failure');return new Response(JSON.stringify(protection));
    }
    authorityLookups++;
    const nonce = url.pathname.split('/').at(-1)!,binding = bindings.get(nonce);
    assert.ok(binding,'only locally mocked authority allowed');
    return new Response(JSON.stringify({binding,status:'active'}));
  };
  const seed = (identity:string,enterpriseId = profile.id) => repo.createTask(loginRequest(profile,{identity,enterpriseId})).task;
  const terminal = (task: ReturnType<typeof seed>) => {repo.claimTask(task.enterpriseId,task.id);repo.markCallbackPending(task.enterpriseId,task.id,'success');repo.resolveAuthority(task.enterpriseId,task.id,'succeeded');};
  const request = (path:string,method = 'GET',body?:unknown,authenticated = true) => fetch(`${base}${path}`,{method,
    headers:{'Content-Type':'application/json',...(authenticated ? {'X-Internal-Token':'login-protection-test'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
  const path = (id:string,e = profile.id) => `/api/profiles/${e}/tasks/${id}`;
  try {
    await t.test('referenced terminal tasks cannot delete; retry requires new Proxy attempt even with unreferenced history',async () => {
      const task = seed('pool-member');terminal(task);
      assert.equal((await request(path(task.id),'DELETE')).status,409);
      const retry = await request(`${path(task.id)}/retry`,'POST',{ssoPassword:'test-only'});
      assert.equal(retry.status,409);assert.equal((await retry.json() as {error:{code:string}}).error.code,'new_proxy_attempt_required');
      assert.equal(lookups,1);assert.equal(repo.getTask(profile.id,task.id)?.status,'success');
    });
    await t.test('unavailable or malformed protection retains recovery evidence and redacts upstream errors',async () => {
      const task = seed('unavailable');terminal(task);
      for (const body of [undefined,{}, {managed:true}]) {
        unavailable = body === undefined;protection = body;
        const response = await request(path(task.id),'DELETE');assert.equal(response.status,503);
        assert.ok(!(await response.text()).includes('private upstream failure'));assert.ok(repo.getTask(profile.id,task.id));
      }
      unavailable = false;
    });
    await t.test('consumed pool/direct history deletes task only, never nonce ledger',async () => {
      for (const managed of [true,false]) {
        protection = {managed,referenced:false};const task = seed(`history-${managed}`);terminal(task);
        assert.equal((await request(path(task.id),'DELETE')).status,204);assert.equal(repo.getTask(profile.id,task.id),undefined);
        assert.ok(getDb().prepare('SELECT 1 FROM login_nonce_ledger WHERE task_id=?').get(task.id));
      }
    });
    await t.test('unreferenced migrated history is deletable without emitting authority callbacks; tombstone survives',async () => {
      protection = {managed:false,referenced:false};
      getDb().prepare(`INSERT INTO login_tasks(enterprise_id,binding_version,id,identity,sso_user,sso_type,status,attempts,created_at,oauth_attempt_id)
        VALUES (?,1,'legacy-history','old','old','custom','failed',1,'2020','legacy-old-nonce')`).run(profile.id);
      getDb().prepare('INSERT INTO login_legacy_nonce_tombstones(oauth_attempt_id,task_id,enterprise_id) VALUES (?,?,?)')
        .run('legacy-old-nonce','legacy-history',profile.id);
      const before = authorityLookups;
      assert.equal((await request(path('legacy-history'),'DELETE')).status,204);
      assert.equal(authorityLookups,before);
      assert.ok(getDb().prepare('SELECT 1 FROM login_legacy_nonce_tombstones WHERE oauth_attempt_id=?').get('legacy-old-nonce'));
    });
    await t.test('unauthorized, absent, active and cross-enterprise mutations do not contact Proxy',async () => {
      const before = lookups+authorityLookups,task = seed('pending');
      assert.equal((await request(path(task.id),'DELETE',undefined,false)).status,401);
      assert.equal((await request(path(task.id),'DELETE')).status,409);
      for (const suffix of ['', '/retry','/cancel','/reconcile']) {
        assert.equal((await request(path(task.id,SECOND_ENTERPRISE)+suffix,suffix ? 'POST' : 'DELETE',{})).status,404);
      }
      assert.equal((await request(path('missing'),'DELETE')).status,404);
      assert.equal(lookups+authorityLookups,before);assert.equal(repo.getTask(profile.id,task.id)?.status,'pending');
    });
    await t.test('same SSO name across profiles stays separate for GET/list/pagination and legacy root',async () => {
      const second = seed('second-identity',SECOND_ENTERPRISE);
      assert.equal((await request(`/api/tasks/${second.id}`)).status,404);
      const listed = await (await request(`/api/profiles/${SECOND_ENTERPRISE}/tasks?page=1&pageSize=10&q=same-name`)).json() as {items:Array<{enterpriseId:string}>,total:number};
      assert.ok(listed.items.length > 0);assert.ok(listed.items.every(task => task.enterpriseId === SECOND_ENTERPRISE));
      const legacy = await (await request('/api/tasks')).json() as Array<{enterpriseId:string}>;
      assert.ok(legacy.every(task => task.enterpriseId === profile.id));
      const before = lookups+authorityLookups;
      assert.equal((await request('/api/profiles/11111111-1111-4111-8111-111111111111/tasks')).status,404);
      assert.equal(lookups+authorityLookups,before);
    });
    await t.test('create rejects override URL/selectors and mismatched revision before authority call; root cannot select second',async () => {
      const body = loginRequest(profile),before = authorityLookups;
      for (const patch of [{ssoUrl:'https://evil.test/login'},{selectorOverrides:{ssoPasswordInput:'#evil'}},{enterpriseRevision:999},{ghLogin:'body_subject'}]) {
        assert.equal((await request(`/api/profiles/${profile.id}/tasks`,'POST',{...body,...patch})).status,400);
      }
      assert.equal((await request('/api/tasks','POST',{...body,enterpriseId:SECOND_ENTERPRISE})).status,400);
      assert.equal(authorityLookups,before);
      const {ssoUser:_,ssoPassword:__,ssoType:___,...binding} = body;
      bindings.set(body.oauthAttemptId,binding);
      assert.equal((await request(`/api/profiles/${profile.id}/tasks`,'POST',body)).status,202);
      assert.equal(authorityLookups,before+1);
    });
  } finally {
    globalThis.fetch = original;server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
