import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

test('default credential resolution is internal, read-only and refuses changed passwords', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sso-credential-test-'));
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DB_PATH = ':memory:';
  process.env.SSO_DEFAULT_USER_PASSWORD = 'fixture-default-password';
  process.env.SSO_USER_EVENTS_LOG = join(directory, 'events.log');
  process.env.INTERNAL_API_TOKEN = 'fixture-internal-token';
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { defaultSsoEnterprise } = await import('../enterprises.js');
  const { createSsoUser } = await import('../users/service.js');
  const { countUsers } = await import('../db/usersRepo.js');
  const { createEnterpriseInternalRouter } = await import('./enterpriseRoutes.js');
  const enterprise = defaultSsoEnterprise();
  await createSsoUser(enterprise, { ssoUser: 'default-user' });
  await createSsoUser(enterprise, { ssoUser: 'changed-user', password: 'fixture-custom-password' });
  const app = express();
  app.use(express.json());
  app.use('/internal/enterprises/:enterpriseId', createEnterpriseInternalRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, authenticated = true) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: authenticated ? { 'X-Internal-Token': 'fixture-internal-token' } : {},
  });
  const scoped = (ssoUser: string) => `/internal/enterprises/default/users/${ssoUser}/login-credentials`;
  const denied = await request(scoped('default-user'), false);
  assert.equal(denied.status, 401);
  const resolved = await request(scoped('default-user'));
  assert.equal(resolved.status, 200);
  assert.equal(resolved.headers.get('cache-control'), 'no-store');
  assert.equal((await resolved.json() as { password: string }).password, 'fixture-default-password');
  const changed = await request(scoped('changed-user'));
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as { error: { code: string } }).error.code, 'password_override_required');
  assert.equal((await request(scoped('missing-user'))).status, 404);
  assert.equal((await request('/api/enterprises/default/users/default-user/login-credentials')).status, 404);
  assert.equal(countUsers(enterprise.id), 2);
});
