import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID, type EnterpriseServiceReadinessDto } from '@ghcp/shared';

const TOKEN = 'login-routes-token';
const PROXY = 'http://proxy.test';
const logDir = mkdtempSync(join(tmpdir(), 'login-routes-'));
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DB_PATH = ':memory:';
process.env.INTERNAL_API_TOKEN = TOKEN;
process.env.PROXY_BASE_URL = PROXY;
process.env.LOG_DIR = logDir;
process.env.LOG_LEVEL = 'error';

const fixture = await import('../testing/enterpriseFixture.js');
const { setLoginEnterprisesForTesting } = await import('../enterprises.js');
setLoginEnterprisesForTesting(fixture.loginFixtureRegistry());
const repo = await import('../db/tasksRepo.js');
const { loginQueue } = await import('../tasks/queue.js');
const { buildApp } = await import('../server.js');

// Nothing in this file may start a browser: queued tasks stay queued.
loginQueue.stopAccepting();

const DEFAULT = DEFAULT_ENTERPRISE_ID;
const CONTOSO = fixture.GHE_ENTERPRISE_ID;

/** Every call Login makes to Proxy, as `METHOD path`. */
const proxyCalls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== PROXY) return originalFetch(input, init);
  proxyCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname.endsWith('/login-task-protection')) return Response.json({ managed: false, referenced: false });
  if (url.pathname.endsWith('/prepare')) return Response.json(preparedRetry(url, init));
  return Response.json({});
};

const server = buildApp().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  server.close();
  rmSync(logDir, { recursive: true, force: true });
});

interface ResponseBody {
  error: { code: string };
  id: string;
  enterpriseId: string;
  ssoType: string;
  status: string;
  total: number;
  oauthAttemptId: string;
  items: Array<{ id: string; taskId: string; status: string }>;
  pending: string[];
}

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

async function call(path: string, options: CallOptions = {}): Promise<{ status: number; body: ResponseBody }> {
  const token = options.token === undefined ? TOKEN : options.token;
  const response = await originalFetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Internal-Token': token } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as ResponseBody };
}

function createIn(enterpriseId: string, body: Record<string, unknown>) {
  return call(`/api/enterprises/${enterpriseId}/tasks`, { body });
}

function preparedRetry(url: URL, init: RequestInit | undefined): Record<string, unknown> {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const [, , , , , identity, , attemptId] = url.pathname.split('/');
  return { ...body, identity, oauthAttemptId: attemptId, ssoPassword: body.ssoPassword ?? 'server-default' };
}

function taskBody(identity: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity,
    ssoUser: 'same-user',
    ssoPassword: 'fixture-password',
    ghLogin: `${identity}-gh`,
    oauthAttemptId: randomUUID(),
    ...extra,
  };
}

/** A failed task of the enterprise, ready for retry or delete. */
function failedTask(enterpriseId: typeof DEFAULT, identity: string, ssoType: 'custom' | 'azure' = 'custom') {
  const input = { identity, ssoUser: 'same-user', ghLogin: `${identity}-gh`, ssoType, oauthAttemptId: randomUUID() };
  const task = repo.createTask(enterpriseId, input);
  repo.markFailed(enterpriseId, task.id, 'fixture failure', task.oauthAttemptId);
  return task;
}

test('readiness lists every enterprise with what Login knows and its blockers', async () => {
  assert.equal((await call('/internal/enterprises', { token: null })).status, 401);
  const { status, body } = await call('/internal/enterprises');
  assert.equal(status, 200);
  const readiness = body as unknown as EnterpriseServiceReadinessDto[];
  assert.deepEqual(readiness, [
    {
      id: DEFAULT,
      githubBaseUrl: 'https://github.com',
      slug: 'acme',
      shortcode: null,
      configured: true,
      blockers: [],
    },
    {
      id: CONTOSO,
      githubBaseUrl: 'https://contoso.ghe.com',
      slug: 'contoso',
      shortcode: null,
      configured: true,
      blockers: [],
    },
    {
      id: fixture.UNREADY_ENTERPRISE_ID,
      githubBaseUrl: 'https://unready.ghe.com',
      slug: null,
      shortcode: null,
      configured: false,
      blockers: ['enterprise_field_missing:github.slug'],
    },
  ]);
});

test('unscoped task routes are refused; the global runtime settings stay unscoped', async () => {
  for (const [path, method] of [['/api/tasks', 'GET'], ['/api/tasks', 'POST'], ['/api/queue', 'GET'],
    ['/api/tasks/summary', 'GET'], ['/api/tasks/operations/preview', 'POST'], ['/api/enterprises', 'GET']]) {
    const { status, body } = await call(path!, { method, body: method === 'POST' ? taskBody('unscoped') : undefined });
    assert.equal(status, 400, path);
    assert.equal(body.error.code, 'enterprise_scope_required', path);
  }
  assert.equal((await call('/api/tasks', { token: null })).status, 401);
  assert.equal((await call('/api/settings/runtime')).status, 200);
  assert.equal((await call('/api/enterprises/default/settings/runtime')).status, 404);
  assert.equal((await call('/api/enterprises/nobody/tasks')).body.error.code, 'enterprise_not_found');
  assert.equal((await call('/api/enterprises/Not_Valid/tasks')).body.error.code, 'invalid_enterprise_id');
  assert.equal((await call('/api/enterprises/default/tasks', { token: null })).status, 401);
  assert.equal((await call('/api/enterprises/nobody/tasks', { token: null })).status, 401);
  assert.deepEqual(proxyCalls, []);
});

test('a created task is bound to its enterprise and to the provider the enterprise pins', async () => {
  const created = await createIn(CONTOSO, taskBody('contoso-new'));
  assert.equal(created.status, 202);
  assert.equal(created.body.enterpriseId, CONTOSO);
  assert.equal(created.body.ssoType, 'azure');
  const id = created.body.id;
  assert.equal((await call(`/api/enterprises/${CONTOSO}/tasks/${id}`)).body.enterpriseId, CONTOSO);
  assert.equal((await call(`/api/enterprises/${DEFAULT}/tasks/${id}`)).status, 404);
  const restated = await createIn(DEFAULT, taskBody('default-new', { ssoType: 'custom' }));
  assert.equal(restated.status, 202);
  assert.equal(restated.body.ssoType, 'custom');
  assert.deepEqual(loginQueue.snapshot(CONTOSO).pending, [id]);
  assert.deepEqual(loginQueue.snapshot(DEFAULT).pending, [restated.body.id]);
});

test('without login.ssoProvider (the r4 default) each task chooses its provider, custom when omitted', async () => {
  for (const [identity, ssoType, expected] of [['r4-azure', 'azure', 'azure'], ['r4-custom', 'custom', 'custom'],
    ['r4-omitted', undefined, 'custom']] as const) {
    const created = await createIn(DEFAULT, taskBody(identity, { ssoType }));
    assert.equal(created.status, 202, identity);
    assert.equal(created.body.ssoType, expected, identity);
  }
  const invalid = await createIn(DEFAULT, taskBody('r4-okta', { ssoType: 'okta' }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_login_task');
});

test('a request cannot override the SSO page or selectors, pick another provider or name another scope', async () => {
  const overrides = {
    ssoUrl: 'https://evil.test/login',
    ssoLoginUrl: 'https://evil.test/login',
    allowedLoginUrls: ['https://evil.test/login'],
    selectors: { ssoSubmit: '#evil' },
    selectorOverrides: { ssoSubmit: '#evil' },
  };
  for (const [field, value] of Object.entries(overrides)) {
    const response = await createIn(DEFAULT, taskBody(`override-${field}`, { [field]: value }));
    assert.equal(response.status, 400, field);
    assert.equal(response.body.error.code, 'task_override_forbidden', field);
  }
  const mismatch = await createIn(CONTOSO, taskBody('mismatch', { ssoType: 'custom' }));
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, 'sso_type_mismatch');
  const invalidType = await createIn(CONTOSO, taskBody('invalid', { ssoType: 'okta' }));
  assert.equal(invalidType.body.error.code, 'sso_type_mismatch');
  const conflict = await createIn(CONTOSO, taskBody('conflict', { enterpriseId: DEFAULT }));
  assert.equal(conflict.status, 400);
  assert.equal(conflict.body.error.code, 'enterprise_scope_conflict');
  const missing = await createIn(DEFAULT, { ...taskBody('missing'), ghLogin: ' ' });
  assert.equal(missing.body.error.code, 'invalid_login_task');
  const unready = await createIn(fixture.UNREADY_ENTERPRISE_ID, taskBody('unready'));
  assert.equal(unready.status, 503);
  assert.equal(unready.body.error.code, 'enterprise_not_ready');
  const identities = ['mismatch', 'invalid', 'conflict', 'missing', 'unready', ...Object.keys(overrides)];
  for (const enterpriseId of [DEFAULT, CONTOSO]) {
    const page = repo.listTasksPage(enterpriseId, { q: 'override' }).items.concat(
      identities.flatMap((identity) => repo.listTasksPage(enterpriseId, { identity }).items),
    );
    assert.deepEqual(page, [], 'Rejected requests leave no task behind');
  }
});

test('an attempt id belongs to one enterprise; replays elsewhere conflict and lookups do not cross', async () => {
  const body = taskBody('attempt-owner');
  const first = await createIn(CONTOSO, body);
  assert.equal(first.status, 202);
  const replay = await createIn(CONTOSO, body);
  assert.equal(replay.body.id, first.body.id);
  const elsewhere = await createIn(DEFAULT, body);
  assert.equal(elsewhere.status, 409);
  assert.equal(elsewhere.body.error.code, 'attempt_conflict');
  const attemptPath = `tasks/by-attempt/${body.oauthAttemptId}`;
  assert.equal((await call(`/api/enterprises/${DEFAULT}/${attemptPath}`)).status, 404);
  assert.equal((await call(`/api/enterprises/${CONTOSO}/${attemptPath}`)).body.id, first.body.id);
});

test('another enterprise cannot read, retry, cancel or delete a task, and Proxy is never asked', async () => {
  const task = failedTask(CONTOSO, 'contoso-isolated', 'azure');
  const before = proxyCalls.length;
  const path = `/api/enterprises/${DEFAULT}/tasks/${task.id}`;
  for (const [suffix, method] of [['', 'GET'], ['/attempts', 'GET'], [`/attempts/${task.oauthAttemptId}/log`, 'GET'],
    ['/retry', 'POST'], ['/cancel', 'POST'], ['', 'DELETE']]) {
    const body = method === 'POST' ? { credentialMode: 'override', ssoPassword: 'x' } : undefined;
    const response = await call(`${path}${suffix}`, { method, body });
    assert.equal(response.status, 404, `${method} ${suffix}`);
  }
  assert.equal(proxyCalls.length, before);
  assert.equal(repo.getTask(CONTOSO, task.id)?.status, 'failed');
  assert.equal(repo.listAttempts(CONTOSO, task.id).length, 1);
  const listed = await call(`/api/enterprises/${DEFAULT}/tasks?status=failed`);
  assert.equal(listed.body.items.some((item) => item.id === task.id), false);
  const summary = await call(`/api/enterprises/${DEFAULT}/tasks/summary`);
  assert.equal(summary.body.total, repo.summarizeTasks(DEFAULT).total);
  assert.equal(repo.listTasks(DEFAULT).some((listedTask) => listedTask.id === task.id), false);
  const operations = await call(`/api/enterprises/${DEFAULT}/tasks/operations/preview`, {
    body: { action: 'delete', selection: { ids: [task.id] } },
  });
  assert.equal(operations.body.items.some((item) => item.id === task.id && item.status === 'pending'), false);
  assert.equal(proxyCalls.length, before);
});

test('a retry keeps the task in its enterprise and asks Proxy in that enterprise only', async () => {
  const task = failedTask(CONTOSO, 'contoso-retry', 'azure');
  const scoped = `/api/enterprises/${CONTOSO}/tasks/${task.id}/retry`;
  for (const body of [{ ssoUrl: 'https://evil.test/login' }, { selectorOverrides: { ssoSubmit: '#x' } }]) {
    assert.equal((await call(scoped, { body })).body.error.code, 'task_override_forbidden');
  }
  assert.equal((await call(scoped, { body: { enterpriseId: DEFAULT } })).body.error.code, 'enterprise_scope_conflict');
  const before = proxyCalls.length;
  const retried = await call(scoped, { body: { credentialMode: 'override', ssoPassword: 'fixture-override' } });
  assert.equal(retried.status, 202);
  assert.equal(retried.body.enterpriseId, CONTOSO);
  assert.equal(retried.body.status, 'pending');
  assert.notEqual(retried.body.oauthAttemptId, task.oauthAttemptId);
  const account = `/internal/enterprises/${CONTOSO}/accounts/contoso-retry`;
  assert.deepEqual(proxyCalls.slice(before), [
    `GET ${account}/login-task-protection`,
    `POST ${account}/oauth-attempts/${retried.body.oauthAttemptId}/prepare`,
  ]);
  assert.equal(repo.getTask(CONTOSO, task.id)?.enterpriseId, CONTOSO);
  assert.equal(repo.listAttempts(CONTOSO, task.id).length, 2);
  assert.deepEqual(loginQueue.snapshot(CONTOSO).pending.includes(task.id), true);
  assert.deepEqual(loginQueue.snapshot(DEFAULT).pending.includes(task.id), false);
});

test('a retry is refused only when the enterprise pins another provider than the task recorded', async () => {
  const pinned = failedTask(CONTOSO, 'contoso-custom', 'custom');
  const before = proxyCalls.length;
  const credentials = { credentialMode: 'override', ssoPassword: 'x' };
  const refused = await call(`/api/enterprises/${CONTOSO}/tasks/${pinned.id}/retry`, { body: credentials });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'sso_type_mismatch');
  assert.equal(proxyCalls.length, before);
  assert.equal(repo.getTask(CONTOSO, pinned.id)?.status, 'failed');
  const open = failedTask(DEFAULT, 'legacy-azure', 'azure');
  const retried = await call(`/api/enterprises/${DEFAULT}/tasks/${open.id}/retry`, { body: credentials });
  assert.equal(retried.status, 202);
  assert.equal(retried.body.ssoType, 'azure');
  assert.equal(proxyCalls.at(-1), `POST /internal/enterprises/${DEFAULT}/accounts/legacy-azure/oauth-attempts/`
    + `${retried.body.oauthAttemptId}/prepare`);
});

test('deleting a task asks Proxy for pool protection in the task enterprise', async () => {
  const task = failedTask(CONTOSO, 'contoso-delete', 'azure');
  const before = proxyCalls.length;
  assert.equal((await call(`/api/enterprises/${CONTOSO}/tasks/${task.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(proxyCalls.slice(before), [
    `GET /internal/enterprises/${CONTOSO}/accounts/contoso-delete/login-task-protection`,
  ]);
  assert.equal(repo.getTask(CONTOSO, task.id), undefined);
});
