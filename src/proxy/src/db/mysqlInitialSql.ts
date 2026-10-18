import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { POOL_SCHEMA_MIGRATION } from '../userPool/mysqlMigrations.js';
import { ENTERPRISE_MIGRATION_IDS } from './enterpriseMigrationIds.js';
import {
  MYSQL_BASE_ENTERPRISE_STEPS,
  MYSQL_POOL_ENTERPRISE_STEPS,
  type MysqlMigrationStep,
} from './mysqlEnterpriseMigrations.js';
import { INITIAL_SCHEMA_MIGRATION, TOKEN_COLLATION_MIGRATION } from './mysqlMigrations.js';
import { MYSQL_BASE_TABLES, MYSQL_CREDENTIAL_FENCE_DDL, MYSQL_POOL_TABLES, mysqlCreateTable } from './mysqlSchema.js';

/**
 * Renders scripts/proxy-mysql-initial.sql for deployments that run Proxy with MYSQL_AUTO_MIGRATE=false.
 * It is generated from MYSQL_SCHEMA, the same definition auto-migration creates and startup validates,
 * so the manual script cannot drift from what Proxy accepts. Regenerate with `npm run mysql:initial-sql`.
 */
export function renderMysqlInitialSql(): string {
  const migrations = [INITIAL_SCHEMA_MIGRATION, TOKEN_COLLATION_MIGRATION,
    ...schemaStepIds(MYSQL_BASE_ENTERPRISE_STEPS)];
  return [
    '-- GENERATED FILE: do not edit. Regenerate with `npm --workspace @ghcp/proxy run mysql:initial-sql`.',
    '-- Prepares the Proxy MySQL schema for MYSQL_AUTO_MIGRATE=false. Run as an administrator account.',
    '--',
    '-- Runtime account privileges on this database:',
    '--   SELECT, INSERT, UPDATE, DELETE',
    '--   plus TRIGGER on proxy_accounts when the user pool is enabled (caller-lease mode):',
    '--   MySQL only shows trigger metadata to accounts holding TRIGGER, and Proxy verifies the',
    '--   credential fence trigger at startup.',
    '--',
    '-- The `default` row of proxy_enterprises is not created here: its identity fingerprint and cap',
    '-- come from the deployment configuration. Proxy inserts it at its first start (INSERT only).',
    '',
    'CREATE DATABASE IF NOT EXISTS ghcp_proxy',
    '  CHARACTER SET utf8mb4',
    '  COLLATE utf8mb4_0900_ai_ci;',
    '',
    'USE ghcp_proxy;',
    '',
    '-- If the database already exists, start here.',
    ...MYSQL_BASE_TABLES.map((table) => `${mysqlCreateTable(table)};\n`),
    ...migrations.map(migrationRecord),
    '',
    '-- User pool (caller-lease mode). Safe to apply even when the pool is disabled.',
    ...MYSQL_POOL_TABLES.map((table) => `${mysqlCreateTable(table)};\n`),
    'DELIMITER //',
    `${MYSQL_CREDENTIAL_FENCE_DDL}//`,
    'DELIMITER ;',
    '',
    ...[POOL_SCHEMA_MIGRATION, ...schemaStepIds(MYSQL_POOL_ENTERPRISE_STEPS)].map(migrationRecord),
    '',
  ].join('\n');
}

/**
 * Renders scripts/proxy-mysql-enterprise-upgrade.sql: the multi-enterprise steps of design §4.2 for a
 * single-enterprise (r4) database, from the same step definitions auto-migration runs.
 */
export function renderMysqlEnterpriseUpgradeSql(): string {
  return [
    '-- GENERATED FILE: do not edit. Regenerate with',
    '-- `npm --workspace @ghcp/proxy run mysql:enterprise-upgrade-sql`.',
    '--',
    '-- Upgrades a single-enterprise (r4) Proxy MySQL schema to multi-enterprise for MYSQL_AUTO_MIGRATE=false.',
    '-- Back up the database and stop every Proxy replica first. Run once, as an administrator account,',
    '-- against the Proxy database, e.g. `mysql ghcp_proxy < proxy-mysql-enterprise-upgrade.sql`.',
    '-- The statements are not idempotent. If the script stops part way, either restore the backup, or start',
    '-- one Proxy replica with MYSQL_AUTO_MIGRATE=true: it detects the applied statements and finishes the rest.',
    '--',
    '-- The `default` enterprise row is inserted with an empty profile_fingerprint and a placeholder cap.',
    '-- At its next start Proxy completes it from its configuration: fingerprint, the pool cap persisted in',
    '-- user_pool_settings, and the pool member count. It also rewrites the pool configuration fingerprint',
    '-- (step 08). Both need only the runtime privileges; replicas of the previous release then fail to start.',
    '-- No new triggers and no new privileges are required.',
    '',
    ...renderSteps(MYSQL_BASE_ENTERPRISE_STEPS),
    '-- User pool tables. Skip this section if the database has no user_pool_accounts table; the pool section',
    '-- of proxy-mysql-initial.sql creates the final tables if the pool is enabled later.',
    '',
    ...renderSteps(MYSQL_POOL_ENTERPRISE_STEPS),
  ].join('\n');
}

function renderSteps(steps: readonly MysqlMigrationStep[]): string[] {
  return steps.flatMap((step) => [
    `-- ${step.id}`,
    ...step.changes.map((change) => `${change.sql};\n`),
    migrationRecord(step.id),
    '',
  ]);
}

/** Step 02 is completed by Proxy itself: it needs the deployment's identity. */
function schemaStepIds(steps: readonly MysqlMigrationStep[]): string[] {
  return steps.map((step) => step.id).filter((id) => id !== ENTERPRISE_MIGRATION_IDS.seedDefault);
}

function migrationRecord(id: string): string {
  return `INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('${id}', UTC_TIMESTAMP(3));`;
}

const RENDERERS: Record<string, () => string> = {
  initial: renderMysqlInitialSql,
  'enterprise-upgrade': renderMysqlEnterpriseUpgradeSql,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, kind = 'initial'] = process.argv.slice(2);
  const render = RENDERERS[kind];
  if (!target || !render) {
    throw new Error('Usage: tsx src/db/mysqlInitialSql.ts <output.sql> [initial|enterprise-upgrade]');
  }
  await writeFile(target, render());
}
