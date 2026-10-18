import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID, type ManagementOperation } from '@ghcp/shared';

test('exports real query scopes, freezes 247 targets and protects isolated cleanup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'login-management-'));
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DB_PATH = ':memory:';
  process.env.LOG_DIR = directory;
  process.env.INTERNAL_API_TOKEN = 'fixture-management';
  process.env.PROXY_BASE_URL = 'http://proxy.test';
  const scope = DEFAULT_ENTERPRISE_ID;
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Fork pool-protection lookup before deleting terminal tasks: these fixture tasks are not pool-managed.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input).startsWith('http://proxy.test/') && String(input).includes('/login-task-protection')
    ? Response.json({ managed: false, referenced: false })
    : originalFetch(input, init));
  t.after(() => { globalThis.fetch = originalFetch; });
  const repo = await import('../db/tasksRepo.js');
  const { getDb } = await import('../db/connection.js');
  const { deleteLoginTask } = await import('../tasks/delete.js');
  const { AccountLogger } = await import('../tasks/accountLogger.js');
  const { buildApp } = await import('../server.js');
  const create = (identity: string) => repo.createTask(scope, {
    identity, ssoUser: identity, ghLogin: `${identity}-gh`, ssoType: 'custom', oauthAttemptId: randomUUID(),
  });
  const tasks = Array.from({ length: 250 }, (_, index) => {
    const task = create(`export-${index}`);
    repo.markFailed(scope, task.id, index === 0 ? '=SUM(1,2)\n"quoted"' : 'Fixture failure', task.oauthAttemptId);
    return task;
  });
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/enterprises/${scope}/tasks`;
  const headers = { 'X-Internal-Token': 'fixture-management', 'Content-Type': 'application/json' };
  const all = await fetch(`${base}/export?status=failed`, { headers });
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('x-export-matched-at-start'), '250');
  const csv = await all.text();
  assert.equal(tasks.every((task) => csv.split(task.id).length === 2), true);
  assert.match(csv, /"'=SUM\(1,2\)\n""quoted"""/);
  const page = await (await fetch(`${base}/export?page=2&pageSize=100&scope=page`, { headers })).text();
  assert.equal(tasks.filter((task) => page.includes(task.id)).length, 100);
  const selected = await (await fetch(`${base}/export`, {
    method: 'POST', headers, body: JSON.stringify({ selection: { ids: [tasks[0]!.id, tasks[200]!.id] } }),
  })).text();
  assert.equal(tasks.filter((task) => selected.includes(task.id)).length, 2);
  const previewResponse = await fetch(`${base}/operations/preview`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'delete', selection: { query: { status: 'failed' }, excludedIds: tasks.slice(0, 3).map((task) => task.id) } }),
  });
  assert.equal(previewResponse.status, 201);
  const preview = await previewResponse.json() as ManagementOperation;
  assert.equal(preview.items.length, 247);
  const later = create('created-after-preview');
  repo.markFailed(scope, later.id, 'Later failure', later.oauthAttemptId);
  const execute = await fetch(`${base}/operations/${preview.id}/execute`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(execute.status, 202);
  let operation = await execute.json() as ManagementOperation;
  for (let index = 0; index < 200 && operation.status === 'running'; index++) {
    await delay(10);
    operation = await (await fetch(`${base}/operations/${preview.id}`, { headers })).json() as ManagementOperation;
  }
  assert.equal(operation.status, 'completed');
  assert.equal(operation.items.filter((item) => item.status === 'success').length, 247);
  assert.ok(repo.getTask(scope, later.id));
  assert.equal(repo.summarizeTasks(scope).total, 4);

  const task = create('isolated-log');
  const log = AccountLogger.create(directory, task.ssoUser, false, `${task.id}-${task.oauthAttemptId}`, undefined, ['fixture-password']);
  log.error('failure', 'Do not retain fixture-password');
  repo.markRunning(scope, task.id, log.path, task.oauthAttemptId);
  repo.markFailed(scope, task.id, 'Fixture failure', task.oauthAttemptId);
  assert.equal((await readFile(log.path, 'utf8')).includes('fixture-password'), false);
  const other = create('other-log-reference');
  repo.markRunning(scope, other.id, log.path, other.oauthAttemptId);
  repo.markFailed(scope, other.id, 'Fixture failure', other.oauthAttemptId);
  await assert.rejects(deleteLoginTask(scope, task.id), /referenced by another/);
  assert.ok(repo.getTask(scope, task.id));
  getDb().prepare('UPDATE login_task_attempts SET log_path = NULL WHERE task_id = ?').run(other.id);
  getDb().prepare('UPDATE login_tasks SET log_path = NULL WHERE id = ?').run(other.id);
  assert.equal(repo.claimTaskDeletion(scope, task.id), 'claimed');
  assert.throws(() => repo.reserveRetry(scope, repo.getTask(scope, task.id)!, randomUUID()), /changed/);
  repo.releaseTaskDeletion(scope, task.id);
  assert.equal(await deleteLoginTask(scope, task.id), 'deleted');
  await assert.rejects(readFile(log.path), { code: 'ENOENT' });
  assert.ok(repo.getTask(scope, other.id));
  assert.equal((await fetch(`${base}/${task.id}/attempts`, { headers })).status, 404);

  const legacy = create('legacy-log');
  const shared = AccountLogger.create(directory, legacy.ssoUser, false);
  repo.markRunning(scope, legacy.id, shared.path, legacy.oauthAttemptId);
  repo.markFailed(scope, legacy.id, 'Legacy failure', legacy.oauthAttemptId);
  getDb().prepare('UPDATE login_task_attempts SET history_incomplete = 1 WHERE task_id = ?').run(legacy.id);
  assert.equal(await deleteLoginTask(scope, legacy.id), 'deleted');
  assert.match(await readFile(shared.path, 'utf8'), /Starting login task log/);
});
