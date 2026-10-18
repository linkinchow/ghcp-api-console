import type Database from 'better-sqlite3';
import {
  addColumnIfMissing,
  DEFAULT_ENTERPRISE_ID,
  rebuildSqliteTable,
  runSqliteMigrations,
  type SqliteMigrationStep,
} from '@ghcp/shared';
import {
  CREATE_SSO_ENTERPRISES_SQL,
  insertEnterpriseIfMissing,
  syncEnterprises,
  type SsoEnterpriseSeed,
} from './enterpriseRepo.js';

/** `schema_migrations` ids of the multi-enterprise upgrade (design §4.3); never rename an applied id. */
export const ENTERPRISE_MIGRATION_IDS = {
  createEnterprises: 'enterprise-v1/01-create-sso-enterprises',
  users: 'enterprise-v1/02-users-enterprise',
  runtimeSettings: 'enterprise-v1/03-runtime-settings-enterprise',
  budgetCache: 'enterprise-v1/04-budget-cache-enterprise',
  importPlans: 'enterprise-v1/05-emu-import-plans-enterprise',
} as const;

const USER_COLUMNS = [
  'enterprise_id',
  'sso_user',
  'password_hash',
  'salt',
  'email',
  'role',
  'gh_login',
  'gh_scim_id',
  'emu_status',
  'copilot_seat_status',
  'copilot_seat_pending_cancellation_date',
  'copilot_seat_last_operation',
  'copilot_seat_last_error',
  'copilot_seat_updated_at',
  'created_at',
  'updated_at',
] as const;

const RUNTIME_SETTINGS_COLUMNS = [
  'enterprise_id',
  'max_sso_users',
  'user_prefix',
  'email_domain',
  'bulk_sync_concurrency',
  'scim_request_delay_ms',
  'scim_max_retries',
  'scim_retry_base_delay_ms',
  'version',
  'updated_at',
] as const;

const BUDGET_CACHE_COLUMNS = [
  'enterprise_id',
  'period_key',
  'year',
  'month',
  'quantity',
  'unit_type',
  'raw_json',
  'fetched_at',
] as const;

const IMPORT_PLAN_COLUMNS = ['enterprise_id', 'id', 'sso_user', 'status', 'created_at', 'updated_at', 'applied_at'];

/**
 * Brings any SSO database (fresh, r4 or older) to the multi-enterprise schema, then creates or verifies a row per
 * registry enterprise. A fresh database takes the same path as an upgraded one, so both end up identical.
 * Returns the enterprise step ids applied now.
 */
export function runMigrations(db: Database.Database, enterprises: readonly SsoEnterpriseSeed[]): string[] {
  const defaultSeed = enterprises.find((seed) => seed.id === DEFAULT_ENTERPRISE_ID);
  if (!defaultSeed) throw new Error('SSO migrations need the default enterprise.');
  runBaselineMigrations(db, defaultSeed);
  const applied = runSqliteMigrations(db, enterpriseSteps(defaultSeed));
  db.transaction(() => syncEnterprises(db, enterprises)).immediate();
  return applied;
}

/** The ordered steps of design §4.3; each one commits atomically with its `schema_migrations` record. */
export function enterpriseSteps(defaultSeed: SsoEnterpriseSeed): SqliteMigrationStep[] {
  return [
    { id: ENTERPRISE_MIGRATION_IDS.createEnterprises, up: (db) => createEnterprises(db, defaultSeed) },
    { id: ENTERPRISE_MIGRATION_IDS.users, up: migrateUsers, disableForeignKeys: true },
    { id: ENTERPRISE_MIGRATION_IDS.runtimeSettings, up: migrateRuntimeSettings, disableForeignKeys: true },
    { id: ENTERPRISE_MIGRATION_IDS.budgetCache, up: migrateBudgetCache, disableForeignKeys: true },
    { id: ENTERPRISE_MIGRATION_IDS.importPlans, up: migrateImportPlans, disableForeignKeys: true },
  ];
}

/**
 * The single-enterprise (r4) schema and its in-place column upgrades. On a migrated database every statement is a
 * no-op: the tables already exist and the old runtime settings row is only seeded while the `id` column exists.
 */
export function runBaselineMigrations(db: Database.Database, defaultSeed: SsoEnterpriseSeed): void {
  db.exec(BASELINE_SCHEMA_SQL);
  seedBaselineRuntimeSettings(db, defaultSeed);
  addColumnIfMissing(db, 'sso_emu_import_plan_rows', 'copilot_seat_status', 'TEXT');
  addColumnIfMissing(db, 'sso_users', 'copilot_seat_pending_cancellation_date', 'TEXT');
  if (addColumnIfMissing(db, 'sso_emu_import_plan_rows', 'copilot_seat_pending_cancellation_date', 'TEXT')) {
    db.prepare(`
      UPDATE sso_emu_import_plan_rows
      SET status = 'conflict', detail = ?
      WHERE status IN ('pending_create', 'pending_update')
    `).run('Seat synchronization changed. Preview again before applying this import.');
  }
  dropLegacyPasswordColumn(db);
}

const BASELINE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sso_users (
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

  CREATE TABLE IF NOT EXISTS sso_pool_managed_users (
    sso_user TEXT PRIMARY KEY REFERENCES sso_users(sso_user) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS sso_runtime_settings (
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

  CREATE TABLE IF NOT EXISTS sso_budget_cache (
    period_key TEXT PRIMARY KEY,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    unit_type TEXT,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sso_emu_import_plans (
    id TEXT PRIMARY KEY,
    sso_user TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    applied_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sso_emu_import_plan_rows (
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

  CREATE INDEX IF NOT EXISTS idx_sso_emu_import_plan_rows_status
    ON sso_emu_import_plan_rows (plan_id, status, row_index);
`;

/** The r4 single row (`id = 1`); after step 03 the table is keyed by enterprise and `syncEnterprises` seeds it. */
function seedBaselineRuntimeSettings(db: Database.Database, defaultSeed: SsoEnterpriseSeed): void {
  if (!hasColumn(db, 'sso_runtime_settings', 'id')) return;
  db.prepare(`
    INSERT OR IGNORE INTO sso_runtime_settings (
      id, max_sso_users, user_prefix, email_domain, bulk_sync_concurrency,
      scim_request_delay_ms, scim_max_retries, scim_retry_base_delay_ms, version, updated_at
    )
    VALUES (1, NULL, ?, ?, 3, 250, 3, 1000, 1, ?)
  `).run(defaultSeed.userPrefix, defaultSeed.emailDomain, new Date().toISOString());
}

function dropLegacyPasswordColumn(db: Database.Database): void {
  if (!hasColumn(db, 'sso_emu_import_plan_rows', 'password_for_login')) return;
  db.pragma('secure_delete = ON');
  db.exec('ALTER TABLE sso_emu_import_plan_rows DROP COLUMN password_for_login');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** Step 01: the enterprise table, with `default` as the owner of every pre-upgrade row. */
function createEnterprises(db: Database.Database, defaultSeed: SsoEnterpriseSeed): void {
  db.exec(CREATE_SSO_ENTERPRISES_SQL);
  insertEnterpriseIfMissing(db, defaultSeed);
}

/** Step 02: composite keys `(enterprise_id, sso_user)`; the pool marker follows its user. */
function migrateUsers(db: Database.Database): void {
  backfillEnterpriseColumn(db, 'sso_users');
  rebuildSqliteTable(db, {
    table: 'sso_users',
    createSql: createUsersSql,
    copyColumns: USER_COLUMNS,
    afterSql: [`
      CREATE INDEX IF NOT EXISTS idx_sso_users_enterprise_gh_login
        ON sso_users (enterprise_id, gh_login)
    `],
  });
  backfillEnterpriseColumn(db, 'sso_pool_managed_users');
  rebuildSqliteTable(db, {
    table: 'sso_pool_managed_users',
    createSql: createPoolManagedUsersSql,
    copyColumns: ['enterprise_id', 'sso_user'],
  });
}

/** Step 03: the old `id = 1` row becomes the `default` enterprise's row. */
function migrateRuntimeSettings(db: Database.Database): void {
  addColumnIfMissing(db, 'sso_runtime_settings', 'enterprise_id', 'TEXT');
  db.prepare(`
    UPDATE sso_runtime_settings
    SET enterprise_id = ?
    WHERE enterprise_id IS NULL
  `).run(DEFAULT_ENTERPRISE_ID);
  rebuildSqliteTable(db, {
    table: 'sso_runtime_settings',
    createSql: createRuntimeSettingsSql,
    copyColumns: RUNTIME_SETTINGS_COLUMNS,
  });
}

/** Step 04: one budget cache per enterprise and period. */
function migrateBudgetCache(db: Database.Database): void {
  backfillEnterpriseColumn(db, 'sso_budget_cache');
  rebuildSqliteTable(db, {
    table: 'sso_budget_cache',
    createSql: createBudgetCacheSql,
    copyColumns: BUDGET_CACHE_COLUMNS,
  });
}

/** Step 05: plans belong to an enterprise; their rows inherit it through `plan_id`. */
function migrateImportPlans(db: Database.Database): void {
  backfillEnterpriseColumn(db, 'sso_emu_import_plans');
  rebuildSqliteTable(db, {
    table: 'sso_emu_import_plans',
    createSql: createImportPlansSql,
    copyColumns: IMPORT_PLAN_COLUMNS,
    afterSql: [`
      CREATE INDEX IF NOT EXISTS idx_sso_emu_import_plans_enterprise
        ON sso_emu_import_plans (enterprise_id, created_at)
    `],
  });
}

/** Before the upgrade there was a single enterprise, so every existing row belongs to `default`. */
function backfillEnterpriseColumn(db: Database.Database, table: string): void {
  addColumnIfMissing(db, table, 'enterprise_id', 'TEXT');
  db.prepare(`
    UPDATE ${table}
    SET enterprise_id = ?
    WHERE enterprise_id IS NULL
  `).run(DEFAULT_ENTERPRISE_ID);
}

/** Keeps the baseline BINARY collation of `sso_user`; lookups stay case-insensitive through lower(). */
function createUsersSql(table: string): string {
  return `
    CREATE TABLE ${table} (
      enterprise_id TEXT NOT NULL REFERENCES sso_enterprises(id),
      sso_user TEXT NOT NULL,
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
      updated_at TEXT NOT NULL,
      PRIMARY KEY (enterprise_id, sso_user)
    )
  `;
}

function createPoolManagedUsersSql(table: string): string {
  return `
    CREATE TABLE ${table} (
      enterprise_id TEXT NOT NULL,
      sso_user TEXT NOT NULL,
      PRIMARY KEY (enterprise_id, sso_user),
      FOREIGN KEY (enterprise_id, sso_user) REFERENCES sso_users(enterprise_id, sso_user) ON DELETE RESTRICT
    )
  `;
}

function createRuntimeSettingsSql(table: string): string {
  return `
    CREATE TABLE ${table} (
      enterprise_id TEXT NOT NULL PRIMARY KEY REFERENCES sso_enterprises(id),
      max_sso_users INTEGER,
      user_prefix TEXT NOT NULL,
      email_domain TEXT NOT NULL,
      bulk_sync_concurrency INTEGER NOT NULL,
      scim_request_delay_ms INTEGER NOT NULL,
      scim_max_retries INTEGER NOT NULL,
      scim_retry_base_delay_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
}

function createBudgetCacheSql(table: string): string {
  return `
    CREATE TABLE ${table} (
      enterprise_id TEXT NOT NULL REFERENCES sso_enterprises(id),
      period_key TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      unit_type TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (enterprise_id, period_key)
    )
  `;
}

/** Plan ids stay globally unique (random batch ids); every lookup also filters by enterprise. */
function createImportPlansSql(table: string): string {
  return `
    CREATE TABLE ${table} (
      enterprise_id TEXT NOT NULL REFERENCES sso_enterprises(id),
      id TEXT NOT NULL PRIMARY KEY,
      sso_user TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT
    )
  `;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}
