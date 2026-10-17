import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { GithubSubjectError } from '../accounts/githubSubject.js';
import { CopilotApiError, type ModelsCatalog } from '../copilot/copilotClient.js';
import { ModelsAdminError, type ModelsAdminCredential } from '../copilot/modelsAdmin.js';
import { createModelsApiRouter, type ModelsApiDependencies } from './modelsApi.js';

const TOKEN = 'synthetic-admin-copilot-token';
const FETCHED_AT = Date.parse('2026-10-17T08:00:00.000Z');
const ADMIN: ModelsAdminCredential = { githubLogin: 'admin_synthetic', githubUserId: '101', accessToken: TOKEN };

function catalog(cacheStatus: ModelsCatalog['cacheStatus'] = 'fresh'): ModelsCatalog {
  return {
    fetchedAt: FETCHED_AT,
    cacheStatus,
    models: [
      { id: 'claude-sonnet-4.5', supported_endpoints: ['/v1/messages'], private_token: TOKEN,
        capabilities: { limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 } } },
      { id: 'synthetic-responses', supported_endpoints: ['/responses'] },
    ],
  };
}

interface Fixture {
  get(query?: string): Promise<{ status: number; body: any; text: string; headers: Headers }>;
  catalogCalls: Array<Parameters<ModelsApiDependencies['catalog']>>;
  adminCalls: () => number;
  verifyCalls: () => number;
}

async function fixture(t: TestContext, overrides: Partial<ModelsApiDependencies> = {}): Promise<Fixture> {
  let adminCalls = 0;
  let verifyCalls = 0;
  const catalogCalls: Fixture['catalogCalls'] = [];
  const deps: Partial<ModelsApiDependencies> = {
    admin: () => { adminCalls++; return (overrides.admin ?? (() => ADMIN))(); },
    verifySubject: async (...args) => {
      verifyCalls++;
      return (overrides.verifySubject ?? (async () => ({ login: 'Admin_Synthetic', id: '101' })))(...args);
    },
    catalog: async (...args) => {
      catalogCalls.push(args);
      return (overrides.catalog ?? (async () => catalog()))(...args);
    },
  };
  const app = express();
  app.use('/api', createModelsApiRouter(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async get(query = '') {
      const response = await fetch(`${origin}/api/models${query}`);
      const text = await response.text();
      assert.equal(text.includes(TOKEN), false, 'the admin token must never appear in a response');
      return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
    },
    catalogCalls,
    adminCalls: () => adminCalls,
    verifyCalls: () => verifyCalls,
  };
}

test('returns the admin catalog with a dedicated cache identity and allow-listed fields', async (t) => {
  const f = await fixture(t);
  const response = await f.get();
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.adminLogin, 'Admin_Synthetic');
  assert.equal(response.body.fetchedAt, '2026-10-17T08:00:00.000Z');
  assert.equal(response.body.cacheStatus, 'fresh');
  assert.deepEqual(response.body.models.map((model: { id: string }) => model.id), ['claude-sonnet-4-5', 'synthetic-responses']);
  assert.equal(response.text.includes('private_token'), false);

  const [auth, options] = f.catalogCalls[0]!;
  assert.equal(auth.identity, 'models-admin:101');
  assert.equal(auth.accessToken, TOKEN);
  assert.equal(options?.useCache, true);

  await f.get('?refresh=true');
  assert.equal(f.catalogCalls[1]![1]?.useCache, false);
});

test('only an optional true/false refresh flag is accepted, before any admin lookup', async (t) => {
  const f = await fixture(t);
  for (const query of ['?refresh=yes', '?refresh=true&refresh=false', '?identity=someone', '?refresh[x]=1']) {
    const response = await f.get(query);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.error.code, 'invalid_models_query');
  }
  assert.equal(f.adminCalls(), 0);
});

test('a token that belongs to someone else is rejected before the catalog is queried', async (t) => {
  for (const subject of [{ login: 'other_admin', id: '101' }, { login: 'admin_synthetic', id: '999' }]) {
    const f = await fixture(t, { verifySubject: async () => subject });
    const response = await f.get();
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'models_admin_identity_mismatch');
    assert.equal(f.catalogCalls.length, 0);
  }
  // Without a configured user ID, the login alone (case-insensitive) identifies the admin.
  const withoutId = await fixture(t, {
    admin: () => ({ githubLogin: 'admin_synthetic', accessToken: TOKEN }),
    verifySubject: async () => ({ login: 'ADMIN_SYNTHETIC', id: '555' }),
  });
  assert.equal((await withoutId.get()).status, 200);
});

test('admin configuration and GitHub verification failures map to fixed messages', async (t) => {
  const cases: Array<[ModelsAdminError['code'], number]> = [
    ['models_admin_not_configured', 409],
    ['models_admin_credential_missing', 409],
    ['models_admin_configuration_invalid', 503],
  ];
  for (const [code, status] of cases) {
    const f = await fixture(t, { admin: () => { throw new ModelsAdminError(code); } });
    const response = await f.get();
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
    assert.equal(f.verifyCalls(), 0);
  }
  const unverifiable = await fixture(t, { verifySubject: async () => { throw new GithubSubjectError('github_subject_unavailable'); } });
  const response = await unverifiable.get();
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'models_admin_verification_failed');
});

test('Copilot failures never forward upstream bodies and never fall back to another account', async (t) => {
  const cases: Array<[number, number, string]> = [
    [401, 502, 'models_upstream_authorization_rejected'],
    [403, 502, 'models_upstream_authorization_rejected'],
    [429, 429, 'models_upstream_rate_limited'],
    [500, 502, 'models_upstream_unavailable'],
  ];
  for (const [upstream, status, code] of cases) {
    const f = await fixture(t, { catalog: async () => { throw new CopilotApiError(`secret body ${TOKEN}`, upstream); } });
    const response = await f.get();
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
    assert.equal(f.catalogCalls.length, 1);
  }
  const colliding = await fixture(t, {
    catalog: async () => ({ ...catalog(), models: [{ id: 'claude-opus-4.6' }, { id: 'claude-opus-4-6' }] }),
  });
  assert.equal((await colliding.get()).body.error.code, 'models_catalog_invalid');
});

test('a catalog fetched for an admin that rotated meanwhile is not returned', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    admin: () => (++calls === 1 ? ADMIN : { ...ADMIN, accessToken: 'synthetic-rotated-token' }),
  });
  const response = await f.get();
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'models_admin_changed');
});

test('closing the request aborts the outstanding catalog lookup', async (t) => {
  let aborted!: () => void;
  const lookupAborted = new Promise<void>((resolve) => { aborted = resolve; });
  let entered!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { entered = resolve; });
  const app = express();
  app.use('/api', createModelsApiRouter({
    admin: () => ADMIN,
    verifySubject: async () => ({ login: 'admin_synthetic', id: '101' }),
    catalog: (_auth, options) => new Promise((_resolve, reject) => {
      entered();
      options?.signal?.addEventListener('abort', () => { aborted(); reject(options.signal!.reason); }, { once: true });
    }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/models`, { signal: controller.signal })
    .catch(() => undefined);
  await lookupStarted;
  controller.abort();
  await Promise.all([lookupAborted, request]);
});

test('the Models API is mounted behind the internal token', async (t) => {
  const savedEnv = { ...process.env };
  Object.assign(process.env, { DOTENV_CONFIG_PATH: '/dev/null', DB_PATH: ':memory:', INTERNAL_API_TOKEN: 'synthetic-internal' });
  t.after(() => { process.env = savedEnv; });
  const { config } = await import('../config.js');
  const savedToken = config.internalApiToken;
  config.internalApiToken = 'synthetic-internal';
  t.after(() => { config.internalApiToken = savedToken; });
  const { buildApp } = await import('../server.js');
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/models`);
  assert.equal(response.status, 401);
});
