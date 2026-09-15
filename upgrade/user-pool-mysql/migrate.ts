import Database from 'better-sqlite3';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { runMysqlMigrations, TOKEN_COLLATION_MIGRATION } from '../../src/proxy/src/db/mysqlMigrations.js';
import { canonicalSql, SQLITE_CREDENTIAL_FENCE_DDL, MysqlSchemaError,
  MYSQL_SCHEMA, validateMysqlSchema, validateMysqlCredentialFence } from '../../src/proxy/src/db/mysqlSchema.js';
import { normalizePoolConfig, readPoolConfig, type PoolConfig } from '../../src/proxy/src/userPool/config.js';
import { accountName, NAME_CAPACITY } from '../../src/proxy/src/userPool/names.js';

type Value = string | number | null;
type Row = Record<string, Value>;
// Exact supported schema: ? means nullable, tN means text with a MySQL character limit.
const SCHEMA = {
  proxy_accounts: { identity: 't255', sso_user: 't255', gh_login: 't255?', copilot_oauth_token: 'text?', copilot_oauth_status: 't32', copilot_oauth_updated_at: 'iso?', copilot_oauth_attempt_id: 't36?', created_at: 'iso', updated_at: 'iso' },
  proxy_request_stats: { id: 't64', identity: 't255', gh_login: 't255?', requested_at: 'iso', path: 't128', model: 't255?', success: 'i', failure_reason: 'text?', input_tokens: 'i?', output_tokens: 'i?', cache_tokens: 'i?', cache_input_tokens: 'i?', cache_write_tokens: 'i?', caller_id: 't71?', lease_id: 't36?' },
  user_pool_settings: { id: 'i32', version: 'i32', idle_target: 'i32', max_accounts: 'i32', lease_seconds: 'i32', paused: 'i32', next_ordinal: 'i32', account_domain: 't253', owner: 't36?', owner_until: 'i' },
  user_pool_accounts: { identity: 't255', ordinal: 'i32', state: 't16', stage: 't64', attempt_id: 't36', oauth_attempt_id: 't36?', sso_created_at: 't64?', task_id: 't255?', attempts: 'i32', retry_at: 'i', last_error: 'text?', updated_at: 'i', cooldown_until: 'i', verified_at: 'i?', generation: 'i', reauth_count: 'i32', reauth_window_at: 'i' },
  user_pool_leases: { caller_id: 't71', member_identity: 't255', lease_id: 't36', phase: 't16', assigned_at: 'i', last_success_at: 'i?', expires_at: 'i' },
  user_pool_catalog_cooldowns: { caller_id: 't71', member_identity: 't255', expires_at: 'i' },
  user_pool_events: { id: 'i', at: 'i', action: 't64', identity: 't255?', caller_id: 't71?', lease_id: 't36?', detail: 'text?' },
  user_pool_holds: { request_id: 't36', lease_id: 't36', expires_at: 'i', deadline_at: 'i', generation: 'i' },
  user_pool_catalog_holds: { request_id: 't36', lease_id: 't36', caller_id: 't71', member_identity: 't255', assigned_at: 'i', expires_at: 'i', deadline_at: 'i', generation: 'i' },
  proxy_identity_initializations: { identity: 't255', claim_id: 't36', lease_expires_at: 'iso', created_at: 'iso', updated_at: 'iso' },
} satisfies Record<string, Record<string, string>>;
type Table = keyof typeof SCHEMA;
type Snapshot = Record<Table, Row[]>;
const TABLES = Object.keys(SCHEMA) as Table[];
const TRANSIENT: Table[] = ['user_pool_holds', 'user_pool_catalog_holds', 'proxy_identity_initializations'];
export const MIGRATION_LOCK = 'ghcp_user_pool_offline_import';
export class MigrationError extends Error {}
function requireSafe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MigrationError(message);
}
export function safeError(error: unknown): string {
  return error instanceof MigrationError ? error.message : 'Migration failed; database/driver details suppressed to protect credentials. Do not resume traffic or retry an uncertain commit without inspecting the target.';
}
function integerSpec(spec: string): boolean { return /^i(?:32)?\??$/.test(spec); }
function fields(table: Table, mysql = false): Record<string, string> {
  return mysql && table === 'user_pool_settings' ? { ...SCHEMA[table], config_fingerprint: 't64' } : SCHEMA[table];
}
function exactColumns(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((name) => actual.includes(name));
}
function iso(value: string): string {
  const time = Date.parse(value);
  requireSafe(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(time) && new Date(time).toISOString() === value && Number(value.slice(0, 4)) >= 1000,
  'Source contains an unsupported ISO timestamp.');
  return value.slice(0, 23).replace('T', ' ');
}
function validateRow(table: Table, row: Row): void {
  for (const [key, spec] of Object.entries(fields(table))) {
    const value = row[key];
    if (value === null && spec.endsWith('?')) continue;
    const valid = integerSpec(spec)
      ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && (!spec.startsWith('i32') || value <= 2147483647)
      : typeof value === 'string' && (value.length > 0 || spec.endsWith('?')) && Buffer.from(value).toString('utf8') === value
        && (spec.startsWith('t') && /^t\d/.test(spec)
          ? [...value].length <= Number(spec.match(/\d+/)![0]) && value.trim() === value
          : Buffer.byteLength(value) <= 65535);
    requireSafe(valid, `Source field validation failed in ${table}.`);
    if (spec.startsWith('iso') || key === 'sso_created_at') iso(value as string);
    if (key === 'caller_id') requireSafe(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value), 'Source contains an unsupported caller identity.');
    if (key.endsWith('attempt_id') || key === 'lease_id' || key === 'owner' || (table === 'proxy_request_stats' && key === 'id')) {
      requireSafe(typeof value === 'string' && /^[\x21-\x7e]+$/.test(value), 'Source contains an unsupported ASCII identifier.');
    }
  }
}
function unique(rows: Row[], key: string): void {
  requireSafe(new Set(rows.map((row) => row[key])).size === rows.length, 'Source uniqueness validation failed.');
}

function readSnapshot(path: string, now: number): Snapshot {
  // A standalone rollback-journal backup avoids SQLite creating/updating WAL shared-memory sidecars even on a readonly connection.
  requireSafe(!['-wal', '-shm', '-journal'].some((suffix) => existsSync(path + suffix)), 'Source must be a standalone backup without SQLite sidecars.');
  const fd = openSync(path, 'r');
  const header = Buffer.alloc(20);
  try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  requireSafe(header.subarray(0, 16).toString() === 'SQLite format 3\0' && header[18] === 1 && header[19] === 1,
    'Source must be a consistent standalone rollback-journal SQLite backup; WAL-mode inputs are not supported.');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    db.pragma('foreign_keys = ON');
    db.exec('BEGIN'); // One read transaction pins schema, integrity checks and every table to one snapshot.
    const objects = db.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { name: string; type: string }[];
    requireSafe(objects.every(({ name, type }) => type === 'index'
      || (type === 'trigger' && name === 'user_pool_credential_fence')
      || (type === 'table' && (TABLES.includes(name as Table) || name === 'schema_migrations'))), 'Unsupported source schema objects.');
    const fence = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='user_pool_credential_fence'").get() as { sql: string } | undefined;
    requireSafe(fence && canonicalSql(fence.sql) === canonicalSql(SQLITE_CREDENTIAL_FENCE_DDL),
      'Source credential fence definition is unsupported; credentials require separate reconciliation.');
    requireSafe((db.pragma('integrity_check') as { integrity_check: string }[]).every((row) => row.integrity_check === 'ok'), 'Source integrity check failed.');
    requireSafe((db.pragma('foreign_key_check') as unknown[]).length === 0, 'Source foreign key check failed.');
    const snapshot = {} as Snapshot;
    for (const table of TABLES) {
      const columns = db.pragma(`table_xinfo(${table})`) as { name: string; type: string; hidden: number }[];
      requireSafe(exactColumns(columns.map((column) => column.name), Object.keys(fields(table)))
        && columns.every((column) => column.hidden === 0 && column.type.toUpperCase() === (integerSpec(fields(table)[column.name]) ? 'INTEGER' : 'TEXT')),
      `Unsupported source schema in ${table}; use a separately reviewed schema upgrade, never modify the backup with this tool.`);
      snapshot[table] = db.prepare(`SELECT * FROM ${table}`).all() as Row[];
      for (const row of snapshot[table]) validateRow(table, row);
      unique(snapshot[table], Object.keys(fields(table))[0]);
    }
    validateSnapshot(snapshot, now);
    return snapshot;
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
function validateSnapshot(s: Snapshot, now: number): void {
  requireSafe(s.user_pool_settings.length === 1, 'Source must have exactly one pool settings row.');
  const settings = s.user_pool_settings[0];
  requireSafe(settings.id === 1 && settings.paused === 1, 'Source pool must already be paused.');
  requireSafe(Number(settings.owner_until) <= now, 'Source has a live scheduler owner.');
  requireSafe(TRANSIENT.every((table) => s[table].length === 0), 'Source has undrained holds or initialization claims, including expired rows.');
  requireSafe(Number(settings.version) >= 1 && Number(settings.max_accounts) >= 1 && Number(settings.max_accounts) <= NAME_CAPACITY
    && Number(settings.idle_target) <= Number(settings.max_accounts) && Number(settings.next_ordinal) <= NAME_CAPACITY
    && Number(settings.lease_seconds) >= 60 && Number(settings.lease_seconds) <= 2592000, 'Source pool settings are invalid.');
  const domain = settings.account_domain as string;
  requireSafe(domain === domain.toLowerCase() && domain.split('.').length >= 2
    && domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && /^[a-z]{2,63}$/.test(domain.split('.').at(-1)!), 'Source account domain is invalid.');
  const accounts = new Map(s.proxy_accounts.map((row) => [row.identity, row]));
  for (const row of s.proxy_accounts) {
    requireSafe(['valid', 'expired', 'missing', 'failed'].includes(row.copilot_oauth_status as string)
      && row.copilot_oauth_attempt_id === null, 'Source has refreshing or unresolved OAuth accounts.');
    requireSafe(row.copilot_oauth_status !== 'valid' || (typeof row.copilot_oauth_token === 'string' && row.copilot_oauth_token.length > 0 && row.copilot_oauth_updated_at !== null), 'Source valid OAuth credentials are incomplete.');
  }
  unique(s.user_pool_accounts, 'ordinal');
  const inventory = new Map(s.user_pool_accounts.map((row) => [row.identity, row]));
  for (const row of s.user_pool_accounts) {
    const account = accounts.get(row.identity);
    requireSafe(account && Number(row.ordinal) < Number(settings.next_ordinal)
      && row.identity === accountName(Number(row.ordinal)) && account.sso_user === row.identity, 'Source inventory identity/ordinal relationship is invalid.');
    requireSafe(['ready', 'cooling', 'failed', 'disabled'].includes(row.state as string), 'Source has provisioning or unsupported inventory states.');
    requireSafe(['new', 'sso-created', 'scim-synced', 'synced', 'warmup', 'ready'].includes(row.stage as string)
      && !/ambiguous|unconfirmed|stalled|sso_name_conflict|oauth_task_invalid/i.test(String(row.last_error ?? '')), 'Source has uncertain external provisioning intent.');
    const completed = ['ready', 'cooling'].includes(row.state as string) && row.stage === 'ready'
      && row.verified_at !== null && row.sso_created_at !== null && typeof account.gh_login === 'string'
      && account.gh_login.length > 0 && account.copilot_oauth_status === 'valid';
    requireSafe(!['ready', 'cooling'].includes(row.state as string) || completed, 'Source available inventory is not verified.');
    // Successful provisioning retains historical Login/OAuth correlation. Accept only proven ready completion.
    requireSafe((row.task_id === null && row.oauth_attempt_id === null)
      || (completed && row.task_id !== null && row.oauth_attempt_id !== null), 'Source has unresolved Login task evidence.');
  }
  unique(s.user_pool_leases, 'member_identity');
  unique(s.user_pool_leases, 'lease_id');
  for (const row of s.user_pool_leases) {
    const member = inventory.get(row.member_identity);
    requireSafe(member && ['active', 'provisional'].includes(row.phase as string)
      && Number(row.expires_at) >= Number(row.assigned_at)
      && (row.phase === 'active' ? row.last_success_at !== null && Number(row.last_success_at) >= Number(row.assigned_at)
        && Number(row.last_success_at) <= Number(row.expires_at) : row.last_success_at === null), 'Source lease relationship or deadlines are invalid.');
  }
  for (const row of s.user_pool_catalog_cooldowns) requireSafe(inventory.has(row.member_identity), 'Source cooldown references missing inventory.');
  for (const row of s.proxy_request_stats) requireSafe(accounts.has(row.identity) && [0, 1].includes(Number(row.success))
    && ((row.caller_id === null) === (row.lease_id === null)), 'Source stats relationships are invalid.');
  for (const row of s.user_pool_events) requireSafe(Number(row.id) > 0, 'Source event sequence is invalid.');
}

export interface MigrationOptions {
  sqlitePath: string;
  dryRun?: boolean;
  confirmOfflineSource?: boolean;
  confirmEmptyTarget?: boolean;
  /** Exact deployment PoolConfig; mutable target/cap/lease seeds come from SQLite. */
  poolConfig?: PoolConfig;
  /** Owned by the caller, never closed here. Use verified TLS for nonlocal injected pools. */
  pool?: Pool;
  env?: NodeJS.ProcessEnv;
}
export interface MigrationResult { dryRun: boolean; counts: Record<Table, number> }
/** Source-only validation; does not connect to MySQL or initialize either provider. */
export function preflightSqlite(sqlitePath: string): MigrationResult {
  try { return summarize(readSnapshot(sqlitePath, Date.now()), true); }
  catch (error) { throw new MigrationError(safeError(error)); }
}
function summarize(snapshot: Snapshot, dryRun: boolean): MigrationResult {
  return { dryRun, counts: Object.fromEntries(TABLES.map((table) => [table, snapshot[table].length])) as Record<Table, number> };
}
export function mysqlPoolFromEnv(env: NodeJS.ProcessEnv): Pool {
  try {
    requireSafe(Boolean(env.MYSQL_URL), 'MYSQL_URL is required in the environment (never on the command line).');
    const url = new URL(env.MYSQL_URL!);
    requireSafe(url.protocol === 'mysql:' && !!url.hostname && /^\/[^/]+$/.test(url.pathname)
      && !url.search && !url.hash, 'MYSQL_URL must specify a database without query options or fragments.');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const mode = env.MYSQL_SSL_MODE ?? (local ? 'disabled' : 'verify-ca');
    requireSafe(['disabled', 'required', 'verify-ca'].includes(mode), 'Invalid MYSQL_SSL_MODE.');
    requireSafe(local || mode === 'verify-ca', 'Nonlocal MySQL requires verified TLS (MYSQL_SSL_MODE=verify-ca).');
    requireSafe(mode !== 'verify-ca' || Boolean(env.MYSQL_SSL_CA_PATH), 'MYSQL_SSL_CA_PATH is required for verified TLS.');
    const limit = env.MYSQL_CONNECTION_LIMIT ?? '3';
    requireSafe(/^\d+$/.test(limit) && Number(limit) >= 3 && Number(limit) <= 100, 'MYSQL_CONNECTION_LIMIT must be between 3 and 100.');
    return createPool({ uri: env.MYSQL_URL, connectionLimit: Number(limit), connectTimeout: 10000, timezone: 'Z', dateStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4',
      ssl: mode === 'disabled' ? undefined : mode === 'required' ? { rejectUnauthorized: false }
        : { ca: readFileSync(env.MYSQL_SSL_CA_PATH!, 'utf8'), rejectUnauthorized: true, verifyIdentity: true } });
  } catch (error) { throw new MigrationError(safeError(error)); }
}
async function rows(c: PoolConnection, sql: string, values: Value[] = []): Promise<Row[]> {
  const [result] = await c.query<RowDataPacket[]>(sql, values);
  return result as Row[];
}
async function inspectTarget(c: PoolConnection, locking: boolean, config: PoolConfig): Promise<void> {
  const tables = await rows(c, 'SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE()');
  let history: Row[] = [];
  for (const { name, engine } of tables) {
    requireSafe(name === 'schema_migrations' || TABLES.includes(name as Table), 'Target has unsupported tables; use a dedicated empty database.');
    requireSafe(engine === 'InnoDB', 'Target tables must use InnoDB.');
    if (name === 'schema_migrations') {
      history = await rows(c, 'SELECT id FROM schema_migrations');
      requireSafe(history.every((row) => ['2026-08-27-proxy-mysql-initial', '2026-08-27-proxy-token-binary-collation',
        '2026-09-12-user-pool-mysql-v1'].includes(String(row.id))), 'Target has unsupported migration history.');
      continue;
    }
    const table = name as Table;
    // Check contents BEFORE schema shape: nonempty partial schemas must never be upgraded first.
    const existing = await rows(c, `SELECT * FROM ${table}${locking ? ' FOR UPDATE' : ''}`);
    if (table === 'user_pool_settings' && existing.length === 1) {
      const seed = existing[0];
      requireSafe(Number(seed.id) === 1 && Number(seed.version) === 1 && Number(seed.next_ordinal) === 0
        && Number(seed.paused) === 0 && seed.owner === null && Number(seed.owner_until) === 0
        && Number(seed.idle_target) === config.idleTarget && Number(seed.max_accounts) === config.maxAccounts
        && Number(seed.lease_seconds) === config.leaseSeconds && seed.account_domain === config.accountDomain
        && typeof seed.config_fingerprint === 'string' && /^[0-9a-f]{64}$/.test(seed.config_fingerprint),
      'Target settings are not an unused matching initialization seed.');
    } else requireSafe(existing.length === 0, 'Target is not empty; migration will not merge or overwrite data.');
  }
  try {
    await validateMysqlSchema(c, Object.keys(MYSQL_SCHEMA), { allowMissingTables: !locking, allowLegacyStats: !locking,
      allowLegacyTokenCollation: !locking && !history.some(row => row.id === TOKEN_COLLATION_MIGRATION) });
    await validateMysqlCredentialFence(c, !locking && !history.some(row => row.id === '2026-09-12-user-pool-mysql-v1'));
  } catch (error) {
    // Never print attacker-controlled schema/SQL or driver details from the dedicated target.
    if (error instanceof MysqlSchemaError) throw new MigrationError('Target schema or credential fence does not match the supported pool schema.');
    throw error;
  }
}
function deploymentConfig(settings: Row, options: MigrationOptions): PoolConfig {
  const seed = { enabled: true, accountDomain: settings.account_domain as string, idleTarget: Number(settings.idle_target),
    maxAccounts: Number(settings.max_accounts), leaseSeconds: Number(settings.lease_seconds) };
  try {
    if (options.poolConfig) {
      requireSafe(options.poolConfig.enabled === true && options.poolConfig.accountDomain === seed.accountDomain
        && typeof options.poolConfig.warmupModel === 'string' && options.poolConfig.warmupModel.trim().length > 0
        && ([[options.poolConfig.provisionalSeconds, 10, 3600], [options.poolConfig.pollMs, 1000, 3600000],
          [options.poolConfig.retryAfterSeconds, 1, 3600], [options.poolConfig.requestTimeoutMs, 5000, 600000]] as number[][])
          .every(([value, min, max]) => Number.isSafeInteger(value) && value >= min && value <= max),
      'Deployment pool configuration is missing or differs from the source domain.');
      return normalizePoolConfig({ ...options.poolConfig, ...seed });
    }
    // Use the same parser/defaults as the deployment, never a placeholder warmup model.
    // Only mutable settings are taken from the backup; all invariants seed initialize()'s fingerprint.
    const env = options.env ?? process.env;
    requireSafe(!env.POOL_ACCOUNT_EMAIL_DOMAIN || env.POOL_ACCOUNT_EMAIL_DOMAIN.trim().toLowerCase() === seed.accountDomain,
      'Deployment pool configuration differs from the source domain.');
    return readPoolConfig({ ...env, ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql',
      POOL_ACCOUNT_EMAIL_DOMAIN: seed.accountDomain, READY_IDLE_TARGET: String(seed.idleTarget),
      POOL_MAX_ACCOUNTS: String(seed.maxAccounts), CALLER_LEASE_TTL_SECONDS: String(seed.leaseSeconds) });
  } catch { throw new MigrationError('Deployment pool configuration is missing or invalid; provide the intended runtime PoolConfig or environment.'); }
}
function converted(table: Table, row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    fields(table, true)[key].startsWith('iso') && value !== null ? iso(value as string) : value]));
}
async function verify(c: PoolConnection, snapshot: Snapshot): Promise<void> {
  for (const table of TABLES) {
    const columns = Object.entries(fields(table, true)).map(([key, spec]) => spec.startsWith('iso')
      ? `LEFT(DATE_FORMAT(\`${key}\`, '%Y-%m-%d %H:%i:%s.%f'), 23) AS \`${key}\`` : `\`${key}\``);
    const actual = await rows(c, `SELECT ${columns.join(',')} FROM ${table}`);
    const primary = Object.keys(fields(table))[0];
    const expected = new Map(snapshot[table].map((row) => [String(row[primary]), converted(table, row)]));
    requireSafe(actual.length === expected.size, 'Target row-count verification failed; import rolled back.');
    for (const row of actual) {
      const match = expected.get(String(row[primary]));
      requireSafe(match && Object.entries(fields(table, true)).every(([key, spec]) =>
        (integerSpec(spec) && row[key] !== null ? Number(row[key]) : row[key]) === match[key]),
      'Target content verification failed; import rolled back.'); // Includes token bytes, never prints them.
      expected.delete(String(row[primary]));
    }
    requireSafe(expected.size === 0, 'Target relationship verification failed; import rolled back.');
  }
}
export async function migrateSqlitePoolToMysql(options: MigrationOptions): Promise<MigrationResult> {
  let pool: Pool | undefined;
  let connection: PoolConnection | undefined;
  let locked = false;
  let transaction = false;
  let committing = false;
  let destroyed = false;
  try {
    requireSafe(options.dryRun || (options.confirmOfflineSource === true && options.confirmEmptyTarget === true),
      'Import requires explicit offline-source and empty-target confirmations.');
    const snapshot = readSnapshot(options.sqlitePath, Date.now());
    if (options.dryRun) return summarize(snapshot, true);
    const config = deploymentConfig(snapshot.user_pool_settings[0], options);
    pool = options.pool ?? mysqlPoolFromEnv(options.env ?? process.env);
    connection = await pool.getConnection();
    try {
      locked = Number((await rows(connection, 'SELECT GET_LOCK(?, 30) AS acquired', [MIGRATION_LOCK]))[0]?.acquired) === 1;
    } catch (error) {
      connection.destroy(); destroyed = true; // Lost GET_LOCK response may hide an acquired connection-scoped lock.
      throw error;
    }
    requireSafe(locked, 'Could not acquire the target migration lock.');
    const version = (await rows(connection, 'SELECT VERSION() AS version'))[0]?.version;
    requireSafe(typeof version === 'string' && /^8\./.test(version) && !/mariadb/i.test(version), 'Target must be MySQL 8.');
    await inspectTarget(connection, false, config);
    await runMysqlMigrations(pool);
    // Lazy load: source-only preflight stays independent of MySQL schema/provider initialization.
    const { MysqlPoolStore } = await import('../../src/proxy/src/userPool/mysqlStore.js');
    await new MysqlPoolStore(pool, config).initialize();
    await connection.query('SET SESSION time_zone = \'+00:00\'');
    await connection.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    await connection.query('SET SESSION foreign_key_checks = 1');
    await connection.query('SET SESSION unique_checks = 1');
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await connection.beginTransaction();
    transaction = true;
    const [seed] = await rows(connection, 'SELECT * FROM user_pool_settings WHERE id = 1 FOR UPDATE');
    await inspectTarget(connection, true, config); // Range locks plus the pool mutex protect the copy.
    requireSafe(seed && typeof seed.config_fingerprint === 'string', 'Target initialization is incomplete.');
    snapshot.user_pool_settings[0] = { ...snapshot.user_pool_settings[0], paused: 1, owner: null, owner_until: 0,
      config_fingerprint: seed.config_fingerprint }; // Preserve initialize()'s fingerprint of deployment options.
    for (const table of TABLES) {
      const keys = Object.keys(fields(table, true));
      if (table === 'user_pool_settings') {
        const settings = snapshot[table][0];
        await connection.query(`UPDATE ${table} SET ${keys.map((key) => `\`${key}\` = ?`).join(',')} WHERE id = 1`, keys.map((key) => settings[key]));
        continue;
      }
      for (let offset = 0; offset < snapshot[table].length; offset += 100) {
        const batch = snapshot[table].slice(offset, offset + 100).map((row) => converted(table, row));
        await connection.query(`INSERT INTO ${table} (${keys.map((key) => `\`${key}\``).join(',')}) VALUES ${batch.map(() => `(${keys.map(() => '?').join(',')})`).join(',')}`,
          batch.flatMap((row) => keys.map((key) => row[key])));
      }
    }
    await verify(connection, snapshot);
    committing = true;
    await connection.commit();
    committing = false;
    transaction = false;
    return summarize(snapshot, false);
  } catch (error) {
    if (committing) {
      // COMMIT can succeed server-side even when its response is lost. Never retry or claim rollback.
      connection?.destroy(); destroyed = true;
      throw new MigrationError('commit_outcome_unknown: do not retry or resume traffic; inspect the target privately.');
    }
    if (transaction) {
      try { await connection!.rollback(); }
      catch {
        connection?.destroy(); destroyed = true;
        throw new MigrationError('rollback_unconfirmed: keep services stopped and inspect the target privately.');
      }
    }
    throw new MigrationError(safeError(error));
  } finally {
    if (locked && !destroyed) {
      try {
        const released = await rows(connection!, 'SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK]);
        if (Number(released[0]?.released) !== 1) { connection!.destroy(); destroyed = true; }
      } catch { connection?.destroy(); destroyed = true; }
    }
    if (!destroyed) connection?.release();
    if (pool && !options.pool) await pool.end().catch(() => {});
  }
}
