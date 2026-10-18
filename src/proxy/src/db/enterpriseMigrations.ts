import type Database from 'better-sqlite3';
import {
  addColumnIfMissing,
  DEFAULT_ENTERPRISE_ID,
  runSqliteMigrations,
  type SqliteMigrationStep,
} from '@ghcp/shared';
import { ENTERPRISE_MIGRATION_IDS as IDS } from './enterpriseMigrationIds.js';
import { CREATE_PROXY_ENTERPRISES_SQL, ensureEnterprise, verifyEnterpriseIdentity } from './enterpriseRepo.js';
import type { EnterpriseSeed } from './enterpriseSeed.js';

/** Tables whose `enterprise_id` must be set on every INSERT (design §4.1 rule 4). */
type GuardedTable = 'proxy_accounts' | 'proxy_identity_initializations' | 'proxy_request_stats';

/**
 * The SQLite steps of design §4.2 that only need the base Proxy tables. Every `up` is idempotent: a fresh
 * database already has the columns, so the steps only add what is missing, backfill NULLs and create indexes
 * and triggers with IF NOT EXISTS.
 */
export function baseEnterpriseSteps(seed: EnterpriseSeed): SqliteMigrationStep[] {
  return [
    { id: IDS.createEnterprises, up: createEnterprisesTable },
    { id: IDS.seedDefault, up: (db) => seedDefault(db, seed) },
    { id: IDS.accounts, up: migrateAccounts },
    { id: IDS.accountGuards, up: createAccountGuards },
    { id: IDS.initializationsAndStats, up: migrateInitializationsAndStats },
  ];
}

/** Steps 06–07, run once the pool tables exist (UserPoolStore construction). */
export function poolEnterpriseSteps(): SqliteMigrationStep[] {
  return [
    { id: IDS.poolAccounts, up: migratePoolAccounts },
    { id: IDS.poolEvents, up: migratePoolEvents },
  ];
}

/**
 * Applies the base steps, then on every start re-seeds a missing `default` row and checks its identity.
 * Returns the step ids applied now.
 */
export function runEnterpriseMigrations(db: Database.Database, seed: EnterpriseSeed): string[] {
  assertDefaultSeed(seed);
  const applied = runSqliteMigrations(db, baseEnterpriseSteps(seed));
  db.transaction(() => {
    ensureEnterprise(db, seed);
    verifyEnterpriseIdentity(db, seed);
  }).immediate();
  return applied;
}

export function runPoolEnterpriseMigrations(db: Database.Database): string[] {
  return runSqliteMigrations(db, poolEnterpriseSteps());
}

function createEnterprisesTable(db: Database.Database): void {
  db.exec(CREATE_PROXY_ENTERPRISES_SQL);
}

function seedDefault(db: Database.Database, seed: EnterpriseSeed): void {
  ensureEnterprise(db, seed);
}

function migrateAccounts(db: Database.Database): void {
  addColumnIfMissing(db, 'proxy_accounts', 'enterprise_id', 'TEXT REFERENCES proxy_enterprises(id)');
  backfillDefault(db, 'proxy_accounts');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_proxy_accounts_identity_enterprise
      ON proxy_accounts(identity, enterprise_id);
    CREATE INDEX IF NOT EXISTS idx_proxy_accounts_enterprise_updated
      ON proxy_accounts(enterprise_id, updated_at);
  `);
  assertAccountsReferenceEnterprises(db);
}

function createAccountGuards(db: Database.Database): void {
  db.exec(requiredTriggerSql('proxy_accounts'));
  // NULL -> value stays allowed so a backfill can never be blocked by its own guard.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS proxy_accounts_enterprise_immutable
      BEFORE UPDATE OF enterprise_id ON proxy_accounts
      WHEN OLD.enterprise_id IS NOT NULL
        AND NEW.enterprise_id IS NOT OLD.enterprise_id
    BEGIN
      SELECT RAISE(ABORT, 'enterprise_id_immutable');
    END
  `);
}

function migrateInitializationsAndStats(db: Database.Database): void {
  addColumnIfMissing(db, 'proxy_identity_initializations', 'enterprise_id', 'TEXT');
  backfillDefault(db, 'proxy_identity_initializations');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_proxy_identity_initializations_enterprise
      ON proxy_identity_initializations(enterprise_id)
  `);
  db.exec(requiredTriggerSql('proxy_identity_initializations'));
  addColumnIfMissing(db, 'proxy_request_stats', 'enterprise_id', 'TEXT');
  backfillDefault(db, 'proxy_request_stats');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_proxy_request_stats_enterprise_time
      ON proxy_request_stats(enterprise_id, requested_at, id)
  `);
  db.exec(requiredTriggerSql('proxy_request_stats'));
}

function migratePoolAccounts(db: Database.Database): void {
  addColumnIfMissing(db, 'user_pool_accounts', 'enterprise_id', 'TEXT');
  db.exec(`
    UPDATE user_pool_accounts
    SET enterprise_id = (
      SELECT a.enterprise_id
      FROM proxy_accounts a
      WHERE a.identity = user_pool_accounts.identity
    )
    WHERE enterprise_id IS NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_pool_accounts_enterprise_state
      ON user_pool_accounts(enterprise_id, state, updated_at, ordinal)
  `);
  createPoolAccountGuards(db);
}

/** SQLite stand-in for MySQL's composite FK (identity, enterprise_id) -> proxy_accounts. */
function createPoolAccountGuards(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS user_pool_accounts_enterprise_matches
      BEFORE INSERT ON user_pool_accounts
      WHEN NEW.enterprise_id IS NULL
        OR NEW.enterprise_id IS NOT (
          SELECT a.enterprise_id
          FROM proxy_accounts a
          WHERE a.identity = NEW.identity
        )
    BEGIN
      SELECT RAISE(ABORT, 'enterprise_id_mismatch');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS user_pool_accounts_enterprise_immutable
      BEFORE UPDATE OF enterprise_id ON user_pool_accounts
      WHEN OLD.enterprise_id IS NOT NULL
        AND NEW.enterprise_id IS NOT OLD.enterprise_id
    BEGIN
      SELECT RAISE(ABORT, 'enterprise_id_immutable');
    END
  `);
}

/** Events stay nullable (global events have no enterprise); every pre-upgrade event belongs to `default`. */
function migratePoolEvents(db: Database.Database): void {
  addColumnIfMissing(db, 'user_pool_events', 'enterprise_id', 'TEXT');
  db.prepare(`
    UPDATE user_pool_events
    SET enterprise_id = ?
    WHERE enterprise_id IS NULL
  `).run(DEFAULT_ENTERPRISE_ID);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_pool_events_enterprise
      ON user_pool_events(enterprise_id, at, id)
  `);
}

/** Before the upgrade there was a single enterprise, so every existing row belongs to `default`. */
function backfillDefault(db: Database.Database, table: GuardedTable): void {
  db.prepare(`
    UPDATE ${table}
    SET enterprise_id = ?
    WHERE enterprise_id IS NULL
  `).run(DEFAULT_ENTERPRISE_ID);
}

function requiredTriggerSql(table: GuardedTable): string {
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_enterprise_required
      BEFORE INSERT ON ${table}
      WHEN NEW.enterprise_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'enterprise_id_required');
    END
  `;
}

function assertAccountsReferenceEnterprises(db: Database.Database): void {
  const violations = db.pragma('foreign_key_check(proxy_accounts)') as unknown[];
  if (violations.length > 0) throw new Error('proxy_accounts.enterprise_id references a missing enterprise.');
}

function assertDefaultSeed(seed: EnterpriseSeed): void {
  if (seed.id === DEFAULT_ENTERPRISE_ID) return;
  throw new Error('Proxy migrations must be seeded with the default enterprise.');
}
