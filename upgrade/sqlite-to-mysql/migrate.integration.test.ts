import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import { defaultEnterpriseSeed } from '../../src/proxy/src/db/enterpriseSeed.js';
import { runMigrations } from '../../src/proxy/src/db/migrations.js';
import { migrateSqliteToMysql, type MigrationOptions } from './migrate.js';

const mysqlUrl = process.env.MYSQL_TEST_URL;
const skip = mysqlUrl ? false : 'Set MYSQL_TEST_URL (loopback) to run the migration integration test.';
/** The Proxy environment of these tests: github.com with the baseline shortcode, direct mode. */
const env: NodeJS.ProcessEnv = {};
const seed = defaultEnterpriseSeed(env);

/** proxy_accounts and proxy_request_stats as a single-enterprise (r4) Proxy leaves them. */
const R4_SCHEMA = `
  CREATE TABLE proxy_accounts (
    identity TEXT PRIMARY KEY,
    sso_user TEXT NOT NULL,
    gh_login TEXT,
    copilot_oauth_token TEXT,
    copilot_oauth_status TEXT NOT NULL DEFAULT 'missing',
    copilot_oauth_updated_at TEXT,
    copilot_oauth_attempt_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE proxy_request_stats (
    id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    gh_login TEXT,
    requested_at TEXT NOT NULL,
    path TEXT NOT NULL,
    model TEXT,
    success INTEGER NOT NULL,
    failure_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_tokens INTEGER,
    cache_input_tokens INTEGER,
    cache_write_tokens INTEGER,
    caller_id TEXT,
    lease_id TEXT
  );
`;

interface Fixture {
  path: string;
  options(overrides?: Partial<MigrationOptions>): MigrationOptions;
}

test('copies a single-enterprise (r4) SQLite into default and refuses a non-empty target', { skip }, async () => {
  await withFixture('r4', async (fixture, pool) => {
    const dryRun = await migrateSqliteToMysql(fixture.options({ dryRun: true }));
    assert.deepEqual(dryRun, { accounts: 1, requestStats: 1, dryRun: true });

    const result = await migrateSqliteToMysql(fixture.options());
    assert.deepEqual(result, { accounts: 1, requestStats: 1, dryRun: false });
    await assertCopiedRows(pool);
    const enterprise = await targetEnterprise(pool);
    assert.equal(enterprise.profile_fingerprint, seed.fingerprint);
    assert.equal(Number(enterprise.inventory_count), 0);

    await assert.rejects(
      migrateSqliteToMysql(fixture.options()),
      /Refusing to migrate into a non-empty MySQL target/,
    );
    assert.equal(sourceCount(fixture.path, 'proxy_accounts'), 1);
  });
});

test('copies a multi-enterprise SQLite with its default enterprise policy', { skip }, async () => {
  await withFixture('multi-enterprise', async (fixture, pool) => {
    updateSource(fixture.path, `
      UPDATE proxy_enterprises
      SET max_accounts = 42, policy_version = 3, created_at = 1000, updated_at = 2000
      WHERE id = 'default'
    `);
    const result = await migrateSqliteToMysql(fixture.options());
    assert.deepEqual(result, { accounts: 1, requestStats: 1, dryRun: false });
    await assertCopiedRows(pool);
    const enterprise = await targetEnterprise(pool);
    assert.deepEqual(
      [enterprise.id, enterprise.state, enterprise.profile_fingerprint],
      [DEFAULT_ENTERPRISE_ID, 'active', seed.fingerprint],
    );
    assert.deepEqual(
      [enterprise.max_accounts, enterprise.inventory_count, enterprise.policy_version].map(Number),
      [42, 0, 3],
    );
    assert.deepEqual([enterprise.created_at, enterprise.updated_at].map(Number), [1000, 2000]);
  });
});

test('refuses sources it cannot copy faithfully, before writing the target', { skip }, async () => {
  await withFixture('multi-enterprise', async (fixture, pool) => {
    const otherIdentity = fixture.options({ env: { ENTERPRISE_SHORTCODE: 'other' } });
    await assert.rejects(migrateSqliteToMysql({ ...otherIdentity, dryRun: true }), /different identity/);
    await assert.rejects(migrateSqliteToMysql(otherIdentity), /different identity/);

    updateSource(fixture.path, `
      INSERT INTO proxy_enterprises (
        id, state, max_accounts, inventory_count, policy_version, profile_fingerprint, created_at, updated_at
      )
      VALUES ('second', 'active', 5, 0, 1, '${'b'.repeat(64)}', 1, 1)
    `);
    await assert.rejects(migrateSqliteToMysql(fixture.options()), /1 enterprise\(s\) besides default/);
    assert.equal(await targetTableCount(pool), 0, 'the target stays untouched');
  });
  await withFixture('r4', async (fixture, pool) => {
    updateSource(fixture.path, 'ALTER TABLE proxy_accounts ADD COLUMN enterprise_id TEXT');
    await assert.rejects(migrateSqliteToMysql(fixture.options()), /partially applied multi-enterprise/);
    assert.equal(await targetTableCount(pool), 0, 'the target stays untouched');
  });
});

async function withFixture(
  shape: 'r4' | 'multi-enterprise',
  run: (fixture: Fixture, pool: Pool) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ghcp-proxy-upgrade-'));
  const path = join(directory, 'proxy.sqlite');
  createSource(path, shape);
  const url = testServerUrl();
  const database = `ghcp_upgrade_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool({ uri: url.toString(), connectionLimit: 1 });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  url.pathname = `/${database}`;
  const target = url.toString();
  const pool = createPool({ uri: target, connectionLimit: 2, timezone: 'Z', dateStrings: true });
  const options = (overrides: Partial<MigrationOptions> = {}) => ({ sqlitePath: path, mysqlUrl: target, env,
    ...overrides });
  try {
    await run({ path, options }, pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Creates and drops its own `ghcp_upgrade_test_*` databases, so it refuses non-loopback servers. */
function testServerUrl(): URL {
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Refusing a non-loopback MySQL server');
  url.pathname = '/';
  return url;
}

function createSource(path: string, shape: 'r4' | 'multi-enterprise'): void {
  const source = new Database(path);
  try {
    if (shape === 'r4') source.exec(R4_SCHEMA);
    else runMigrations(source, seed);
    insertSourceRows(source, shape);
  } finally {
    source.close();
  }
}

function insertSourceRows(source: Database.Database, shape: 'r4' | 'multi-enterprise'): void {
  const enterprise = shape === 'r4' ? [] : [DEFAULT_ENTERPRISE_ID];
  const enterpriseColumn = shape === 'r4' ? '' : ', enterprise_id';
  const enterpriseValue = shape === 'r4' ? '' : ', ?';
  source.prepare(`
    INSERT INTO proxy_accounts (
      identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
      copilot_oauth_updated_at, copilot_oauth_attempt_id, created_at, updated_at${enterpriseColumn}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${enterpriseValue})
  `).run(
    'Alice',
    'alice',
    'alice_octo',
    'sensitive-test-token',
    'valid',
    '2026-08-27T10:00:00.000Z',
    null,
    '2026-08-27T09:00:00.000Z',
    '2026-08-27T10:00:00.000Z',
    ...enterprise,
  );
  source.prepare(`
    INSERT INTO proxy_request_stats (
      id, identity, requested_at, path, success, input_tokens${enterpriseColumn}
    ) VALUES (?, ?, ?, ?, ?, ?${enterpriseValue})
  `).run('request-1', 'Alice', '2026-08-27T10:01:00.000Z', '/v1/models', 1, 42, ...enterprise);
}

function updateSource(path: string, sql: string): void {
  const source = new Database(path);
  try {
    source.exec(sql);
  } finally {
    source.close();
  }
}

function sourceCount(path: string, table: string): number {
  const source = new Database(path, { readonly: true });
  try {
    return (source.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    source.close();
  }
}

async function assertCopiedRows(pool: Pool): Promise<void> {
  const [accounts] = await pool.query<RowDataPacket[]>(`
    SELECT identity, copilot_oauth_token, enterprise_id
    FROM proxy_accounts
  `);
  assert.deepEqual(accounts.map((row) => ({ ...row })), [
    { identity: 'Alice', copilot_oauth_token: 'sensitive-test-token', enterprise_id: DEFAULT_ENTERPRISE_ID },
  ]);
  const [stats] = await pool.query<RowDataPacket[]>(`
    SELECT input_tokens, enterprise_id
    FROM proxy_request_stats
  `);
  assert.deepEqual(stats.map((row) => [Number(row.input_tokens), row.enterprise_id]), [[42, DEFAULT_ENTERPRISE_ID]]);
}

async function targetEnterprise(pool: Pool): Promise<RowDataPacket> {
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT *
    FROM proxy_enterprises
    ORDER BY id
  `);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function targetTableCount(pool: Pool): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
  `);
  return Number(rows[0].count);
}
