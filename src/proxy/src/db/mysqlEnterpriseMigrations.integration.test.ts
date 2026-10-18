import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import type { PoolConfig } from '../userPool/config.js';
import { POOL_SCHEMA_MIGRATION, poolConfigFingerprint,
  singleEnterprisePoolConfigFingerprint } from '../userPool/mysqlMigrations.js';
import { accountName } from '../userPool/names.js';
import { ENTERPRISE_MIGRATION_IDS } from './enterpriseMigrationIds.js';
import type { EnterpriseSeed } from './enterpriseSeed.js';
import {
  MYSQL_BASE_ENTERPRISE_STEPS,
  MYSQL_POOL_ENTERPRISE_STEPS,
  runMysqlMigrationSteps,
} from './mysqlEnterpriseMigrations.js';
import { renderMysqlEnterpriseUpgradeSql, renderMysqlInitialSql } from './mysqlInitialSql.js';
import { INITIAL_SCHEMA_MIGRATION, TOKEN_COLLATION_MIGRATION } from './mysqlMigrations.js';
import { MYSQL_SCHEMA, validateMysqlSchema } from './mysqlSchema.js';
import { MysqlStorage } from './mysqlStorage.js';

const mysqlUrl = process.env.MYSQL_TEST_URL;
const enabled = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';
const skip = enabled ? false
  : 'Requires loopback MYSQL_TEST_URL (ghcp_pool_test_*) and MYSQL_POOL_TEST_DISPOSABLE=1; '
    + 'creates/drops fresh databases.';

const options: PoolConfig = {
  enabled: true, accountDomain: 'synthetic.example.test', idleTarget: 2, maxAccounts: 50,
  leaseSeconds: 3600, provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2,
  retryAfterSeconds: 30, warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000,
};
const seed: EnterpriseSeed = { id: DEFAULT_ENTERPRISE_ID, fingerprint: 'a'.repeat(64), maxAccounts: 50 };
/** Differs from both the seed and the pool options: an upgrade must keep the persisted cap. */
const R4_CAP = 7;
const R4_TABLES: Record<string, string> = {
  proxy_accounts: 'identity', proxy_request_stats: 'id', proxy_identity_initializations: 'identity',
  user_pool_settings: 'id', user_pool_accounts: 'identity', user_pool_leases: 'caller_id', user_pool_events: 'id',
};
const REQUIRED_ENTERPRISE = ['proxy_accounts', 'proxy_request_stats', 'proxy_identity_initializations',
  'user_pool_accounts'];
const START_HERE = '-- If the database already exists, start here.';
const r4Script = readFile(new URL('./testdata/proxy-mysql-r4-initial.sql', import.meta.url), 'utf8');
type Snapshot = Record<string, RowDataPacket[]>;

test('an r4 database upgrades in place: rows keep every value and gain enterprise_id=default', { skip }, async () => {
  await withDatabase(async (db) => {
    await createR4Database(db);
    const before = await snapshot(db);
    await startProxy(db);
    await assertMigrated(db, before);
    for (const table of REQUIRED_ENTERPRISE) await assertInsertWithoutEnterpriseFails(db, table);
    assert.notEqual(await storedPoolFingerprint(db), singleEnterprisePoolConfigFingerprint(options),
      'an r4 replica now fails its pool configuration check');

    const migrated = await snapshot(db);
    const recorder = recordStatements(db);
    await startProxy(db);
    recorder.restore();
    assert.deepEqual(recorder.statements.filter((sql) => /^\s*ALTER\b/i.test(sql)), [], 're-run is a no-op');
    assert.deepEqual(await snapshot(db), migrated);
  });
});

test('after an upgrade, reservations write enterprise_id and maintain the inventory counter', { skip }, async () => {
  await withDatabase(async (db) => {
    await createR4Database(db);
    const storage = await startProxy(db);
    const pool = await storage.userPool(options);
    const member = await pool.reserve();
    assert.equal(member?.enterprise_id, DEFAULT_ENTERPRISE_ID);
    const [enterprise] = await storage.listEnterprises();
    assert.equal(enterprise.inventoryCount, 3);
    const settings = await pool.settings();
    const updated = await pool.updateSettings(settings.version, { max_accounts: 9 });
    assert.equal(updated.max_accounts, 9);
    const [capped] = await storage.listEnterprises();
    assert.deepEqual([capped.maxAccounts, capped.policyVersion], [9, enterprise.policyVersion + 1]);
    const [events] = await db.query<RowDataPacket[]>(`
      SELECT action, enterprise_id
      FROM user_pool_events
      WHERE action IN ('name_reserved', 'settings_updated') AND at > 5
      ORDER BY id
    `);
    assert.deepEqual(events.map((row) => [row.action, row.enterprise_id]),
      [['name_reserved', DEFAULT_ENTERPRISE_ID], ['settings_updated', null]]);
  });
});

test('an upgrade interrupted after any statement resumes and completes', { skip, timeout: 300000 }, async () => {
  const changes = [...MYSQL_BASE_ENTERPRISE_STEPS, ...MYSQL_POOL_ENTERPRISE_STEPS].flatMap((step) => step.changes);
  for (let applied = 0; applied <= changes.length; applied++) {
    await withDatabase(async (db) => {
      await createR4Database(db);
      const before = await snapshot(db);
      for (const change of changes.slice(0, applied)) await db.query(change.sql);
      await startProxy(db);
      await assertMigrated(db, before);
    });
  }
});

test('an upgrade interrupted after recorded steps resumes and completes', { skip }, async () => {
  for (let steps = 1; steps < MYSQL_BASE_ENTERPRISE_STEPS.length; steps++) {
    await withDatabase(async (db) => {
      await createR4Database(db);
      const before = await snapshot(db);
      await withConnection(db, (connection) =>
        runMysqlMigrationSteps(connection, MYSQL_BASE_ENTERPRISE_STEPS.slice(0, steps)));
      await startProxy(db);
      await assertMigrated(db, before);
    });
  }
});

test('MYSQL_AUTO_MIGRATE=false accepts the generated initial SQL and inserts the default row itself', { skip },
  async () => {
    await withDatabase(async (db) => {
      await runScript(db, initialSchemaPart(renderMysqlInitialSql()));
      const recorder = recordStatements(db);
      const storage = await startProxy(db, false);
      recorder.restore();
      assert.deepEqual(recorder.statements.filter(isDdl), []);
      const [enterprise] = await storage.listEnterprises();
      const { id, profileFingerprint, maxAccounts, inventoryCount } = enterprise;
      assert.deepEqual([id, profileFingerprint, maxAccounts, inventoryCount],
        [DEFAULT_ENTERPRISE_ID, seed.fingerprint, options.maxAccounts, 0]);
      await assertRecorded(db, Object.values(ENTERPRISE_MIGRATION_IDS));
      await validateEverything(db);
    });
  });

test('MYSQL_AUTO_MIGRATE=false on an r4 database names the upgrade script, then accepts its result', { skip },
  async () => {
    await withDatabase(async (db) => {
      await createR4Database(db);
      const before = await snapshot(db);
      await assert.rejects(new MysqlStorage(db, 2, false, seed).initialize(),
        /scripts\/proxy-mysql-enterprise-upgrade\.sql/);
      await runScript(db, renderMysqlEnterpriseUpgradeSql());
      const recorder = recordStatements(db);
      await startProxy(db, false);
      recorder.restore();
      assert.deepEqual(recorder.statements.filter(isDdl), []);
      await assertMigrated(db, before);
    });
  });

test('extra secondary indexes added by a DBA do not block startup in either mode', { skip }, async () => {
  await withDatabase(async (db) => {
    await runScript(db, initialSchemaPart(renderMysqlInitialSql()));
    await db.query('CREATE INDEX dba_request_model ON proxy_request_stats (model)');
    await db.query('CREATE UNIQUE INDEX dba_pool_attempt ON user_pool_accounts (attempt_id)');
    await startProxy(db, false);
    await startProxy(db, true);
  });
});

test('the default enterprise identity may change only while it has no pool members', { skip }, async () => {
  await withDatabase(async (db) => {
    const storage = await startProxy(db);
    const changed = { ...seed, fingerprint: 'b'.repeat(64) };
    await startProxy(db, true, changed);
    assert.equal((await storage.listEnterprises())[0].profileFingerprint, changed.fingerprint);
    await (await storage.userPool(options)).reserve();
    for (const autoMigrate of [true, false]) {
      await assert.rejects(new MysqlStorage(db, 2, autoMigrate, seed).initialize(),
        /^Error: enterprise_identity_changed/);
    }
    assert.equal((await storage.listEnterprises())[0].profileFingerprint, changed.fingerprint);
  });
});

async function withDatabase(run: (db: Pool) => Promise<void>): Promise<void> {
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Refusing a non-loopback MySQL test server');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'Refusing a non-test MySQL URL');
  const name = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  url.pathname = '/';
  const admin = createPool({ uri: url.toString(), connectionLimit: 1 });
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  url.pathname = `/${name}`;
  const db = createPool({ uri: url.toString(), connectionLimit: 4, timezone: 'Z', dateStrings: true,
    decimalNumbers: true });
  try {
    await run(db);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
}

async function startProxy(db: Pool, autoMigrate = true, enterprise = seed): Promise<MysqlStorage> {
  const storage = new MysqlStorage(db, 2, autoMigrate, enterprise);
  await storage.initialize();
  await storage.userPool(options);
  return storage;
}

async function createR4Database(db: Pool): Promise<void> {
  await runScript(db, initialSchemaPart(await r4Script));
  await insertR4Rows(db);
}

function initialSchemaPart(script: string): string {
  return script.slice(script.indexOf(START_HERE));
}

async function insertR4Rows(db: Pool): Promise<void> {
  const [first, second] = [accountName(0), accountName(1)];
  await db.query(`
    INSERT INTO proxy_accounts (
      identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status, created_at, updated_at
    )
    VALUES
      ('direct-user', 'Direct-User', 'direct_octo', 'SyntheticDirectToken', 'valid',
        '2026-01-01 00:00:00.001', '2026-01-02 00:00:00.002'),
      (?, ?, NULL, NULL, 'missing', '2026-01-03 00:00:00.000', '2026-01-03 00:00:00.000'),
      (?, ?, ?, 'SyntheticPoolToken', 'valid', '2026-01-04 00:00:00.000', '2026-01-04 00:00:00.000')
  `, [first, first, second, second, second]);
  await db.query(`
    INSERT INTO proxy_request_stats (
      id, identity, gh_login, requested_at, path, model, success, input_tokens, caller_id, lease_id
    )
    VALUES
      ('stat-1', 'direct-user', 'direct_octo', '2026-01-05 00:00:00.000', '/v1/messages', 'synthetic', 1, 10,
        NULL, NULL),
      ('stat-2', ?, NULL, '2026-01-05 00:00:01.000', '/v1/models', NULL, 0, NULL, ?, ?)
  `, [second, `sha256:${'c'.repeat(64)}`, randomUUID()]);
  await db.query(`
    INSERT INTO proxy_identity_initializations (identity, claim_id, lease_expires_at, created_at, updated_at)
    VALUES ('claiming-user', ?, '2026-01-06 00:00:00.000', '2026-01-06 00:00:00.000', '2026-01-06 00:00:00.000')
  `, [randomUUID()]);
  await insertR4Pool(db, first, second);
}

async function insertR4Pool(db: Pool, first: string, second: string): Promise<void> {
  await db.query(`
    INSERT INTO user_pool_settings (
      id, idle_target, max_accounts, lease_seconds, next_ordinal, account_domain, config_fingerprint
    )
    VALUES (1, 2, ?, 3600, 2, ?, ?)
  `, [R4_CAP, options.accountDomain, singleEnterprisePoolConfigFingerprint(options)]);
  await db.query(`
    INSERT INTO user_pool_accounts (identity, ordinal, state, stage, attempt_id, updated_at, verified_at)
    VALUES (?, 0, 'provisioning', 'new', ?, 1, NULL), (?, 1, 'ready', 'ready', ?, 2, 2)
  `, [first, randomUUID(), second, randomUUID()]);
  await db.query(`
    INSERT INTO user_pool_leases (caller_id, member_identity, lease_id, phase, assigned_at, expires_at)
    VALUES (?, ?, ?, 'active', 3, 9999999999999)
  `, [`sha256:${'c'.repeat(64)}`, second, randomUUID()]);
  await db.query(`
    INSERT INTO user_pool_events (at, action, identity, detail)
    VALUES (4, 'name_reserved', ?, NULL), (5, 'settings_updated', NULL, NULL)
  `, [first]);
}

async function snapshot(db: Pool): Promise<Snapshot> {
  const tables: Snapshot = {};
  for (const [table, key] of Object.entries(R4_TABLES)) {
    const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY ${key}`);
    tables[table] = rows;
  }
  return tables;
}

/** Every pre-upgrade row is unchanged apart from enterprise_id='default' and the pool fingerprint. */
async function assertMigrated(db: Pool, before: Snapshot): Promise<void> {
  const after = await snapshot(db);
  for (const [table, key] of Object.entries(R4_TABLES)) {
    const keys = new Set(before[table].map((row) => row[key]));
    const rows = after[table].filter((row) => keys.has(row[key]));
    const hasEnterprise = 'enterprise_id' in MYSQL_SCHEMA[table].columns;
    if (hasEnterprise) for (const row of rows) assert.equal(row.enterprise_id, DEFAULT_ENTERPRISE_ID, table);
    assert.deepEqual(rows.map(withoutUpgradeChanges), before[table].map(withoutUpgradeChanges), table);
  }
  assert.equal(await storedPoolFingerprint(db), poolConfigFingerprint(options));
  const [enterprises] = await db.query<RowDataPacket[]>('SELECT * FROM proxy_enterprises');
  assert.deepEqual(enterprises.map((row) => [row.id, row.state, row.max_accounts, row.inventory_count,
    row.profile_fingerprint]), [[DEFAULT_ENTERPRISE_ID, 'active', R4_CAP, 2, seed.fingerprint]]);
  await assertRecorded(db, [INITIAL_SCHEMA_MIGRATION, TOKEN_COLLATION_MIGRATION, POOL_SCHEMA_MIGRATION,
    ...Object.values(ENTERPRISE_MIGRATION_IDS)]);
  await validateEverything(db);
}

function withoutUpgradeChanges(row: RowDataPacket): Record<string, unknown> {
  const { enterprise_id: _enterprise, config_fingerprint: _fingerprint, ...rest } = row;
  return rest;
}

async function assertRecorded(db: Pool, ids: readonly string[]): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT id FROM schema_migrations');
  const recorded = new Set(rows.map((row) => row.id));
  for (const id of ids) assert.ok(recorded.has(id), id);
}

async function validateEverything(db: Pool): Promise<void> {
  await withConnection(db, (connection) => validateMysqlSchema(connection, Object.keys(MYSQL_SCHEMA)));
}

async function storedPoolFingerprint(db: Pool): Promise<string> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT config_fingerprint FROM user_pool_settings WHERE id = 1');
  return String(rows[0].config_fingerprint);
}

async function assertInsertWithoutEnterpriseFails(db: Pool, table: string): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} LIMIT 1`);
  const { enterprise_id: _enterprise, ...row } = rows[0];
  const key = R4_TABLES[table];
  const copy = { ...row, [key]: typeof row[key] === 'number' ? 999 : `copy-${row[key]}` };
  if (table === 'user_pool_accounts') Object.assign(copy, { identity: accountName(5), ordinal: 5 });
  await assert.rejects(db.query(`INSERT INTO ${table} SET ?`, [copy]),
    (error: { code?: string }) => error.code === 'ER_NO_DEFAULT_FOR_FIELD', table);
}

async function withConnection<T>(db: Pool, run: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await db.getConnection();
  try {
    return await run(connection);
  } finally {
    connection.release();
  }
}

/** Splits an administrator script on its delimiters (the credential fence uses DELIMITER //). */
function sqlStatements(script: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let current: string[] = [];
  for (const line of script.replace(/\r\n/g, '\n').split('\n')) {
    const change = line.match(/^DELIMITER (\S+)$/);
    if (change) {
      delimiter = change[1];
      continue;
    }
    if (!current.length && (!line.trim() || line.startsWith('--'))) continue;
    current.push(line);
    if (!line.trimEnd().endsWith(delimiter)) continue;
    statements.push(current.join('\n').trimEnd().slice(0, -delimiter.length));
    current = [];
  }
  return statements;
}

async function runScript(db: Pool, script: string): Promise<void> {
  for (const statement of sqlStatements(script)) await db.query(statement);
}

function isDdl(sql: string): boolean {
  return /^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(sql);
}

function recordStatements(db: Pool): { statements: string[]; restore(): void } {
  const statements: string[] = [];
  const getConnection = db.getConnection;
  db.getConnection = async () => {
    const connection = await getConnection.call(db);
    const query = connection.query.bind(connection) as (sql: string, values?: unknown) => Promise<unknown>;
    const execute = connection.execute.bind(connection) as (sql: string, values?: unknown) => Promise<unknown>;
    return Object.assign(connection, {
      query: (sql: string, values?: unknown) => { statements.push(String(sql)); return query(sql, values); },
      execute: (sql: string, values?: unknown) => { statements.push(String(sql)); return execute(sql, values); },
    });
  };
  return { statements, restore: () => { db.getConnection = getConnection; } };
}
