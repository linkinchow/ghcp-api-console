import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_ENTERPRISE_ID, runSqliteMigrations, type EnterpriseId } from '@ghcp/shared';
import { readPoolConfig } from '../userPool/config.js';
import { accountName } from '../userPool/names.js';
import { UserPoolStore } from '../userPool/store.js';
import { baseEnterpriseSteps, poolEnterpriseSteps } from './enterpriseMigrations.js';
import { ENTERPRISE_MIGRATION_IDS } from './enterpriseMigrationIds.js';
import { defaultEnterpriseSeed, type EnterpriseSeed } from './enterpriseSeed.js';
import { runMigrations } from './migrations.js';
import { SqliteStorage } from './sqliteStorage.js';

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;

const SEED: EnterpriseSeed = { id: DEFAULT_ENTERPRISE_ID, fingerprint: 'a'.repeat(64), maxAccounts: 50 };
const CHANGED_SEED: EnterpriseSeed = { ...SEED, fingerprint: 'b'.repeat(64) };
const ENTERPRISES = [DEFAULT_ENTERPRISE_ID];
const POOL_OPTIONS = readPoolConfig({
  ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test',
  POOL_WARMUP_MODEL: 'test-model',
  READY_IDLE_TARGET: '2',
  POOL_MAX_ACCOUNTS: '20',
});
const ENTERPRISE_TABLES = [
  'proxy_accounts',
  'proxy_identity_initializations',
  'proxy_request_stats',
  'user_pool_accounts',
  'user_pool_events',
];
const ALL_STEP_IDS = Object.values(ENTERPRISE_MIGRATION_IDS).filter(
  (id) => id !== ENTERPRISE_MIGRATION_IDS.poolConfigFingerprint,
);

/** The Proxy schema as single-slug r4 (fork/main) leaves it: base migrations plus the pool store's tables. */
const R4_SCHEMA = `
  CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
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
  CREATE INDEX idx_proxy_accounts_updated ON proxy_accounts(updated_at, identity);
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
  CREATE INDEX idx_proxy_request_stats_identity_time ON proxy_request_stats(identity, requested_at DESC);
  CREATE INDEX idx_proxy_request_stats_time ON proxy_request_stats(requested_at DESC, id DESC);
  CREATE TABLE proxy_identity_initializations (
    identity TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_proxy_identity_initializations_lease ON proxy_identity_initializations(lease_expires_at);
  CREATE TABLE user_pool_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL DEFAULT 1,
    idle_target INTEGER NOT NULL, max_accounts INTEGER NOT NULL, lease_seconds INTEGER NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0, next_ordinal INTEGER NOT NULL DEFAULT 0,
    account_domain TEXT NOT NULL, owner TEXT, owner_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE user_pool_accounts (
    identity TEXT PRIMARY KEY REFERENCES proxy_accounts(identity) ON DELETE RESTRICT,
    ordinal INTEGER UNIQUE NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new',
    attempt_id TEXT NOT NULL, oauth_attempt_id TEXT, sso_created_at TEXT,
    task_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL,
    cooldown_until INTEGER NOT NULL DEFAULT 0, verified_at INTEGER,
    generation INTEGER NOT NULL DEFAULT 0,
    reauth_count INTEGER NOT NULL DEFAULT 0, reauth_window_at INTEGER NOT NULL DEFAULT 0,
    CHECK(state IN ('provisioning', 'ready', 'cooling', 'failed', 'disabled'))
  );
  CREATE TABLE user_pool_leases (
    caller_id TEXT PRIMARY KEY,
    member_identity TEXT UNIQUE NOT NULL REFERENCES user_pool_accounts(identity),
    lease_id TEXT UNIQUE NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('provisional', 'active')),
    assigned_at INTEGER NOT NULL, last_success_at INTEGER, expires_at INTEGER NOT NULL
  );
  CREATE TABLE user_pool_holds (
    request_id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL REFERENCES user_pool_leases(lease_id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT -1
  );
  CREATE INDEX user_pool_holds_lease ON user_pool_holds(lease_id, expires_at);
  CREATE TABLE user_pool_catalog_holds (
    request_id TEXT PRIMARY KEY, lease_id TEXT UNIQUE NOT NULL, caller_id TEXT NOT NULL,
    member_identity TEXT NOT NULL REFERENCES user_pool_accounts(identity),
    assigned_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL, generation INTEGER NOT NULL
  );
  CREATE INDEX user_pool_catalog_member ON user_pool_catalog_holds(member_identity, expires_at);
  CREATE INDEX user_pool_catalog_caller ON user_pool_catalog_holds(caller_id);
  CREATE TABLE user_pool_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL,
    identity TEXT, caller_id TEXT, lease_id TEXT, detail TEXT
  );
  CREATE TABLE user_pool_catalog_cooldowns (
    caller_id TEXT PRIMARY KEY,
    member_identity TEXT NOT NULL REFERENCES user_pool_accounts(identity),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX user_pool_catalog_cooldown_expiry ON user_pool_catalog_cooldowns(expires_at);
  CREATE TRIGGER user_pool_credential_fence
    AFTER UPDATE OF copilot_oauth_token, copilot_oauth_status, copilot_oauth_attempt_id,
      copilot_oauth_updated_at, sso_user, gh_login ON proxy_accounts
    WHEN OLD.copilot_oauth_token IS NOT NEW.copilot_oauth_token
      OR OLD.copilot_oauth_status IS NOT NEW.copilot_oauth_status
      OR OLD.copilot_oauth_attempt_id IS NOT NEW.copilot_oauth_attempt_id
      OR OLD.copilot_oauth_updated_at IS NOT NEW.copilot_oauth_updated_at
      OR OLD.sso_user IS NOT NEW.sso_user OR OLD.gh_login IS NOT NEW.gh_login
    BEGIN
      UPDATE user_pool_accounts SET generation = generation + 1, verified_at = NULL
      WHERE identity = NEW.identity;
    END;
`;

const R4_DATA = `
  INSERT INTO schema_migrations VALUES ('2026-07-23-copilot-oauth-direct', '2026-08-01T00:00:00.000Z');
  INSERT INTO proxy_accounts VALUES
    ('alice', 'alice', 'alice_octo', 'oauth-a', 'valid', '2026-08-01', NULL, '2026-07-01', '2026-08-01'),
    ('bob', 'bob', NULL, NULL, 'missing', NULL, NULL, '2026-07-02', '2026-07-02'),
    ('${accountName(0)}', '${accountName(0)}', 'm0_octo', 'oauth-m0', 'valid', '2026-08-03', NULL, '2026-07-03',
      '2026-08-03'),
    ('${accountName(1)}', '${accountName(1)}', NULL, NULL, 'refreshing', NULL, 'attempt-1', '2026-07-04',
      '2026-07-04');
  INSERT INTO proxy_request_stats VALUES
    ('r1', 'alice', 'alice_octo', '2026-08-01T00:00:00Z', '/v1/models', NULL, 1, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL),
    ('r2', '${accountName(0)}', 'm0_octo', '2026-08-02T00:00:00Z', '/v1/messages', 'claude', 0, 'boom', 10, 2, 0,
      1, 1, 'sha256:caller', 'lease-1');
  INSERT INTO proxy_identity_initializations VALUES
    ('carol', 'claim-1', '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  INSERT INTO user_pool_settings VALUES (1, 4, 3, 7, 3600, 0, 2, 'pool.example.test', NULL, 0);
  INSERT INTO user_pool_accounts VALUES
    ('${accountName(0)}', 0, 'ready', 'ready', 'attempt-0', NULL, '2026-07-03', NULL, 0, 0, NULL, 1, 0, 1, 5, 0, 0),
    ('${accountName(1)}', 1, 'provisioning', 'oauth-wait', 'attempt-1', 'attempt-1', '2026-07-04', 'task-1', 1,
      0, NULL, 2, 0, NULL, 1, 0, 0);
  INSERT INTO user_pool_leases VALUES ('sha256:caller', '${accountName(0)}', 'lease-1', 'active', 1, 2, 9999999999999);
  INSERT INTO user_pool_events (at, action, identity, caller_id, lease_id, detail) VALUES
    (1, 'name_reserved', '${accountName(0)}', NULL, NULL, NULL),
    (2, 'settings_updated', NULL, NULL, NULL, NULL);
`;

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function r4Database(): Database.Database {
  const db = openDb();
  db.exec(R4_SCHEMA);
  db.exec(R4_DATA);
  return db;
}

/** What a Proxy start does: base migrations, then the pool store (caller-lease mode). */
function start(db: Database.Database, seed = SEED): UserPoolStore {
  runMigrations(db, seed);
  return new UserPoolStore(db, POOL_OPTIONS);
}

function allSteps() {
  return [...baseEnterpriseSteps(SEED), ...poolEnterpriseSteps()];
}

function tableNames(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function snapshot(db: Database.Database): Snapshot {
  const result: Snapshot = {};
  for (const table of tableNames(db)) {
    result[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
  }
  return result;
}

/** Drops values that legitimately differ between runs (wall-clock timestamps). */
function stableSnapshot(db: Database.Database): Snapshot {
  const result = snapshot(db);
  result.schema_migrations = result.schema_migrations!.map(({ applied_at: _applied, ...row }) => row);
  result.proxy_enterprises = result.proxy_enterprises!.map(
    ({ created_at: _created, updated_at: _updated, ...row }) => row,
  );
  return result;
}

function schema(db: Database.Database): Row[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Row[];
}

function columnSets(db: Database.Database): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const table of tableNames(db)) {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>;
    result[table] = columns.map((column) => column.name).sort();
  }
  return result;
}

function objectNames(db: Database.Database, type: 'index' | 'trigger'): string[] {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = ?
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all(type) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function recordedSteps(db: Database.Database): string[] {
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function defaultEnterprise(db: Database.Database): Row {
  return db.prepare('SELECT * FROM proxy_enterprises WHERE id = ?').get(DEFAULT_ENTERPRISE_ID) as Row;
}

function withoutEnterprise(rows: Row[]): Row[] {
  return rows.map(({ enterprise_id: _enterprise, ...row }) => row);
}

test('an r4 database keeps every row and assigns all of them to the default enterprise', () => {
  const db = r4Database();
  try {
    const before = snapshot(db);
    const store = start(db);
    const after = snapshot(db);
    for (const table of Object.keys(before)) {
      if (table === 'schema_migrations') continue;
      if (!ENTERPRISE_TABLES.includes(table)) {
        assert.deepEqual(after[table], before[table], table);
        continue;
      }
      assert.ok(after[table]!.every((row) => row.enterprise_id === DEFAULT_ENTERPRISE_ID), table);
      assert.deepEqual(withoutEnterprise(after[table]!), before[table], table);
    }
    assert.deepEqual(recordedSteps(db), ['2026-07-23-copilot-oauth-direct', ...ALL_STEP_IDS].sort());
    const enterprise = defaultEnterprise(db);
    assert.equal(enterprise.state, 'active');
    assert.equal(enterprise.max_accounts, 7, 'the persisted pool cap survives the upgrade');
    assert.equal(enterprise.inventory_count, 2);
    assert.equal(enterprise.policy_version, 1);
    assert.equal(enterprise.profile_fingerprint, SEED.fingerprint);
    assert.equal(store.enterprisePolicies()[0].maxAccounts, 7);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('running the migrations again changes nothing', () => {
  const db = r4Database();
  try {
    start(db);
    const first = { rows: snapshot(db), schema: schema(db) };
    start(db);
    assert.deepEqual({ rows: snapshot(db), schema: schema(db) }, first);
  } finally {
    db.close();
  }
});

for (let index = 0; index < ALL_STEP_IDS.length; index++) {
  for (const crash of ['before-record', 'after-record'] as const) {
    test(`a crash ${crash} of step ${ALL_STEP_IDS[index]} resumes to the same result`, () => {
      const reference = r4Database();
      const db = r4Database();
      try {
        start(reference);
        const steps = allSteps();
        runSqliteMigrations(db, steps.slice(0, index));
        // `before-record` leaves the step's DDL applied without its schema_migrations row.
        if (crash === 'before-record') db.transaction(() => steps[index]!.up(db))();
        else runSqliteMigrations(db, steps.slice(index, index + 1));
        start(db);
        assert.deepEqual(stableSnapshot(db), stableSnapshot(reference));
        assert.deepEqual(schema(db), schema(reference));
      } finally {
        db.close();
        reference.close();
      }
    });
  }
}

test('a fresh database records every step and matches the upgraded schema', () => {
  const fresh = openDb();
  const upgraded = r4Database();
  try {
    start(fresh);
    start(upgraded);
    assert.deepEqual(recordedSteps(fresh), ['2026-07-23-copilot-oauth-direct', ...ALL_STEP_IDS].sort());
    assert.deepEqual(columnSets(fresh), columnSets(upgraded));
    assert.deepEqual(objectNames(fresh, 'index'), objectNames(upgraded, 'index'));
    assert.deepEqual(objectNames(fresh, 'trigger'), objectNames(upgraded, 'trigger'));
    const enterprise = defaultEnterprise(fresh);
    assert.equal(enterprise.inventory_count, 0);
    assert.equal(enterprise.max_accounts, POOL_OPTIONS.maxAccounts, 'a new pool takes its configured cap');
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test('a direct-mode database seeds default from the enterprise seed and skips the pool steps', () => {
  const db = openDb();
  try {
    runMigrations(db, SEED);
    assert.equal(defaultEnterprise(db).max_accounts, SEED.maxAccounts);
    assert.ok(!recordedSteps(db).includes(ENTERPRISE_MIGRATION_IDS.poolAccounts));
    db.prepare('DELETE FROM proxy_enterprises').run();
    runMigrations(db, SEED);
    assert.equal(defaultEnterprise(db).id, DEFAULT_ENTERPRISE_ID, 'a missing default row is re-seeded');
  } finally {
    db.close();
  }
});

for (const origin of ['fresh', 'upgraded'] as const) {
  test(`${origin}: inserts without an enterprise fail on every guarded table`, () => {
    const db = origin === 'fresh' ? openDb() : r4Database();
    try {
      start(db);
      assert.throws(() => db.prepare(`
        INSERT INTO proxy_accounts (identity, sso_user, created_at, updated_at)
        VALUES ('dave', 'dave', 'now', 'now')
      `).run(), /enterprise_id_required/);
      assert.throws(() => db.prepare(`
        INSERT INTO proxy_identity_initializations (identity, claim_id, lease_expires_at, created_at, updated_at)
        VALUES ('dave', 'claim', 'later', 'now', 'now')
      `).run(), /enterprise_id_required/);
      assert.throws(() => db.prepare(`
        INSERT INTO proxy_request_stats (id, identity, requested_at, path, success)
        VALUES ('r9', 'dave', 'now', '/v1/models', 1)
      `).run(), /enterprise_id_required/);
      insertAccount(db, 'erin', DEFAULT_ENTERPRISE_ID);
      assert.throws(() => insertMember(db, 'erin', null), /enterprise_id_mismatch/);
      assert.throws(() => insertMember(db, 'erin', 'other'), /enterprise_id_mismatch/);
      insertMember(db, 'erin', DEFAULT_ENTERPRISE_ID);
    } finally {
      db.close();
    }
  });

  test(`${origin}: an account or pool member never changes enterprise`, () => {
    const db = origin === 'fresh' ? openDb() : r4Database();
    try {
      start(db);
      insertEnterprise(db, 'other');
      insertAccount(db, 'erin', DEFAULT_ENTERPRISE_ID);
      insertMember(db, 'erin', DEFAULT_ENTERPRISE_ID);
      assert.throws(
        () => db.prepare("UPDATE proxy_accounts SET enterprise_id = 'other' WHERE identity = 'erin'").run(),
        /enterprise_id_immutable/,
      );
      assert.throws(
        () => db.prepare("UPDATE user_pool_accounts SET enterprise_id = 'other' WHERE identity = 'erin'").run(),
        /enterprise_id_immutable/,
      );
      assert.throws(() => insertAccount(db, 'frank', 'missing'), /FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });
}

function insertAccount(db: Database.Database, identity: string, enterpriseId: string): void {
  db.prepare(`
    INSERT INTO proxy_accounts (identity, enterprise_id, sso_user, created_at, updated_at)
    VALUES (?, ?, ?, 'now', 'now')
  `).run(identity, enterpriseId, identity);
}

function insertMember(db: Database.Database, identity: string, enterpriseId: string | null): void {
  db.prepare(`
    INSERT INTO user_pool_accounts (identity, enterprise_id, ordinal, state, attempt_id, updated_at)
    VALUES (?, ?, 900, 'provisioning', 'attempt', 0)
  `).run(identity, enterpriseId);
}

function insertEnterprise(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO proxy_enterprises (id, state, max_accounts, profile_fingerprint, created_at, updated_at)
    VALUES (?, 'draft', 1, ?, 0, 0)
  `).run(id, 'c'.repeat(64));
}

test('a changed identity fails closed once the enterprise has pool members', () => {
  const db = openDb();
  try {
    start(db).reserve(ENTERPRISES);
    assert.throws(() => runMigrations(db, CHANGED_SEED), (error: Error) => {
      assert.match(error.message, /^enterprise_identity_changed: enterprise "default"/);
      assert.ok(!error.message.includes(SEED.fingerprint) && !error.message.includes(CHANGED_SEED.fingerprint));
      return true;
    });
    assert.equal(defaultEnterprise(db).profile_fingerprint, SEED.fingerprint);
  } finally {
    db.close();
  }
});

test('a changed identity is adopted while the enterprise has no pool members', () => {
  const db = openDb();
  try {
    start(db);
    db.prepare(`
      INSERT INTO proxy_accounts (identity, enterprise_id, sso_user, created_at, updated_at)
      VALUES ('direct', 'default', 'direct', 'now', 'now')
    `).run();
    runMigrations(db, CHANGED_SEED);
    assert.equal(defaultEnterprise(db).profile_fingerprint, CHANGED_SEED.fingerprint);
  } finally {
    db.close();
  }
});

test('switching from direct mode to a caller-lease pool keeps working', () => {
  const db = openDb();
  try {
    runMigrations(db, defaultEnterpriseSeed({}));
    const poolEnv = {
      ACCOUNT_ROUTING_MODE: 'caller-lease',
      POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test',
      POOL_WARMUP_MODEL: 'test-model',
    };
    runMigrations(db, defaultEnterpriseSeed(poolEnv));
    new UserPoolStore(db, POOL_OPTIONS).reserve(ENTERPRISES);
    const changedDomain = { ...poolEnv, POOL_ACCOUNT_EMAIL_DOMAIN: 'other.example.test' };
    assert.throws(() => runMigrations(db, defaultEnterpriseSeed(changedDomain)), /^Error: enterprise_identity_changed/);
  } finally {
    db.close();
  }
});

test('reservations increment the inventory counter and a restart corrects drift', () => {
  const db = openDb();
  try {
    const store = start(db);
    store.reserve(ENTERPRISES);
    store.reserve(ENTERPRISES);
    assert.equal(defaultEnterprise(db).inventory_count, 2);
    db.prepare('UPDATE proxy_enterprises SET inventory_count = 9').run();
    start(db);
    assert.equal(defaultEnterprise(db).inventory_count, 2);
    const drift = db.prepare(`
      SELECT enterprise_id, detail
      FROM user_pool_events
      WHERE action = 'enterprise_inventory_drift'
    `).all();
    assert.deepEqual(drift, [{ enterprise_id: DEFAULT_ENTERPRISE_ID, detail: 'stored=9 actual=2' }]);
  } finally {
    db.close();
  }
});

test('the pool cap lives on the default enterprise and events carry the member enterprise', () => {
  const db = r4Database();
  try {
    const store = start(db);
    const policy = store.updateEnterprisePolicy(DEFAULT_ENTERPRISE_ID, 1, { maxAccounts: 5 });
    assert.equal(policy.maxAccounts, 5);
    assert.equal(defaultEnterprise(db).max_accounts, 5);
    assert.equal(defaultEnterprise(db).policy_version, 2);
    const legacy = db.prepare('SELECT max_accounts FROM user_pool_settings').get() as { max_accounts: number };
    assert.equal(legacy.max_accounts, 7, 'the legacy column is no longer written');
    const settings = store.settings();
    store.updateSettings(settings.version, { paused: 1 });
    assert.equal(defaultEnterprise(db).policy_version, 2, 'other settings do not touch the enterprise policy');
    store.event('member_retry', accountName(1));
    const events = db.prepare(`
      SELECT action, enterprise_id
      FROM user_pool_events
      WHERE id > 2
      ORDER BY id
    `).all();
    assert.deepEqual(events, [
      { action: 'enterprise_policy_updated', enterprise_id: DEFAULT_ENTERPRISE_ID },
      { action: 'settings_updated', enterprise_id: null },
      { action: 'member_retry', enterprise_id: DEFAULT_ENTERPRISE_ID },
    ]);
  } finally {
    db.close();
  }
});

test('SQLite storage records enterprises on accounts, claims and statistics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-enterprise-storage-'));
  const path = join(directory, 'proxy.sqlite');
  const storage = new SqliteStorage(path, 10, [SEED]);
  try {
    await storage.initialize();
    const account = await storage.createAccount({ enterpriseId: DEFAULT_ENTERPRISE_ID, identity: 'a', ssoUser: 'a' });
    assert.equal(account.enterpriseId, DEFAULT_ENTERPRISE_ID);
    const other = 'other' as EnterpriseId;
    await assert.rejects(storage.createAccount({ enterpriseId: other, identity: 'a', ssoUser: 'a' }), /immutable/);
    await assert.rejects(storage.importCopilotOauthToken({
      enterpriseId: other,
      identity: 'a',
      ssoUser: 'a',
      copilotOauthToken: 'token',
    }), /immutable/);
    assert.equal(await storage.claimIdentityInitialization(DEFAULT_ENTERPRISE_ID, 'b', 'claim', 60), true);
    await storage.recordRequestStat({
      enterpriseId: DEFAULT_ENTERPRISE_ID,
      identity: 'a',
      path: '/v1/models',
      success: true,
    });
    const stat = await storage.listRequestStats(DEFAULT_ENTERPRISE_ID, 'a');
    assert.equal(stat.length, 1);
    const enterprises = await storage.listEnterprises();
    assert.deepEqual(enterprises.map(({ id, state, maxAccounts }) => ({ id, state, maxAccounts })), [
      { id: DEFAULT_ENTERPRISE_ID, state: 'active', maxAccounts: SEED.maxAccounts },
    ]);
  } finally {
    await storage.close();
  }
  const changed = new SqliteStorage(path, 10, [CHANGED_SEED]);
  try {
    await changed.initialize();
    const [enterprise] = await changed.listEnterprises();
    assert.equal(enterprise!.profileFingerprint, CHANGED_SEED.fingerprint, 'no pool members: identity adopted');
  } finally {
    await changed.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
