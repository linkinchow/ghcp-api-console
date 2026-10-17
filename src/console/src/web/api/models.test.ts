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
  await getAdminModels(false, controller.signal);
  await getAdminModels(true);

  assert.equal(requests[0]!.path, '/api/console/proxy/models?refresh=false');
  assert.equal(requests[0]!.options?.signal, controller.signal);
  assert.equal(requests[0]!.options?.cache, 'no-store');
  assert.equal(requests[0]!.options?.body, undefined);
  assert.equal(requests[1]!.path, '/api/console/proxy/models?refresh=true');
});

test('session and admin-source errors propagate unchanged, without retries', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ error: { code: 'unauthorized', message: 'Session expired' } }), { status: 401 },
  ));
  await assert.rejects(getAdminModels(), (error) => error instanceof ConsoleApiError && error.status === 401);

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
    await assert.rejects(getAdminModels(), (error) => error instanceof ConsoleApiError && error.status === status && error.code === code);
  }
  assert.equal(fetch.mock.callCount(), 1 + cases.length);
});
