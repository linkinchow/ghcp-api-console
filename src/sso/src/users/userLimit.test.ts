import assert from 'node:assert/strict';
import test from 'node:test';

test('enforces the SSO user limit while allowing updates and released capacity', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SSO_DEFAULT_USER_PASSWORD = 'configured-default';
  process.env.LOG_LEVEL = 'error';

  const { deleteUser, getUser, SsoUserLimitReachedError } = await import('../db/usersRepo.js');
  const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
  const { verifyPassword } = await import('../auth/password.js');
  const { createSsoUser, ensureUser, getSsoUserCapacity, importUsers } = await import('./service.js');
  const enterprise = (await import('../enterprises.js')).defaultSsoEnterprise();
  updateSsoRuntimeSettings(enterprise.id, { expectedVersion: 1, changes: { maxSsoUsers: 2 } });

  await createSsoUser(enterprise, { ssoUser: 'alice', password: 'initial' });
  await createSsoUser(enterprise, { ssoUser: 'bob' });
  const bob = getUser(enterprise.id, 'bob')!;
  assert.equal(await verifyPassword('configured-default', bob.passwordHash, bob.salt), true);

  assert.deepEqual(getSsoUserCapacity(enterprise), {
    current: 2,
    limit: 2,
    remaining: 0,
    reached: true,
  });
  assert.equal((await ensureUser(enterprise, 'alice@example.com', 'alice')).passwordForLogin, undefined);
  assert.equal((await ensureUser(enterprise, 'bob@example.com', 'bob')).passwordForLogin, 'configured-default');
  await assert.rejects(
    createSsoUser(enterprise, { ssoUser: 'carol' }),
    (err: unknown) => err instanceof SsoUserLimitReachedError && err.current === 2 && err.limit === 2,
  );

  const imported = await importUsers(enterprise, 'ssoUser,password\nalice\ncarol,password');
  assert.equal(imported.summary.success, 1);
  assert.equal(imported.summary.failed, 1);
  assert.equal(imported.rows.find((row) => row.ssoUser === 'alice')?.status, 'unchanged');
  const alice = getUser(enterprise.id, 'alice')!;
  assert.equal(await verifyPassword('initial', alice.passwordHash, alice.salt), true);
  assert.match(imported.rows.find((row) => row.ssoUser === 'carol')?.detail ?? '', /limit of 2 has been reached/);
  assert.equal(getUser(enterprise.id, 'carol'), undefined);

  assert.equal(deleteUser(enterprise.id, 'bob'), true);
  await createSsoUser(enterprise, { ssoUser: 'carol' });
  assert.equal(getUser(enterprise.id, 'carol')?.ssoUser, 'carol');
  assert.deepEqual(getSsoUserCapacity(enterprise), {
    current: 2,
    limit: 2,
    remaining: 0,
    reached: true,
  });
});
