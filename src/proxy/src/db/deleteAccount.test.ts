import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';

test('deletes one Proxy account and its request stats without affecting other identities', async () => {
  process.env.DB_PATH = ':memory:';
  const { createAccount, deleteAccount, getAccount } = await import('./accountsRepo.js');
  const { listRequestStats, recordRequestStat } = await import('./requestStatsRepo.js');

  await createAccount({
    enterpriseId: DEFAULT_ENTERPRISE_ID,
    identity: 'alice',
    ssoUser: 'alice',
    ghLogin: 'alice_emu',
  });
  await createAccount({ enterpriseId: DEFAULT_ENTERPRISE_ID, identity: 'bob', ssoUser: 'bob', ghLogin: 'bob_emu' });
  await recordRequestStat({
    enterpriseId: DEFAULT_ENTERPRISE_ID,
    identity: 'alice',
    path: '/v1/models',
    success: true,
  });
  await recordRequestStat({ enterpriseId: DEFAULT_ENTERPRISE_ID, identity: 'bob', path: '/v1/models', success: true });

  assert.deepEqual(await deleteAccount('alice'), {
    identity: 'alice',
    deletedRequestStats: 1,
  });
  assert.equal(await getAccount('alice'), undefined);
  assert.notEqual(await getAccount('bob'), undefined);
  assert.equal((await listRequestStats(DEFAULT_ENTERPRISE_ID, 'alice')).length, 0);
  assert.equal((await listRequestStats(DEFAULT_ENTERPRISE_ID, 'bob')).length, 1);
  assert.equal(await deleteAccount('alice'), undefined);
});
