import assert from 'node:assert/strict';
import test from 'node:test';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { parseEnterpriseRegistryV3, type EnterpriseReadinessV1 } from '@ghcp/shared';
import { probeEnterpriseCreationCapacity, probeEnterpriseReadiness } from './enterpriseReadiness.js';

const id = 'a0000000-0000-4000-8000-000000000001';
const registry = parseEnterpriseRegistryV3({ version: 3, registryRevision: 1, legacyEnterpriseId: id, profiles: [{
  id, slug: 'synthetic-enterprise', shortcode: 'synth', accountDomain: 'pool.invalid', revision: 1, maxAccounts: 5,
  routes: { proxyInternalUrl: 'http://127.0.0.1:19301', ssoInternalUrl: 'http://127.0.0.1:19302', loginInternalUrl: 'http://127.0.0.1:19303', ssoPublicUrl: 'http://127.0.0.1:19302' },
  sso: { entityId: 'urn:synthetic:idp', ssoUrl: 'http://127.0.0.1:19302/sso', loginUrl: 'http://127.0.0.1:19302/login', logoutUrl: 'http://127.0.0.1:19302/logout',
    spEntityId: 'urn:synthetic:sp', spAcsUrl: 'http://127.0.0.1:19304/acs', scimBaseUrl: 'http://127.0.0.1:19304/scim', githubApiBaseUrl: 'http://127.0.0.1:19304',
    emailDomain: 'pool.invalid', userPrefix: 'user', signingCertRef: { env: 'TEST_CERT' }, signingKeyRef: { env: 'TEST_KEY' }, sessionSecretRef: { env: 'TEST_SESSION' } },
  login: { provider: 'custom', allowedLoginUrls: ['http://127.0.0.1:19302/login'], selectors: {} },
}] });
function probe(component: 'sso' | 'login'): EnterpriseReadinessV1 {
  return { probeVersion: 1, component, schemaVersion: 3, contractVersion: 2, capability: 'enterprise-isolation-legacy-pool', enterpriseId: id,
    enterpriseRevision: 1, profileIdentitySha256: enterpriseProfileIdentityHashV4(registry.profiles[0]!), registryRevision: 1,
    registrySha256: enterpriseRegistryHashV3(registry), legacyEnterpriseId: id, ready: true, blockers: [] };
}
const component = (url: string) => url.includes(':19302/') ? 'sso' as const : 'login' as const;

test('creation capacity is a separate scoped live read; full and unlimited do not change readiness evidence', async () => {
  for (const [currentUsers, maxUsers, availableSlots, canCreate] of [[2, 3, 1, true], [3, 3, 0, false], [5, 3, 0, false], [5, null, null, true]] as const) {
    const value = await probeEnterpriseCreationCapacity(registry.profiles[0]!, 'synthetic', { fetch: async (input, options) => {
      assert.equal(String(input), `http://127.0.0.1:19302/internal/profiles/${id}/creation-capacity`);
      assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'error');
      const headers = new Headers(options?.headers);
      assert.equal(headers.get('x-enterprise-id'), id); assert.equal(headers.get('x-enterprise-revision'), '1');
      return Response.json({ enterpriseId: id, enterpriseRevision: 1, currentUsers, maxUsers, availableSlots, canCreate });
    } });
    assert.equal(value, canCreate);
  }
});

test('unknown, stale, contradictory, oversized or hanging creation capacity fails closed', async () => {
  const valid = { enterpriseId: id, enterpriseRevision: 1, currentUsers: 2, maxUsers: 3, availableSlots: 1, canCreate: true };
  for (const changed of [
    { enterpriseId: 'wrong' }, { enterpriseRevision: 2 }, { currentUsers: -1 }, { currentUsers: '2' },
    { currentUsers: Number.MAX_SAFE_INTEGER + 1 }, { maxUsers: 0 }, { availableSlots: 2 },
    { canCreate: false }, { maxUsers: null }, { password: 'private' },
  ]) await assert.rejects(probeEnterpriseCreationCapacity(registry.profiles[0]!, 'synthetic', {
    fetch: async () => Response.json({ ...valid, ...changed }),
  }), /enterprise_creation_capacity_unavailable/);
  for (const fetcher of [
    async () => Response.json(valid, { status: 503 }), async () => new Response('x'.repeat(32769)),
    async () => new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }),
    async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const keepAlive = setTimeout(() => {}, 1000);
    try { await assert.rejects(probeEnterpriseCreationCapacity(registry.profiles[0]!, 'synthetic', {
      fetch: fetcher, timeoutMs: 15,
    }), /enterprise_creation_capacity_unavailable/); } finally { clearTimeout(keepAlive); }
  }
});

test('readiness probes only fixed internal paths and strictly pair all enterprise identities', async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); paths.push(url);
    assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('x-enterprise-id'), id);
    return Response.json(probe(component(url)));
  };
  const evidence = await probeEnterpriseReadiness(registry, id, 'synthetic', { fetch: fetcher });
  assert.equal(evidence.enterpriseId, id); assert.equal(paths.length, 2);
  assert(paths.every(path => path.endsWith(`/internal/profiles/${id}/readiness`)));
  assert(!JSON.stringify(evidence).includes('TEST_CERT'));
});

test('wrong enterprise, stale registry, wrong component, unknown fields and blocked readiness fail closed', async () => {
  for (const changed of [
    { enterpriseId: 'b0000000-0000-4000-8000-000000000002' }, { registryRevision: 2 }, { component: 'proxy' },
    { schemaVersion: 4 }, { secret: 'must-not-leak' }, { ready: false, blockers: ['scim_secret_unavailable'] },
  ]) {
    await assert.rejects(probeEnterpriseReadiness(registry, id, 'synthetic', { fetch: async input => Response.json({ ...probe(component(String(input))), ...changed }) }),
      /enterprise_readiness_/);
  }
});

test('response body and hanging requests are bounded; redirect responses are never accepted', async () => {
  for (const fetcher of [
    async () => new Response('x'.repeat(32769)),
    async () => new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }),
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      await assert.rejects(probeEnterpriseReadiness(registry, id, 'synthetic', { fetch: fetcher, timeoutMs: 25 }), /enterprise_readiness_unavailable/);
    } finally { clearTimeout(keepAlive); }
  }
});
