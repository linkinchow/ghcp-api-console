import assert from 'node:assert/strict';
import test from 'node:test';
import { ConsoleApiError, safeErrorBlockers } from './client.js';
import { discoverEnterprises, profilePath, transitionEnterprise, updateEnterpriseCap, updateGlobalPoolSettings } from './enterprises.js';
import { deleteProxyAccount, listProxyAccounts, listRequestStatsPage, reauthorizeCopilotOauth } from './proxy.js';
import { getLoginRuntimeSettings, listLoginTasksPage, reconcileLoginTask } from './login.js';
import { getSsoRuntimeSettings, patchSsoUser, runSsoUserBatch } from './sso.js';
import { getUserPoolPage } from './userPool.js';
const a = 'aaaaaaaa-1111-4111-8111-111111111111';
const b = 'bbbbbbbb-2222-4222-8222-222222222222';
const incarnation = 'cccccccc-3333-4333-8333-333333333333';

test('explicit path scope is immutable between calls and unsafe or missing scope fails closed', async t => {
  const requests: Array<{ path: string; body: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, options?: RequestInit) => {
    requests.push({ path: String(path), body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25 }), { headers: { 'Content-Type': 'application/json' } });
  });
  const first = listProxyAccounts(a, { q: 'same-name' });
  const second = listProxyAccounts(b, { q: 'same-name' });
  await Promise.all([first, second]);
  await listRequestStatsPage(b, { page: 2, pageSize: 25, q: 'old retained record', success: 'false', model: 'synthetic' });
  await getUserPoolPage(b, 'events', 3, 25, 'same-name', '');
  await listLoginTasksPage(b, { status: 'uncertain' });
  await reconcileLoginTask(b, 'bound-task');
  await getSsoRuntimeSettings(b);
  await getLoginRuntimeSettings();
  assert.match(requests[0]!.path, new RegExp(`/profiles/${a}/accounts`));
  assert.match(requests[1]!.path, new RegExp(`/profiles/${b}/accounts`));
  assert.match(requests[2]!.path, /request-stats\/page\?page=2&pageSize=25&q=old\+retained\+record&success=false&model=synthetic/);
  assert.match(requests[3]!.path, new RegExp(`/profiles/${b}/user-pool/page/events`));
  assert.match(requests[4]!.path, new RegExp(`/profiles/${b}/tasks`));
  assert.match(requests[5]!.path, new RegExp(`/profiles/${b}/tasks/bound-task/reconcile$`));
  assert.match(requests[6]!.path, new RegExp(`/sso/profiles/${b}/settings/runtime$`));
  assert.equal(requests[7]!.path, '/api/console/login-service/settings/runtime', 'Login runtime settings remain global');
  for (const invalid of ['', 'default', '../accounts', 'https://evil.test', a + '/..']) assert.throws(() => profilePath('proxy', invalid));
  assert.equal(requests.length, 8);
});

test('dangerous writes carry displayed incarnations and policies carry captured versions', async t => {
  const requests: Array<{ path: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, options?: RequestInit) => {
    requests.push({ path: String(path), body: JSON.parse(String(options?.body)) });
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
  assert.throws(() => deleteProxyAccount(a, 'same-name', ''));
  assert.throws(() => patchSsoUser(a, 'same-name', { expectedUserIncarnation: '' }));
  assert.throws(() => runSsoUserBatch(a, { operation: 'delete_sso', ssoUsers: ['same-name'], expectedIncarnations: {} }));
  assert.equal(requests.length, 0);
  await deleteProxyAccount(a, 'same-name', incarnation);
  await patchSsoUser(b, 'same-name', { expectedUserIncarnation: incarnation, role: 'user' });
  await runSsoUserBatch(b, { operation: 'delete_sso', ssoUsers: ['same-name'], expectedIncarnations: { 'same-name': incarnation } });
  await updateEnterpriseCap(b, 7, 90);
  await transitionEnterprise(b, 8, 'validate');
  await transitionEnterprise(b, 9, 'activate');
  await transitionEnterprise(b, 10, 'drain');
  await updateGlobalPoolSettings(4, { idle_target: 900, lease_seconds: 600, paused: 1 });
  assert.deepEqual(requests.map(item => item.body), [
    { expectedAccountIncarnation: incarnation }, { expectedUserIncarnation: incarnation, role: 'user' },
    { operation: 'delete_sso', ssoUsers: ['same-name'], expectedIncarnations: { 'same-name': incarnation } },
    { expectedVersion: 7, maxAccounts: 90 }, { expectedVersion: 8 }, { expectedVersion: 9, confirm: true }, { expectedVersion: 10, confirm: true },
    { expectedVersion: 4, changes: { idle_target: 900, lease_seconds: 600, paused: 1 } },
  ]);
  assert.equal(requests.at(-1)!.path, '/api/console/proxy/management/pool/settings');
  const before = requests.length;
  assert.throws(() => reauthorizeCopilotOauth(b, 'same-name', { ssoPassword: 'synthetic', ssoType: 'custom', expectedAccountIncarnation: '' }));
  assert.equal(requests.length, before);
  await reauthorizeCopilotOauth(b, 'same-name', { ssoPassword: 'synthetic', ssoType: 'custom', expectedAccountIncarnation: incarnation });
  assert.equal(requests.at(-1)!.path, `/api/console/proxy/profiles/${b}/accounts/same-name/copilot-oauth/reauthorize`);
  assert.equal(requests.at(-1)!.body.expectedAccountIncarnation, incarnation);
});

test('readiness error details expose only bounded safe blocker codes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: {
    code: 'enterprise_readiness_blocked', message: 'Enterprise pool operation was not applied.',
    details: { blockers: ['seat_secret_unavailable', 'scim_secret_unavailable', 'seat_secret_unavailable', 'https://private.test', '/private/secret', '<script>alert(1)</script>', null, 3, 'x'.repeat(97)], secretRef: 'never render this detail' },
  } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(transitionEnterprise(b, 2, 'validate'), error => {
    assert.ok(error instanceof ConsoleApiError);
    assert.deepEqual(safeErrorBlockers(error), ['seat_secret_unavailable', 'scim_secret_unavailable']);
    assert.equal(error.message, 'Enterprise pool operation was not applied.');
    return true;
  });
  for (const details of [null, 'not-an-object', [], { blockers: 'secret' }, { blockers: Array(33).fill('valid_code') }]) {
    assert.deepEqual(safeErrorBlockers(new ConsoleApiError(503, 'blocked', 'Blocked', details)), []);
  }
  assert.deepEqual(safeErrorBlockers(new Error('ordinary failure')), []);
});

test('unavailable or invalid enterprise discovery never guesses a legacy enterprise', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ enabled: true, legacyEnterpriseId: a, enterprises: [{ enterpriseId: b, slug: 'other', policyVersion: 1 }] })));
  await assert.rejects(discoverEnterprises(), /discovery is invalid/);
  mock.mock.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'offline', message: 'Discovery offline' } }), { status: 503 }));
  await assert.rejects(discoverEnterprises(), /Discovery offline/);
  assert.equal(mock.mock.callCount(), 2, 'no unscoped fallback fetch');
});
