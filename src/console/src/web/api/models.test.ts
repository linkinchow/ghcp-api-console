import assert from 'node:assert/strict';
import test from 'node:test';
import { ConsoleApiError } from './client.js';
import { getAdminModels } from './models.js';

test('requests the admin catalog with an explicit refresh flag, no body and no caching', async (t) => {
  const requests: Array<{ path: string; options?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, options?: RequestInit) => {
    requests.push({ path: String(path), options });
    return new Response(JSON.stringify({ models: [] }));
  });
  const controller = new AbortController();
  await getAdminModels('default', false, controller.signal);
  await getAdminModels('ghe-tenant', true);

  assert.equal(requests[0]!.path, '/api/console/proxy/enterprises/default/models?refresh=false');
  assert.equal(requests[0]!.options?.signal, controller.signal);
  assert.equal(requests[0]!.options?.cache, 'no-store');
  assert.equal(requests[0]!.options?.body, undefined);
  assert.equal(requests[1]!.path, '/api/console/proxy/enterprises/ghe-tenant/models?refresh=true');
});

test('an invalid enterprise never falls back to an unscoped catalog', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  assert.throws(() => getAdminModels(''), /Invalid enterprise/);
  assert.throws(() => getAdminModels('../models'), /Invalid enterprise/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('session and admin-source errors propagate unchanged, without retries', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ error: { code: 'unauthorized', message: 'Session expired' } }), { status: 401 },
  ));
  const unauthorized = (error: unknown) => error instanceof ConsoleApiError && error.status === 401;
  await assert.rejects(getAdminModels('default'), unauthorized);

  const cases = [
    [409, 'models_admin_not_configured'],
    [409, 'models_admin_credential_missing'],
    [502, 'models_admin_identity_mismatch'],
    [502, 'models_upstream_authorization_rejected'],
    [503, 'models_admin_configuration_invalid'],
  ] as const;
  for (const [status, code] of cases) {
    fetch.mock.mockImplementation(async () => new Response(
      JSON.stringify({ error: { code, message: 'Contact your operator.' } }), { status },
    ));
    const expected = (error: unknown) => error instanceof ConsoleApiError
      && error.status === status && error.code === code;
    await assert.rejects(getAdminModels('default'), expected);
  }
  assert.equal(fetch.mock.callCount(), 1 + cases.length);
});
