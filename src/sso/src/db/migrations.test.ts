import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_ENTERPRISE_ID, parseRegistry, runSqliteMigrations, type EnterpriseId } from '@ghcp/shared';
import { ssoEnterpriseSeed, ssoProfileFingerprint, type SsoEnterpriseSeed } from './enterpriseRepo.js';
import { ENTERPRISE_MIGRATION_IDS, enterpriseSteps, runMigrations } from './migrations.js';

type Row = Record<string, unknown>;

const SEED: SsoEnterpriseSeed = {
  id: DEFAULT_ENTERPRISE_ID,
  fingerprint: 'a'.repeat(64),
  userPrefix: 'user',
  emailDomain: 'customsso.com',
};
const OTHER: SsoEnterpriseSeed = {
  id: 'contoso-eu' as EnterpriseId,
  fingerprint: 'c'.repeat(64),
  userPrefix: 'ghcp',
  emailDomain: 'contoso.example.eu',
};
const ALL_STEP_IDS = Object.values(ENTERPRISE_MIGRATION_IDS);
const DATA_TABLES = [
  'sso_users',
  'sso_pool_managed_users',
  'sso_runtime_settings',
  'sso_budget_cache',
  'sso_emu_import_plans',
  'sso_emu_import_plan_rows',
];

/** The SSO schema exactly as single-slug r4 (fork/main `src/sso/src/db/migrations.ts`) leaves it. */
const R4_SCHEMA = `
  CREATE TABLE sso_users (
    sso_user TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    gh_login TEXT,
    gh_scim_id TEXT,
    emu_status TEXT NOT NULL DEFAULT 'not_synced',
    copilot_seat_status TEXT NOT NULL DEFAULT 'unknown',
    copilot_seat_pending_cancellation_date TEXT,
    copilot_seat_last_operation TEXT,
    copilot_seat_last_error TEXT,
    copilot_seat_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE sso_pool_managed_users (
    sso_user TEXT PRIMARY KEY REFERENCES sso_users(sso_user) ON DELETE RESTRICT
  );
  CREATE TABLE sso_runtime_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_sso_users INTEGER,
    user_prefix TEXT NOT NULL,
    email_domain TEXT NOT NULL,
    bulk_sync_concurrency INTEGER NOT NULL,
    scim_request_delay_ms INTEGER NOT NULL,
    scim_max_retries INTEGER NOT NULL,
    scim_retry_base_delay_ms INTEGER NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE sso_budget_cache (
    period_key TEXT PRIMARY KEY,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    unit_type TEXT,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE sso_emu_import_plans (
    id TEXT PRIMARY KEY,
    sso_user TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    applied_at TEXT
  );
  CREATE TABLE sso_emu_import_plan_rows (
    plan_id TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    sso_user TEXT NOT NULL,
    email TEXT,
    gh_login TEXT,
    gh_scim_id TEXT,
    emu_status TEXT,
    copilot_seat_status TEXT,
    copilot_seat_pending_cancellation_date TEXT,
    status TEXT NOT NULL,
    detail TEXT NOT NULL,
    action TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, row_index),
    FOREIGN KEY (plan_id) REFERENCES sso_emu_import_plans(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_sso_emu_import_plan_rows_status
    ON sso_emu_import_plan_rows (plan_id, status, row_index);
`;

/** Representative r4 data: two users (one pool-managed), tuned settings, a budget period and an import plan. */
const R4_DATA = `
  INSERT INTO sso_users (
    sso_user, password_hash, salt, email, role, gh_login, gh_scim_id, emu_status, copilot_seat_status,
    copilot_seat_pending_cancellation_date, copilot_seat_last_operation, created_at, updated_at
  )
  VALUES
    ('legacy.user', 'hash-1', 'salt-1', 'legacy@example.test', 'user', 'legacy-user_octo', 'scim-1', 'active',
     'pending_cancellation', '2026-10-17', 'remove', '2026-07-01', '2026-08-01'),
    ('Pool.User', 'hash-2', 'salt-2', 'pool@example.test', 'user', NULL, NULL, 'not_synced',
     'unknown', NULL, NULL, '2026-07-02', '2026-08-02');
  INSERT INTO sso_pool_managed_users (sso_user)
  VALUES ('Pool.User');
  INSERT INTO sso_runtime_settings (
    id, max_sso_users, user_prefix, email_domain, bulk_sync_concurrency,
    scim_request_delay_ms, scim_max_retries, scim_retry_base_delay_ms, version, updated_at
  )
  VALUES (1, 50, 'existing', 'existing.example.test', 2, 100, 4, 500, 7, '2026-08-03');
  INSERT INTO sso_budget_cache (period_key, year, month, quantity, unit_type, raw_json, fetched_at)
  VALUES ('2026-09', 2026, 9, 12.5, 'ai_unit', '{"raw":true}', '2026-09-30');
  INSERT INTO sso_emu_import_plans (id, sso_user, status, created_at, updated_at, applied_at)
  VALUES ('plan-1', NULL, 'applied', '2026-08-04', '2026-08-05', '2026-08-05');
  INSERT INTO sso_emu_import_plan_rows (
    plan_id, row_index, sso_user, email, gh_login, gh_scim_id, emu_status, copilot_seat_status,
    status, detail, action, created_at, updated_at
  )
  VALUES ('plan-1', 1, 'legacy.user', 'legacy@example.test', 'legacy-user_octo', 'scim-1', 'active', 'assigned',
          'updated', 'done', NULL, '2026-08-04', '2026-08-05');
`;

function openR4Db(data = true): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(R4_SCHEMA);
  if (data) db.exec(R4_DATA);
  return db;
}

function rows(db: Database.Database, table: string): Row[] {
  const order = sortedColumns(db, table).map((_column, index) => index + 1).join(', ');
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[];
}

function snapshot(db: Database.Database): Record<string, Row[]> {
  return Object.fromEntries(DATA_TABLES.map((table) => [table, rows(db, table)]));
}

function schemaOf(db: Database.Database): Row[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Row[];
}

function appliedSteps(db: Database.Database): string[] {
  const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>;
  return applied.map((row) => row.id);
}

function withEnterprise(source: Row[], extra: Row = {}): Row[] {
  return source.map((row) => ({ enterprise_id: DEFAULT_ENTERPRISE_ID, ...row, ...extra }));
}

/** The r4 rows as the migrated tables must hold them: unchanged, owned by `default`. */
function expectedAfterUpgrade(before: Record<string, Row[]>): Record<string, Row[]> {
  const settings = before.sso_runtime_settings!.map(({ id: _id, ...row }) => row);
  return {
    sso_users: withEnterprise(before.sso_users!),
    sso_pool_managed_users: withEnterprise(before.sso_pool_managed_users!),
    sso_runtime_settings: withEnterprise(settings),
    sso_budget_cache: withEnterprise(before.sso_budget_cache!),
    sso_emu_import_plans: withEnterprise(before.sso_emu_import_plans!),
    sso_emu_import_plan_rows: before.sso_emu_import_plan_rows!,
  };
}

function sortedColumns(db: Database.Database, table: string): string[] {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>;
  return columns.map((column) => column.name).sort();
}

test('an r4 database is upgraded in place and every row belongs to default', () => {
  const db = openR4Db();
  try {
    const before = snapshot(db);
    assert.deepEqual(runMigrations(db, [SEED]), ALL_STEP_IDS);
    const after = snapshot(db);
    const expected = expectedAfterUpgrade(before);
    for (const table of DATA_TABLES) {
      const actual = after[table]!.map((row) => Object.fromEntries(Object.entries(row).sort()));
      const wanted = expected[table]!.map((row) => Object.fromEntries(Object.entries(row).sort()));
      assert.deepEqual(actual, wanted, table);
    }
    assert.deepEqual(appliedSteps(db), [...ALL_STEP_IDS].sort());
    assert.deepEqual(db.prepare('SELECT id, profile_fingerprint FROM sso_enterprises').all(), [
      { id: DEFAULT_ENTERPRISE_ID, profile_fingerprint: SEED.fingerprint },
    ]);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('composite keys keep same-name users apart and require an existing enterprise', () => {
  const db = openR4Db();
  try {
    runMigrations(db, [SEED, OTHER]);
    const insertUser = db.prepare(`
      INSERT INTO sso_users (enterprise_id, sso_user, password_hash, salt, email, created_at, updated_at)
      VALUES (?, ?, 'hash', 'salt', 'same@example.test', 'now', 'now')
    `);
    insertUser.run(OTHER.id, 'legacy.user');
    assert.throws(() => insertUser.run(DEFAULT_ENTERPRISE_ID, 'legacy.user'), /UNIQUE/);
    assert.throws(() => insertUser.run('unknown', 'someone'), /FOREIGN KEY/);
    assert.throws(() => db.prepare(`
      INSERT INTO sso_users (sso_user, password_hash, salt, email, created_at, updated_at)
      VALUES ('no-enterprise', 'hash', 'salt', 'x@example.test', 'now', 'now')
    `).run(), /NOT NULL/);
    // Baseline BINARY collation: names differing only in case are distinct keys.
    insertUser.run(DEFAULT_ENTERPRISE_ID, 'LEGACY.USER');
    const insertMarker = db.prepare('INSERT INTO sso_pool_managed_users (enterprise_id, sso_user) VALUES (?, ?)');
    assert.throws(() => insertMarker.run(OTHER.id, 'Pool.User'), /FOREIGN KEY/);
    insertMarker.run(OTHER.id, 'legacy.user');
    const deleteUser = db.prepare('DELETE FROM sso_users WHERE enterprise_id = ? AND sso_user = ?');
    assert.throws(() => deleteUser.run(DEFAULT_ENTERPRISE_ID, 'Pool.User'), /FOREIGN KEY/);
    assert.equal(deleteUser.run(DEFAULT_ENTERPRISE_ID, 'legacy.user').changes, 1);
  } finally {
    db.close();
  }
});

test('re-running is a no-op and a fresh database ends with the same schema', () => {
  const upgraded = openR4Db();
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  try {
    runMigrations(upgraded, [SEED]);
    const once = snapshot(upgraded);
    assert.deepEqual(runMigrations(upgraded, [SEED]), []);
    assert.deepEqual(snapshot(upgraded), once);
    assert.deepEqual(runMigrations(fresh, [SEED]), ALL_STEP_IDS);
    assert.deepEqual(runMigrations(fresh, [SEED]), []);
    assert.deepEqual(schemaOf(fresh), schemaOf(upgraded));
    const settings = rows(fresh, 'sso_runtime_settings').map(({ updated_at: _updatedAt, ...row }) => row);
    assert.deepEqual(settings, [{
      enterprise_id: DEFAULT_ENTERPRISE_ID,
      max_sso_users: null,
      user_prefix: 'user',
      email_domain: 'customsso.com',
      bulk_sync_concurrency: 3,
      scim_request_delay_ms: 250,
      scim_max_retries: 3,
      scim_retry_base_delay_ms: 1000,
      version: 1,
    }]);
  } finally {
    upgraded.close();
    fresh.close();
  }
});

test('a crash inside any step rolls it back and the next start completes the upgrade', () => {
  const reference = openR4Db();
  runMigrations(reference, [SEED]);
  const expected = snapshot(reference);
  const expectedSchema = schemaOf(reference);
  reference.close();
  const steps = enterpriseSteps(SEED);
  steps.forEach((step, index) => {
    const db = openR4Db();
    try {
      runSqliteMigrations(db, steps.slice(0, index));
      const beforeCrash = { schema: schemaOf(db), data: snapshot(db) };
      const crash = (target: Database.Database) => {
        step.up(target);
        throw new Error('crash');
      };
      const crashing = { ...step, up: crash };
      assert.throws(() => runSqliteMigrations(db, [crashing]), /crash/);
      assert.deepEqual({ schema: schemaOf(db), data: snapshot(db) }, beforeCrash, step.id);
      assert.equal(appliedSteps(db).includes(step.id), false);
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(runMigrations(db, [SEED]), ALL_STEP_IDS.slice(index));
      assert.deepEqual(snapshot(db), expected, step.id);
      assert.deepEqual(schemaOf(db), expectedSchema, step.id);
    } finally {
      db.close();
    }
  });
});

test('pre-r4 import plan rows gain seat columns and lose the plaintext password column', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE sso_emu_import_plan_rows (
        plan_id TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        sso_user TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        password_for_login TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, row_index)
      );
      INSERT INTO sso_emu_import_plan_rows (
        plan_id, row_index, sso_user, status, detail, password_for_login, created_at, updated_at
      ) VALUES ('legacy-plan', 1, 'alice', 'created', 'legacy', 'plaintext-secret', 'now', 'now');
    `);
    runMigrations(db, [SEED]);
    const columns = sortedColumns(db, 'sso_emu_import_plan_rows');
    assert.equal(columns.includes('copilot_seat_status'), true);
    assert.equal(columns.includes('copilot_seat_pending_cancellation_date'), true);
    assert.equal(columns.includes('password_for_login'), false);
    const settings = db.prepare('SELECT * FROM sso_runtime_settings WHERE enterprise_id = ?').get(SEED.id) as Row;
    assert.equal(settings.max_sso_users, null);
    assert.equal(settings.user_prefix, 'user');
    assert.equal(settings.email_domain, 'customsso.com');
    assert.equal(settings.version, 1);
    runMigrations(db, [SEED]);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM sso_runtime_settings').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('seat date columns are added without guessing user states or replaying legacy previews', () => {
  const db = openR4Db(false);
  try {
    db.exec(`
      ALTER TABLE sso_users DROP COLUMN copilot_seat_pending_cancellation_date;
      ALTER TABLE sso_emu_import_plan_rows DROP COLUMN copilot_seat_pending_cancellation_date;
      INSERT INTO sso_users (sso_user, password_hash, salt, email, copilot_seat_status, created_at, updated_at)
        VALUES ('alice', 'original-hash', 'original-salt', 'alice@example.test', 'unassigned', 'created', 'updated');
      INSERT INTO sso_emu_import_plans (id, status, created_at, updated_at)
        VALUES ('legacy', 'planned', 'created', 'updated'), ('history', 'applied', 'created', 'updated');
      INSERT INTO sso_emu_import_plan_rows (plan_id, row_index, sso_user, status, detail, action, created_at, updated_at)
        VALUES ('legacy', 1, 'alice', 'pending_update', 'old preview', 'update', 'created', 'updated'),
               ('history', 1, 'bob', 'updated', 'old result', NULL, 'created', 'updated');
    `);
    runMigrations(db, [SEED]);
    const user = db.prepare(`
      SELECT enterprise_id, password_hash, copilot_seat_status, copilot_seat_pending_cancellation_date
      FROM sso_users
    `).get();
    assert.deepEqual(user, {
      enterprise_id: DEFAULT_ENTERPRISE_ID,
      password_hash: 'original-hash',
      copilot_seat_status: 'unassigned',
      copilot_seat_pending_cancellation_date: null,
    });
    const rowOf = db.prepare('SELECT status, detail FROM sso_emu_import_plan_rows WHERE plan_id = ?');
    const preview = rowOf.get('legacy') as { status: string; detail: string };
    assert.equal(preview.status, 'conflict');
    assert.match(preview.detail, /Preview again/);
    assert.deepEqual(rowOf.get('history'), { status: 'updated', detail: 'old result' });
    db.exec(`
      UPDATE sso_emu_import_plan_rows
      SET status = 'pending_update', copilot_seat_pending_cancellation_date = '2026-10-01'
      WHERE plan_id = 'legacy'
    `);
    runMigrations(db, [SEED]);
    const replayed = db.prepare(`
      SELECT status, copilot_seat_pending_cancellation_date
      FROM sso_emu_import_plan_rows
      WHERE plan_id = 'legacy'
    `).get();
    assert.deepEqual(replayed, { status: 'pending_update', copilot_seat_pending_cancellation_date: '2026-10-01' });
  } finally {
    db.close();
  }
});

test('new registry enterprises get their own row and seeded runtime settings', () => {
  const db = openR4Db();
  try {
    runMigrations(db, [SEED]);
    const defaultSettings = rows(db, 'sso_runtime_settings');
    runMigrations(db, [SEED, OTHER]);
    const settings = db.prepare(`
      SELECT enterprise_id, user_prefix, email_domain, version
      FROM sso_runtime_settings
      ORDER BY enterprise_id
    `).all();
    assert.deepEqual(settings, [
      { enterprise_id: OTHER.id, user_prefix: 'ghcp', email_domain: 'contoso.example.eu', version: 1 },
      {
        enterprise_id: DEFAULT_ENTERPRISE_ID,
        user_prefix: 'existing',
        email_domain: 'existing.example.test',
        version: 7,
      },
    ]);
    assert.deepEqual(rows(db, 'sso_runtime_settings').filter((row) => row.enterprise_id === SEED.id), defaultSettings);
    assert.deepEqual(db.prepare('SELECT id FROM sso_enterprises ORDER BY id').all(), [
      { id: OTHER.id },
      { id: DEFAULT_ENTERPRISE_ID },
    ]);
  } finally {
    db.close();
  }
});

test('an identity change is fatal only once the enterprise has users', () => {
  const db = openR4Db(false);
  try {
    runMigrations(db, [SEED, OTHER]);
    const changed = { ...OTHER, fingerprint: 'd'.repeat(64) };
    runMigrations(db, [SEED, changed]);
    const stored = db.prepare('SELECT profile_fingerprint FROM sso_enterprises WHERE id = ?');
    assert.deepEqual(stored.get(OTHER.id), { profile_fingerprint: changed.fingerprint });
    db.prepare(`
      INSERT INTO sso_users (enterprise_id, sso_user, password_hash, salt, email, created_at, updated_at)
      VALUES (?, 'alice', 'hash', 'salt', 'alice@example.test', 'now', 'now')
    `).run(OTHER.id);
    assert.throws(() => runMigrations(db, [SEED, OTHER]), /enterprise_identity_changed: enterprise "contoso-eu"/);
    assert.deepEqual(stored.get(OTHER.id), { profile_fingerprint: changed.fingerprint });
    assert.throws(() => runMigrations(db, [SEED]), /enterprise_missing_from_registry: enterprise "contoso-eu"/);
    runMigrations(db, [SEED, changed]);
  } finally {
    db.close();
  }
});

test('migrations refuse to run without the default enterprise', () => {
  const db = new Database(':memory:');
  try {
    assert.throws(() => runMigrations(db, [OTHER]), /default enterprise/);
  } finally {
    db.close();
  }
});

test('the SSO fingerprint covers id, GitHub base URL, slug and shortcode only', () => {
  const registry = (overrides: Record<string, unknown>) => parseRegistry({
    version: 1,
    enterprises: [{
      id: 'default',
      github: { baseUrl: 'https://github.com', slug: 'acme', shortcode: 'octo', ...overrides },
      sso: { scimBaseUrl: 'https://api.github.com/scim/v2/enterprises/acme' },
    }],
  }, { service: 'sso' }).enterprises[0]!;
  const base = ssoProfileFingerprint(registry({}));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(ssoProfileFingerprint(registry({ slug: 'ACME' })), base);
  assert.equal(ssoProfileFingerprint(registry({ apiBaseUrl: 'https://api.example.test' })), base);
  assert.notEqual(ssoProfileFingerprint(registry({ slug: 'other' })), base);
  assert.notEqual(ssoProfileFingerprint(registry({ shortcode: 'abcd' })), base);
  assert.notEqual(ssoProfileFingerprint(registry({ baseUrl: 'https://acme.ghe.com', shortcode: '' })), base);
  assert.deepEqual(ssoEnterpriseSeed(registry({})), {
    id: DEFAULT_ENTERPRISE_ID,
    fingerprint: base,
    userPrefix: 'user',
    emailDomain: 'customsso.com',
  });
});
