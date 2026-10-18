import assert from 'node:assert/strict';
import test from 'node:test';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { MysqlStorage } from './mysqlStorage.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ENTERPRISE_ID, type EnterpriseId } from '@ghcp/shared';

const enterpriseId = DEFAULT_ENTERPRISE_ID;
const seed = { id: enterpriseId, fingerprint: 'f'.repeat(64), maxAccounts: 8 };

const mysqlUrl = process.env.MYSQL_TEST_URL;
const mysqlRuntimeUrl = process.env.MYSQL_TEST_RUNTIME_URL;

test('provides MySQL repository parity and cross-instance claims', {
  skip: mysqlUrl ? false : 'Set MYSQL_TEST_URL to run MySQL integration tests.',
}, async (t) => {
  const firstPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const secondPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const thirdPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const fourthPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const runtimePool = createPool({
    uri: mysqlRuntimeUrl ?? mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const first = new MysqlStorage(firstPool, 2, true, [seed]);
  const second = new MysqlStorage(secondPool, 2, true, [seed]);
  const third = new MysqlStorage(thirdPool, 2, true, [seed]);
  const fourth = new MysqlStorage(fourthPool, 2, true, [seed]);
  const runtime = new MysqlStorage(runtimePool, 2, false, [seed]);
  const contenders = [first, second, third, fourth];
  try {
    await Promise.all(contenders.map((storage) => storage.initialize()));
    await clearTestData(firstPool);
    // Skip mode validates the prepared schema read-only, then only inserts/verifies the `default` row: no DDL.
    const statements: string[] = [];
    const realGetConnection = runtimePool.getConnection.bind(runtimePool);
    const validationConnection = t.mock.method(runtimePool, 'getConnection', async () => {
      const connection = await realGetConnection();
      const query = connection.query.bind(connection) as (sql: string, values?: unknown) => Promise<unknown>;
      return Object.assign(connection, {
        query: (sql: string, values?: unknown) => { statements.push(String(sql)); return query(sql, values); },
      });
    });
    await runtime.initialize();
    validationConnection.mock.restore();
    assert.ok(statements.length > 0);
    assert.deepEqual(statements.filter((sql) => /\b(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(sql)), []);
    const enterprises = await runtime.listEnterprises();
    assert.deepEqual(enterprises.map((enterprise) => [enterprise.id, enterprise.profileFingerprint]),
      [[enterpriseId, seed.fingerprint]]);

    await first.createAccount({ enterpriseId, identity: 'Alice', ssoUser: 'alice', ghLogin: 'alice_octo' });
    assert.equal((await second.getAccount('Alice'))?.ghLogin, 'alice_octo');
    assert.equal((await second.getAccount('Alice'))?.enterpriseId, enterpriseId);
    // The final schema has no default: an INSERT that omits enterprise_id (an old replica) fails.
    await assert.rejects(firstPool.query(`
      INSERT INTO proxy_accounts (identity, sso_user, created_at, updated_at)
      VALUES ('old-replica', 'old-replica', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `), /enterprise_id/);
    await assert.rejects(firstPool.query(`
      INSERT INTO proxy_accounts (identity, sso_user, created_at, updated_at, enterprise_id)
      VALUES ('unknown-enterprise', 'unknown-enterprise', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 'missing')
    `), /foreign key/i);
    assert.equal(await second.getAccount('alice'), undefined);
    assert.equal((await first.listAccounts(DEFAULT_ENTERPRISE_ID, { q: 'ALICE' })).total, 1);

    assert.equal(await first.beginCopilotOauthAuthorization('Alice', 'attempt-1'), true);
    assert.equal(await second.saveCopilotOauthToken('Alice', 'stale-attempt', 'stale-token'), undefined);
    assert.equal((await second.saveCopilotOauthToken('Alice', 'attempt-1', 'CaseSensitiveToken'))?.copilotOauthStatus, 'valid');
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'stale-token', 'expired'), false);
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'casesensitivetoken', 'expired'), false);
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'CaseSensitiveToken', 'expired'), true);
    assert.equal(await second.beginCopilotOauthAuthorization('Alice', 'stale-retry', 'unknown-previous'), false, 'A retry naming the wrong previous attempt is refused');
    for (let round = 0; round < 8; round++) {
      const attemptId = `write-fail-${round}`;
      const token = `fixture-race-token-${round}`;
      assert.equal(await first.beginCopilotOauthAuthorization('Alice', attemptId), true);
      // Token write and failure report race on the account row; exactly one of them wins.
      const [saved, failed] = await Promise.all([first.saveCopilotOauthToken('Alice', attemptId, token), second.failCopilotOauthAuthorization('Alice', attemptId)]);
      assert.equal(Boolean(saved) !== failed, true);
      const account = await first.getAccount('Alice');
      assert.equal(account?.copilotOauthToken === token, Boolean(saved));
      assert.equal(account?.copilotOauthStatus, saved ? 'valid' : 'failed');
    }
    await first.withReadSnapshot(async (reader) => {
      assert.equal((await reader.listAccounts(DEFAULT_ENTERPRISE_ID)).total, 1);
      await second.createAccount({ enterpriseId, identity: 'snapshot-extra', ssoUser: 'snapshot-extra' });
      assert.equal((await reader.listAccounts(DEFAULT_ENTERPRISE_ID)).total, 1);
      assert.equal((await second.listAccounts(DEFAULT_ENTERPRISE_ID)).total, 2);
      await second.deleteAccount('snapshot-extra');
    });
    for (let index = 0; index < 137; index++) {
      await first.createAccount({ enterpriseId, identity: `summary-${index}`, ssoUser: `summary-${index}`,
        copilotOauthStatus: index % 2 ? 'valid' : 'failed' });
    }
    assert.equal((await first.summarizeAccounts(DEFAULT_ENTERPRISE_ID)).total, 138);
    assert.equal((await second.listAccounts(DEFAULT_ENTERPRISE_ID, { q: 'summary-', status: 'failed' })).total, 69);
    await first.createAccount({ enterpriseId, identity: 'query-account', ssoUser: 'query-account' });
    await firstPool.query(`
      INSERT INTO proxy_request_stats (id, identity, requested_at, path, success, model, enterprise_id)
      VALUES ?`, [
      Array.from({ length: 1501 }, (_, index) => [randomUUID(), 'query-account',
        new Date(Date.UTC(2020, 0, 1, 0, 0, index)), '/v1/models', index === 0 ? 0 : 1,
        index === 0 ? 'older-only' : 'recent', enterpriseId]),
    ]);
    const recent = await first.listRequestStats(DEFAULT_ENTERPRISE_ID, 'query-account', 1000);
    assert.equal(recent.some((stat) => stat.model === 'older-only'), false);
    const older = await second.listRequestStatsPage(DEFAULT_ENTERPRISE_ID,
      { identity: 'query-account', model: 'older-only', success: 'false' });
    assert.equal(older.total, 1);
    assert.equal(older.items[0]?.model, 'older-only');
    const last = await second.listRequestStatsPage(DEFAULT_ENTERPRISE_ID,
      { identity: 'query-account', page: 16, pageSize: 100 });
    assert.equal(last.items.length, 1);

    const claims = await Promise.all([
      first.claimIdentityInitialization(enterpriseId, 'new-user', 'claim-a', 60),
      second.claimIdentityInitialization(enterpriseId, 'new-user', 'claim-b', 60),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winnerClaim = claims[0] ? 'claim-a' : 'claim-b';
    const winnerStorage = claims[0] ? first : second;
    assert.equal(await winnerStorage.releaseIdentityInitialization('new-user', 'stale-claim'), false);
    assert.equal(await winnerStorage.releaseIdentityInitialization('new-user', winnerClaim), true);
    await firstPool.execute(`
      INSERT INTO proxy_identity_initializations (
        identity, claim_id, lease_expires_at, created_at, updated_at, enterprise_id
      ) VALUES ('expired-user', 'expired-claim', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000',
        '2020-01-01 00:00:00.000', 'default')
    `);
    assert.equal(await second.claimIdentityInitialization(enterpriseId, 'expired-user', 'replacement-claim', 60), true);
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
        storage.claimIdentityInitialization(enterpriseId, freshIdentity, `fresh-${round}-${index}`, 60)));
      assert.equal(freshClaims.filter(Boolean).length, 1);

      const expiredIdentity = `expired-race-${round}`;
      await firstPool.execute(`
        INSERT INTO proxy_identity_initializations (
          identity, claim_id, lease_expires_at, created_at, updated_at, enterprise_id
        ) VALUES (?, 'expired-claim', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000',
          '2020-01-01 00:00:00.000', 'default')
      `, [expiredIdentity]);
      const expiredClaims = await Promise.all(contenders.map((storage, index) =>
        storage.claimIdentityInitialization(enterpriseId, expiredIdentity, `expired-${round}-${index}`, 60)));
      assert.equal(expiredClaims.filter(Boolean).length, 1);
    }

    for (let index = 0; index < 3; index += 1) {
      await first.recordRequestStat({
        enterpriseId,
        identity: 'Alice',
        path: '/v1/models',
        success: index !== 0,
        inputTokens: index,
      });
    }
    const stats = await second.listRequestStats(DEFAULT_ENTERPRISE_ID, 'Alice', 10);
    assert.equal(stats.length, 2);
    assert.deepEqual(stats.map((stat) => stat.inputTokens).sort(), [1, 2]);
    await first.pruneAllRequestStats();

    assert.deepEqual(await second.deleteAccount('Alice'), {
      identity: 'Alice',
      deletedRequestStats: 2,
    });
    assert.equal(await first.getAccount('Alice'), undefined);

    await runtime.createAccount({ enterpriseId, identity: 'runtime-user', ssoUser: 'runtime-user' });
    assert.equal((await runtime.getAccount('runtime-user'))?.ssoUser, 'runtime-user');
    assert.equal(await runtime.beginCopilotOauthAuthorization('runtime-user', 'runtime-attempt'), true);
    await runtime.recordRequestStat({ enterpriseId, identity: 'runtime-user', path: '/v1/models', success: true });
    assert.equal((await runtime.listRequestStats(DEFAULT_ENTERPRISE_ID, 'runtime-user')).length, 1);
    await runtime.pruneAllRequestStats();
    assert.equal(await runtime.claimIdentityInitialization(enterpriseId, 'runtime-user', 'runtime-claim', 60), true);
    assert.equal(await runtime.releaseIdentityInitialization('runtime-user', 'runtime-claim'), true);
    assert.deepEqual(await runtime.deleteAccount('runtime-user'), {
      identity: 'runtime-user',
      deletedRequestStats: 1,
    });
  } finally {
    await clearTestData(firstPool).catch(() => undefined);
    await Promise.all([...contenders, runtime].map((storage) => storage.close()));
  }
});

test('an existing identity never moves to another enterprise', {
  skip: mysqlUrl ? false : 'Set MYSQL_TEST_URL to run MySQL integration tests.',
}, async () => {
  const pool = createPool({ uri: mysqlUrl!, connectionLimit: 2, timezone: 'Z', dateStrings: true });
  const storage = new MysqlStorage(pool, 2, true, [seed]);
  const identity = `immutable-${randomUUID()}`;
  const other = `immutable-${randomUUID().slice(0, 8)}` as EnterpriseId;
  try {
    await storage.initialize();
    await insertEnterprise(pool, other);
    await storage.importCopilotOauthToken({ enterpriseId, identity, ssoUser: identity, ghLogin: 'octo',
      copilotOauthToken: 'synthetic-immutable-token' });
    const before = await accountRow(pool, identity);
    await assert.rejects(
      storage.createAccount({ enterpriseId: other, identity, ssoUser: 'moved', ghLogin: 'moved' }),
      (error: Error) => error.message === 'enterprise_id_immutable',
    );
    await assert.rejects(
      storage.importCopilotOauthToken({ enterpriseId: other, identity, ssoUser: 'moved',
        copilotOauthToken: 'synthetic-moved-token' }),
      (error: Error) => error.message === 'enterprise_id_immutable',
    );
    assert.deepEqual(await accountRow(pool, identity), before);
    assert.equal(before.enterprise_id, enterpriseId);
  } finally {
    await pool.query('DELETE FROM proxy_accounts WHERE identity = ?', [identity]);
    await pool.query('DELETE FROM proxy_enterprises WHERE id = ?', [other]);
    await storage.close();
  }
});

async function insertEnterprise(pool: Pool, id: EnterpriseId): Promise<void> {
  await pool.query(`
    INSERT INTO proxy_enterprises (
      id, state, max_accounts, inventory_count, policy_version, profile_fingerprint, created_at, updated_at
    )
    VALUES (?, 'active', 5, 0, 1, ?, 0, 0)
  `, [id, 'e'.repeat(64)]);
}

async function accountRow(pool: Pool, identity: string): Promise<RowDataPacket> {
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT *
    FROM proxy_accounts
    WHERE identity = ?
  `, [identity]);
  assert.equal(rows.length, 1);
  return { ...rows[0] };
}

async function clearTestData(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query('DELETE FROM proxy_identity_initializations');
  await pool.query('DELETE FROM proxy_request_stats');
  await pool.query('DELETE FROM proxy_accounts');
}
