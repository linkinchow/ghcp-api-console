import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initEnterpriseSqliteV4, validateEnterpriseSqliteV4, validatePoolNameCatalogSqliteV4 } from '../../src/packages/shared/src/enterpriseStorageV4.js';
import { validateEnterpriseMysqlV4, validatePoolNameCatalogMysqlV4 } from '../../src/packages/shared/src/enterpriseMysqlV4.js';
import type { MysqlConnection } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { accountName, PoolNameCatalogCompatibilityError } from '../../src/packages/shared/src/poolNames.js';
import { initEnterpriseSqliteV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
import { assertSqliteQuiescentV4 } from './sqlite.js';
import { preflightEnterpriseMysqlV4 } from './mysql.js';
import { registryV3, poolOptionsV3, A } from '../multi-enterprise/fixtures.js';
import { mysqlFixtureV4 } from './mysql.fixture.js';
import type { SqliteServiceV4 } from './manifest.js';

function insert(db: Database.Database, ordinal: number, identity = accountName(ordinal)): void {
  const stamp = '2026-09-19T00:00:00.000Z';
  db.prepare('INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(A, randomUUID(), identity, identity, stamp, stamp);
  db.prepare("INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,updated_at) VALUES(?,?,'disabled','new',?,1)").run(identity, ordinal, randomUUID());
  db.prepare('UPDATE user_pool_settings SET next_ordinal=? WHERE id=1').run(ordinal + 1);
}

test('SQLite V4 startup accepts unchanged prefix and rejects legacy high ordinals without writes', () => {
  for (const [ordinal, identity, allowed] of [[39, accountName(39), true], [1000, 'aaliyah.abbott01', false], [1000, accountName(1000), true], [9999, accountName(9999), true]] as const) {
    const db = new Database(':memory:');
    try {
      initEnterpriseSqliteV4(db, 'proxy', registryV3(), poolOptionsV3()); insert(db, ordinal, identity);
      const before = db.serialize();
      if (allowed) validateEnterpriseSqliteV4(db, 'proxy', registryV3());
      else assert.throws(() => validateEnterpriseSqliteV4(db, 'proxy', registryV3()), PoolNameCatalogCompatibilityError);
      assert.deepEqual(db.serialize(), before);
    } finally { db.close(); }
  }
});

test('SQLite final V4 preflight rejects old suffix or ambiguous cursor before migration mutations', () => {
  for (const oldRow of [true, false]) {
    const db = new Database(':memory:');
    try {
      initEnterpriseSqliteV3(db, 'proxy', registryV3(), poolOptionsV3());
      if (oldRow) insert(db, 1000, 'aaliyah.abbott01'); else db.prepare('UPDATE user_pool_settings SET next_ordinal=1001').run();
      const before = db.serialize();
      assert.throws(() => assertSqliteQuiescentV4(db, { component: 'proxy', layout: 'pool' } as SqliteServiceV4), PoolNameCatalogCompatibilityError);
      assert.deepEqual(db.serialize(), before);
      assert.equal((db.prepare('SELECT schema_version FROM enterprise_schema').get() as { schema_version: number }).schema_version, 3);
    } finally { db.close(); }
  }
});

test('SQLite catalog guard queries only bounded pool inventory and cursor', () => {
  const db = new Database(':memory:');
  try {
    initEnterpriseSqliteV4(db, 'proxy', registryV3(), poolOptionsV3());
    const prepare = db.prepare.bind(db), sql: string[] = [];
    db.prepare = ((query: string) => { sql.push(query); return prepare(query); }) as typeof db.prepare;
    validatePoolNameCatalogSqliteV4(db);
    assert.equal(sql.length, 2); assert.match(sql[1], /FROM user_pool_accounts p/); assert.match(sql[1], /LIMIT 10001$/);
    assert.doesNotMatch(sql.join('\n'), /SELECT \* FROM proxy_accounts/);
  } finally { db.close(); }
});

function mysqlMember(f: ReturnType<typeof mysqlFixtureV4>, ordinal: number, identity: string): void {
  f.data.proxy_accounts.push({ enterprise_id: A, account_incarnation: randomUUID(), identity, sso_user: identity, copilot_oauth_status: 'missing', copilot_oauth_attempt_id: null, created_at: '2026-09-19 00:00:00.000' });
  f.data.user_pool_accounts.push({ identity, ordinal, state: 'disabled', stage: 'new', attempt_id: randomUUID(), updated_at: 1 });
  f.data.user_pool_settings[0].next_ordinal = ordinal + 1;
}

test('SQL-mock MySQL V4 startup and final preflight use same exact catalog barrier', async () => {
  for (const version of [3, 4] as const) for (const valid of [false, true]) {
    const f = mysqlFixtureV4('pool', version);
    mysqlMember(f, 1000, valid ? accountName(1000) : 'aaliyah.abbott01');
    const before = structuredClone(f.data);
    const check = () => version === 4 ? validateEnterpriseMysqlV4(f.connection, 'proxy', registryV3()) : preflightEnterpriseMysqlV4(f.connection, registryV3());
    if (valid) await check(); else await assert.rejects(check(), PoolNameCatalogCompatibilityError);
    assert.deepEqual(f.data, before); assert.equal(f.mutations.length, 0);
    assert.ok(f.statements.some(sql => sql.includes('FROM user_pool_settings s LEFT JOIN user_pool_accounts') && sql.endsWith('LIMIT 10001')));
  }
  const ambiguous = mysqlFixtureV4('pool', 4); ambiguous.data.user_pool_settings[0].next_ordinal = 1001;
  await assert.rejects(validateEnterpriseMysqlV4(ambiguous.connection, 'proxy', registryV3()), PoolNameCatalogCompatibilityError);
  assert.equal(ambiguous.mutations.length, 0);
});

test('MySQL catalog check sees a single cursor/inventory snapshot when startup races a reservation', async () => {
  const f = mysqlFixtureV4('pool', 4);
  // A healthy prefix was read, then another replica atomically reserves ordinal1000.
  f.data.user_pool_settings[0].next_ordinal = 1000;
  let reserved = false;
  const racing = { query: async (sql: string, values: unknown[] = []) => {
    const result = await f.connection.query(sql, values);
    if (sql === 'SELECT * FROM user_pool_settings' && !reserved) {
      reserved = true;
      mysqlMember(f, 1000, accountName(1000));
    }
    return result;
  }, destroy: () => f.connection.destroy() } as unknown as MysqlConnection;
  await validateEnterpriseMysqlV4(racing, 'proxy', registryV3());
  assert.equal(reserved, true);
  assert.equal(f.data.user_pool_settings[0].next_ordinal, 1001);
  const joined = f.statements.filter(sql => sql.startsWith('SELECT s.next_ordinal,p.identity,p.ordinal,a.sso_user'));
  assert.equal(joined.length, 1);
  assert.doesNotMatch(joined[0], /FOR UPDATE|LOCK IN SHARE MODE|GET_LOCK/);
  assert.equal(f.mutations.length, 0);
});

test('MySQL one-statement catalog check preserves empty cursor and rejects missing or malformed inventory', async () => {
  const empty = mysqlFixtureV4('pool', 4);
  await validatePoolNameCatalogMysqlV4(empty.connection);
  assert.equal(empty.statements.length, 1);
  empty.data.user_pool_settings[0].next_ordinal = 1001;
  await assert.rejects(validatePoolNameCatalogMysqlV4(empty.connection), PoolNameCatalogCompatibilityError);
  empty.data.user_pool_settings = [];
  await assert.rejects(validatePoolNameCatalogMysqlV4(empty.connection), PoolNameCatalogCompatibilityError);
  const malformed = mysqlFixtureV4('pool', 4);
  mysqlMember(malformed, 0, accountName(0));
  malformed.data.user_pool_accounts[0].ordinal = null;
  await assert.rejects(validatePoolNameCatalogMysqlV4(malformed.connection), PoolNameCatalogCompatibilityError);
  assert.equal(empty.mutations.length + malformed.mutations.length, 0);
});
