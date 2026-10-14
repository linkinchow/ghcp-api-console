import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (!/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMDRIVE|NODE_TEST_CONTEXT)$/i.test(key)) delete process.env[key];
}
const root = mkdtempSync(join(tmpdir(), 'multi-enterprise-messages-'));
const dbPath = join(root, 'proxy.sqlite');
const registryPath = join(root, 'registry.json');
const beta = 'mid-conversation-output-config-2026-07-01';
const betaValue = `${beta},future-compatible-beta-2026-10-01`;
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
Object.assign(process.env, {
  NODE_ENV: 'test', DOTENV_CONFIG_PATH: join(root, 'missing.env'), STORAGE_DRIVER: 'sqlite', DB_PATH: dbPath,
  ENTERPRISE_REGISTRY_FILE: registryPath, ACCOUNT_ROUTING_MODE: 'caller-lease', API_KEY: 'synthetic-pool-protocol-client',
  INTERNAL_API_TOKEN: 'synthetic-pool-protocol-internal', COPILOT_API_BASE_URL: 'https://pool-messages.example.test',
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', POOL_ACCOUNT_EMAIL_DOMAIN: 'alpha.accounts.test',
  POOL_WARMUP_MODEL: 'claude-opus-5.5', POOL_MAX_ACCOUNTS: '10', READY_IDLE_TARGET: '0',
  CALLER_LEASE_TTL_SECONDS: '600', REQUEST_STATS_PER_ACCOUNT_LIMIT: '100',
});
const [{ default: Database }, { fixtureProfile, fixtureRegistry, fixtureReadinessEvidence }, { initEnterpriseSqliteV4 },
  { readPoolConfig }, { UserPoolStore }, { accountName }] = await Promise.all([
  import('better-sqlite3'), import('../test/enterpriseFixtures.js'), import('@ghcp/shared/enterpriseStorageV4'),
  import('../userPool/config.js'), import('../userPool/store.js'), import('../userPool/names.js'),
]);
const options = readPoolConfig(process.env);
const alpha = { ...fixtureProfile(options), maxAccounts: 9 };
const betaId = '22222222-2222-4222-8222-222222222222';
const publicRoot = 'http://sso-beta.synthetic.invalid';
const bravo = { ...fixtureProfile(options), id: betaId, slug: 'synthetic-beta', shortcode: 'beta', revision: 2,
  accountDomain: 'beta.accounts.test', maxAccounts: 1,
  routes: { ...alpha.routes, ssoInternalUrl: publicRoot, loginInternalUrl: 'http://login-beta.synthetic.invalid', ssoPublicUrl: publicRoot },
  sso: { ...alpha.sso, entityId: 'urn:synthetic:beta', ssoUrl: `${publicRoot}/profiles/${betaId}/sso`,
    loginUrl: `${publicRoot}/profiles/${betaId}/login`, logoutUrl: `${publicRoot}/profiles/${betaId}/logout`, emailDomain: 'beta.users.test' },
  login: { provider: 'custom' as const, allowedLoginUrls: [`${publicRoot}/profiles/${betaId}/login`], selectors: {} },
};
const registry = fixtureRegistry(options, [bravo, alpha]); // legacy scope is explicit, never registry-array order.
writeFileSync(registryPath, JSON.stringify(registry));
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
initEnterpriseSqliteV4(db, 'proxy', registry, { layout: 'pool', pool: { settings: {
  version: 1, idle_target: 0, lease_seconds: options.leaseSeconds, paused: 1, next_ordinal: 0,
  account_domain: alpha.accountDomain, owner: null, owner_until: 0,
} } });
const seed = new UserPoolStore(db, options, registry);
const owners = [alpha, bravo].map((profile, index) => ({ profile, identity: accountName(index),
  callerId: caller(index + 1), token: `synthetic-pool-oauth-${index}` }));
for (const owner of owners) {
  const now = seed.now();
  const stamp = new Date(now).toISOString();
  let policy = seed.enterprisePolicy(owner.profile.id)!;
  const evidence = { ...fixtureReadinessEvidence(registry, owner.profile.id), checkedAt: now };
  policy = seed.updateEnterprisePolicy(owner.profile.id, policy.policyVersion, { type: 'validate', evidence });
  seed.updateEnterprisePolicy(owner.profile.id, policy.policyVersion, { type: 'activate', evidence });
  // Ready inventory and OAuth are synthetic fixtures. No SSO, seat, login or model provisioning is performed.
  db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,gh_login,copilot_oauth_status,copilot_oauth_token,created_at,updated_at)
    VALUES(?,?,?,?,?,'valid',?,?,?)`).run(owner.profile.id, randomUUID(), owner.identity, owner.identity,
    `${owner.identity}_${owner.profile.shortcode}`, owner.token, stamp, stamp);
  db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,updated_at,verified_at)
    VALUES(?,?,'ready','ready',?,?,?)`).run(owner.identity, owners.indexOf(owner), randomUUID(), now, now);
}
db.prepare('UPDATE user_pool_settings SET next_ordinal=2,paused=0 WHERE id=1').run();
const [{ buildApp }, { config }, { getStorage, closeStorage }, { getUserPool, stopUserPool }] = await Promise.all([
  import('../server.js'), import('../config.js'), import('../db/connection.js'), import('../userPool/runtime.js'),
]);
const nativeFetch = globalThis.fetch;
let origin = '';
let server: ReturnType<ReturnType<typeof buildApp>['listen']>;
const forwarded: Array<{ owner: typeof owners[number]; headers: Headers; body: Record<string, unknown> }> = [];
const forbiddenRequests: string[] = [];

before(async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== config.copilotApiBaseUrl) {
      forbiddenRequests.push(url.origin);
      assert.fail('all outbound requests except the synthetic Copilot transport are forbidden');
    }
    const headers = new Headers(init?.headers);
    const owner = owners.find(item => headers.get('authorization') === `Bearer ${item.token}`);
    assert.ok(owner, 'server-selected enterprise/member OAuth replaces client credentials');
    if (url.pathname === '/models') return Response.json({ data: [{ id: 'claude-opus-5.5', supported_endpoints: ['/v1/messages'] }] });
    assert.equal(url.pathname, '/v1/messages');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const metadata = body.metadata as { user_id: string };
    assert.equal(metadata.user_id, owner.callerId, 'caller cannot borrow the other enterprise credential');
    const held = db.prepare(`SELECT a.enterprise_id, e.revision, l.member_identity, h.request_id FROM user_pool_leases l
      JOIN proxy_accounts a ON a.identity=l.member_identity JOIN enterprise_profiles e ON e.id=a.enterprise_id
      JOIN user_pool_holds h ON h.lease_id=l.lease_id WHERE l.caller_id=?`).get(owner.callerId) as {
        enterprise_id: string; revision: number; member_identity: string; request_id: string;
      };
    assert.equal(held.enterprise_id, owner.profile.id);
    assert.equal(held.revision, owner.profile.revision);
    assert.equal(held.member_identity, owner.identity);
    assert.ok(held.request_id, 'real caller admission holds the matching lease while forwarding');
    forwarded.push({ owner, headers, body });
    if (!headers.get('anthropic-beta')?.split(',').map(value => value.trim()).includes(beta)) {
      return Response.json({ type: 'error', error: { type: 'invalid_request_error',
        message: 'messages.1.output_config: Extra inputs are not permitted' } }, { status: 400 });
    }
    if (body.stream === true) {
      return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_pool_synthetic","model":"claude-opus-5.5","usage":{"input_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return Response.json({ id: 'msg_pool_synthetic', type: 'message', role: 'assistant', model: 'claude-opus-5.5',
      content: [{ type: 'text', text: 'Synthetic OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const pool = await getUserPool();
  assert.ok(pool instanceof UserPoolStore);
  for (const [index, owner] of owners.entries()) {
    assert.equal(await getStorage().getAccount(owners[1 - index].identity, owner.profile.id), undefined);
  }
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = nativeFetch;
  if (server) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  await stopUserPool();
  await closeStorage();
  db.close();
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function payload(owner: typeof owners[number], stream: boolean): Record<string, unknown> {
  return {
    model: 'claude-opus-5-5', max_tokens: 4096, stream, metadata: { user_id: owner.callerId },
    output_config: { effort: 'xhigh' }, thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: "# currentDate\nToday's date is 2026-10-14.\n", cache_control: { type: 'ephemeral', scope: 'global' } }],
    tools: [{ name: 'mcp__ide__executeCode', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'Synthetic question' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Synthetic prior thinking', signature: 'opaque-synthetic-signature' },
        { type: 'tool_use', id: 'toolu_pool', name: 'synthetic_tool', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pool', content: 'Synthetic result' }] },
      { role: 'system', content: [], output_config: { effort: 'high' } },
    ],
  };
}

async function request(owner: typeof owners[number], body: Record<string, unknown>, optimized: boolean, includeBeta = true) {
  return nativeFetch(`${origin}/v1/messages`, { method: 'POST', headers: {
    Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': owner.callerId, 'Content-Type': 'application/json',
    'X-Claude-Code-Optimized': String(optimized), 'anthropic-version': '2023-06-01',
    ...(includeBeta ? { 'anthropic-beta': betaValue } : {}),
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
}

for (const optimized of [false, true]) {
  for (const stream of [false, true]) {
    for (const owner of owners) {
      test(`caller-lease ${owner.profile.slug} ${optimized ? 'optimized' : 'plain'} ${stream ? 'SSE' : 'JSON'} preserves effort, lease scope and agent continuation`, async () => {
        const body = payload(owner, stream);
        const expected = structuredClone(body);
        const response = await request(owner, body, optimized);
        assert.equal(response.status, 200);
        if (stream) {
          assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
          const text = await response.text();
          assert.match(text, /message_stop/);
          assert.match(text, /claude-opus-5-5/);
        } else {
          assert.equal((await response.json() as { model: string }).model, 'claude-opus-5-5');
        }
        const captured = forwarded.at(-1)!;
        assert.equal(captured.owner.profile.id, owner.profile.id);
        assert.equal(captured.headers.get('authorization'), `Bearer ${owner.token}`);
        assert.notEqual(captured.headers.get('authorization'), `Bearer ${config.apiKey}`);
        assert.equal(captured.headers.get('anthropic-beta'), betaValue);
        assert.equal(captured.headers.get('anthropic-version'), '2023-06-01');
        assert.equal(captured.headers.get('x-initiator'), 'agent');
        assert.deepEqual(captured.body, { ...expected, model: 'claude-opus-5.5' });
        assert.deepEqual(body, expected);
        const pool = (await getUserPool()) as InstanceType<typeof UserPoolStore>;
        const lease = pool.leases(owner.profile.id).find(item => item.caller_id === owner.callerId)!;
        assert.equal(lease.member_identity, owner.identity);
        assert.equal(pool.leases(owners.find(item => item !== owner)!.profile.id).some(item => item.caller_id === owner.callerId), false);
        const stats = await getStorage().listRequestStats(undefined, 100, owner.profile.id);
        assert.ok(stats.length > 0);
        assert.ok(stats.every(stat => stat.enterpriseId === owner.profile.id && stat.identity === owner.identity));
        assert.deepEqual(forbiddenRequests, []);
      });
    }
  }
  for (const owner of owners) {
    test(`caller-lease ${owner.profile.slug} ${optimized ? 'optimized' : 'plain'} missing beta stays provider 400 without cross-enterprise fallback`, async () => {
      const body = payload(owner, false);
      const response = await request(owner, body, optimized, false);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { message: string } }).error.message,
        'messages.1.output_config: Extra inputs are not permitted');
      const captured = forwarded.at(-1)!;
      assert.equal(captured.owner, owner);
      assert.equal(captured.headers.get('anthropic-beta'), null);
      assert.deepEqual(captured.body, { ...body, model: 'claude-opus-5.5' });
      const pool = (await getUserPool()) as InstanceType<typeof UserPoolStore>;
      assert.equal(pool.inventory(owner.identity)?.state, 'ready');
      assert.equal(pool.leases(owner.profile.id).find(item => item.caller_id === owner.callerId)?.member_identity, owner.identity);
      assert.deepEqual(forbiddenRequests, []);
    });
  }
}
