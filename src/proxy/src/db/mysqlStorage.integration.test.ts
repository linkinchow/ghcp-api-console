import { randomUUID } from 'node:crypto';
import { initMysqlFixture, TEST_ENTERPRISE, fixtureRegistry, completeFixtureAttempt } from '../test/enterpriseFixtures.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import { MysqlStorage } from './mysqlStorage.js';

const mysqlUrl = process.env.MYSQL_TEST_URL;

test('provides MySQL repository parity and cross-instance claims', {
  skip: mysqlUrl && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1' ? false : 'Requires loopback MYSQL_TEST_URL and MYSQL_POOL_TEST_DISPOSABLE=1.',
}, async () => {
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search + url.hash, '');
  url.pathname = '/';
  const admin = createPool({ uri: url.toString(), connectionLimit: 1 });
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  url.pathname = '/' + database;
  const firstPool = createPool({
    uri: url.toString(),
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const secondPool = createPool({
    uri: url.toString(),
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const thirdPool = createPool({
    uri: url.toString(),
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const fourthPool = createPool({
    uri: url.toString(),
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const first = new MysqlStorage(firstPool, 2, fixtureRegistry());
  const second = new MysqlStorage(secondPool, 2, fixtureRegistry());
  const third = new MysqlStorage(thirdPool, 2, fixtureRegistry());
  const fourth = new MysqlStorage(fourthPool, 2, fixtureRegistry());
  const contenders = [first, second, third, fourth];
  try {
    await initMysqlFixture(firstPool);
    await Promise.all(contenders.map((storage) => storage.initialize()));
    await clearTestData(firstPool);

    await first.createAccount({ identity: 'Alice', ssoUser: 'alice', ghLogin: 'alice_octo' });
    assert.equal((await second.getAccount('Alice'))?.ghLogin, 'alice_octo');
    assert.equal(await second.getAccount('alice'), undefined);
    assert.equal((await first.listAccounts({ q: 'ALICE' })).total, 1);

    assert.equal(await first.beginCopilotOauthAuthorization('Alice', '11111111-1111-4111-8111-111111111111'), true);
    assert.equal(await completeFixtureAttempt(second,'Alice', 'stale-attempt', 'stale-token'), undefined);
    assert.equal((await completeFixtureAttempt(second,'Alice', '11111111-1111-4111-8111-111111111111', 'CaseSensitiveToken'))?.copilotOauthStatus, 'valid');
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'stale-token', 'expired'), false);
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'casesensitivetoken', 'expired'), false);
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'CaseSensitiveToken', 'expired'), true);

    const claims = await Promise.all([
      first.claimIdentityInitialization('new-user', 'claim-a', 60),
      second.claimIdentityInitialization('new-user', 'claim-b', 60),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winnerClaim = claims[0] ? 'claim-a' : 'claim-b';
    const winnerStorage = claims[0] ? first : second;
    assert.equal(await winnerStorage.releaseIdentityInitialization('new-user', 'stale-claim'), false);
    assert.equal(await winnerStorage.releaseIdentityInitialization('new-user', winnerClaim), true);
    await firstPool.execute(`
      INSERT INTO proxy_identity_initializations (
        enterprise_id, identity, claim_id, lease_expires_at, created_at, updated_at
      ) VALUES (?, 'expired-user', 'expired-claim', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000')
    `, [TEST_ENTERPRISE.id]);
    assert.equal(await second.claimIdentityInitialization('expired-user', 'replacement-claim', 60), true);
    const [reclaimedRows] = await firstPool.query<Array<RowDataPacket & {
      claim_id: string;
      updated_at: string;
    }>>(
      'SELECT claim_id, updated_at FROM proxy_identity_initializations WHERE identity = ?',
      ['expired-user'],
    );
    assert.equal(reclaimedRows[0]?.claim_id, 'replacement-claim');
    assert.notEqual(reclaimedRows[0]?.updated_at, '2020-01-01 00:00:00.000');

    for (let round = 0; round < 20; round += 1) {
      const freshIdentity = `fresh-race-${round}`;
      const freshClaims = await Promise.all(contenders.map((storage, index) =>
        storage.claimIdentityInitialization(freshIdentity, `fresh-${round}-${index}`, 60)));
      assert.equal(freshClaims.filter(Boolean).length, 1);

      const expiredIdentity = `expired-race-${round}`;
      await firstPool.execute(`
        INSERT INTO proxy_identity_initializations (
          enterprise_id, identity, claim_id, lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, 'expired-claim', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000')
      `, [TEST_ENTERPRISE.id, expiredIdentity]);
      const expiredClaims = await Promise.all(contenders.map((storage, index) =>
        storage.claimIdentityInitialization(expiredIdentity, `expired-${round}-${index}`, 60)));
      assert.equal(expiredClaims.filter(Boolean).length, 1);
    }

    for (let index = 0; index < 3; index += 1) {
      await first.recordRequestStat({
        identity: 'Alice',
        path: '/v1/models',
        success: index !== 0,
        inputTokens: index,
      });
    }
    const stats = await second.listRequestStats('Alice', 10);
    assert.equal(stats.length, 2);
    assert.deepEqual(stats.map((stat) => stat.inputTokens).sort(), [1, 2]);
    await first.pruneAllRequestStats();

    assert.deepEqual(await second.deleteAccount('Alice'), {
      identity: 'Alice',
      deletedRequestStats: 2,
    });
    assert.equal(await first.getAccount('Alice'), undefined);
    await verifyImportCas(first,second);
  } finally {
    await clearTestData(firstPool).catch(() => undefined);
    await Promise.all(contenders.map((storage) => storage.close()));
    try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
  }
});

async function verifyImportCas(first: MysqlStorage, second: MysqlStorage): Promise<void> {
  for (const action of ['deleted','recreated','fresh-attempt','finished-attempt','absent-created'] as const) {
    const identity=`import-${action}`,input={identity,ssoUser:identity,ghLogin:'alice_octo',copilotOauthToken:'synthetic-csv-token'};
    if (action!=='absent-created') await first.createAccount(input);
    const expectedAccount=await first.getCopilotOauthTokenImportFence(identity);
    if (action==='deleted'||action==='recreated') await second.deleteAccount(identity);
    if (action==='recreated'||action==='absent-created') await second.createAccount(input);
    let freshAttempt:string|undefined;
    if (action==='fresh-attempt'||action==='finished-attempt') {
      const account=(await second.getAccount(identity))!;
      const binding={enterpriseId:TEST_ENTERPRISE.id,enterpriseRevision:1,identity,accountIncarnation:account.accountIncarnation,
        oauthAttemptId:randomUUID(),expectedGhLogin:'alice_octo'};
      freshAttempt=binding.oauthAttemptId;
      await second.beginAuthorizationAttempt(binding);
      if (action==='finished-attempt') await second.endAuthorizationAttempt(binding,'cancelled');
    }
    const before=await second.getAccount(identity);
    await assert.rejects(first.importCopilotOauthToken({...input,expectedAccount}),/stale_token_import/);
    assert.deepEqual(await second.getAccount(identity),before);
    if (freshAttempt) assert.equal((await second.getAuthorizationAttempt(TEST_ENTERPRISE.id,identity,freshAttempt))?.status,
      action==='finished-attempt'?'cancelled':'active');
  }
  // Two writers sharing an absence snapshot cannot both insert/update the identity.
  const identity='import-absent-contenders',input={identity,ssoUser:identity,ghLogin:'alice_octo',copilotOauthToken:'synthetic-first'};
  const expectedAccount=await first.getCopilotOauthTokenImportFence(identity);
  assert.equal(expectedAccount.accountIncarnation,null);
  const outcomes=await Promise.allSettled([
    first.importCopilotOauthToken({...input,expectedAccount}),
    second.importCopilotOauthToken({...input,copilotOauthToken:'synthetic-second',expectedAccount}),
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const loser=outcomes.find(x=>x.status==='rejected') as PromiseRejectedResult;
  assert.match(String(loser.reason),/stale_token_import/);
  const created=(await first.getAccount(identity))!;
  const binding={enterpriseId:TEST_ENTERPRISE.id,enterpriseRevision:1,identity,accountIncarnation:created.accountIncarnation,
    oauthAttemptId:randomUUID(),expectedGhLogin:'alice_octo'};
  await second.beginAuthorizationAttempt(binding);
  const observed=await first.getCopilotOauthTokenImportFence(identity);
  const overwritten=await first.importCopilotOauthToken({...input,copilotOauthToken:'intentional-replacement',expectedAccount:observed});
  assert.equal(overwritten.accountIncarnation,created.accountIncarnation);
  assert.equal(overwritten.copilotOauthToken,'intentional-replacement');
  assert.equal((await second.getAuthorizationAttempt(TEST_ENTERPRISE.id,identity,binding.oauthAttemptId))?.status,'cancelled');
}

async function clearTestData(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query('DELETE FROM proxy_identity_initializations');
  await pool.query('DELETE FROM proxy_request_stats');
  await pool.query('DELETE FROM proxy_authorization_attempts');
  await pool.query('DELETE FROM proxy_accounts');
}
