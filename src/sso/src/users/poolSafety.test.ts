import assert from 'node:assert/strict';
import test from 'node:test';
import { initSsoFixture } from '../db/enterpriseFixture.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

test('pool safety APIs fail closed without adopting or recreating users', async (t) => {
  process.env.INTERNAL_API_TOKEN = 'pool-safety-test-token';
  process.env.PROXY_BASE_URL = 'https://proxy.test';
  process.env.SSO_DEFAULT_USER_PASSWORD = 'pool-safety-default-password';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SCIM_BASE_URL = 'https://scim.test/scim/v2/enterprises/test';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.LOG_LEVEL = 'error';
  const scope = initSsoFixture();
  const { getUser: incarnationUser } = await import('../db/usersRepo.js');

  const { requireInternalToken } = await import('../auth/internalAuth.js');
  const { hashPassword, verifyPassword } = await import('../auth/password.js');
  const { config } = await import('../config.js');
  const { getDb } = await import('../db/connection.js');
  const { createUser, deleteUser, getUser, isPoolManagedSsoUser, toDto, updateEmu } = await import('../db/usersRepo.js');
  const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
  const { createUsersApiRouter } = await import('../routes/usersApi.js');
  const { runSsoUserBatch } = await import('./service.js');
  updateSsoRuntimeSettings({ expectedVersion: 1, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } }, scope);

  const app = express();
  app.use(express.json());
  app.use('/api', requireInternalToken, createUsersApiRouter(scope));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const originalFetch = globalThis.fetch;
  const scimRequests: Array<{ url: string; method: string }> = [];
  const proxyRequests: Array<{ url: string; method: string }> = [];
  let membershipResponse = () => jsonResponse(200, { managed: false, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision, contractVersion: 2 });
  let conflict = true;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(`${baseUrl}/`)) return originalFetch(input, init);
    const method = init?.method ?? 'GET';
    if (url.startsWith('https://proxy.test/')) {
      proxyRequests.push({ url, method });
      assert.equal(new Headers(init?.headers).get('X-Internal-Token'), process.env.INTERNAL_API_TOKEN);
      if (url.endsWith('/pool-membership') && method === 'GET') return membershipResponse();
      if (method === 'DELETE') return jsonResponse(200, { enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision, contractVersion: 2, ssoUser: decodeURIComponent(url.split('/').at(-1)!), matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 });
      throw new Error(`Unexpected Proxy request: ${method} ${url}`);
    }
    scimRequests.push({ url, method });
    if (url.startsWith('https://scim.test/') && (method === 'DELETE' || method === 'PATCH')) return jsonResponse(200, {});
    if (url.includes('/copilot/billing/selected_users') && method === 'DELETE') return jsonResponse(200, {});
    if (url === 'https://scim.test/scim/v2/enterprises/test/Users' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { userName: string };
      return conflict
        ? jsonResponse(409, { detail: 'Username already exists.' })
        : jsonResponse(201, { id: `new-${body.userName}`, userName: body.userName, githubLogin: `${body.userName}_emu` });
    }
    if (url.startsWith('https://scim.test/scim/v2/enterprises/test/Users?') && method === 'GET') {
      const username = /userName eq "([^"]+)"/.exec(new URL(url).searchParams.get('filter') ?? '')?.[1] ?? 'legacy-sync';
      return jsonResponse(200, { Resources: [{ id: 'preexisting-id', userName: username }] });
    }
    if (url === 'https://scim.test/scim/v2/enterprises/test/Users/preexisting-id' && method === 'PUT') {
      return jsonResponse(200, { id: 'preexisting-id', userName: 'legacy-sync', githubLogin: 'legacy-sync_emu' });
    }
    if (url.includes('/copilot/billing/selected_users') && method === 'POST') return jsonResponse(201, {});
    throw new Error(`Unexpected outbound request: ${method} ${url}`);
  };

  const seed = (ssoUser: string, password = process.env.SSO_DEFAULT_USER_PASSWORD!, role: 'user' | 'admin' = 'user') =>
    createUser({ ssoUser, ...hashPassword(password), email: `${ssoUser}@pool.test`, role }, scope);
  const request = (path: string, body?: unknown, token: string | undefined = process.env.INTERNAL_API_TOKEN, method = 'POST') =>
    fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Internal-Token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // Durable operation fences now write before external calls and clear after known outcomes.
  // Compare the complete final database rows, not SQLite's cumulative implementation counter.
  const changes = () => ({ users: getDb().prepare('SELECT * FROM sso_users ORDER BY sso_user').all(), markers: getDb().prepare('SELECT * FROM sso_pool_managed_users ORDER BY sso_user').all() });
  const ownership = (user: { createdAt: string; email: string }) => ({ expectedCreatedAt: user.createdAt, expectedEmail: user.email });

  try {
    await t.test('credentials require internal auth and valid ownership fields', async () => {
      const user = seed('owned');
      const before = changes();
      for (const token of ['', 'wrong-token']) {
        const response = await request('/users/owned/login-credentials', ownership(user), token);
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error.code, 'internal_auth_failed');
      }
      for (const body of [undefined, {}, { expectedCreatedAt: user.createdAt }, { expectedEmail: user.email },
        { ...ownership(user), expectedCreatedAt: 123 }, { ...ownership(user), expectedCreatedAt: 'not-a-date' },
        { ...ownership(user), expectedEmail: '  ' }]) {
        const response = await request('/users/owned/login-credentials', body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'invalid_ownership');
      }
      assert.deepEqual(changes(), before);
      assert.deepEqual(getUser('owned', scope), user);
    });

    await t.test('credentials read an existing user without mutations or secret-bearing ordinary DTOs', async () => {
      const user = getUser('owned', scope)!;
      const before = changes();
      const response = await request('/users/owned/login-credentials', ownership(user));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { user: JSON.parse(JSON.stringify(toDto(user))), passwordForLogin: process.env.SSO_DEFAULT_USER_PASSWORD });
      for (const path of ['/users/owned', '/users']) {
        const ordinary = await request(path, undefined, process.env.INTERNAL_API_TOKEN, 'GET');
        assert.equal(ordinary.status, 200);
        const body = await ordinary.text();
        for (const secret of ['passwordForLogin', 'passwordHash', 'salt', process.env.SSO_DEFAULT_USER_PASSWORD!]) {
          assert.equal(body.includes(secret), false, `Ordinary ${path} response must not contain ${secret}`);
        }
      }
      assert.deepEqual(changes(), before);
      assert.deepEqual(getUser('owned', scope), user);
    });

    await t.test('credentials reject mismatched identity, ownership, role, and disabled EMU state', async () => {
      const user = getUser('owned', scope)!;
      const admin = seed('admin', undefined, 'admin');
      seed('suspended');
      const suspended = updateEmu('suspended', { emuStatus: 'suspended', ghScimId: 'suspended-id' }, (incarnationUser('suspended', scope)!.userIncarnation), scope);
      seed('deleted-emu');
      const deleted = updateEmu('deleted-emu', { emuStatus: 'deleted' }, (incarnationUser('deleted-emu', scope)!.userIncarnation), scope);
      const before = changes();
      for (const [ssoUser, body] of [
        ['owned', { ...ownership(user), expectedEmail: 'different@pool.test' }],
        ['owned', { ...ownership(user), expectedCreatedAt: '2000-01-01T00:00:00.000Z' }],
        ['OWNED', ownership(user)],
        ['admin', ownership(admin)],
        ['suspended', ownership(suspended)],
        ['deleted-emu', ownership(deleted)],
      ] as const) {
        const response = await request(`/users/${ssoUser}/login-credentials`, body);
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'user_ownership_mismatch');
      }
      assert.deepEqual(changes(), before);
    });

    await t.test('missing/deleted credentials return 404 and never recreate users; recreated identity fails ownership', async () => {
      const deleted = seed('removed');
      deleteUser('removed', (incarnationUser('removed', scope)!.userIncarnation), undefined, scope);
      let before = changes();
      for (const ssoUser of ['missing', 'removed']) {
        const response = await request(`/users/${ssoUser}/login-credentials`, ownership(deleted));
        assert.equal(response.status, 404);
        assert.equal((await response.json()).error.code, 'user_not_found');
        assert.equal(getUser(ssoUser, scope), undefined);
      }
      assert.deepEqual(changes(), before);
      seed('removed');
      getDb().prepare('UPDATE sso_users SET created_at = ? WHERE sso_user = ?').run('2099-01-01T00:00:00.000Z', 'removed');
      before = changes();
      const response = await request('/users/removed/login-credentials', ownership(deleted));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'user_ownership_mismatch');
      assert.deepEqual(changes(), before);
    });

    await t.test('unknown passwords fail closed without rotation; verified username fallback still works', async () => {
      const custom = seed('custom-password', 'not-a-known-password');
      const usernamePassword = seed('username-password', 'username-password');
      const before = changes();
      const unavailable = await request('/users/custom-password/login-credentials', ownership(custom));
      assert.equal(unavailable.status, 409);
      assert.equal((await unavailable.json()).error.code, 'login_credentials_unavailable');
      assert.deepEqual(getUser('custom-password', scope), custom);
      const response = await request('/users/username-password/login-credentials', ownership(usernamePassword));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).passwordForLogin, 'username-password');
      assert.deepEqual(changes(), before);
    });

    await t.test('createOnly validates flag type and operation before performing any work', async () => {
      for (const body of [
        { operation: 'sync_emu', ssoUsers: ['owned'], createOnly: 'true' },
        { operation: 'delete_sso', ssoUsers: ['owned'], createOnly: true },
      ]) {
        const response = await request('/users/batch', body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'invalid_create_only');
      }
      assert.equal(scimRequests.length, 0);
    });

    await t.test('createOnly conflict issues only POST, never looks up, adopts, updates, or assigns seats', async () => {
      const user = seed('collision');
      const before = changes();
      const response = await request('/users/batch', {
        operation: 'sync_emu', ssoUsers: ['collision'], createOnly: true, assignCopilotSeat: true,
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.summary.failed, 1);
      assert.equal(result.summary.success, 0);
      assert.equal(result.rows[0].status, 'failed');
      assert.match(result.rows[0].detail, /SCIM create-only conflict/);
      assert.equal(result.rows[0].user, undefined);
      assert.deepEqual(scimRequests.splice(0), [{ url: 'https://scim.test/scim/v2/enterprises/test/Users', method: 'POST' }]);
      assert.deepEqual(getUser('collision', scope), user);
      assert.deepEqual(changes(), before);
    });

    await t.test('createOnly refuses existing provisioning before any request or local write', async () => {
      for (const [ssoUser, patch] of [
        ['linked-id', { ghScimId: 'existing-id', emuStatus: 'active' as const }],
        ['linked-login', { ghLogin: 'existing-login', emuStatus: 'not_synced' as const }],
        ['linked-state', { emuStatus: 'suspended' as const }],
      ] as const) {
        seed(ssoUser);
        const user = updateEmu(ssoUser, patch, (incarnationUser(ssoUser, scope)!.userIncarnation), scope);
        const before = changes();
        const result = await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: [ssoUser], createOnly: true, assignCopilotSeat: true }, scope);
        assert.equal(result.summary.failed, 1);
        assert.match(result.rows[0]?.detail ?? '', /SCIM create-only refused/);
        assert.deepEqual(getUser(ssoUser, scope), user);
        assert.deepEqual(changes(), before);
      }
      assert.deepEqual(scimRequests, []);
    });

    await t.test('default and explicit false retain legacy conflict adoption behavior', async () => {
      seed('legacy-sync');
      for (const createOnly of [undefined, false]) {
        updateEmu('legacy-sync', { emuStatus: 'not_synced' }, (incarnationUser('legacy-sync', scope)!.userIncarnation), scope);
        const result = await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: ['legacy-sync'], createOnly }, scope);
        assert.equal(result.summary.success, 1);
        assert.equal(getUser('legacy-sync', scope)?.ghScimId, 'preexisting-id');
        assert.deepEqual(scimRequests.splice(0).map(({ method }) => method), ['POST', 'GET', 'PUT']);
      }
    });

    await t.test('createOnly successfully creates new SCIM users and still supports requested seats', async () => {
      conflict = false;
      seed('new-pool-user');
      const result = await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: ['new-pool-user'], createOnly: true, assignCopilotSeat: true }, scope);
      assert.equal(result.summary.success, 1);
      assert.equal(getUser('new-pool-user', scope)?.ghScimId, 'new-new-pool-user');
      assert.equal(getUser('new-pool-user', scope)?.copilotSeatStatus, 'assigned');
      assert.deepEqual(scimRequests.splice(0).map(({ method }) => method), ['POST', 'POST']);
    });
    await t.test('pool creation rejects weak defaults and invalid flags before writing users', async () => {
      const configured = process.env.SSO_DEFAULT_USER_PASSWORD;
      try {
        for (const password of [undefined, '', 'short', ' '.repeat(20), 'pool-password-user', 'POOL-PASSWORD-USER']) {
          process.env.SSO_DEFAULT_USER_PASSWORD = password;
          const before = changes();
          const response = await request('/users', { ssoUser: 'pool-password-user', poolManaged: true });
          assert.equal(response.status, 400);
          assert.equal((await response.json()).error.code, 'pool_password_policy');
          assert.equal(getUser('pool-password-user', scope), undefined);
          assert.equal(isPoolManagedSsoUser('pool-password-user', scope), false);
          assert.deepEqual(changes(), before);
        }
        process.env.SSO_DEFAULT_USER_PASSWORD = configured;
        const explicit = await request('/users', { ssoUser: 'pool-custom-password', poolManaged: true, password: 'short' });
        assert.equal(explicit.status, 400);
        assert.equal((await explicit.json()).error.code, 'pool_password_policy');
        assert.equal(getUser('pool-custom-password', scope), undefined);
        for (const poolManaged of ['true', 1, null]) {
          const response = await request('/users', { ssoUser: 'bad-pool-flag', poolManaged });
          assert.equal(response.status, 400);
          assert.equal((await response.json()).error.code, 'invalid_pool_managed');
        }
        const admin = await request('/users', { ssoUser: 'pool-admin', poolManaged: true, role: 'admin' });
        assert.equal(admin.status, 400);
        assert.equal(getUser('pool-admin', scope), undefined);
      } finally {
        process.env.SSO_DEFAULT_USER_PASSWORD = configured;
      }
      assert.deepEqual(scimRequests, []);
      assert.deepEqual(proxyRequests, []);
    });

    await t.test('pool creation stores strong hash and durable marker atomically without leaking them in DTOs', async () => {
      const response = await request('/users', { ssoUser: 'managed-user', poolManaged: true });
      assert.equal(response.status, 201);
      const created = await response.json();
      const stored = getUser('managed-user', scope)!;
      assert.equal(verifyPassword(process.env.SSO_DEFAULT_USER_PASSWORD!, stored.passwordHash, stored.salt), true);
      assert.equal(verifyPassword(stored.ssoUser, stored.passwordHash, stored.salt), false);
      assert.equal(isPoolManagedSsoUser('MANAGED-USER', scope), true);
      assert.deepEqual(getDb().prepare('SELECT * FROM sso_pool_managed_users').all(), [{ enterprise_id: stored.enterpriseId, sso_user: 'managed-user' }]);
      for (const dto of [created, await (await request('/users/managed-user', undefined, undefined, 'GET')).json(),
        await (await request('/users', undefined, undefined, 'GET')).json()]) {
        const text = JSON.stringify(dto);
        for (const secret of ['poolManaged', 'pool_managed', 'passwordForLogin', 'passwordHash', 'salt', 'token', process.env.SSO_DEFAULT_USER_PASSWORD!]) {
          assert.equal(text.includes(secret), false);
        }
      }
      const credentials = await request('/users/managed-user/login-credentials', ownership(stored));
      assert.equal(credentials.status, 200);
      assert.equal((await credentials.json()).passwordForLogin, process.env.SSO_DEFAULT_USER_PASSWORD);
      // An ownership insert failure must roll back the user insert in the same transaction.
      getDb().exec(`CREATE TRIGGER fail_pool_marker BEFORE INSERT ON sso_pool_managed_users
        WHEN NEW.sso_user = 'marker-failure' BEGIN SELECT RAISE(ABORT, 'marker insert failed'); END;`);
      try {
        const failed = await request('/users', { ssoUser: 'marker-failure', poolManaged: true });
        assert.equal(failed.status, 400);
        assert.equal(getUser('marker-failure', scope), undefined);
        assert.equal(isPoolManagedSsoUser('marker-failure', scope), false);
      } finally {
        getDb().exec('DROP TRIGGER fail_pool_marker');
      }
    });

    await t.test('marked pool users reject legacy sync and elevated roles without adopting SCIM conflicts', async () => {
      const created = await request('/users', { ssoUser: 'managed-conflict', poolManaged: true });
      assert.equal(created.status, 201);
      conflict = true;
      const rejected = await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: ['managed-conflict'], createOnly: true }, scope);
      assert.equal(rejected.summary.failed, 1);
      assert.deepEqual(scimRequests.splice(0).map(({ method }) => method), ['POST']);
      const before = getUser('managed-conflict', scope);
      for (const options of [{}, { createOnly: false }, { createOnly: true, enterpriseRole: 'enterprise_owner' as const }]) {
        const result = await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: ['managed-conflict'], ...options }, scope);
        assert.equal(result.summary.failed, 1);
        assert.match(result.rows[0].detail ?? '', /pool_member_managed/);
        assert.deepEqual(getUser('managed-conflict', scope), before);
        assert.deepEqual(scimRequests, []);
      }
      conflict = false;
      const allowed = await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: ['managed-conflict'], createOnly: true }, scope);
      assert.equal(allowed.summary.success, 1);
      assert.deepEqual(scimRequests.splice(0).map(({ method }) => method), ['POST']);
    });

    await t.test('direct creation rejects unavailable configured secret and keeps custom passwords without marking or Proxy calls', async () => {
      const configured = process.env.SSO_DEFAULT_USER_PASSWORD;
      try {
        delete process.env.SSO_DEFAULT_USER_PASSWORD;
        const missingSecret = await request('/users', { ssoUser: 'missing-secret' });
        assert.equal(missingSecret.status, 400);
        assert.equal(getUser('missing-secret', scope), undefined);
        process.env.SSO_DEFAULT_USER_PASSWORD = configured;
        for (const poolManaged of [undefined, false]) {
          const ssoUser = poolManaged === false ? 'direct-false' : 'direct-default';
          const response = await request('/users', { ssoUser, poolManaged });
          assert.equal(response.status, 201);
          const user = getUser(ssoUser, scope)!;
          assert.equal(verifyPassword(configured!, user.passwordHash, user.salt), true);
          assert.equal(isPoolManagedSsoUser(ssoUser, scope), false);
        }
        const response = await request('/users', { ssoUser: 'direct-custom', password: 'custom-password' });
        assert.equal(response.status, 201);
        const user = getUser('direct-custom', scope)!;
        assert.equal(verifyPassword('custom-password', user.passwordHash, user.salt), true);
      } finally {
        process.env.SSO_DEFAULT_USER_PASSWORD = configured;
      }
      assert.deepEqual(proxyRequests, []);
    });

    await t.test('marked users block password email role and CSV edits locally without relying on Proxy', async () => {
      membershipResponse = () => { throw new Error('Proxy unavailable secret-token'); };
      const user = getUser('managed-user', scope)!;
      const before = changes();
      for (const patch of [{ password: 'replacement-secret' }, { email: 'changed@pool.test' }, { role: 'admin' }, { password: '' }]) {
        const response = await request('/users/MANAGED-USER', patch, undefined, 'PATCH');
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'pool_member_managed');
      }
      const imported = await request('/users/import', { csvText: 'managed-user,replacement-secret' });
      assert.equal((await imported.json()).rows[0].status, 'failed');
      assert.deepEqual(getUser('managed-user', scope), user);
      assert.deepEqual(changes(), before);
      const response = await request('/users/direct-default', { password: 'changed', email: 'changed@pool.test', role: 'admin' }, undefined, 'PATCH');
      assert.equal(response.status, 200);
      assert.equal(getUser('direct-default', scope)?.role, 'admin');
      assert.deepEqual(proxyRequests, []);
    });

    await t.test('marked users block every destructive operation before any external action or local mutation', async () => {
      // Covers both in-flight local-only provisioning and fully linked pool users.
      for (const linked of [false, true]) {
        if (linked) updateEmu('managed-user', { ghLogin: 'managed_emu', ghScimId: 'managed-id', emuStatus: 'active' }, (incarnationUser('managed-user', scope)!.userIncarnation), scope);
        const before = changes();
        const user = getUser('managed-user', scope);
        for (const operation of ['delete_sso', 'delete_emu', 'suspend_emu', 'remove_copilot']) {
          const response = await request('/users/batch', { operation, ssoUsers: ['MANAGED-USER'] });
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.summary.failed, 1);
          assert.match(result.rows[0].detail, /^pool_member_managed:/);
        }
        const response = await request('/users/managed-user/copilot-seat', undefined, undefined, 'DELETE');
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'pool_member_managed');
        assert.deepEqual(getUser('managed-user', scope), user);
        assert.deepEqual(changes(), before);
      }
      assert.deepEqual(proxyRequests, []);
      assert.deepEqual(scimRequests, []);
    });

    await t.test('legacy unmarked pool users are protected by read-only Proxy preflight before GitHub calls', async () => {
      seed('pre-marker');
      const user = updateEmu('pre-marker', { ghLogin: 'legacy_emu', ghScimId: 'legacy-id', emuStatus: 'active' }, (incarnationUser('pre-marker', scope)!.userIncarnation), scope);
      membershipResponse = () => jsonResponse(200, { managed: true, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision, contractVersion: 2 });
      const before = changes();
      for (const operation of ['delete_sso', 'delete_emu', 'suspend_emu', 'remove_copilot']) {
        const response = await request('/users/batch', { operation, ssoUsers: ['PRE-MARKER'] });
        const result = await response.json();
        assert.equal(result.summary.failed, 1);
        assert.match(result.rows[0].detail, /^pool_member_managed:/);
        assert.deepEqual(proxyRequests.splice(0), [{ url: `https://proxy.test/internal/profiles/${scope.enterpriseId}/accounts/by-sso-user/pre-marker/pool-membership`, method: 'GET' }]);
      }
      assert.equal(isPoolManagedSsoUser('pre-marker', scope), false);
      assert.deepEqual(changes(), before);
      assert.deepEqual(getUser('pre-marker', scope), user);
      assert.deepEqual(scimRequests, []);
    });

    await t.test('unavailable or malformed Proxy preflight fails closed and returns only safe errors', async () => {
      const user = getUser('pre-marker', scope);
      const before = changes();
      const badResponses = [
        () => { throw new Error('private-token transport failure'); },
        () => jsonResponse(404, { error: { code: 'not_found', message: 'private-token' } }),
        () => jsonResponse(503, { message: 'private-token' }),
        () => new Response('not-json private-token', { status: 200 }),
        () => jsonResponse(200, {}),
        () => jsonResponse(200, null),
        () => jsonResponse(200, { managed: 'false' }),
      ];
      for (const badResponse of badResponses) {
        membershipResponse = badResponse;
        for (const operation of ['delete_sso', 'delete_emu', 'suspend_emu', 'remove_copilot']) {
          const response = await request('/users/batch', { operation, ssoUsers: ['pre-marker'] });
          const result = await response.json();
          assert.equal(result.summary.failed, 1);
          assert.match(result.rows[0].detail, /^pool_membership_unavailable:/);
          assert.equal(JSON.stringify(result).includes('private-token'), false);
        }
      }
      const response = await request('/users/pre-marker/copilot-seat', undefined, undefined, 'DELETE');
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'pool_membership_unavailable');
      assert.equal(proxyRequests.splice(0).every(({ method, url }) => method === 'GET' && url.endsWith('/pool-membership')), true);
      assert.deepEqual(scimRequests, []);
      assert.deepEqual(changes(), before);
      assert.deepEqual(getUser('pre-marker', scope), user);
    });

    await t.test('direct nonpool destructive operations still run after explicit negative membership preflight', async () => {
      membershipResponse = () => jsonResponse(200, { managed: false, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision, contractVersion: 2 });
      for (const operation of ['delete_sso', 'delete_emu', 'suspend_emu', 'remove_copilot']) {
        const ssoUser = `direct-${operation}`;
        seed(ssoUser);
        updateEmu(ssoUser, { ghLogin: `${ssoUser}_emu`, ghScimId: `${ssoUser}-id`, emuStatus: 'active' }, (incarnationUser(ssoUser, scope)!.userIncarnation), scope);
        const response = await request('/users/batch', { operation, ssoUsers: [ssoUser] });
        const result = await response.json();
        assert.equal(result.summary.success, 1, JSON.stringify(result));
        const proxy = proxyRequests.splice(0);
        assert.deepEqual(proxy[0], { url: `https://proxy.test/internal/profiles/a2793f03-dafd-4e59-89cf-587b1673d30b/accounts/by-sso-user/${ssoUser}/pool-membership`, method: 'GET' });
        assert.equal(proxy.length, operation === 'delete_sso' ? 2 : 1);
        assert.ok(scimRequests.splice(0).length > 0);
        assert.equal(isPoolManagedSsoUser(ssoUser, scope), false);
        if (operation === 'delete_sso') assert.equal(getUser(ssoUser, scope), undefined);
        if (operation === 'delete_emu') assert.equal(getUser(ssoUser, scope)?.emuStatus, 'not_synced');
        if (operation === 'suspend_emu') assert.equal(getUser(ssoUser, scope)?.emuStatus, 'suspended');
        if (operation === 'remove_copilot') assert.equal(getUser(ssoUser, scope)?.copilotSeatStatus, 'unassigned');
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
