import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { managementErrorHandler } from '@ghcp/shared';
import { createEnterpriseFixture, FIXTURE_SECRETS, GHE_ENTERPRISE_ID } from '../testing/enterpriseFixture.js';

const TOKEN = 'routes-internal-token';
const fixture = createEnterpriseFixture();
process.env.DB_PATH = ':memory:';
process.env.SSO_USER_EVENTS_LOG = join(fixture.directory, 'events.log');
process.env.INTERNAL_API_TOKEN = TOKEN;
process.env.LOG_LEVEL = 'error';

const { setSsoEnterprisesForTesting } = await import('../enterprises.js');
setSsoEnterprisesForTesting(fixture.registry);
const { requireInternalToken } = await import('../auth/internalAuth.js');
const routes = await import('./enterpriseRoutes.js');
const { createEnterpriseApiRouter, createEnterpriseInternalRouter, rejectUnscoped } = routes;
const { createEnterprisesInternalRouter } = await import('./enterprisesInternal.js');

/** The same wiring as `server.ts` (SAML routes aside). */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/enterprises/:enterpriseId', requireInternalToken, createEnterpriseApiRouter());
  app.use('/internal/enterprises/:enterpriseId', requireInternalToken, createEnterpriseInternalRouter());
  app.use('/internal/enterprises', requireInternalToken, createEnterprisesInternalRouter());
  app.use('/api', requireInternalToken, rejectUnscoped);
  app.use('/internal', requireInternalToken, rejectUnscoped);
  app.use(managementErrorHandler('sso'));
  return app;
}

const server = buildApp().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(fixture.directory, { recursive: true, force: true });
});

/** The fields these tests read from JSON responses. */
interface ResponseBody {
  error: { code: string };
  id: string;
  email: string;
  total: number;
  version: number;
  maxSsoUsers: number | null;
  reached: boolean;
  password: string;
}

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

async function call(path: string, options: CallOptions = {}): Promise<{ status: number; body: ResponseBody }> {
  const token = options.token === undefined ? TOKEN : options.token;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Internal-Token': token } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as ResponseBody };
}

const api = (id: string, path: string) => `/api/enterprises/${id}${path}`;
const internal = (id: string, path: string) => `/internal/enterprises/${id}${path}`;

test('unscoped management and internal paths are rejected instead of defaulting', async () => {
  for (const [path, method] of [
    ['/api/users', 'GET'],
    ['/api/settings/runtime', 'GET'],
    ['/api/ai-credits/usage', 'GET'],
    ['/api/users/operations/preview', 'POST'],
    ['/internal/users/someone/login-credentials', 'POST'],
    ['/api/enterprises', 'GET'],
  ] as const) {
    const response = await call(path, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 400, path);
    assert.equal(response.body.error.code, 'enterprise_scope_required', path);
  }
  assert.equal((await call('/api/users', { token: null })).status, 401);
});

test('scoped paths authenticate first, then resolve the enterprise strictly', async () => {
  assert.equal((await call(api('missing', '/users'), { token: null })).status, 401);
  assert.equal((await call(api('default', '/users'), { token: 'wrong' })).status, 401);
  const unknown = await call(api('missing', '/users'));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'enterprise_not_found');
  const invalid = await call(api('Not_An_Id', '/users'));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_enterprise_id');
  const conflict = await call(api('default', '/users'), { headers: { 'x-enterprise-id': GHE_ENTERPRISE_ID } });
  assert.equal(conflict.status, 400);
  assert.equal(conflict.body.error.code, 'enterprise_scope_conflict');
  const conflictingBody = { ssoUser: 'x', enterpriseId: GHE_ENTERPRISE_ID };
  const bodyConflict = await call(api('default', '/users'), { body: conflictingBody });
  assert.equal(bodyConflict.body.error.code, 'enterprise_scope_conflict');
  assert.equal((await call(internal('missing', '/users/x/login-credentials'), { method: 'POST' })).status, 404);
  const unrouted = await call(api('default', '/no-such-route'));
  assert.equal(unrouted.status, 404);
  assert.equal(unrouted.body.error.code, 'not_found');
});

test('same-name users, settings and credentials are isolated per enterprise path', async () => {
  const left = await call(api('default', '/users'), { body: { ssoUser: 'same' } });
  const right = await call(api(GHE_ENTERPRISE_ID, '/users'), { body: { ssoUser: 'same' } });
  assert.equal(left.status, 201);
  assert.equal(right.status, 201);
  assert.equal(left.body.email, 'same@acme.example.com');
  assert.equal(right.body.email, 'same@contoso.example.eu');
  assert.equal((await call(api('default', '/users'), { body: { ssoUser: 'only-a' } })).status, 201);
  assert.equal((await call(api('default', '/users/same'))).body.email, 'same@acme.example.com');
  assert.equal((await call(api(GHE_ENTERPRISE_ID, '/users/same'))).body.email, 'same@contoso.example.eu');
  const missing = await call(api(GHE_ENTERPRISE_ID, '/users/only-a'));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'user_not_found');
  assert.equal((await call(api(GHE_ENTERPRISE_ID, '/users'))).body.total, 1);
  assert.equal((await call(api('default', '/users'))).body.total, 2);

  const settings = (await call(api('default', '/settings/runtime'))).body;
  const patched = await call(api('default', '/settings/runtime'), {
    method: 'PATCH',
    body: { expectedVersion: settings.version, changes: { maxSsoUsers: 2 } },
  });
  assert.equal(patched.status, 200);
  assert.equal((await call(api(GHE_ENTERPRISE_ID, '/settings/runtime'))).body.maxSsoUsers, null);
  assert.equal((await call(api('default', '/users/capacity'))).body.reached, true);
  assert.equal((await call(api(GHE_ENTERPRISE_ID, '/users/capacity'))).body.reached, false);

  const credentials = (id: string, ssoUser: string) => call(internal(id, `/users/${ssoUser}/login-credentials`), {
    method: 'POST',
  });
  assert.equal((await credentials('default', 'same')).body.password, FIXTURE_SECRETS.ACME_DEFAULT_PASSWORD);
  assert.equal((await credentials(GHE_ENTERPRISE_ID, 'same')).body.password, FIXTURE_SECRETS.CONTOSO_DEFAULT_PASSWORD);
  assert.equal((await credentials(GHE_ENTERPRISE_ID, 'only-a')).status, 404);
  assert.equal((await call(api('default', '/ai-credits/usage'))).status, 404);
});

test('management operation previews belong to the enterprise that created them', async () => {
  const preview = await call(api('default', '/users/operations/preview'), {
    body: { action: 'sync_emu', selection: { ids: ['only-a'] } },
  });
  assert.equal(preview.status, 201, JSON.stringify(preview.body));
  const { id } = preview.body;
  assert.equal((await call(api('default', `/users/operations/${id}`))).status, 200);
  const foreign = await call(api(GHE_ENTERPRISE_ID, `/users/operations/${id}`));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'operation_not_found');
});

test('readiness lists every enterprise with identity fields and blockers but no secrets', async () => {
  assert.equal((await call('/internal/enterprises', { token: null })).status, 401);
  const response = await call('/internal/enterprises');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [
    {
      id: 'default',
      githubBaseUrl: 'https://github.com',
      slug: 'acme',
      shortcode: 'octo',
      configured: true,
      blockers: [],
    },
    {
      id: GHE_ENTERPRISE_ID,
      githubBaseUrl: 'https://contoso.ghe.com',
      slug: 'contoso',
      shortcode: '',
      configured: false,
      blockers: ['enterprise_secret_unconfigured:sso.signingKey'],
    },
  ]);
  const text = JSON.stringify(response.body);
  for (const secret of Object.values(FIXTURE_SECRETS)) assert.equal(text.includes(secret), false);
  assert.equal(text.includes(fixture.directory.replaceAll('\\', '\\\\')), false);
});
