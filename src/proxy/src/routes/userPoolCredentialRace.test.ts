import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPool, type Pool } from 'mysql2/promise';
import type { PoolStore } from '../userPool/storage.js';
import type { PrewarmWorker as Worker } from '../userPool/worker.js';

// Capture explicit opt-in before loading any production module or dotenv.
const mysqlTestUrl = process.env.MYSQL_TEST_URL;
const mysqlEnabled = process.env.MYSQL_POOL_TEST_DISPOSABLE === '1' && Boolean(mysqlTestUrl);
const modules = await (async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      DOTENV_CONFIG_PATH: join(tmpdir(), `credential-race-missing-${randomUUID()}`, '.env'),
      PORT: '3000', STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:',
      MYSQL_URL: '', MYSQL_CONNECTION_LIMIT: '4', MYSQL_SSL_MODE: 'disabled', MYSQL_SSL_CA_PATH: '',
      IDENTITY_INIT_LEASE_SECONDS: '900', API_KEY: 'synthetic-credential-race-key',
      IDENTITY_HEADER: 'X-User-Identity', IDENTITY_HEADER_REQUIRED: 'true', CLAUDE_CODE_OPTIMIZED: 'false',
      INTERNAL_API_TOKEN: 'synthetic-credential-race-internal',
      SSO_BASE_URL: 'https://credential-race-sso.invalid', LOGIN_BASE_URL: 'https://credential-race-login.invalid',
      ENTERPRISE_SHORTCODE: 'synthetic', REQUEST_STATS_PER_ACCOUNT_LIMIT: '100',
      PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', PROXY_ERROR_DIAGNOSTICS_DIR: tmpdir(),
      PROXY_ERROR_DIAGNOSTICS_REDACT: 'true', PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB: '1',
      PROXY_ERROR_DIAGNOSTICS_MAX_FILES: '1', PROXY_ERROR_DIAGNOSTICS_SHARED: 'false', PROXY_INSTANCE_ID: 'credential-race',
      COPILOT_API_BASE_URL: 'https://credential-race.invalid', OPENCODE_USER_AGENT: 'synthetic-test',
      GITHUB_API_VERSION: '2026-06-01', ACCOUNT_ROUTING_MODE: 'direct',
    });
    return await Promise.all([
      import('../config.js'), import('../copilot/copilotClient.js'), import('../db/accountsRepo.js'),
      import('../db/connection.js'), import('../server.js'), import('../userPool/config.js'),
      import('../userPool/provisioner.js'), import('../userPool/runtime.js'), import('../userPool/worker.js'),
    ]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
})();
const [{ config }, { clearModelsCache }, { getAccount, importCopilotOauthToken }, { closeStorage },
  { buildApp }, { readPoolConfig }, { realProvisioner }, { getUserPool, stopUserPool }, { PrewarmWorker }] = modules;

// Run via node/tsx --test (the normal per-file child-process isolation). These
// sequential cases intentionally own config, runtime singleton and fetch together.
// Two real Express listeners share that runtime/store, not independent OS replicas.
const nativeFetch = globalThis.fetch;
const caller = `sha256:${'c'.repeat(64)}`;
const tokenA = 'synthetic-credential-race-a';
const tokenB = 'synthetic-credential-race-b';
const model = 'gpt-credential-race';
const deadlineMs = 8000;
type Order = 'success-first' | 'unauthorized-first';
type Scenario = { order: Order; aba: boolean };

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Credential race timed out: ${label}`)), deadlineMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const until = performance.now() + deadlineMs;
  while (!await check()) {
    assert.ok(performance.now() < until, `Credential race timed out: ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function success(): Response {
  return json({ id: 'synthetic-race-result', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'OK' }] });
}

// An explicit destructive-test opt-in is not enough: the URL must be a local root
// fixture. Never migrate/drop the supplied database; allocate a random sibling.
function mysqlFixtureUrl(raw: string): URL {
  const url = new URL(raw);
  assert.equal(url.protocol, 'mysql:');
  assert.equal(url.username, 'root');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'MySQL fixture must be loopback');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search + url.hash, '');
  return url;
}

async function race(engine: 'sqlite' | 'mysql', scenario: Scenario): Promise<void> {
  const savedConfig = { ...config };
  const env = {
    ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: engine,
    POOL_ACCOUNT_EMAIL_DOMAIN: 'credential-race.test', POOL_WARMUP_MODEL: model,
    READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '1', POOL_REQUEST_TIMEOUT_SECONDS: '30',
    PROVISIONAL_LEASE_TTL_SECONDS: '300', CALLER_LEASE_TTL_SECONDS: '600',
    PREWARM_POLL_SECONDS: '60', PREWARM_CONCURRENCY: '1', POOL_LOGIN_MAX_PENDING: '1',
    POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '1',
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const servers: Server[] = [];
  const controllers: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
  const responses = { success: gate<Response>(), unauthorized: gate<Response>(), warmup: gate<Response>() };
  const started = { success: gate<void>(), unauthorized: gate<void>(), warmup: gate<void>() };
  let directory: string | undefined;
  let admin: Pool | undefined;
  let database: string | undefined;
  let worker: Worker | undefined;
  let store: PoolStore | undefined;
  let identity: string | undefined;
  let holdWarmup = false;
  const calls: Array<{ kind: string; token: string }> = [];
  const createdAt = '2026-01-01T00:00:00.000Z';
  try {
    await stopUserPool();
    await closeStorage();
    Object.assign(process.env, env);
    Object.assign(config, {
      storageDriver: engine, apiKey: 'synthetic-credential-race-key',
      internalApiToken: 'synthetic-credential-race-internal',
      identityHeader: 'X-User-Identity', identityHeaderRequired: true,
      claudeCodeOptimized: false, errorDiagnosticsEnabled: false,
      requestStatsPerAccountLimit: 100, mysqlSslMode: 'disabled', mysqlConnectionLimit: 4,
      copilotApiBaseUrl: 'https://credential-race.invalid',
      ssoBaseUrl: 'https://credential-race-sso.invalid', loginBaseUrl: 'https://credential-race-login.invalid',
    });
    if (engine === 'mysql') {
      const url = mysqlFixtureUrl(mysqlTestUrl!);
      url.pathname = '/';
      admin = createPool({ uri: url.toString(), connectionLimit: 1, connectTimeout: 5000 });
      const name = `ghcp_pool_test_credential_race_${randomUUID().replaceAll('-', '')}`;
      await bounded(admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`), 'create sibling database');
      database = name;
      url.pathname = `/${name}`;
      config.mysqlUrl = url.toString();
    } else {
      directory = await mkdtemp(join(tmpdir(), 'user-pool-credential-race-'));
      config.dbPath = join(directory, 'pool.sqlite');
    }
    store = await getUserPool();
    assert.ok(store);
    identity = (await store.reserve())!.identity;
    const memberIdentity = identity;
    await importCopilotOauthToken({ identity, ssoUser: identity, ghLogin: 'synthetic-gh-race', copilotOauthToken: tokenA });
    assert.equal(await store.update(identity, { state: 'provisioning', stage: 'warmup', sso_created_at: createdAt }), true);

    // This is the existing client-boundary fetch pattern, not storage/runtime mocks.
    // Unexpected traffic (including Login or any real provider) fails closed.
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === config.ssoBaseUrl && url.pathname === `/api/users/${memberIdentity}`) {
        assert.equal(init?.method, 'GET');
        return json({ ssoUser: memberIdentity, email: `${memberIdentity}@credential-race.test`, role: 'user',
          createdAt, emuStatus: 'active', ghLogin: 'synthetic-gh-race', ghScimId: 'synthetic-scim', copilotSeatStatus: 'assigned' });
      }
      assert.equal(url.origin, config.copilotApiBaseUrl, 'No real services may be called');
      const token = new Headers(init?.headers).get('authorization') ?? '';
      if (url.pathname === '/models') {
        calls.push({ kind: 'catalog', token });
        return json({ data: [{ id: model, capabilities: { endpoints: ['/v1/messages'] } }] });
      }
      assert.equal(url.pathname, '/v1/messages');
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const content = body.messages[0].content;
      const kind = content === 'Reply OK' ? 'warmup' : content;
      calls.push({ kind, token });
      if (kind === 'old-success') {
        started.success.resolve();
        return responses.success.promise;
      }
      if (kind === 'old-unauthorized') {
        started.unauthorized.resolve();
        return responses.unauthorized.promise;
      }
      if (kind === 'warmup' && holdWarmup) {
        started.warmup.resolve();
        return responses.warmup.promise;
      }
      assert.ok(['warmup', 'replacement', 'must-not-admit'].includes(kind));
      return success();
    };
    const options = readPoolConfig(process.env);
    worker = new PrewarmWorker(store, realProvisioner(store, options), 60000, 1, undefined, { multiReplica: engine === 'mysql' });
    await bounded(worker.tick(), 'initial production warmup');
    assert.equal((await store.inventory(identity))?.state, 'ready');
    assert.notEqual((await store.inventory(identity))?.verified_at, null);
    assert.equal(calls.filter(call => call.kind === 'warmup').length, 1);

    const urls: string[] = [];
    for (let i = 0; i < 2; i++) {
      const server = buildApp().listen(0, '127.0.0.1');
      servers.push(server);
      await bounded(once(server, 'listening'), 'listen');
      urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
    assert.notEqual(urls[0], urls[1]);
    const request = (replica: number, content: string) => {
      const controller = new AbortController();
      controllers.push(controller);
      const promise = nativeFetch(`${urls[replica]}/v1/messages`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': caller, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content }] }),
      }).then(async response => ({ status: response.status, body: await response.json() as Record<string, unknown> }));
      // Observe rejection immediately so failed assertions cannot leave an unhandled fetch.
      void promise.catch(() => {});
      pending.push(promise);
      return promise;
    };
    const oldSuccess = request(0, 'old-success');
    await bounded(started.success.promise, 'first request upstream');
    const oldUnauthorized = request(1, 'old-unauthorized');
    await bounded(started.unauthorized.promise, 'second request upstream');
    const [oldLease] = await store.leases();
    assert.equal((await store.leases()).length, 1);
    assert.equal(oldLease.member_identity, identity);
    assert.equal(oldLease.caller_id, caller);
    assert.equal(oldLease.active_requests, 2);
    assert.equal(oldLease.phase, 'provisional');
    assert.equal(oldLease.last_success_at, null);
    const originalGeneration = (await store.inventory(identity))!.generation;
    const reauthEvents = async () => (await store!.events() as Array<{ action: string }>).filter(event => event.action === 'oauth_reauth_scheduled').length;
    const leaseRenewals = async () => (await store!.events() as Array<{ action: string; lease_id: string }>).filter(event => event.action === 'lease_renewed' && event.lease_id === oldLease.lease_id).length;
    const releaseUnauthorized = async () => {
      responses.unauthorized.resolve(json({ error: { message: 'synthetic unauthorized' } }, 401));
      assert.equal((await bounded(oldUnauthorized, 'old 401 response')).status, 401);
    };
    const releaseSuccess = async () => {
      responses.success.resolve(success());
      assert.equal((await bounded(oldSuccess, 'old 200 response')).status, 200);
    };
    const importToken = async (token: string) => importCopilotOauthToken({ identity: memberIdentity, ssoUser: memberIdentity, ghLogin: 'synthetic-gh-race', copilotOauthToken: token });
    const beforeRotation = (await store.inventory(identity))!.generation;
    await importToken(tokenB);
    const intermediate = (await store.inventory(identity))!;
    assert.equal(intermediate.generation, beforeRotation + 1, 'Production credential-write trigger increments generation');
    assert.equal(intermediate.verified_at, null, 'Rotation clears verification');
    if (scenario.aba) {
      await importToken(tokenA);
      assert.equal((await store.inventory(identity))!.generation, intermediate.generation + 1, 'A -> B -> A is a new credential generation');
    }
    const replacementToken = scenario.aba ? tokenA : tokenB;
    const rotationGeneration = (await store.inventory(identity))!.generation;
    assert.ok(rotationGeneration > originalGeneration);
    const expectedReauth = 0;
    const assertReplacement = async () => {
      const account = await getAccount(memberIdentity);
      assert.equal(account?.copilotOauthToken, replacementToken);
      assert.equal(account?.copilotOauthStatus, 'valid');
      assert.equal((await store!.inventory(memberIdentity))?.reauth_count, expectedReauth);
      assert.equal(await reauthEvents(), expectedReauth, 'A stale 401 must not schedule another authorization');
    };
    await assertReplacement();
    // Do not run admission/reclaim before the first completion: failed-state
    // fencing would mask a broken credential-generation (especially ABA) fence.
    const leaseBeforeCompletion = (await store.leases())[0];
    assert.equal(leaseBeforeCompletion.lease_id, oldLease.lease_id);
    assert.equal(leaseBeforeCompletion.phase, 'provisional');
    const assertOldNotRenewed = async () => {
      assert.equal(await leaseRenewals(), 0, 'Old 200 cannot promote or renew its prior-generation lease');
      const remaining = (await store!.leases()).find(lease => lease.lease_id === oldLease.lease_id);
      if (remaining) {
        assert.equal(remaining.phase, 'provisional');
        assert.equal(remaining.last_success_at, null);
        assert.ok(remaining.expires_at <= leaseBeforeCompletion.expires_at);
      }
    };
    const first = scenario.order === 'success-first' ? releaseSuccess : releaseUnauthorized;
    const second = scenario.order === 'success-first' ? releaseUnauthorized : releaseSuccess;
    await first();
    await waitFor(async () => (await store!.leases())[0]?.active_requests === 1, 'first race hold drains');
    await assertReplacement();
    await assertOldNotRenewed();
    assert.equal((await bounded(request(0, 'must-not-admit'), 'unverified admission')).status, 503);
    assert.equal(calls.filter(call => call.kind === 'must-not-admit').length, 0);
    await bounded(worker.tick(), 'worker skips live holds');
    assert.equal(calls.filter(call => call.kind === 'warmup').length, 1, 'New credentials cannot warm up while old holds exist');
    await second();
    await waitFor(async () => !await store!.hasHolds(memberIdentity), 'all old holds drain');
    await assertReplacement();
    await assertOldNotRenewed();
    assert.equal(calls.filter(call => call.kind === 'old-success').length, 1);
    assert.equal(calls.filter(call => call.kind === 'old-unauthorized').length, 1, 'Failed inference is never replayed');
    assert.ok(calls.filter(call => call.kind.startsWith('old-')).every(call => call.token === `Bearer ${tokenA}`));

    // Use the actual production worker/provisioner and its credential-generation pin.
    // No direct verified_at write is used, for either initial or replacement readiness.
    holdWarmup = true;
    const verification = worker.tick();
    pending.push(verification);
    await bounded(started.warmup.promise, 'replacement warmup starts');
    assert.equal((await store.inventory(identity))?.verified_at, null);
    const verifyingGeneration = (await store.inventory(identity))!.generation;
    assert.ok(verifyingGeneration >= rotationGeneration);
    const beforeVerify = await bounded(request(1, 'must-not-admit'), 'admission during warmup');
    assert.ok([429, 503].includes(beforeVerify.status));
    assert.equal(calls.filter(call => call.kind === 'must-not-admit').length, 0);
    assert.equal(await store.hasHolds(identity), false);
    responses.warmup.resolve(success());
    await bounded(verification, 'replacement verification completes');
    const verified = (await store.inventory(identity))!;
    assert.equal(verified.state, 'ready');
    assert.equal(verified.stage, 'ready');
    assert.notEqual(verified.verified_at, null);
    assert.equal(verified.generation, verifyingGeneration, 'Warmup commits its pinned credential generation');
    await assertReplacement();
    const replacement = await bounded(request(1, 'replacement'), 'verified replacement admission');
    assert.equal(replacement.status, 200);
    await waitFor(async () => !await store!.hasHolds(memberIdentity), 'replacement hold drains');
    const [newLease] = await store.leases();
    assert.equal((await store.leases()).length, 1);
    assert.notEqual(newLease.lease_id, oldLease.lease_id, 'Expired lease epoch is not resurrected');
    assert.equal(newLease.member_identity, memberIdentity);
    assert.equal(newLease.caller_id, caller);
    assert.equal(newLease.phase, 'active');
    assert.notEqual(newLease.last_success_at, null);
    assert.equal(newLease.active_requests, 0);
    assert.equal(calls.filter(call => call.kind === 'replacement').length, 1);
    assert.equal(calls.find(call => call.kind === 'replacement')?.token, `Bearer ${replacementToken}`);
    assert.equal(calls.filter(call => call.kind === 'warmup').at(-1)?.token, `Bearer ${replacementToken}`);
    assert.equal((await store.inventory(identity))?.generation, verified.generation);
    await assertReplacement();
    await assertOldNotRenewed();
  } finally {
    // All gates settle even if an assertion fails; abort clients before closing DBs.
    responses.success.resolve(success());
    responses.unauthorized.resolve(json({ error: 'synthetic cleanup' }, 401));
    responses.warmup.resolve(success());
    for (const controller of controllers) controller.abort();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await bounded(Promise.allSettled(pending), 'pending cleanup').catch(() => {});
    try { await worker?.stop(); }
    finally {
      if (identity) clearModelsCache(identity);
      await stopUserPool();
      await closeStorage();
      globalThis.fetch = nativeFetch;
      Object.assign(config, savedConfig);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      try {
        if (database) await bounded(admin!.query(`DROP DATABASE \`${database}\``), 'drop sibling database');
      } finally {
        await admin?.end();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

for (const engine of ['sqlite', 'mysql'] as const) {
  const skip = engine === 'mysql' && !mysqlEnabled
    ? 'Requires MYSQL_POOL_TEST_DISPOSABLE=1 and a loopback root MYSQL_TEST_URL /ghcp_pool_test_*; no MySQL was exercised' : false;
  test(`${engine}: two HTTP route instances fence credential replacement races`, { skip, timeout: 120000, concurrency: false }, async t => {
    for (const aba of [false, true]) {
      for (const order of ['success-first', 'unauthorized-first'] as const) {
        await t.test(`${aba ? 'A -> B -> A' : 'A -> B'}: ${order}`, { timeout: 20000 }, () => race(engine, { order, aba }));
      }
    }
  });
}
