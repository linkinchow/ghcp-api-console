import Database from 'better-sqlite3';
import {
  createPool,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import { defaultEnterpriseSeed, type EnterpriseSeed } from '../../src/proxy/src/db/enterpriseSeed.js';
import { runMysqlMigrations } from '../../src/proxy/src/db/mysqlMigrations.js';

interface SqliteAccountRow {
  identity: string;
  sso_user: string;
  gh_login: string | null;
  copilot_oauth_token: string | null;
  copilot_oauth_status: string;
  copilot_oauth_updated_at: string | null;
  copilot_oauth_attempt_id: string | null;
  created_at: string;
  updated_at: string;
  enterprise_id: string | null;
}

interface SqliteStatRow {
  id: string;
  identity: string;
  gh_login: string | null;
  requested_at: string;
  path: string;
  model: string | null;
  success: number;
  failure_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  cache_input_tokens: number | null;
  cache_write_tokens: number | null;
  enterprise_id: string | null;
}

/** A `proxy_enterprises` row, as both SQLite and MySQL store it. */
interface EnterpriseRow {
  id: string;
  state: string;
  max_accounts: number;
  inventory_count: number;
  policy_version: number;
  profile_fingerprint: string;
  created_at: number;
  updated_at: number;
}

/** `single-enterprise`: r4 schema without `enterprise_id`; every row belongs to `default`. */
type SourceShape = 'single-enterprise' | 'multi-enterprise';

interface SourceData {
  shape: SourceShape;
  accounts: SqliteAccountRow[];
  requestStats: SqliteStatRow[];
  /** The source's `default` row; absent for single-enterprise sources. */
  enterprise?: EnterpriseRow;
}

interface TargetState {
  exists: boolean;
  accounts: number;
  requestStats: number;
  /** Enterprises other than `default`, plus a `default` that already counts pool members. */
  usedEnterprises: number;
}

export interface MigrationOptions {
  sqlitePath: string;
  mysqlUrl: string;
  dryRun?: boolean;
  progress?: (message: string) => void;
  /** The Proxy's environment; the `default` enterprise seed comes from it. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface MigrationResult {
  accounts: number;
  requestStats: number;
  dryRun: boolean;
}

const REQUIRED_ACCOUNT_COLUMNS = [
  'identity',
  'sso_user',
  'gh_login',
  'copilot_oauth_token',
  'copilot_oauth_status',
  'copilot_oauth_updated_at',
  'copilot_oauth_attempt_id',
  'created_at',
  'updated_at',
];

const REQUIRED_STAT_COLUMNS = [
  'id',
  'identity',
  'gh_login',
  'requested_at',
  'path',
  'model',
  'success',
  'failure_reason',
  'input_tokens',
  'output_tokens',
  'cache_tokens',
  'cache_input_tokens',
  'cache_write_tokens',
];

const REQUIRED_ENTERPRISE_COLUMNS = [
  'id',
  'state',
  'max_accounts',
  'inventory_count',
  'policy_version',
  'profile_fingerprint',
  'created_at',
  'updated_at',
];

/** Tables that gain `enterprise_id` in the multi-enterprise schema and are copied by this tool. */
const ENTERPRISE_TABLES = ['proxy_accounts', 'proxy_request_stats'];
const COPY_BATCH_SIZE = 500;
const MIGRATE_HINT = 'Start the current Proxy once in SQLite mode to apply schema migrations before upgrading.';

export async function migrateSqliteToMysql(options: MigrationOptions): Promise<MigrationResult> {
  const progress = options.progress ?? (() => undefined);
  const source = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  const pool = createPool({
    uri: options.mysqlUrl,
    connectionLimit: 2,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  try {
    const seed = deploymentSeed(options.env ?? process.env);
    const data = readSource(source, seed);
    const { accounts, requestStats } = data;
    progress(`Source preflight: ${accounts.length} account(s), ${requestStats.length} request stat(s), `
      + `${data.shape} schema.`);
    progress(`Default enterprise fingerprint from the environment: ${seed.fingerprint}.`);

    await requireMysql8(pool);
    if (options.dryRun) {
      const target = await inspectTarget(pool);
      progress(target.exists
        ? `Target preflight: ${target.accounts} account(s), ${target.requestStats} request stat(s).`
        : 'Target preflight: Proxy tables do not exist yet; the migration will create them.');
      return { accounts: accounts.length, requestStats: requestStats.length, dryRun: true };
    }

    await runMysqlMigrations(pool, seed);
    const target = await inspectTarget(pool);
    if (!target.exists) throw new Error('MySQL schema initialization did not create the Proxy tables.');
    requireEmptyTarget(target);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (data.enterprise) await copyEnterprise(connection, data.enterprise);
      await copyAccounts(connection, accounts, progress);
      await copyRequestStats(connection, requestStats, progress);
      await verifyTargetCounts(connection, accounts.length, requestStats.length);
      await verifyTargetEnterprise(connection, seed, data.enterprise);
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    progress(`Migration complete: ${accounts.length} account(s), ${requestStats.length} request stat(s).`);
    return { accounts: accounts.length, requestStats: requestStats.length, dryRun: false };
  } finally {
    source.close();
    await pool.end();
  }
}

/** Exactly what the Proxy computes at startup from the same environment (registry file or variables). */
function deploymentSeed(env: NodeJS.ProcessEnv): EnterpriseSeed {
  try {
    return defaultEnterpriseSeed(env);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`The Proxy enterprise configuration in this environment is invalid: ${detail}`);
  }
}

function readSource(db: Database.Database, seed: EnterpriseSeed): SourceData {
  requireSqliteColumns(db, 'proxy_accounts', REQUIRED_ACCOUNT_COLUMNS);
  requireSqliteColumns(db, 'proxy_request_stats', REQUIRED_STAT_COLUMNS);
  const shape = sourceShape(db);
  const accounts = db.prepare(`
    SELECT *
    FROM proxy_accounts
    ORDER BY identity
  `).all() as SqliteAccountRow[];
  const requestStats = db.prepare(`
    SELECT *
    FROM proxy_request_stats
    ORDER BY requested_at, id
  `).all() as SqliteStatRow[];
  if (shape === 'single-enterprise') {
    return { shape, accounts: assignDefault(accounts), requestStats: assignDefault(requestStats) };
  }
  requireDefaultRows(accounts, 'proxy_accounts');
  requireDefaultRows(requestStats, 'proxy_request_stats');
  return { shape, accounts, requestStats, enterprise: readSourceEnterprise(db, seed) };
}

/** Either the r4 schema or a completed multi-enterprise migration; never a partially migrated database. */
function sourceShape(db: Database.Database): SourceShape {
  const enterprises = sqliteColumns(db, 'proxy_enterprises').size > 0;
  const columns = ENTERPRISE_TABLES.map((table) => sqliteColumns(db, table).has('enterprise_id'));
  if (!enterprises && columns.every((present) => !present)) return 'single-enterprise';
  if (enterprises && columns.every(Boolean)) {
    requireSqliteColumns(db, 'proxy_enterprises', REQUIRED_ENTERPRISE_COLUMNS);
    return 'multi-enterprise';
  }
  throw new Error(`Source SQLite has a partially applied multi-enterprise migration. ${MIGRATE_HINT}`);
}

function assignDefault<Row extends { enterprise_id: string | null }>(rows: Row[]): Row[] {
  return rows.map((row) => ({ ...row, enterprise_id: DEFAULT_ENTERPRISE_ID }));
}

function requireDefaultRows(rows: Array<{ enterprise_id: string | null }>, table: string): void {
  const foreign = rows.filter((row) => row.enterprise_id !== DEFAULT_ENTERPRISE_ID).length;
  if (foreign === 0) return;
  throw new Error(
    `Source SQLite table "${table}" has ${foreign} row(s) outside the default enterprise; `
    + 'this tool copies only single-enterprise (default) data.',
  );
}

/**
 * The source's `default` row must describe the deployment this environment configures: the Proxy verifies the
 * same fingerprint at startup. Other enterprises cannot be copied faithfully, so they are refused.
 */
function readSourceEnterprise(db: Database.Database, seed: EnterpriseSeed): EnterpriseRow {
  const rows = db.prepare(`
    SELECT *
    FROM proxy_enterprises
    ORDER BY id
  `).all() as EnterpriseRow[];
  const enterprise = rows.find((row) => row.id === DEFAULT_ENTERPRISE_ID);
  if (!enterprise) throw new Error(`Source SQLite has no default enterprise. ${MIGRATE_HINT}`);
  if (rows.length !== 1) {
    throw new Error(
      `Source SQLite has ${rows.length - 1} enterprise(s) besides default; `
      + 'this tool copies only single-enterprise (default) data.',
    );
  }
  if (enterprise.profile_fingerprint !== seed.fingerprint) throw identityMismatch(enterprise, seed);
  if (enterprise.inventory_count !== 0) {
    throw new Error(
      `Source default enterprise has ${enterprise.inventory_count} user-pool member(s); `
      + 'migrate caller-lease pools with upgrade/user-pool-mysql instead.',
    );
  }
  return enterprise;
}

function identityMismatch(enterprise: EnterpriseRow, seed: EnterpriseSeed): Error {
  return new Error(
    'The source default enterprise has a different identity (GitHub base URL, shortcode or pool account '
    + `domain) than this environment configures (source ${enterprise.profile_fingerprint}, `
    + `environment ${seed.fingerprint}). Run the tool with the exact Proxy configuration.`,
  );
}

function requireSqliteColumns(db: Database.Database, table: string, required: string[]): void {
  const names = sqliteColumns(db, table);
  if (names.size === 0) throw new Error(`Source SQLite table "${table}" does not exist.`);
  const missing = required.filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(`Source SQLite table "${table}" is missing column(s): ${missing.join(', ')}. ${MIGRATE_HINT}`);
  }
}

function sqliteColumns(db: Database.Database, table: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

async function requireMysql8(pool: Pool): Promise<void> {
  const [rows] = await pool.query<Array<RowDataPacket & { version: string }>>(
    'SELECT VERSION() AS version',
  );
  const version = rows[0]?.version ?? '';
  if (!/^8\./.test(version)) throw new Error(`MySQL 8.x is required; target reported version "${version}".`);
}

async function inspectTarget(pool: Pool): Promise<TargetState> {
  const [tables] = await pool.query<Array<RowDataPacket & { name: string }>>(`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN ('proxy_accounts', 'proxy_request_stats', 'proxy_enterprises')
  `);
  const names = new Set(tables.map((row) => row.name));
  if (!names.has('proxy_accounts') || !names.has('proxy_request_stats')) {
    return { exists: false, accounts: 0, requestStats: 0, usedEnterprises: 0 };
  }
  return {
    exists: true,
    accounts: await countRows(pool, 'proxy_accounts'),
    requestStats: await countRows(pool, 'proxy_request_stats'),
    usedEnterprises: names.has('proxy_enterprises') ? await countUsedEnterprises(pool) : 0,
  };
}

async function countRows(pool: Pool, table: string): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** A fresh schema holds only the seeded `default` row, without pool members. */
async function countUsedEnterprises(pool: Pool): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(`
    SELECT COUNT(*) AS count
    FROM proxy_enterprises
    WHERE id <> ? OR inventory_count <> 0
  `, [DEFAULT_ENTERPRISE_ID]);
  return Number(rows[0]?.count ?? 0);
}

function requireEmptyTarget(target: TargetState): void {
  if (target.accounts === 0 && target.requestStats === 0 && target.usedEnterprises === 0) return;
  throw new Error(
    `Refusing to migrate into a non-empty MySQL target `
    + `(${target.accounts} account(s), ${target.requestStats} request stat(s), `
    + `${target.usedEnterprises} enterprise(s) in use).`,
  );
}

/** Keeps the seeded identity (verified equal) and member count (0); copies the rest of the source row. */
async function copyEnterprise(connection: PoolConnection, enterprise: EnterpriseRow): Promise<void> {
  await connection.query(`
    UPDATE proxy_enterprises
    SET state = ?, max_accounts = ?, policy_version = ?, created_at = ?, updated_at = ?
    WHERE id = ?
  `, [
    enterprise.state,
    enterprise.max_accounts,
    enterprise.policy_version,
    enterprise.created_at,
    enterprise.updated_at,
    DEFAULT_ENTERPRISE_ID,
  ]);
}

async function copyAccounts(
  connection: PoolConnection,
  rows: SqliteAccountRow[],
  progress: (message: string) => void,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += COPY_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + COPY_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap((row) => [
      row.identity,
      row.sso_user,
      row.gh_login,
      row.copilot_oauth_token,
      row.copilot_oauth_status,
      mysqlTimestamp(row.copilot_oauth_updated_at),
      row.copilot_oauth_attempt_id,
      mysqlTimestamp(row.created_at),
      mysqlTimestamp(row.updated_at),
      row.enterprise_id,
    ]);
    await connection.query(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
        copilot_oauth_updated_at, copilot_oauth_attempt_id, created_at, updated_at, enterprise_id
      ) VALUES ${placeholders}
    `, values);
    progress(`Copied ${Math.min(offset + batch.length, rows.length)}/${rows.length} accounts.`);
  }
}

async function copyRequestStats(
  connection: PoolConnection,
  rows: SqliteStatRow[],
  progress: (message: string) => void,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += COPY_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + COPY_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap((row) => [
      row.id,
      row.identity,
      row.gh_login,
      mysqlTimestamp(row.requested_at),
      row.path,
      row.model,
      row.success,
      row.failure_reason,
      row.input_tokens,
      row.output_tokens,
      row.cache_tokens,
      row.cache_input_tokens,
      row.cache_write_tokens,
      row.enterprise_id,
    ]);
    await connection.query(`
      INSERT INTO proxy_request_stats (
        id, identity, gh_login, requested_at, path, model, success, failure_reason,
        input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens, enterprise_id
      ) VALUES ${placeholders}
    `, values);
    progress(`Copied ${Math.min(offset + batch.length, rows.length)}/${rows.length} request stats.`);
  }
}

/** Every copied row belongs to `default`, so the total and the `default` count must both match. */
async function verifyTargetCounts(
  connection: PoolConnection,
  expectedAccounts: number,
  expectedRequestStats: number,
): Promise<void> {
  const accounts = await countByEnterprise(connection, 'proxy_accounts');
  const stats = await countByEnterprise(connection, 'proxy_request_stats');
  const matches = accounts.total === expectedAccounts && accounts.default === expectedAccounts
    && stats.total === expectedRequestStats && stats.default === expectedRequestStats;
  if (matches) return;
  throw new Error(
    `Target verification failed: expected ${expectedAccounts}/${expectedRequestStats} account/stat rows `
    + `in the default enterprise, found ${accounts.default}/${stats.default} `
    + `(${accounts.total}/${stats.total} in total).`,
  );
}

async function countByEnterprise(
  connection: PoolConnection,
  table: string,
): Promise<{ total: number; default: number }> {
  const [rows] = await connection.query<Array<RowDataPacket & { total: number; matching: number }>>(`
    SELECT COUNT(*) AS total, COALESCE(SUM(enterprise_id = ?), 0) AS matching
    FROM ${table}
  `, [DEFAULT_ENTERPRISE_ID]);
  return { total: Number(rows[0]?.total ?? -1), default: Number(rows[0]?.matching ?? -1) };
}

/** The target's only enterprise is `default` with the deployment's identity and the copied policy. */
async function verifyTargetEnterprise(
  connection: PoolConnection,
  seed: EnterpriseSeed,
  source: EnterpriseRow | undefined,
): Promise<void> {
  const [rows] = await connection.query<Array<RowDataPacket & EnterpriseRow>>(`
    SELECT *
    FROM proxy_enterprises
    ORDER BY id
  `);
  const target = rows[0];
  const expected = source ? { ...source, inventory_count: 0 } : undefined;
  const valid = rows.length === 1 && target.id === DEFAULT_ENTERPRISE_ID
    && target.profile_fingerprint === seed.fingerprint && Number(target.inventory_count) === 0
    && (!expected || REQUIRED_ENTERPRISE_COLUMNS.every((key) => sameValue(target, expected, key)));
  if (!valid) throw new Error('Target verification failed: proxy_enterprises does not hold the expected default.');
}

function sameValue(target: EnterpriseRow, expected: EnterpriseRow, key: string): boolean {
  return String(target[key as keyof EnterpriseRow]) === String(expected[key as keyof EnterpriseRow]);
}

function mysqlTimestamp(value: string | null): string | null {
  return value ? value.slice(0, 23).replace('T', ' ') : null;
}
