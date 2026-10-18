import type Database from 'better-sqlite3';
import {
  addColumnIfMissing,
  DEFAULT_ENTERPRISE_ID,
  runSqliteMigrations,
  type SqliteMigrationStep,
} from '@ghcp/shared';
import {
  CREATE_LOGIN_ENTERPRISES_SQL,
  insertEnterpriseIfMissing,
  syncEnterprises,
  type LoginEnterpriseSeed,
} from './enterpriseRepo.js';

/** `schema_migrations` ids of the multi-enterprise upgrade (design §4.4); never rename an applied id. */
export const ENTERPRISE_MIGRATION_IDS = {
  createEnterprises: 'enterprise-v1/01-create-login-enterprises',
  tasks: 'enterprise-v1/02-tasks-enterprise',
  taskGuards: 'enterprise-v1/03-tasks-enterprise-guards',
} as const;

/**
 * Brings any Login database (fresh, r4 or older) to the multi-enterprise schema, then creates or verifies a row
 * per registry enterprise. A fresh database takes the same path as an upgraded one, so both end up identical.
 * Returns the enterprise step ids applied now.
 */
export function runMigrations(db: Database.Database, enterprises: readonly LoginEnterpriseSeed[]): string[] {
  const defaultSeed = enterprises.find((seed) => seed.id === DEFAULT_ENTERPRISE_ID);
  if (!defaultSeed) throw new Error('Login migrations need the default enterprise.');
  runBaselineMigrations(db);
  const applied = runSqliteMigrations(db, enterpriseSteps(defaultSeed));
  db.transaction(() => syncEnterprises(db, enterprises)).immediate();
  return applied;
}

/** The ordered steps of design §4.4; each one commits atomically with its `schema_migrations` record. */
export function enterpriseSteps(defaultSeed: LoginEnterpriseSeed): SqliteMigrationStep[] {
  return [
    { id: ENTERPRISE_MIGRATION_IDS.createEnterprises, up: (db) => createEnterprises(db, defaultSeed) },
    { id: ENTERPRISE_MIGRATION_IDS.tasks, up: migrateTasks },
    { id: ENTERPRISE_MIGRATION_IDS.taskGuards, up: createTaskGuards },
  ];
}

/** The single-enterprise (r4) schema and its in-place column upgrades; a no-op on a migrated database. */
export function runBaselineMigrations(db: Database.Database): void {
  db.exec(`
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
  `);
  addColumnIfMissing(db, 'login_tasks', 'oauth_attempt_id', 'TEXT');
  addColumnIfMissing(db, 'login_tasks', 'stage', 'TEXT');
  addColumnIfMissing(db, 'login_tasks', 'stage_updated_at', 'TEXT');
  addColumnIfMissing(db, 'login_tasks', 'failure_code', 'TEXT');
  addColumnIfMissing(db, 'login_tasks', 'queued_at', 'TEXT');
  // Holds the stage a delete attempt overwrote so a failed delete can restore it instead of
  // collapsing the stage back to the plain status and losing the diagnostic detail.
  addColumnIfMissing(db, 'login_tasks', 'prior_stage', 'TEXT');
  db.exec(`
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
    INSERT OR IGNORE INTO login_task_attempts (
      id, task_id, attempt_number, status, failure_reason, log_path, queued_at,
      started_at, finished_at, history_incomplete
    )
    SELECT oauth_attempt_id, id, MAX(attempts, 1), status, failure_reason, log_path,
      created_at, started_at, finished_at, 1
    FROM login_tasks WHERE oauth_attempt_id IS NOT NULL;
    INSERT OR IGNORE INTO login_task_attempts (
      id, task_id, attempt_number, status, failure_reason, log_path, queued_at,
      started_at, finished_at, history_incomplete
    )
    SELECT 'legacy-' || id, id, MAX(attempts, 1), status, failure_reason, log_path,
      created_at, started_at, finished_at, 1
    FROM login_tasks WHERE oauth_attempt_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_login_tasks_failure_created ON login_tasks(failure_code, created_at, id);
  `);
  addAttemptNumberUniqueIndex(db);
}

/**
 * Makes `attempt_number` unique per task. The number is derived with `MAX(attempt_number) + 1`, so
 * without this index two writers against the same database file would silently produce two
 * "attempt 3" rows and the attempt history would read as if one of them never happened.
 *
 * Skipped when historical rows already collide: failing startup on data a running deployment
 * already contains would be worse than leaving the old rows unconstrained.
 */
function addAttemptNumberUniqueIndex(db: Database.Database): void {
  const duplicate = db.prepare(`
    SELECT 1 FROM login_task_attempts GROUP BY task_id, attempt_number HAVING COUNT(*) > 1 LIMIT 1
  `).get();
  if (duplicate) return;
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_login_attempts_task_number ON login_task_attempts(task_id, attempt_number)');
}

/** Step 01: the enterprise table, with `default` as the owner of every pre-upgrade task. */
function createEnterprises(db: Database.Database, defaultSeed: LoginEnterpriseSeed): void {
  db.exec(CREATE_LOGIN_ENTERPRISES_SQL);
  insertEnterpriseIfMissing(db, defaultSeed);
}

/** Step 02: before the upgrade there was a single enterprise, so every existing task belongs to `default`. */
function migrateTasks(db: Database.Database): void {
  addColumnIfMissing(db, 'login_tasks', 'enterprise_id', 'TEXT REFERENCES login_enterprises(id)');
  db.prepare(`
    UPDATE login_tasks
    SET enterprise_id = ?
    WHERE enterprise_id IS NULL
  `).run(DEFAULT_ENTERPRISE_ID);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_login_tasks_enterprise_status_created
      ON login_tasks (enterprise_id, status, created_at)
  `);
}

/** Step 03: the added column cannot be NOT NULL, so triggers require it and keep a task in its enterprise. */
function createTaskGuards(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS login_tasks_enterprise_required
    BEFORE INSERT ON login_tasks
    FOR EACH ROW
    WHEN NEW.enterprise_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'enterprise_id_required');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS login_tasks_enterprise_immutable
    BEFORE UPDATE OF enterprise_id ON login_tasks
    FOR EACH ROW
    WHEN NEW.enterprise_id IS NOT OLD.enterprise_id
    BEGIN
      SELECT RAISE(ABORT, 'enterprise_id_immutable');
    END
  `);
}
