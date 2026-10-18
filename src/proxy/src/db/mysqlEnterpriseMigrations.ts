import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import { ENTERPRISE_MIGRATION_IDS as IDS } from './enterpriseMigrationIds.js';
import type { EnterpriseSeed } from './enterpriseSeed.js';
import { MYSQL_SCHEMA, mysqlCreateTable, mysqlForeignKey, mysqlUniqueKey, parseMysqlKey } from './mysqlSchema.js';

/**
 * One statement of a multi-enterprise step (design §4.2). MySQL DDL auto-commits, so every statement is
 * guarded on its own: after a crash, `isApplied` reads information_schema and the step resumes where it stopped.
 */
export interface MysqlSchemaChange {
  sql: string;
  isApplied(connection: PoolConnection): Promise<boolean>;
}

export interface MysqlMigrationStep {
  id: string;
  changes: MysqlSchemaChange[];
}

/**
 * The DBA upgrade script cannot know the deployment's identity or cap, so it stores this fingerprint.
 * Proxy completes such a row at its next start (`verifyDefaultEnterprise`).
 */
export const PENDING_ENTERPRISE_FINGERPRINT = '';

const ENTERPRISE_COLUMN = 'enterprise_id';
const DB_NOW_MS = "(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000)";
/** `POOL_MAX_ACCOUNTS`'s default; only a placeholder until Proxy completes a pending row. */
const PENDING_MAX_ACCOUNTS = 100;

/** Steps 01–05: the base Proxy tables. Fresh databases already have them, so only the records are written. */
export const MYSQL_BASE_ENTERPRISE_STEPS: readonly MysqlMigrationStep[] = [
  { id: IDS.createEnterprises, changes: [createTable('proxy_enterprises')] },
  { id: IDS.seedDefault, changes: [pendingDefaultEnterprise()] },
  { id: IDS.accounts, changes: [
    addEnterpriseColumn('proxy_accounts'),
    addUniqueKey('proxy_accounts', 'uq_proxy_accounts_identity_enterprise'),
    addIndex('proxy_accounts', 'idx_proxy_accounts_enterprise_updated'),
    addForeignKey('proxy_accounts', 'fk_proxy_accounts_enterprise'),
  ] },
  { id: IDS.accountGuards, changes: [dropTemporaryDefault('proxy_accounts')] },
  { id: IDS.initializationsAndStats, changes: [
    addEnterpriseColumn('proxy_identity_initializations'),
    addIndex('proxy_identity_initializations', 'idx_proxy_identity_initializations_enterprise'),
    dropTemporaryDefault('proxy_identity_initializations'),
    addEnterpriseColumn('proxy_request_stats'),
    addIndex('proxy_request_stats', 'idx_proxy_request_stats_enterprise_time', true),
    dropTemporaryDefault('proxy_request_stats'),
  ] },
];

/** Steps 06–07: the user pool tables, once they exist. Step 08 needs the pool configuration (userPool/). */
export const MYSQL_POOL_ENTERPRISE_STEPS: readonly MysqlMigrationStep[] = [
  { id: IDS.poolAccounts, changes: [
    addEnterpriseColumn('user_pool_accounts'),
    addIndex('user_pool_accounts', 'idx_user_pool_accounts_enterprise_state'),
    addIndex('user_pool_accounts', 'idx_user_pool_accounts_member_enterprise'),
    addForeignKey('user_pool_accounts', 'fk_user_pool_account_enterprise'),
    dropTemporaryDefault('user_pool_accounts'),
  ] },
  { id: IDS.poolEvents, changes: [
    addEnterpriseColumn('user_pool_events'),
    backfillPoolEvents(),
    addIndex('user_pool_events', 'idx_user_pool_events_enterprise'),
  ] },
];

/** Runs every unrecorded step in order and records it. Returns the ids recorded now. */
export async function runMysqlMigrationSteps(connection: PoolConnection,
  steps: readonly MysqlMigrationStep[]): Promise<string[]> {
  const recorded = await recordedMigrations(connection);
  const applied: string[] = [];
  for (const step of steps) {
    if (recorded.has(step.id)) continue;
    await applyChanges(connection, step.changes);
    await recordMigration(connection, step.id);
    applied.push(step.id);
  }
  return applied;
}

async function applyChanges(connection: PoolConnection, changes: readonly MysqlSchemaChange[]): Promise<void> {
  for (const change of changes) {
    if (!await change.isApplied(connection)) await connection.query(change.sql);
  }
}

export async function recordedMigrations(connection: PoolConnection): Promise<Set<string>> {
  if (!await tableExists(connection, 'schema_migrations')) return new Set();
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT id
    FROM schema_migrations
  `);
  return new Set(rows.map((row) => String(row.id)));
}

export async function recordMigration(connection: PoolConnection, id: string): Promise<void> {
  await connection.query(mysqlMigrationRecordSql(), [id]);
}

export function mysqlMigrationRecordSql(id = '?'): string {
  return `INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (${id}, UTC_TIMESTAMP(3))`;
}

export function allRecorded(recorded: ReadonlySet<string>, steps: readonly MysqlMigrationStep[]): boolean {
  return steps.every((step) => recorded.has(step.id));
}

/**
 * Step 02 at runtime: an upgraded pool keeps its persisted cap and starts with its current member count.
 * INSERT IGNORE needs only the runtime INSERT privilege, so MYSQL_AUTO_MIGRATE=false uses it too.
 */
export async function insertDefaultEnterprise(connection: PoolConnection, seed: EnterpriseSeed): Promise<void> {
  assertDefaultSeed(seed);
  await connection.query(`
    INSERT IGNORE INTO proxy_enterprises (
      id, state, max_accounts, inventory_count, profile_fingerprint, created_at, updated_at
    )
    VALUES (?, 'active', ?, ?, ?, ${DB_NOW_MS}, ${DB_NOW_MS})
  `, [seed.id, await initialCap(connection, seed), await poolInventory(connection), seed.fingerprint]);
}

/**
 * Identity check on every start (design §3.6). A changed fingerprint is accepted only while the enterprise has
 * no pool members; a row left pending by the DBA script is completed from the current configuration.
 */
export async function verifyDefaultEnterprise(connection: PoolConnection, seed: EnterpriseSeed): Promise<void> {
  assertDefaultSeed(seed);
  const row = await enterpriseIdentity(connection, seed.id);
  if (!row) throw new Error(`The "${seed.id}" enterprise is missing from proxy_enterprises.`);
  if (row.profile_fingerprint === seed.fingerprint) return;
  if (row.profile_fingerprint === PENDING_ENTERPRISE_FINGERPRINT) return completePendingEnterprise(connection, seed);
  if (Number(row.inventory_count) > 0) throw identityChanged(seed.id);
  await connection.query(`
    UPDATE proxy_enterprises
    SET profile_fingerprint = ?, updated_at = ${DB_NOW_MS}
    WHERE id = ? AND inventory_count = 0
  `, [seed.fingerprint, seed.id]);
}

function identityChanged(id: string): Error {
  return new Error(`enterprise_identity_changed: enterprise "${id}" has pool members, but its GitHub base URL, `
    + 'shortcode or pool account domain changed. Restore the previous configuration.');
}

async function completePendingEnterprise(connection: PoolConnection, seed: EnterpriseSeed): Promise<void> {
  await connection.query(`
    UPDATE proxy_enterprises
    SET profile_fingerprint = ?, max_accounts = ?, inventory_count = ?, updated_at = ${DB_NOW_MS}
    WHERE id = ? AND profile_fingerprint = ?
  `, [seed.fingerprint, await initialCap(connection, seed), await poolInventory(connection), seed.id,
    PENDING_ENTERPRISE_FINGERPRINT]);
}

async function enterpriseIdentity(connection: PoolConnection, id: string): Promise<RowDataPacket | undefined> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT profile_fingerprint, inventory_count
    FROM proxy_enterprises
    WHERE id = ?
  `, [id]);
  return rows[0];
}

async function initialCap(connection: PoolConnection, seed: EnterpriseSeed): Promise<number> {
  if (!await tableExists(connection, 'user_pool_settings')) return seed.maxAccounts;
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT max_accounts
    FROM user_pool_settings
    WHERE id = 1
  `);
  return rows[0] ? Number(rows[0].max_accounts) : seed.maxAccounts;
}

async function poolInventory(connection: PoolConnection): Promise<number> {
  if (!await tableExists(connection, 'user_pool_accounts')) return 0;
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT COUNT(*) AS n
    FROM user_pool_accounts
  `);
  return Number(rows[0].n);
}

function assertDefaultSeed(seed: EnterpriseSeed): void {
  if (seed.id !== DEFAULT_ENTERPRISE_ID) {
    throw new Error('Proxy migrations must be seeded with the default enterprise.');
  }
}

function createTable(table: string): MysqlSchemaChange {
  return { sql: mysqlCreateTable(table), isApplied: (connection) => tableExists(connection, table) };
}

function pendingDefaultEnterprise(): MysqlSchemaChange {
  return {
    sql: `INSERT IGNORE INTO proxy_enterprises (
  id, state, max_accounts, inventory_count, profile_fingerprint, created_at, updated_at
)
SELECT
  '${DEFAULT_ENTERPRISE_ID}', 'active', ${PENDING_MAX_ACCOUNTS}, 0, '${PENDING_ENTERPRISE_FINGERPRINT}', now_ms, now_ms
FROM (SELECT ${DB_NOW_MS} AS now_ms) AS clock`,
    isApplied: async (connection) => Boolean(await enterpriseIdentity(connection, DEFAULT_ENTERPRISE_ID)),
  };
}

/** Appended with a temporary default: INSTANT DDL that leaves existing rows in `default` without a rewrite. */
function addEnterpriseColumn(table: string): MysqlSchemaChange {
  const definition = MYSQL_SCHEMA[table].columns[ENTERPRISE_COLUMN];
  const temporary = definition.includes('NOT NULL') ? ` DEFAULT '${DEFAULT_ENTERPRISE_ID}'` : '';
  return {
    sql: `ALTER TABLE ${table}\n  ADD COLUMN ${ENTERPRISE_COLUMN} ${definition}${temporary}`,
    isApplied: async (connection) => Boolean(await enterpriseColumn(connection, table)),
  };
}

/** After this metadata-only change an INSERT without `enterprise_id` fails, so old replicas fail closed. */
function dropTemporaryDefault(table: string): MysqlSchemaChange {
  return {
    sql: `ALTER TABLE ${table}\n  ALTER COLUMN ${ENTERPRISE_COLUMN} DROP DEFAULT`,
    isApplied: async (connection) => (await enterpriseColumn(connection, table))?.COLUMN_DEFAULT === null,
  };
}

function addIndex(table: string, name: string, online = false): MysqlSchemaChange {
  const spec = schemaKey(MYSQL_SCHEMA[table].indexes, name);
  const algorithm = online ? ',\n  ALGORITHM=INPLACE,\n  LOCK=NONE' : '';
  return {
    sql: `ALTER TABLE ${table}\n  ADD INDEX ${spec}${algorithm}`,
    isApplied: (connection) => indexExists(connection, table, name),
  };
}

function addUniqueKey(table: string, name: string): MysqlSchemaChange {
  const spec = schemaKey(MYSQL_SCHEMA[table].unique, name);
  return {
    sql: `ALTER TABLE ${table}\n  ADD ${mysqlUniqueKey(spec)}`,
    isApplied: (connection) => indexExists(connection, table, name),
  };
}

function addForeignKey(table: string, name: string): MysqlSchemaChange {
  const foreign = MYSQL_SCHEMA[table].foreign?.find((key) => key[4] === name);
  if (!foreign) throw new Error(`MYSQL_SCHEMA.${table} has no foreign key ${name}`);
  return {
    sql: `ALTER TABLE ${table}\n  ADD ${mysqlForeignKey(table, foreign, '\n  ')}`,
    isApplied: (connection) => foreignKeyExists(connection, table, name),
  };
}

/** Every event written before the upgrade belongs to the single enterprise; later global events stay NULL. */
function backfillPoolEvents(): MysqlSchemaChange {
  return {
    sql: [
      'UPDATE user_pool_events',
      `SET ${ENTERPRISE_COLUMN} = '${DEFAULT_ENTERPRISE_ID}'`,
      `WHERE ${ENTERPRISE_COLUMN} IS NULL`,
    ].join('\n'),
    isApplied: async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(`
        SELECT 1
        FROM user_pool_events
        WHERE ${ENTERPRISE_COLUMN} IS NULL
        LIMIT 1
      `);
      return rows.length === 0;
    },
  };
}

function schemaKey(specs: readonly string[] | undefined, name: string): string {
  const spec = specs?.find((candidate) => parseMysqlKey(candidate).name === name);
  if (!spec) throw new Error(`MYSQL_SCHEMA has no key ${name}`);
  return spec;
}

export async function tableExists(connection: PoolConnection, table: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT 1
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
  `, [table]);
  return rows.length > 0;
}

export async function enterpriseColumn(connection: PoolConnection, table: string): Promise<RowDataPacket | undefined> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT COLUMN_DEFAULT
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
  `, [table, ENTERPRISE_COLUMN]);
  return rows[0];
}

async function indexExists(connection: PoolConnection, table: string, name: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT 1
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
    LIMIT 1
  `, [table, name]);
  return rows.length > 0;
}

async function foreignKeyExists(connection: PoolConnection, table: string, name: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT 1
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  `, [table, name]);
  return rows.length > 0;
}
