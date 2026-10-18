import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express from 'express';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';

const TITLE = 'a restart closes unfinished tasks of every enterprise, releases them at Proxy and never replays work';

test(TITLE, async (t) => {
  const released: string[] = [];
  const app = express();
  app.use(express.json());
  app.post('/internal/enterprises/:enterpriseId/accounts/:identity/mark-copilot-oauth-failed', (req, res) => {
    released.push(`${req.params.enterpriseId}/${req.params.identity}:${req.body.oauthAttemptId}`);
    res.json({ identity: req.params.identity, copilotOauthStatus: 'failed' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DB_PATH = ':memory:';
  process.env.PROXY_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fixture = await import('../testing/enterpriseFixture.js');
  const { loginEnterprises, setLoginEnterprisesForTesting } = await import('../enterprises.js');
  setLoginEnterprisesForTesting(fixture.loginFixtureRegistry());
  const repo = await import('./tasksRepo.js');
  const { getDb } = await import('./connection.js');
  const { loginEnterpriseSeed } = await import('./enterpriseRepo.js');
  const { runMigrations } = await import('./migrations.js');
  const { recoverLoginOutcomes } = await import('../tasks/recovery.js');
  const { loginQueue } = await import('../tasks/queue.js');
  const scope = DEFAULT_ENTERPRISE_ID;
  const other = fixture.GHE_ENTERPRISE_ID;
  const create = (enterpriseId: typeof scope, identity: string) => repo.createTask(enterpriseId, {
    identity, ssoUser: identity, ghLogin: `${identity}-gh`, ssoType: 'custom', oauthAttemptId: randomUUID(),
  });
  const tasks = ['queued', 'executing', 'cancelling', 'finished'].map((identity) => create(scope, identity));
  const otherTask = repo.createTask(other, {
    identity: 'contoso-running', ssoUser: 'same', ghLogin: 'same', ssoType: 'azure', oauthAttemptId: randomUUID(),
  });
  repo.markRunning(scope, tasks[1]!.id, '/fixture-unavailable-log', tasks[1]!.oauthAttemptId);
  repo.markRunning(scope, tasks[2]!.id, '/fixture-unavailable-log', tasks[2]!.oauthAttemptId);
  repo.requestCancellation(scope, tasks[2]!.id);
  repo.markRunning(scope, tasks[3]!.id, '/fixture-unavailable-log', tasks[3]!.oauthAttemptId);
  repo.markSuccess(scope, tasks[3]!.id, tasks[3]!.oauthAttemptId);
  repo.claimTaskDeletion(scope, tasks[3]!.id);
  repo.markRunning(other, otherTask.id, '/fixture-unavailable-log', otherTask.oauthAttemptId);
  getDb().prepare(`
    INSERT INTO login_tasks (id, enterprise_id, identity, sso_user, sso_type, status, attempts, created_at)
    VALUES ('legacy-task', ?, 'legacy', 'legacy', 'custom', 'pending', 0, ?)
  `).run(scope, new Date().toISOString());
  runMigrations(getDb(), loginEnterprises().map((enterprise) => loginEnterpriseSeed(enterprise.profile)));
  recoverLoginOutcomes();
  assert.equal(repo.listUnfinishedTasks(scope).length, 0, 'Recovery settles every unfinished task synchronously');
  assert.equal(repo.listUnfinishedTasks(other).length, 0);
  const statuses = tasks.map((task) => repo.getTask(scope, task.id)?.status);
  assert.deepEqual(statuses, ['failed', 'failed', 'cancelled', 'success']);
  assert.equal(repo.getTask(scope, tasks[0]!.id)?.failureCode, 'service_interrupted');
  assert.equal(repo.getTask(scope, tasks[0]!.id)?.attempts, 0, 'Nothing was replayed');
  assert.equal(repo.getTask(scope, tasks[1]!.id)?.failureCode, 'service_interrupted');
  assert.equal(repo.getTask(scope, tasks[3]!.id)?.stage, 'success', 'An interrupted delete claim is released');
  assert.equal(repo.getTask(other, otherTask.id)?.failureCode, 'service_interrupted');
  assert.equal(repo.getTask(scope, 'legacy-task')?.failureCode, 'service_interrupted');
  assert.equal(repo.listAttempts(scope, 'legacy-task')[0]?.status, 'failed');
  assert.equal(repo.listAttempts(scope, 'legacy-task')[0]?.oauthAttemptId, undefined);
  for (let index = 0; index < 200 && released.length < 4; index++) await delay(10);
  const expected = [
    ...tasks.slice(0, 3).map((task) => `${scope}/${task.identity}:${task.oauthAttemptId}`),
    `${other}/${otherTask.identity}:${otherTask.oauthAttemptId}`,
  ];
  assert.deepEqual(released.sort(), expected.sort(),
    'Proxy is asked, in each task\'s own enterprise, to drop each interrupted attempt; legacy tasks are not reported');
  assert.deepEqual(loginQueue.snapshot(scope).pending, []);
  assert.deepEqual(loginQueue.snapshot(scope).active, []);
});
