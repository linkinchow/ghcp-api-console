import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GITHUB_BASE_URL,
  parseRegistry,
  type EnterpriseServiceReadinessDto,
} from '@ghcp/shared';
import { setProxyEnterprisesForTesting, proxyEnterprises } from '../enterprises.js';
import {
  EnterpriseReadinessClient,
  fetchPeerListing,
  READINESS_MAX_BYTES,
  ReadinessFetchError,
  type ReadinessPeer,
} from './enterpriseReadiness.js';

const GHE_BASE_URL = 'https://contoso.ghe.com';

setProxyEnterprisesForTesting(parseRegistry({
  version: 1,
  enterprises: [
    { id: 'default', github: { baseUrl: DEFAULT_GITHUB_BASE_URL, shortcode: 'octo' } },
    { id: 'contoso-eu', github: { baseUrl: GHE_BASE_URL, slug: 'contoso' } },
  ],
}, { service: 'proxy' }));
test.after(() => setProxyEnterprisesForTesting(undefined));

function row(id: string, patch: Partial<EnterpriseServiceReadinessDto> = {}): EnterpriseServiceReadinessDto {
  const ghe = id === 'contoso-eu';
  return {
    id,
    githubBaseUrl: ghe ? GHE_BASE_URL : DEFAULT_GITHUB_BASE_URL,
    slug: ghe ? 'contoso' : 'acme',
    shortcode: ghe ? '' : 'octo',
    configured: true,
    blockers: [],
    ...patch,
  };
}

interface Listings {
  sso: () => unknown;
  login: () => unknown;
}

function client(listings: Partial<Listings>, options: { now?: () => number; timeoutMs?: number } = {}) {
  const calls: ReadinessPeer[] = [];
  const healthy: Listings = {
    sso: () => [row('default'), row('contoso-eu')],
    login: () => [row('default', { shortcode: null }), row('contoso-eu', { shortcode: null })],
  };
  const sources = { ...healthy, ...listings };
  const readiness = new EnterpriseReadinessClient({
    enterprises: proxyEnterprises,
    fetchListing: async (peer) => {
      calls.push(peer);
      return sources[peer]();
    },
    ...options,
  });
  return { readiness, calls };
}

test('an enterprise is ready only when Proxy, SSO and Login agree and report no blockers', async () => {
  const { readiness } = client({});
  for (const id of ['default', 'contoso-eu']) {
    const result = await readiness.readiness(id);
    assert.equal(result.ready, true, JSON.stringify(result.blockers));
    assert.deepEqual(result.blockers, []);
    assert.equal(result.services.login?.shortcode, null, 'Login does not know the shortcode');
  }
  const unknown = await readiness.readiness('fabrikam');
  assert.equal(unknown.ready, false);
});

test('in caller-lease mode an enterprise without an account domain is not ready, so it gets no members', async (t) => {
  const registry = parseRegistry({
    version: 1,
    enterprises: [
      { id: 'default', github: { baseUrl: DEFAULT_GITHUB_BASE_URL, shortcode: 'octo' } },
      {
        id: 'contoso-eu',
        github: { baseUrl: GHE_BASE_URL, slug: 'contoso' },
        pool: { accountDomain: 'pool.contoso.example.test' },
      },
    ],
  }, { service: 'proxy', poolMode: true });
  setProxyEnterprisesForTesting(registry);
  t.after(() => setProxyEnterprisesForTesting(parseRegistry({
    version: 1,
    enterprises: [
      { id: 'default', github: { baseUrl: DEFAULT_GITHUB_BASE_URL, shortcode: 'octo' } },
      { id: 'contoso-eu', github: { baseUrl: GHE_BASE_URL, slug: 'contoso' } },
    ],
  }, { service: 'proxy' })));
  const { readiness } = client({});
  const missing = await readiness.readiness('default');
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.blockers, ['proxy:enterprise_field_missing:pool.accountDomain']);
  assert.equal((await readiness.readiness('contoso-eu')).ready, true);
});

test('field mismatches and peer blockers fail closed per enterprise', async () => {
  const { readiness } = client({
    sso: () => [
      row('default', { shortcode: 'other' }),
      row('contoso-eu', { blockers: ['secret_missing:sso.signingKey'] }),
    ],
    login: () => [row('default', { slug: 'not-acme', shortcode: null }), row('contoso-eu', {
      githubBaseUrl: 'https://fabrikam.ghe.com', shortcode: null,
    })],
  });
  const github = await readiness.readiness('default');
  assert.equal(github.ready, false);
  assert.deepEqual(github.blockers.sort(), ['shortcode_mismatch', 'slug_mismatch']);
  const ghe = await readiness.readiness('contoso-eu');
  assert.deepEqual(ghe.blockers.sort(), ['login_github_base_url_mismatch', 'sso:secret_missing:sso.signingKey']);
});

test('a missing, malformed or duplicated peer row makes the listing untrusted', async () => {
  const missing = client({ login: () => [row('default', { shortcode: null })] });
  assert.deepEqual((await missing.readiness.readiness('contoso-eu')).blockers, ['login_missing']);
  assert.equal((await missing.readiness.readiness('default')).ready, true);
  const malformed = [
    [row('default'), { ...row('contoso-eu'), id: 'Contoso_EU' }],
    [row('default'), row('default')],
    [row('default'), { ...row('contoso-eu'), configured: 'yes' }],
    { items: [] },
  ];
  for (const listing of malformed) {
    const { readiness } = client({ sso: () => listing });
    const result = await readiness.readiness('default');
    assert.equal(result.ready, false, JSON.stringify(listing));
    assert.ok(result.blockers.includes('sso_invalid_response'), JSON.stringify(result.blockers));
  }
});

test('an unreachable or hung peer fails closed within the deadline', async () => {
  const unreachable = client({ sso: () => { throw new ReadinessFetchError('unavailable'); } });
  assert.ok((await unreachable.readiness.readiness('default')).blockers.includes('sso_unavailable'));
  const hung = client({ login: () => new Promise(() => undefined) }, { timeoutMs: 50 });
  const started = Date.now();
  const result = await hung.readiness.readiness('contoso-eu');
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(result.blockers, ['login_unavailable']);
});

test('ready results are cached for 60 seconds per replica; activation asks for a fresh comparison', async () => {
  let now = 1_000_000;
  const { readiness, calls } = client({}, { now: () => now });
  await readiness.readiness('default');
  await readiness.readiness('contoso-eu');
  assert.equal(calls.length, 2, 'one refresh reads each peer once for every enterprise');
  now += 59_999;
  assert.equal(readiness.cached('default')?.ready, true);
  await readiness.readiness('default');
  assert.equal(calls.length, 2);
  await readiness.readiness('default', { fresh: true });
  assert.equal(calls.length, 4);
  now += 60_000;
  assert.equal(readiness.cached('default'), undefined);
  await readiness.readiness('default');
  assert.equal(calls.length, 6);
});

test('a not-ready result is reused for only 10 seconds, so a recovered peer is noticed soon', async () => {
  let now = 1_000_000;
  let ssoUp = false;
  const { readiness, calls } = client({
    sso: () => {
      if (!ssoUp) throw new ReadinessFetchError('unavailable');
      return [row('default'), row('contoso-eu')];
    },
  }, { now: () => now });
  assert.equal((await readiness.readiness('default')).ready, false);
  now += 9_999;
  assert.equal((await readiness.readiness('default')).ready, false);
  assert.equal(calls.length, 2, 'the failure is still cached');
  ssoUp = true;
  now += 1;
  assert.equal((await readiness.readiness('default')).ready, true);
  assert.equal(calls.length, 4);
});

test('the peer reader sends the internal token and rejects redirects, errors and oversized bodies', async (t) => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  let reply = (): Response => Response.json([row('default')]);
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return reply();
  });
  const signal = AbortSignal.timeout(5000);
  assert.deepEqual(await fetchPeerListing('sso', signal), [row('default')]);
  assert.match(seen[0]!.url, /\/internal\/enterprises$/);
  assert.equal(seen[0]!.init?.redirect, 'error');
  assert.ok(new Headers(seen[0]!.init?.headers).has('x-internal-token'));
  reply = () => new Response('{}', { status: 503 });
  await assert.rejects(fetchPeerListing('login', signal), (error: unknown) => {
    return error instanceof ReadinessFetchError && error.failure === 'unavailable';
  });
  reply = () => new Response(`[${'"x",'.repeat(READINESS_MAX_BYTES / 4)}"x"]`);
  await assert.rejects(fetchPeerListing('login', signal), (error: unknown) => {
    return error instanceof ReadinessFetchError && error.failure === 'invalid_response';
  });
});
