import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import { defaultEnterpriseSeed } from '../../src/proxy/src/db/enterpriseSeed.js';
import { runMigrations } from '../../src/proxy/src/db/migrations.js';
import { UserPoolStore } from '../../src/proxy/src/userPool/store.js';
import { accountName } from '../../src/proxy/src/userPool/names.js';
import { migrateSqlitePoolToMysql as migrate, mysqlPoolFromEnv, preflightSqlite, type MigrationOptions } from './migrate.js';
import { normalizePoolConfig, readPoolConfig, type PoolConfig } from '../../src/proxy/src/userPool/config.js';
import { MYSQL_CREDENTIAL_FENCE_DDL, SQLITE_CREDENTIAL_FENCE_DDL } from '../../src/proxy/src/db/mysqlSchema.js';
import { createSchema, referenceSchema, type SourceShape } from './sqlite-schema.js';

const poolConfig: PoolConfig = { enabled: true, accountDomain: 'fixture.invalid', idleTarget: 2, maxAccounts: 20,
  leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, retryAfterSeconds: 30,
  warmupModel: 'unused-offline', requestTimeoutMs: 120000 };
// The deployment environment: github.com with the baseline shortcode; the importer adds the pool domain.
const migrateSqlitePoolToMysql = (options: MigrationOptions) => migrate({ poolConfig, env: {}, ...options });
/** The `default` enterprise the Proxy (and the importer) derive from that environment. */
const enterpriseSeed = defaultEnterpriseSeed({ ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: poolConfig.accountDomain });

const now = Date.now();
const timestamp = new Date(now - 10000).toISOString();
const caller = `sha256:${'a'.repeat(64)}`;
const secondCaller = `sha256:${'b'.repeat(64)}`;
const lease = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondLease = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const syntheticToken = 'SYNTHETIC_ONLY_NeverUseThisToken_AbCdEf';
/** Creates the source schema as a Proxy of that shape left it, with its pool settings row. */
function createSource(db: Database.Database, shape: SourceShape): void {
  if (shape === 'multi-enterprise') {
    runMigrations(db, enterpriseSeed);
    new UserPoolStore(db, poolConfig);
    // The cap moved to proxy_enterprises; user_pool_settings.max_accounts keeps a stale value.
    db.exec('UPDATE user_pool_settings SET max_accounts=15');
    return;
  }
  createSchema(db, referenceSchema('single-enterprise'));
  db.prepare(`
    INSERT INTO user_pool_settings (id, idle_target, max_accounts, lease_seconds, account_domain)
    VALUES (1, ?, ?, ?, ?)
  `).run(poolConfig.idleTarget, poolConfig.maxAccounts, poolConfig.leaseSeconds, poolConfig.accountDomain);
}
function fixture(shape: SourceShape = 'multi-enterprise'): {
  path: string; change: (sql: string) => void; close: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'pool-migration-synthetic-'));
  const path = join(dir, 'backup.sqlite');
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  createSource(db, shape);
  // Multi-enterprise tables require enterprise_id on insert (guard triggers); r4 tables have no such column.
  const enterprise = shape === 'multi-enterprise' ? [DEFAULT_ENTERPRISE_ID] : [];
  const column = shape === 'multi-enterprise' ? ', enterprise_id' : '';
  const value = shape === 'multi-enterprise' ? ', ?' : '';
  db.prepare('UPDATE user_pool_settings SET paused=1, next_ordinal=3, version=7, owner=?, owner_until=?')
    .run(randomUUID(), now - 1000);
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    const identity = accountName(ordinal);
    db.prepare(`INSERT INTO proxy_accounts(identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
      copilot_oauth_updated_at, created_at, updated_at${column}) VALUES (?, ?, ?, ?, 'valid', ?, ?, ?${value})`)
      .run(identity, identity, `synthetic-${ordinal}`, syntheticToken + ordinal, timestamp, timestamp, timestamp,
        ...enterprise);
    db.prepare(`INSERT INTO user_pool_accounts(identity, ordinal, state, stage, attempt_id, oauth_attempt_id, task_id,
      sso_created_at, updated_at, cooldown_until, verified_at, generation, reauth_count, reauth_window_at${column})
      VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, 9, 2, ?${value})`)
      .run(identity, ordinal, ordinal === 1 ? 'cooling' : 'ready', randomUUID(), randomUUID(), randomUUID(),
        timestamp, now - 5000, ordinal === 1 ? now + 60000 : 0, now - 5000, now - 90000, ...enterprise);
  }
  // The runtime counts each reservation; these members were inserted directly.
  if (shape === 'multi-enterprise') db.exec('UPDATE proxy_enterprises SET inventory_count=3');
  db.prepare(`INSERT INTO user_pool_leases VALUES (?, ?, ?, 'active', ?, ?, ?)`)
    .run(caller, accountName(0), lease, now - 4000, now - 3000, now + 172800000);
  db.prepare(`INSERT INTO user_pool_leases VALUES (?, ?, ?, 'provisional', ?, NULL, ?)`)
    .run(secondCaller, accountName(1), secondLease, now - 4000, now + 300000);
  db.prepare('INSERT INTO user_pool_catalog_cooldowns VALUES (?, ?, ?)').run(`sha256:${'c'.repeat(64)}`, accountName(2), now + 60000);
  db.prepare(`INSERT INTO proxy_request_stats(id, identity, requested_at, path, success, input_tokens,
    cache_input_tokens, caller_id, lease_id${column}) VALUES (?, ?, ?, '/chat/completions', 1, 123, 45, ?, ?${value})`)
    .run('synthetic-stat', accountName(0), timestamp, caller, lease, ...enterprise);
  db.prepare(`INSERT INTO user_pool_events(id, at, action, identity, caller_id, lease_id, detail${column})
    VALUES (17, ?, ?, ?, ?, ?, ?${value})`)
    .run(now - 1000, 'synthetic_event', accountName(0), caller, lease, 'synthetic-detail', ...enterprise);
  db.close();
  return { path, change(sql) { const writable = new Database(path); try { writable.pragma('foreign_keys = OFF'); writable.exec(sql); } finally { writable.close(); } }, close() { rmSync(dir, { recursive: true, force: true }); } };
}
function sourceHash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

test('SQLite preflight preserves backup bytes and reports only safe counts; dry-run never touches a target', async () => {
  const f = fixture();
  try {
    const before = sourceHash(f.path);
    const report = preflightSqlite(f.path);
    assert.equal(report.counts.proxy_accounts, 3);
    assert.equal(report.counts.proxy_request_stats, 1);
    assert.equal(report.counts.user_pool_leases, 2);
    assert.equal(report.counts.user_pool_events, 1);
    assert.equal(report.counts.proxy_enterprises, 1);
    const forbidden = new Proxy({}, { get() { throw new Error('Target must not be used during dry-run'); } }) as Pool;
    assert.deepEqual(await migrateSqlitePoolToMysql({ sqlitePath: f.path, dryRun: true, pool: forbidden }), report);
    assert.equal(sourceHash(f.path), before);
    assert.ok(!JSON.stringify(report).includes(syntheticToken));
    assert.ok(!JSON.stringify(report).includes(caller));
  } finally { f.close(); }
});

const unsafeCases: [string, string, RegExp][] = [
  ['unpaused pool', 'UPDATE user_pool_settings SET paused=0', /already be paused/],
  ['live owner', `UPDATE user_pool_settings SET owner_until=${now + 3600000}`, /live scheduler owner/],
  ['expired inference hold', `INSERT INTO user_pool_holds VALUES ('expired', '${lease}', 1, 1, 9)`, /undrained holds/],
  ['expired catalog hold', `INSERT INTO user_pool_catalog_holds VALUES ('expired', 'catalog-lease', '${caller}', '${accountName(0)}', 1, 2, 2, 9)`, /undrained holds/],
  ['expired initialization', `INSERT INTO proxy_identity_initializations
    VALUES ('synthetic', 'claim', '${timestamp}', '${timestamp}', '${timestamp}', 'default')`, /initialization claims/],
  ['provisioning', "UPDATE user_pool_accounts SET state='provisioning'", /provisioning/],
  ['refreshing OAuth', "UPDATE proxy_accounts SET copilot_oauth_status='refreshing'", /refreshing/],
  ['unresolved callback', "UPDATE proxy_accounts SET copilot_oauth_attempt_id='nonce'", /unresolved OAuth/],
  ['failed creation intent', "UPDATE user_pool_accounts SET state='failed', stage='sso-creating'", /uncertain external/],
  ['disabled seat intent', "UPDATE user_pool_accounts SET state='disabled', stage='seat-assigning'", /uncertain external/],
  ['failed SCIM intent', "UPDATE user_pool_accounts SET state='failed', stage='scim-syncing'", /uncertain external/],
  ['failed OAuth dispatch', "UPDATE user_pool_accounts SET state='failed', stage='oauth-dispatch'", /uncertain external/],
  ['disabled OAuth wait', "UPDATE user_pool_accounts SET state='disabled', stage='oauth-wait'", /uncertain external/],
  ['unresolved Login evidence', "UPDATE user_pool_accounts SET state='failed', stage='warmup'", /Login task evidence/],
  ['cancelled unconfirmed', "UPDATE user_pool_accounts SET last_error='oauth_task_cancelled_unconfirmed'", /uncertain external/],
  ['negative generation', 'UPDATE user_pool_accounts SET generation=-1', /field validation/],
  ['fractional cooldown', 'UPDATE user_pool_accounts SET cooldown_until=1.5', /field validation/],
  ['unsafe epoch integer', 'UPDATE user_pool_accounts SET updated_at=9007199254740992', /field validation/],
  ['non-ISO account time', "UPDATE proxy_accounts SET created_at='2026-02-30T00:00:00.000Z'", /ISO timestamp/],
  ['non-ISO stat time', "UPDATE proxy_request_stats SET requested_at='2026-01-01'", /ISO timestamp/],
  ['invalid next ordinal', 'UPDATE user_pool_settings SET next_ordinal=1', /ordinal relationship/],
  ['broken FK', "DELETE FROM proxy_accounts WHERE identity='" + accountName(0) + "'", /foreign key/],
  ['orphan stat', "UPDATE proxy_request_stats SET identity='nonexistent'", /stats relationships/],
  ['invalid caller', `UPDATE user_pool_leases SET caller_id='not-a-caller' WHERE caller_id='${caller}'`, /caller identity/],
  ['bad stat flag', 'UPDATE proxy_request_stats SET success=2', /stats relationships/],
  ['binary token', "UPDATE proxy_accounts SET copilot_oauth_token=X'0102'", /field validation/],
  ['missing pool field', 'ALTER TABLE user_pool_accounts DROP COLUMN reauth_count', /Unsupported source schema/],
  ['extra credential field', 'ALTER TABLE proxy_accounts ADD COLUMN custom_refresh_token TEXT', /Unsupported source schema/],
  ['extra recovery field', 'ALTER TABLE user_pool_accounts ADD COLUMN reconciliation_required INTEGER', /Unsupported source schema/],
  ['extra task table', 'CREATE TABLE pending_external_tasks(id TEXT)', /Unsupported source schema/],
  ['missing credential fence', 'DROP TRIGGER user_pool_credential_fence', /credential fence/],
  ['no-op credential fence', 'DROP TRIGGER user_pool_credential_fence; CREATE TRIGGER user_pool_credential_fence AFTER UPDATE ON proxy_accounts BEGIN SELECT 1; END', /credential fence/],
  ['weakened generation fence', `DROP TRIGGER user_pool_credential_fence; ${SQLITE_CREDENTIAL_FENCE_DDL.replace('generation + 1', 'generation + 0')}`, /credential fence/],
  ['omitted credential fence field', `DROP TRIGGER user_pool_credential_fence; ${SQLITE_CREDENTIAL_FENCE_DDL.replace(' OR OLD.gh_login IS NOT NEW.gh_login', '')}`, /credential fence/],
  ['MySQL INT overflow', 'UPDATE user_pool_accounts SET attempts=2147483648', /field validation/],
  ['oversized task identifier', "UPDATE user_pool_accounts SET task_id='" + 'x'.repeat(256) + "'", /field validation/],
  ['WAL-mode backup', 'PRAGMA journal_mode=WAL', /rollback-journal SQLite backup/],
  ['second enterprise', `INSERT INTO proxy_enterprises
    VALUES ('second', 'active', 5, 0, 1, '${'b'.repeat(64)}', 1, 1)`, /enterprises other than default/],
  ['enterprise inventory drift', 'UPDATE proxy_enterprises SET inventory_count=2', /inventory counter/],
  ['invalid enterprise fingerprint', "UPDATE proxy_enterprises SET profile_fingerprint='x'", /enterprise is invalid/],
  ['stat outside default', "UPDATE proxy_request_stats SET enterprise_id='second'", /outside the default/],
  ['missing enterprise guard', 'DROP TRIGGER proxy_accounts_enterprise_required', /enterprise guard/],
  ['weakened enterprise guard', `DROP TRIGGER user_pool_accounts_enterprise_matches;
    CREATE TRIGGER user_pool_accounts_enterprise_matches BEFORE INSERT ON user_pool_accounts BEGIN SELECT 1; END`,
  /enterprise guard/],
  ['partial enterprise columns', `DROP INDEX idx_user_pool_events_enterprise;
    ALTER TABLE user_pool_events DROP COLUMN enterprise_id`, /Unsupported source schema in user_pool_events/],
];
for (const [name, sql, expected] of unsafeCases) test(`SQLite rejects ${name} without modifying source`, () => {
  const f = fixture();
  try {
    f.change(sql);
    const before = sourceHash(f.path);
    assert.throws(() => preflightSqlite(f.path), expected);
    assert.equal(sourceHash(f.path), before);
  } finally { f.close(); }
});

const singleEnterpriseCases: [string, string, RegExp][] = [
  ['enterprise column', 'ALTER TABLE proxy_accounts ADD COLUMN enterprise_id TEXT',
    /Unsupported source schema in proxy_accounts/],
  ['enterprise guard', `CREATE TRIGGER proxy_accounts_enterprise_required BEFORE INSERT ON proxy_accounts
    BEGIN SELECT 1; END`, /Unsupported source schema objects/],
];
for (const [name, sql, expected] of singleEnterpriseCases) test(`single-enterprise source rejects ${name}`, () => {
  const f = fixture('single-enterprise');
  try {
    f.change(sql);
    const before = sourceHash(f.path);
    assert.throws(() => preflightSqlite(f.path), expected);
    assert.equal(sourceHash(f.path), before);
  } finally { f.close(); }
});

test('single-enterprise (r4) sources pass preflight with the same counts and no enterprise rows', () => {
  const f = fixture('single-enterprise');
  try {
    const report = preflightSqlite(f.path);
    assert.deepEqual([report.counts.proxy_accounts, report.counts.user_pool_accounts, report.counts.proxy_enterprises],
      [3, 3, 0]);
  } finally { f.close(); }
});

test('a source whose enterprise identity differs from the deployment is rejected before target access', async () => {
  const f = fixture();
  try {
    let opened = 0;
    const getConnection = async () => {
      opened++;
      throw new Error('unexpected synthetic target access');
    };
    const pool = { getConnection } as unknown as Pool;
    const options = { sqlitePath: f.path, confirmOfflineSource: true, confirmEmptyTarget: true, pool };
    await assert.rejects(migrateSqlitePoolToMysql({ ...options, env: { ENTERPRISE_SHORTCODE: 'other' } }),
      /enterprise identity/);
    await assert.rejects(migrateSqlitePoolToMysql({ ...options, env: { GITHUB_BASE_URL: 'not a url' } }),
      /enterprise configuration is invalid/);
    assert.equal(opened, 0);
  } finally { f.close(); }
});

test('standalone-backup check refuses sidecars without changing either file', () => {
  const f = fixture();
  try {
    const before = sourceHash(f.path);
    const sidecar = f.path + '-wal';
    writeFileSync(sidecar, 'synthetic-wal-sentinel');
    assert.throws(() => preflightSqlite(f.path), /without SQLite sidecars/);
    assert.equal(readFileSync(sidecar, 'utf8'), 'synthetic-wal-sentinel');
    assert.equal(sourceHash(f.path), before);
  } finally { f.close(); }
});

test('nullable empty text remains supported without weakening identifier validation', () => {
  const f = fixture();
  try {
    f.change("UPDATE proxy_request_stats SET model='', failure_reason=''; UPDATE user_pool_events SET detail=''");
    assert.equal(preflightSqlite(f.path).counts.proxy_request_stats, 1);
  } finally { f.close(); }
});

test('settled failed reauthorization and historical expired leases are preserved without renewal', () => {
  const f = fixture();
  try {
    f.change(`UPDATE user_pool_accounts SET state='failed', stage='synced', task_id=NULL, oauth_attempt_id=NULL,
      last_error='upstream_401', retry_at=${now + 10000}, verified_at=NULL;
      UPDATE proxy_accounts SET copilot_oauth_status='expired';
      UPDATE user_pool_leases SET expires_at=${now - 500}`);
    assert.equal(preflightSqlite(f.path).counts.user_pool_leases, 2);
  } finally { f.close(); }
});

test('settled recovery preserves still-bound live leases and full-length Login identifiers', () => {
  const f = fixture();
  try {
    f.change(`UPDATE user_pool_accounts SET task_id='${'x'.repeat(255)}'`);
    assert.equal(preflightSqlite(f.path).counts.user_pool_leases, 2);
    f.change(`UPDATE user_pool_accounts SET state='failed', stage='synced', task_id=NULL, oauth_attempt_id=NULL,
      verified_at=NULL, last_error='upstream_unauthorized'; UPDATE proxy_accounts SET copilot_oauth_status='expired'`);
    assert.equal(preflightSqlite(f.path).counts.user_pool_leases, 2);
  } finally { f.close(); }
});

test('write configuration is required, source-domain matched, and rejected before any target access', async () => {
  const f = fixture();
  try {
    let opened = 0;
    const pool = { getConnection: async () => { opened++; throw new Error('unexpected synthetic target access'); } } as unknown as Pool;
    for (const options of [
      { poolConfig: undefined, env: {} },
      { poolConfig: undefined, env: { POOL_ACCOUNT_EMAIL_DOMAIN: 'different.invalid', POOL_WARMUP_MODEL: 'unused' } },
      { poolConfig: { ...poolConfig, accountDomain: 'different.invalid' } },
      { poolConfig: { ...poolConfig, provisionalSeconds: NaN } },
      ...['prewarmConcurrency', 'loginMaxPending'].flatMap(key => [NaN, 0, -1, 1.5, Infinity, key === 'prewarmConcurrency' ? 21 : 101]
        .map(value => ({ poolConfig: { ...poolConfig, [key]: value } }))),
    ]) await assert.rejects(migrate({ sqlitePath: f.path, confirmOfflineSource: true, confirmEmptyTarget: true, pool, ...options }), /configuration/);
    assert.equal(opened, 0);
  } finally { f.close(); }
});

test('import requires both confirmations before opening source or target; errors redact paths and credentials', async () => {
  for (const confirmations of [{}, { confirmOfflineSource: true }, { confirmEmptyTarget: true }]) {
    await assert.rejects(migrateSqlitePoolToMysql({ sqlitePath: syntheticToken, ...confirmations }), /requires explicit/);
  }
  await assert.rejects(migrateSqlitePoolToMysql({ sqlitePath: syntheticToken, dryRun: true }), (error: Error) => !error.message.includes(syntheticToken));
  const f = fixture();
  try {
    const failing = { getConnection: async () => { throw new Error(`SQL with ${syntheticToken}`); } } as unknown as Pool;
    await assert.rejects(migrateSqlitePoolToMysql({ sqlitePath: f.path, confirmOfflineSource: true, confirmEmptyTarget: true, pool: failing }),
      (error: Error) => error.message.includes('suppressed') && !error.message.includes(syntheticToken));
    writeFileSync(f.path, 'synthetic corrupt SQLite ' + syntheticToken);
    assert.throws(() => preflightSqlite(f.path), (error: Error) => !error.message.includes(syntheticToken));
  } finally { f.close(); }
});

test('nonempty target fails under the migration lock, releases it, and redacts driver details', async () => {
  const f = fixture();
  const statements: string[] = [];
  let released = false;
  let closed = false;
  const connection = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('VERSION()')) return [[{ version: '8.0.40' }]];
      if (sql.includes('information_schema.tables')) return [[{ name: 'proxy_accounts', engine: 'InnoDB' }]];
      if (sql.includes('information_schema.columns')) {
        const db = new Database(f.path, { readonly: true });
        try { return [(db.pragma('table_info(proxy_accounts)') as { name: string }[]).map(({ name }) => ({ name, extra: '' }))]; }
        finally { db.close(); }
      }
      if (sql === 'SELECT * FROM proxy_accounts') return [[{ identity: 'synthetic-existing' }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      throw new Error('Unexpected synthetic SQL');
    },
    release() { released = true; },
  };
  const pool = { getConnection: async () => connection, end: async () => { closed = true; } } as unknown as Pool;
  try {
    await assert.rejects(migrateSqlitePoolToMysql({ sqlitePath: f.path, pool, confirmOfflineSource: true, confirmEmptyTarget: true }), /Target is not empty/);
    assert.ok(statements[0].includes('GET_LOCK'));
    assert.ok(statements.at(-1)!.includes('RELEASE_LOCK'));
    assert.ok(!statements.some((sql) => /CREATE|INSERT|UPDATE|DELETE/.test(sql)));
    assert.equal(released, true);
    assert.equal(closed, false, 'The caller owns an injected pool');
  } finally { f.close(); }
});

test('nonempty partial target schema is rejected before schema introspection or migrations', async () => {
  const f = fixture();
  const statements: string[] = [];
  const pool = { getConnection: async () => ({
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('VERSION()')) return [[{ version: '8.4.0' }]];
      if (sql.includes('information_schema.tables')) return [[{ name: 'proxy_request_stats', engine: 'InnoDB' }]];
      if (sql === 'SELECT * FROM proxy_request_stats') return [[{ legacy_secret: syntheticToken }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      throw new Error('unexpected synthetic SQL');
    }, release() {},
  }) } as unknown as Pool;
  try {
    await assert.rejects(migrateSqlitePoolToMysql({ sqlitePath: f.path, pool, confirmOfflineSource: true, confirmEmptyTarget: true }), /Target is not empty/);
    assert.ok(!statements.some((sql) => /CREATE|ALTER|INSERT|information_schema.columns/.test(sql)));
  } finally { f.close(); }
});

test('uncertain advisory-lock response destroys rather than recycles its connection', async () => {
  const f = fixture();
  let destroyed = false;
  let released = false;
  const pool = { getConnection: async () => ({
    query: async () => { throw new Error(syntheticToken); },
    destroy() { destroyed = true; }, release() { released = true; },
  }) } as unknown as Pool;
  try {
    await assert.rejects(migrateSqlitePoolToMysql({ sqlitePath: f.path, pool, confirmOfflineSource: true, confirmEmptyTarget: true }),
      (error: Error) => !error.message.includes(syntheticToken));
    assert.equal(destroyed, true);
    assert.equal(released, false);
  } finally { f.close(); }
});

test('MySQL URL stays out of CLI, URL options cannot override security, and nonlocal TLS must verify', async () => {
  for (const env of [
    { MYSQL_URL: `not-a-url-${syntheticToken}` },
    { MYSQL_URL: 'mysql://synthetic:synthetic@example.invalid/test', MYSQL_SSL_MODE: 'disabled' },
    { MYSQL_URL: 'mysql://synthetic:synthetic@example.invalid/test', MYSQL_SSL_MODE: 'required' },
    { MYSQL_URL: 'mysql://synthetic:synthetic@example.invalid/test', MYSQL_SSL_MODE: 'verify-ca' },
    { MYSQL_URL: 'mysql://synthetic:synthetic@localhost/test?ssl=false' },
    { MYSQL_URL: 'mysql://synthetic:synthetic@localhost/test', MYSQL_CONNECTION_LIMIT: '1' },
  ]) assert.throws(() => mysqlPoolFromEnv(env), (error: Error) => !error.message.includes(syntheticToken));
  // createPool is lazy: constructing and closing this local pool performs no network request.
  const pool = mysqlPoolFromEnv({ MYSQL_URL: 'mysql://synthetic:synthetic@127.0.0.1:1/test', MYSQL_SSL_MODE: 'disabled' });
  await pool.end();
});

// Opt-in only; never MYSQL_URL. Require loopback and an explicitly dedicated test URL.
const integration = process.env.RUN_USER_POOL_MIGRATION_MYSQL_TESTS === '1';
test('isolated MySQL 8 copy, content verification, rollback and concurrent-import exclusion', { skip: !integration }, async (t) => {
  const uri = process.env.USER_POOL_MIGRATION_TEST_MYSQL_URL;
  assert.ok(uri, 'Set USER_POOL_MIGRATION_TEST_MYSQL_URL for an isolated local test server.');
  const url = new URL(uri);
  assert.ok(url.protocol === 'mysql:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/user_pool_migration_test' && !url.search && !url.hash, 'Integration URL must be loopback with database user_pool_migration_test; remote tests are forbidden.');
  const admin = createPool({ uri, dateStrings: true, timezone: 'Z' });
  const database = `user_pool_migration_test_${randomUUID().replaceAll('-', '')}`;
  const f = fixture();
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    url.pathname = '/' + database;
    pool = createPool({ uri: url.toString(), connectionLimit: 6, dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
    const options = { sqlitePath: f.path, confirmOfflineSource: true, confirmEmptyTarget: true, pool };
    await migrateSqlitePoolToMysql({ ...options, dryRun: true });
    const [empty] = await pool.query<RowDataPacket[]>('SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()');
    assert.equal(empty.length, 0);
    await t.test('two importers cannot both pass the empty check', async () => {
      const outcomes = await Promise.allSettled([migrateSqlitePoolToMysql(options), migrateSqlitePoolToMysql(options)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    });
    const [settings] = await pool.query<RowDataPacket[]>('SELECT * FROM user_pool_settings');
    assert.equal(Number(settings[0].paused), 1);
    assert.equal(settings[0].owner, null);
    assert.equal(Number(settings[0].owner_until), 0);
    assert.equal(Number(settings[0].version), 7);
    assert.equal(Number(settings[0].next_ordinal), 3);
    // Multi-enterprise fingerprint: the account domain is covered by the enterprise identity instead.
    const { idleTarget: _idle, maxAccounts: _max, leaseSeconds: _lease, enabled: _enabled, callerDomain: _legacy,
      accountDomain: _domain, ...invariants } = normalizePoolConfig(poolConfig);
    assert.equal(settings[0].config_fingerprint, createHash('sha256')
      .update(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b)))).digest('hex'));
    assert.equal(Number(settings[0].max_accounts), 15, 'the retired settings cap is copied as stored');
    const [enterprises] = await pool.query<RowDataPacket[]>('SELECT * FROM proxy_enterprises');
    assert.deepEqual(enterprises.map((row) => [row.id, row.state, row.profile_fingerprint,
      Number(row.max_accounts), Number(row.inventory_count)]),
    [[DEFAULT_ENTERPRISE_ID, 'active', enterpriseSeed.fingerprint, poolConfig.maxAccounts, 3]]);
    await assertDefaultEnterprise(pool);
    const { MysqlPoolStore: RuntimeStore } = await import('../../src/proxy/src/userPool/mysqlStore.js');
    const runtimeConfig = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql',
      POOL_ACCOUNT_EMAIL_DOMAIN: poolConfig.accountDomain, POOL_WARMUP_MODEL: poolConfig.warmupModel });
    assert.equal(runtimeConfig.prewarmConcurrency, 5);
    assert.equal(runtimeConfig.loginMaxPending, 5);
    await new RuntimeStore(pool, runtimeConfig).initialize(); // Real parser cutover from omitted optional defaults.
    const [accounts] = await pool.query<RowDataPacket[]>('SELECT * FROM proxy_accounts ORDER BY identity');
    assert.equal(accounts[0].copilot_oauth_token, syntheticToken + '0');
    assert.equal(accounts[0].created_at, timestamp.slice(0, 23).replace('T', ' '));
    const [leases] = await pool.query<RowDataPacket[]>('SELECT * FROM user_pool_leases ORDER BY caller_id');
    assert.equal(Number(leases[0].expires_at), now + 172800000);
    assert.equal(Number(leases[1].expires_at), now + 300000);
    const [inventory] = await pool.query<RowDataPacket[]>('SELECT * FROM user_pool_accounts ORDER BY ordinal');
    assert.equal(Number(inventory[0].generation), 9);
    assert.equal(Number(inventory[0].reauth_count), 2);
    assert.equal(inventory[0].sso_created_at, timestamp);
    const [stats] = await pool.query<RowDataPacket[]>('SELECT * FROM proxy_request_stats');
    assert.equal(stats[0].caller_id, caller);
    assert.equal(stats[0].lease_id, lease);
    // Remove only this test's generated schema and reinitialize the provider in another generated empty DB.
    await pool.end(); pool = undefined;
    await admin.query(`DROP DATABASE ${database}`);
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    pool = createPool({ uri: url.toString(), connectionLimit: 6, dateStrings: true, timezone: 'Z' });
    const { runMysqlMigrations } = await import('../../src/proxy/src/db/mysqlMigrations.js');
    await runMysqlMigrations(pool, enterpriseSeed);
    const { MysqlPoolStore } = await import('../../src/proxy/src/userPool/mysqlStore.js');
    await new MysqlPoolStore(pool, poolConfig).initialize();
    const schemaCases = [
      { name: 'no-op credential trigger', change: ['DROP TRIGGER user_pool_credential_fence',
        'CREATE TRIGGER user_pool_credential_fence AFTER UPDATE ON proxy_accounts FOR EACH ROW SET @synthetic_noop=1'],
        restore: ['DROP TRIGGER user_pool_credential_fence', MYSQL_CREDENTIAL_FENCE_DDL] },
      { name: 'missing credential trigger', change: ['DROP TRIGGER user_pool_credential_fence'], restore: [MYSQL_CREDENTIAL_FENCE_DDL] },
      { name: 'weakened trigger body', change: ['DROP TRIGGER user_pool_credential_fence', MYSQL_CREDENTIAL_FENCE_DDL.replace('generation + 1', 'generation + 0')],
        restore: ['DROP TRIGGER user_pool_credential_fence', MYSQL_CREDENTIAL_FENCE_DDL] },
      { name: 'missing ordinal uniqueness', change: ['ALTER TABLE user_pool_accounts DROP INDEX ordinal'],
        restore: ['ALTER TABLE user_pool_accounts ADD UNIQUE KEY ordinal (ordinal)'] },
      { name: 'missing member uniqueness', change: ['ALTER TABLE user_pool_leases ADD INDEX synthetic_member (member_identity)', 'ALTER TABLE user_pool_leases DROP INDEX member_identity'],
        restore: ['ALTER TABLE user_pool_leases ADD UNIQUE KEY member_identity (member_identity)', 'ALTER TABLE user_pool_leases DROP INDEX synthetic_member'] },
      { name: 'missing catalog lease uniqueness', change: ['ALTER TABLE user_pool_catalog_holds DROP INDEX lease_id'],
        restore: ['ALTER TABLE user_pool_catalog_holds ADD UNIQUE KEY lease_id (lease_id)'] },
      { name: 'missing foreign key', change: ['ALTER TABLE user_pool_holds DROP FOREIGN KEY fk_user_pool_hold_lease'],
        restore: ['ALTER TABLE user_pool_holds ADD CONSTRAINT fk_user_pool_hold_lease FOREIGN KEY (lease_id) REFERENCES user_pool_leases(lease_id) ON DELETE CASCADE'] },
      { name: 'wrong foreign key delete action', change: ['ALTER TABLE user_pool_holds DROP FOREIGN KEY fk_user_pool_hold_lease',
        'ALTER TABLE user_pool_holds ADD CONSTRAINT fk_user_pool_hold_lease FOREIGN KEY (lease_id) REFERENCES user_pool_leases(lease_id) ON DELETE RESTRICT'],
        restore: ['ALTER TABLE user_pool_holds DROP FOREIGN KEY fk_user_pool_hold_lease',
          'ALTER TABLE user_pool_holds ADD CONSTRAINT fk_user_pool_hold_lease FOREIGN KEY (lease_id) REFERENCES user_pool_leases(lease_id) ON DELETE CASCADE'] },
      { name: 'wrong generation type', change: ['ALTER TABLE user_pool_accounts MODIFY generation INT NOT NULL DEFAULT 0'],
        restore: ['ALTER TABLE user_pool_accounts MODIFY generation BIGINT NOT NULL DEFAULT 0'] },
      { name: 'wrong caller collation', change: ['ALTER TABLE user_pool_leases MODIFY caller_id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL'],
        restore: ['ALTER TABLE user_pool_leases MODIFY caller_id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'] },
      { name: 'wrong token collation after migration marker', change: ['ALTER TABLE proxy_accounts MODIFY copilot_oauth_token TEXT COLLATE utf8mb4_general_ci'],
        restore: ['ALTER TABLE proxy_accounts MODIFY copilot_oauth_token TEXT COLLATE utf8mb4_bin'] },
      { name: 'wrong token type', change: ['ALTER TABLE proxy_accounts MODIFY copilot_oauth_token VARCHAR(255) COLLATE utf8mb4_bin'],
        restore: ['ALTER TABLE proxy_accounts MODIFY copilot_oauth_token TEXT COLLATE utf8mb4_bin'] },
    ];
    for (const { name, change, restore } of schemaCases) await t.test(`startup and importer reject ${name} without repair`, async () => {
      for (const sql of change) await pool!.query(sql);
      const [before] = await pool!.query<RowDataPacket[]>('SELECT TRIGGER_NAME, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
      try {
        await assert.rejects(new MysqlPoolStore(pool!, poolConfig).initialize(), /schema|credential fence/);
        await assert.rejects(migrateSqlitePoolToMysql({ ...options, pool }), /Target schema|credential fence/);
        const [after] = await pool!.query<RowDataPacket[]>('SELECT TRIGGER_NAME, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
        assert.deepEqual(after, before);
        const [counts] = await pool!.query<RowDataPacket[]>('SELECT COUNT(*) n FROM proxy_accounts');
        assert.equal(Number(counts[0].n), 0);
      } finally { for (const sql of restore) await pool!.query(sql); }
      await new MysqlPoolStore(pool!, poolConfig).initialize();
    });
    await t.test('unused target without settings still rejects altered schema before seeding', async () => {
      await pool!.query('DELETE FROM user_pool_settings');
      await pool!.query('ALTER TABLE user_pool_accounts MODIFY generation INT NOT NULL DEFAULT 0');
      try {
        await assert.rejects(migrateSqlitePoolToMysql({ ...options, pool }), /Target schema/);
        await assert.rejects(new MysqlPoolStore(pool!, poolConfig).initialize(), /schema/);
        const [settings] = await pool!.query<RowDataPacket[]>('SELECT * FROM user_pool_settings');
        assert.equal(settings.length, 0);
      } finally { await pool!.query('ALTER TABLE user_pool_accounts MODIFY generation BIGINT NOT NULL DEFAULT 0'); }
      await new MysqlPoolStore(pool!, poolConfig).initialize();
    });
    await t.test('known historical token CI migration remains supported, but not altered types', async () => {
      await pool!.query("DELETE FROM schema_migrations WHERE id='2026-08-27-proxy-token-binary-collation'");
      await pool!.query('ALTER TABLE proxy_accounts MODIFY copilot_oauth_token VARCHAR(255) COLLATE utf8mb4_general_ci');
      await assert.rejects(runMysqlMigrations(pool!, enterpriseSeed), /schema/);
      await pool!.query('ALTER TABLE proxy_accounts MODIFY copilot_oauth_token TEXT COLLATE utf8mb4_general_ci');
      await runMysqlMigrations(pool!, enterpriseSeed);
      await new MysqlPoolStore(pool!, poolConfig).initialize();
    });
    // Intercept only synthetic INSERT parameters to exercise read-back mismatch and rollback.
    // No target trigger/schema change is used: unknown target triggers must be refused.
    const realPool = pool;
    const corruptingPool = new Proxy(realPool, {
      get(target, key) {
        if (key === 'getConnection') return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, { get(c, prop) {
            if (prop === 'query') return (sql: string, values?: unknown[]) => c.query(sql,
              sql.startsWith('INSERT INTO proxy_accounts') ? values?.map((value) =>
                typeof value === 'string' && value.startsWith(syntheticToken) ? 'SYNTHETIC_CORRUPTION' : value) : values);
            const value = Reflect.get(c, prop); return typeof value === 'function' ? value.bind(c) : value;
          } });
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await t.test('internal token mismatch rolls back all imported DML without printing tokens', async () => {
      await assert.rejects(migrateSqlitePoolToMysql({ ...options, pool: corruptingPool }), /content verification failed/);
      const [counts] = await pool!.query<RowDataPacket[]>('SELECT (SELECT COUNT(*) FROM proxy_accounts) AS accounts, (SELECT COUNT(*) FROM user_pool_events) AS events');
      assert.equal(Number(counts[0].accounts), 0);
      assert.equal(Number(counts[0].events), 0);
      const [seed] = await pool!.query<RowDataPacket[]>('SELECT version, next_ordinal FROM user_pool_settings');
      assert.equal(Number(seed[0].version), 1);
      assert.equal(Number(seed[0].next_ordinal), 0);
    });
    await t.test('lost commit response is not retried or represented as rolled back', async () => {
      let commits = 0;
      let rollbacks = 0;
      let connections = 0;
      const uncertainPool = new Proxy(realPool, { get(target, key) {
        if (key === 'getConnection') return async () => {
          const connection = await target.getConnection();
          if (++connections !== 1) return connection; // Only the import/lock connection loses COMMIT's response.
          return new Proxy(connection, { get(c, prop) {
            if (prop === 'commit') return async () => {
              commits++; await c.commit(); throw new Error('SYNTHETIC_LOST_COMMIT_RESPONSE');
            };
            if (prop === 'rollback') return async () => { rollbacks++; await c.rollback(); };
            const value = Reflect.get(c, prop); return typeof value === 'function' ? value.bind(c) : value;
          } });
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(migrateSqlitePoolToMysql({ ...options, pool: uncertainPool }), /commit_outcome_unknown/);
      assert.equal(commits, 1);
      assert.equal(rollbacks, 0);
      const [committed] = await realPool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM proxy_accounts');
      assert.equal(Number(committed[0].n), 3);
    });
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
    f.close();
  }
});

test('isolated MySQL 8 import of a single-enterprise (r4) source assigns every row to default', {
  skip: !integration,
}, async () => {
  await withIsolatedDatabase(async (pool) => {
    const f = fixture('single-enterprise');
    try {
      f.change('UPDATE user_pool_settings SET max_accounts=25');
      await migrateSqlitePoolToMysql({ sqlitePath: f.path, confirmOfflineSource: true, confirmEmptyTarget: true,
        pool });
      const [enterprises] = await pool.query<RowDataPacket[]>('SELECT * FROM proxy_enterprises');
      assert.deepEqual(enterprises.map((row) => [row.id, row.profile_fingerprint, Number(row.max_accounts),
        Number(row.inventory_count)]), [[DEFAULT_ENTERPRISE_ID, enterpriseSeed.fingerprint, 25, 3]]);
      await assertDefaultEnterprise(pool);
      // The Proxy starts on the imported target: same identity, same pool configuration.
      const { MysqlStorage } = await import('../../src/proxy/src/db/mysqlStorage.js');
      const storage = new MysqlStorage(pool, 2, true, [enterpriseSeed]);
      await storage.initialize();
      await (await storage.userPool(poolConfig)).settings();
    } finally { f.close(); }
  });
});

/** Every imported row belongs to `default`; only global events may have no enterprise. */
async function assertDefaultEnterprise(pool: Pool): Promise<void> {
  for (const table of ['proxy_accounts', 'proxy_request_stats', 'user_pool_accounts', 'user_pool_events']) {
    const [rows] = await pool.query<RowDataPacket[]>(`
      SELECT DISTINCT enterprise_id
      FROM ${table}
    `);
    assert.deepEqual(rows.map((row) => row.enterprise_id), [DEFAULT_ENTERPRISE_ID], table);
  }
}

async function withIsolatedDatabase(run: (pool: Pool) => Promise<void>): Promise<void> {
  const uri = process.env.USER_POOL_MIGRATION_TEST_MYSQL_URL;
  assert.ok(uri, 'Set USER_POOL_MIGRATION_TEST_MYSQL_URL for an isolated local test server.');
  const url = new URL(uri);
  assert.ok(url.protocol === 'mysql:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/user_pool_migration_test' && !url.search && !url.hash,
  'Integration URL must be loopback with database user_pool_migration_test; remote tests are forbidden.');
  const admin = createPool({ uri, dateStrings: true, timezone: 'Z' });
  const database = `user_pool_migration_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  url.pathname = '/' + database;
  const pool = createPool({ uri: url.toString(), connectionLimit: 6, dateStrings: true, timezone: 'Z',
    supportBigNumbers: true, bigNumberStrings: true });
  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
}
