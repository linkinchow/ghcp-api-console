import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_ENTERPRISE_ID, parseRegistry, runSqliteMigrations, type EnterpriseId } from '@ghcp/shared';
import { EnterpriseIdentityError, loginEnterpriseSeed, type LoginEnterpriseSeed } from './enterpriseRepo.js';
import { ENTERPRISE_MIGRATION_IDS, enterpriseSteps, runMigrations } from './migrations.js';

type Row = Record<string, unknown>;

const SEED: LoginEnterpriseSeed = { id: DEFAULT_ENTERPRISE_ID, fingerprint: 'a'.repeat(64) };
const OTHER: LoginEnterpriseSeed = { id: 'contoso-eu' as EnterpriseId, fingerprint: 'c'.repeat(64) };
const ALL_STEP_IDS = Object.values(ENTERPRISE_MIGRATION_IDS);
const DATA_TABLES = ['login_tasks', 'login_task_attempts', 'login_runtime_settings'];

/**
 * The Login schema exactly as single-slug r4 (fork/main `src/login/src/db/migrations.ts`) builds it on a fresh
 * database: the original table, then the columns r4 added in place, so `sqlite_master` matches a real r4 file.
 */
const R4_SCHEMA = `
  CREATE TABLE IF NOT EXISTS login_tasks (
    id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    sso_user TEXT NOT NULL,
    gh_login TEXT,
    oauth_attempt_id TEXT,
    sso_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    log_path TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_login_tasks_status_created_at
    ON login_tasks(status, created_at);
  CREATE TABLE IF NOT EXISTS login_runtime_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 20),
    auth_timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK (auth_timeout_ms BETWEEN 5000 AND 600000),
    auth_debug_logs INTEGER NOT NULL DEFAULT 0 CHECK (auth_debug_logs IN (0, 1)),
    auth_debug_artifacts INTEGER NOT NULL DEFAULT 0 CHECK (auth_debug_artifacts IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO login_runtime_settings (
    id, concurrency, auth_timeout_ms, auth_debug_logs, auth_debug_artifacts, version, updated_at
  ) VALUES (
    1, 1, 60000, 0, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
  ALTER TABLE login_tasks ADD COLUMN stage TEXT;
  ALTER TABLE login_tasks ADD COLUMN stage_updated_at TEXT;
  ALTER TABLE login_tasks ADD COLUMN failure_code TEXT;
  ALTER TABLE login_tasks ADD COLUMN queued_at TEXT;
  ALTER TABLE login_tasks ADD COLUMN prior_stage TEXT;
  CREATE TABLE IF NOT EXISTS login_task_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    stage_updated_at TEXT,
    failure_reason TEXT,
    failure_code TEXT,
    log_path TEXT,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    history_incomplete INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES login_tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_task ON login_task_attempts(task_id, attempt_number);
  CREATE INDEX IF NOT EXISTS idx_login_tasks_identity_status ON login_tasks(identity, status);
  CREATE INDEX IF NOT EXISTS idx_login_tasks_finished ON login_tasks(finished_at, id);
  CREATE INDEX IF NOT EXISTS idx_login_tasks_failure_created ON login_tasks(failure_code, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_login_attempts_task_number ON login_task_attempts(task_id, attempt_number);
`;

/** Representative r4 data: a finished, a failed and a running task, tuned runtime settings. */
const R4_DATA = `
  INSERT INTO login_tasks (
    id, identity, sso_user, gh_login, oauth_attempt_id, sso_type, status, attempts, failure_reason, log_path,
    created_at, started_at, finished_at, stage, stage_updated_at, failure_code, queued_at
  )
  VALUES
    ('task-1', 'alice', 'alice', 'alice_octo', 'attempt-1', 'custom', 'success', 1, NULL, '/logs/a.log',
     '2026-07-01', '2026-07-01', '2026-07-01', 'success', '2026-07-01', NULL, '2026-07-01'),
    ('task-2', 'bob', 'bob', 'bob_octo', 'attempt-2', 'azure', 'failed', 2, 'denied', NULL,
     '2026-07-02', '2026-07-02', '2026-07-02', 'failed', '2026-07-02', 'login_failed', '2026-07-02'),
    ('task-3', 'carol', 'carol', 'carol_octo', 'attempt-3', 'custom', 'running', 1, NULL, NULL,
     '2026-07-03', '2026-07-03', NULL, 'device-code', '2026-07-03', NULL, '2026-07-03');
  INSERT INTO login_task_attempts (id, task_id, attempt_number, status, queued_at)
  VALUES ('attempt-1', 'task-1', 1, 'success', '2026-07-01'),
         ('attempt-0', 'task-2', 1, 'failed', '2026-07-02'),
         ('attempt-2', 'task-2', 2, 'failed', '2026-07-02'),
         ('attempt-3', 'task-3', 1, 'running', '2026-07-03');
  UPDATE login_runtime_settings
  SET concurrency = 4, auth_timeout_ms = 90000, auth_debug_logs = 1, version = 3, updated_at = '2026-08-01'
  WHERE id = 1;
`;

function openR4Db(data = true): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(R4_SCHEMA);
  if (data) db.exec(R4_DATA);
  return db;
}

function rows(db: Database.Database, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Row[];
}

function snapshot(db: Database.Database): Record<string, Row[]> {
  return Object.fromEntries(DATA_TABLES.map((table) => [table, rows(db, table)]));
}

/** Compared up to whitespace and identifier quotes: r4 added columns unquoted, the shared helper quotes them. */
function schemaOf(db: Database.Database): Row[] {
  const schema = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<Row & { sql: string | null }>;
  return schema.map((row) => ({ ...row, sql: row.sql?.replaceAll('"', '').replace(/\s+/g, ' ').trim() ?? null }));
}

function appliedSteps(db: Database.Database): string[] {
  const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>;
  return applied.map((row) => row.id);
}

function insertTask(db: Database.Database, id: string, enterpriseId: string | null): void {
  db.prepare(`
    INSERT INTO login_tasks (id, enterprise_id, identity, sso_user, sso_type, created_at)
    VALUES (?, ?, ?, ?, 'custom', 'now')
  `).run(id, enterpriseId, id, id);
}

test('an r4 database is upgraded in place and every task belongs to default', () => {
  const db = openR4Db();
  try {
    const before = snapshot(db);
    assert.deepEqual(runMigrations(db, [SEED]), ALL_STEP_IDS);
    const after = snapshot(db);
    const expectedTasks = before.login_tasks!.map((row) => ({ ...row, enterprise_id: DEFAULT_ENTERPRISE_ID }));
    assert.deepEqual(after.login_tasks, expectedTasks);
    assert.deepEqual(after.login_task_attempts, before.login_task_attempts);
    assert.deepEqual(after.login_runtime_settings, before.login_runtime_settings);
    assert.deepEqual(appliedSteps(db), [...ALL_STEP_IDS].sort());
    assert.deepEqual(db.prepare('SELECT id, profile_fingerprint FROM login_enterprises').all(), [
      { id: DEFAULT_ENTERPRISE_ID, profile_fingerprint: SEED.fingerprint },
    ]);
    const index = db.prepare(`
      SELECT name
      FROM pragma_index_list('login_tasks')
      WHERE name = 'idx_login_tasks_enterprise_status_created'
    `).get();
    assert.ok(index);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('a task needs an existing enterprise and can never move to another one', () => {
  const db = openR4Db();
  try {
    runMigrations(db, [SEED, OTHER]);
    assert.throws(() => insertTask(db, 'no-enterprise', null), /enterprise_id_required/);
    assert.throws(() => insertTask(db, 'unknown', 'unknown'), /FOREIGN KEY/);
    insertTask(db, 'contoso-task', OTHER.id);
    const move = db.prepare('UPDATE login_tasks SET enterprise_id = ? WHERE id = ?');
    assert.throws(() => move.run(OTHER.id, 'task-1'), /enterprise_id_immutable/);
    assert.throws(() => move.run(DEFAULT_ENTERPRISE_ID, 'contoso-task'), /enterprise_id_immutable/);
    assert.throws(() => move.run(null, 'task-1'), /enterprise_id_immutable/);
    assert.equal(move.run(DEFAULT_ENTERPRISE_ID, 'task-1').changes, 1, 'Writing the same value is allowed');
    db.prepare("UPDATE login_tasks SET status = 'failed' WHERE id = 'contoso-task'").run();
    const owners = db.prepare('SELECT id, enterprise_id FROM login_tasks ORDER BY id').all();
    assert.deepEqual(owners, [
      { id: 'contoso-task', enterprise_id: OTHER.id },
      { id: 'task-1', enterprise_id: DEFAULT_ENTERPRISE_ID },
      { id: 'task-2', enterprise_id: DEFAULT_ENTERPRISE_ID },
      { id: 'task-3', enterprise_id: DEFAULT_ENTERPRISE_ID },
    ]);
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
    const settings = rows(fresh, 'login_runtime_settings').map(({ updated_at: _updatedAt, ...row }) => row);
    assert.deepEqual(settings, [{
      id: 1,
      concurrency: 1,
      auth_timeout_ms: 60_000,
      auth_debug_logs: 0,
      auth_debug_artifacts: 0,
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
      assert.throws(() => runSqliteMigrations(db, [{ ...step, up: crash }]), /crash/);
      assert.deepEqual({ schema: schemaOf(db), data: snapshot(db) }, beforeCrash, step.id);
      assert.equal(appliedSteps(db).includes(step.id), false);
      assert.deepEqual(runMigrations(db, [SEED]), ALL_STEP_IDS.slice(index));
      assert.deepEqual(snapshot(db), expected, step.id);
      assert.deepEqual(schemaOf(db), expectedSchema, step.id);
    } finally {
      db.close();
    }
  });
});

test('a step whose DDL took effect without its record is re-applied safely', () => {
  const db = openR4Db();
  try {
    runMigrations(db, [SEED]);
    const expected = { schema: schemaOf(db), data: snapshot(db) };
    db.exec('DELETE FROM schema_migrations');
    assert.deepEqual(runMigrations(db, [SEED]), ALL_STEP_IDS);
    assert.deepEqual({ schema: schemaOf(db), data: snapshot(db) }, expected);
  } finally {
    db.close();
  }
});

test('pre-r4 databases gain attempt ids and history before the enterprise steps', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE login_tasks (
        id TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        sso_user TEXT NOT NULL,
        gh_login TEXT,
        sso_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        log_path TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      INSERT INTO login_tasks (id, identity, sso_user, gh_login, sso_type, created_at)
      VALUES ('legacy-task', 'alice', 'alice', 'alice_octo', 'custom', '2026-01-01T00:00:00.000Z');
    `);
    runMigrations(db, [SEED]);
    runMigrations(db, [SEED]);
    const task = db.prepare('SELECT id, oauth_attempt_id, enterprise_id FROM login_tasks').get();
    assert.deepEqual(task, { id: 'legacy-task', oauth_attempt_id: null, enterprise_id: DEFAULT_ENTERPRISE_ID });
    const attempts = db.prepare('SELECT id, task_id, history_incomplete FROM login_task_attempts').all();
    assert.deepEqual(attempts, [{ id: 'legacy-legacy-task', task_id: 'legacy-task', history_incomplete: 1 }]);
  } finally {
    db.close();
  }
});

test('runtime settings stay one global row that migrations never overwrite', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db, [SEED, OTHER]);
    db.prepare('UPDATE login_runtime_settings SET concurrency = 7 WHERE id = 1').run();
    runMigrations(db, [SEED, OTHER]);
    const settings = db.prepare('SELECT id, concurrency FROM login_runtime_settings').all();
    assert.deepEqual(settings, [{ id: 1, concurrency: 7 }]);
  } finally {
    db.close();
  }
});

test('identity changes are fatal only for an enterprise that has tasks', () => {
  const db = openR4Db();
  try {
    runMigrations(db, [SEED, OTHER]);
    const changedOther = { ...OTHER, fingerprint: 'd'.repeat(64) };
    runMigrations(db, [SEED, changedOther]);
    const fingerprint = db.prepare('SELECT profile_fingerprint FROM login_enterprises WHERE id = ?');
    assert.deepEqual(fingerprint.get(OTHER.id), { profile_fingerprint: changedOther.fingerprint });
    const changedDefault = { ...SEED, fingerprint: 'b'.repeat(64) };
    assert.throws(() => runMigrations(db, [changedDefault, changedOther]), (error: unknown) => (
      error instanceof EnterpriseIdentityError
      && error.code === 'enterprise_identity_changed'
      && error.enterpriseId === DEFAULT_ENTERPRISE_ID
    ));
    assert.deepEqual(fingerprint.get(DEFAULT_ENTERPRISE_ID), { profile_fingerprint: SEED.fingerprint });
  } finally {
    db.close();
  }
});

test('an enterprise with tasks cannot leave the registry; an empty one can', () => {
  const db = openR4Db();
  try {
    runMigrations(db, [SEED, OTHER]);
    runMigrations(db, [SEED]);
    insertTask(db, 'contoso-task', OTHER.id);
    assert.throws(() => runMigrations(db, [SEED]), (error: unknown) => (
      error instanceof EnterpriseIdentityError
      && error.code === 'enterprise_missing_from_registry'
      && error.enterpriseId === OTHER.id
    ));
    assert.doesNotThrow(() => runMigrations(db, [SEED, OTHER]));
  } finally {
    db.close();
  }
});

test('the fingerprint covers id, GitHub base URL and slug (case-insensitively), and nothing else', () => {
  const registry = (slug: string, ssoLoginUrl: string, oauthClientId: string) => parseRegistry({
    version: 1,
    enterprises: [{
      id: 'contoso-eu',
      github: { baseUrl: 'https://contoso.ghe.com', slug, oauthClientId },
      login: { ssoLoginUrl },
    }],
  }, { service: 'login' }).enterprises[0]!;
  const base = loginEnterpriseSeed(registry('contoso', 'http://sso/a', 'one')).fingerprint;
  assert.equal(loginEnterpriseSeed(registry('CONTOSO', 'http://sso/b', 'two')).fingerprint, base);
  assert.notEqual(loginEnterpriseSeed(registry('contoso-2', 'http://sso/a', 'one')).fingerprint, base);
  assert.match(base, /^[0-9a-f]{64}$/);
});

test('migrations need the default enterprise', () => {
  const db = new Database(':memory:');
  try {
    assert.throws(() => runMigrations(db, [OTHER]), /default enterprise/);
  } finally {
    db.close();
  }
});
