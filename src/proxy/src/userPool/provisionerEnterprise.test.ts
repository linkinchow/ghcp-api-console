import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GITHUB_BASE_URL, parseRegistry, type LoginTaskDto } from '@ghcp/shared';
import { findProxyEnterprise, setProxyEnterprisesForTesting } from '../enterprises.js';
import type { PoolConfig } from './config.js';
import { ProvisionFailure, realProvisioner, type ProvisionContext, type ProvisionInventory } from './provisioner.js';

// A pool member is provisioned through its own enterprise's SSO and Login APIs with its account domain.
const options: PoolConfig = {
  enabled: true, accountDomain: 'pool.default.test', idleTarget: 2, maxAccounts: 10,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 10000, retryAfterSeconds: 30,
  warmupModel: 'test-warmup-model', requestTimeoutMs: 1000,
};

setProxyEnterprisesForTesting(parseRegistry({
  version: 1,
  enterprises: [
    { id: 'default', github: { baseUrl: DEFAULT_GITHUB_BASE_URL, shortcode: 'octo' } },
    {
      id: 'contoso-eu',
      github: { baseUrl: 'https://contoso.ghe.com', slug: 'contoso' },
      login: { ssoProvider: 'azure' },
      pool: { accountDomain: 'pool.contoso.test' },
    },
  ],
}, { service: 'proxy', poolMode: true }));
test.after(() => setProxyEnterprisesForTesting(undefined));

function row(patch: Partial<ProvisionInventory> = {}): ProvisionInventory {
  return {
    identity: 'alex001', enterprise_id: 'contoso-eu', ordinal: 0, state: 'provisioning', stage: 'new',
    attempt_id: 'worker-attempt', task_id: null, attempts: 0, retry_at: 0, last_error: null, updated_at: 0,
    cooldown_until: 0, verified_at: null, generation: 0, sso_created_at: null, oauth_attempt_id: null, ...patch,
  };
}

function context(current: ProvisionInventory): ProvisionContext {
  let saved = current;
  return {
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    pinCredentials: () => undefined,
    checkpoint: (patch) => {
      saved = { ...saved, ...patch };
      return saved;
    },
  };
}

function adapter(fetch: typeof globalThis.fetch) {
  return realProvisioner({ now: () => Date.now() }, options, {
    fetch,
    enterprise: findProxyEnterprise,
    getAccount: async () => undefined,
  });
}

test('SSO creation uses the member enterprise path and account domain', async () => {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const provision = adapter(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ path: url.pathname, body });
    if (init?.method !== 'POST') return Response.json({}, { status: 404 });
    const at = new Date().toISOString();
    return Response.json({ ssoUser: 'alex001', email: body?.email, role: 'user', emuStatus: 'not_synced',
      copilotSeatStatus: 'unassigned', createdAt: at, updatedAt: at });
  });
  const patch = await provision.step(row(), context(row()));
  assert.equal(patch.stage, 'sso-created');
  assert.deepEqual(requests.map(({ path }) => path), [
    '/api/enterprises/contoso-eu/users/alex001',
    '/api/enterprises/contoso-eu/users',
  ]);
  assert.equal(requests[1]!.body?.email, 'alex001@pool.contoso.test');
});

test('Login tasks are read through the member enterprise and must use its SSO provider', async () => {
  const at = new Date().toISOString();
  const user = { ssoUser: 'alex001', email: 'alex001@pool.contoso.test', role: 'user', emuStatus: 'active',
    copilotSeatStatus: 'assigned', ghLogin: 'alex001', ghScimId: 'scim', createdAt: at, updatedAt: at };
  const task = (ssoType: string): LoginTaskDto => ({ id: 'task-1', identity: 'alex001', ssoUser: 'alex001',
    ghLogin: 'alex001', oauthAttemptId: 'nonce', ssoType: ssoType as LoginTaskDto['ssoType'], status: 'running',
    attempts: 1, createdAt: at });
  const paths: string[] = [];
  let ssoType = 'azure';
  const provision = adapter(async (input) => {
    const { pathname } = new URL(String(input));
    paths.push(pathname);
    return Response.json(pathname.includes('/tasks/') ? task(ssoType) : user);
  });
  const waiting = row({ stage: 'oauth-wait', task_id: 'task-1', oauth_attempt_id: 'nonce', sso_created_at: at });
  assert.deepEqual(await provision.step(waiting, context(waiting)), {});
  assert.ok(paths.includes('/api/enterprises/contoso-eu/tasks/task-1'));
  ssoType = 'custom';
  await assert.rejects(provision.step(waiting, context(waiting)), (error: unknown) => {
    return error instanceof ProvisionFailure && error.code === 'oauth_task_mismatch';
  });
});

test('a member whose enterprise left the registry stops terminally', async () => {
  const provision = adapter(async () => assert.fail('no service may be called'));
  const orphan = row({ enterprise_id: 'removed-co' });
  await assert.rejects(provision.step(orphan, context(orphan)), (error: unknown) => {
    return error instanceof ProvisionFailure && error.code === 'enterprise_not_found' && error.terminal;
  });
});
