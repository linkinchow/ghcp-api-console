import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStorage } from './sqliteStorage.js';
import { defaultEnterpriseSeed } from './enterpriseSeed.js';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';

test('coordinates identity initialization claims across SQLite connections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghcp-proxy-claims-'));
  const path = join(directory, 'proxy.sqlite');
  const first = new SqliteStorage(path, 2, [defaultEnterpriseSeed({})]);
  const second = new SqliteStorage(path, 2, [defaultEnterpriseSeed({})]);
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const claims = await Promise.all([
      first.claimIdentityInitialization(DEFAULT_ENTERPRISE_ID, 'alice', 'claim-a', 60),
      second.claimIdentityInitialization(DEFAULT_ENTERPRISE_ID, 'alice', 'claim-b', 60),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);

    const winner = claims[0]
      ? { storage: first, claimId: 'claim-a' }
      : { storage: second, claimId: 'claim-b' };
    const loser = claims[0]
      ? { storage: second, claimId: 'claim-b' }
      : { storage: first, claimId: 'claim-a' };
    assert.equal(await loser.storage.releaseIdentityInitialization('alice', loser.claimId), false);
    assert.equal(await winner.storage.releaseIdentityInitialization('alice', winner.claimId), true);
    const { storage, claimId } = loser;
    const reclaimed = await storage.claimIdentityInitialization(DEFAULT_ENTERPRISE_ID, 'alice', claimId, 60);
    assert.equal(reclaimed, true);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
