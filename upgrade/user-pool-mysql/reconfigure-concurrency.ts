import { createHash } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_SCHEMA, validateMysqlCredentialFence, validateMysqlSchema } from '../../src/proxy/src/db/mysqlSchema.js';
import { normalizePoolConfig, readPoolConfig, type PoolConfig } from '../../src/proxy/src/userPool/config.js';
import { MysqlDeadline } from '../../src/proxy/src/userPool/mysqlDeadline.js';
import { NAME_CAPACITY } from '../../src/proxy/src/userPool/names.js';

const ENV_KEYS = ['ACCOUNT_ROUTING_MODE', 'STORAGE_DRIVER', 'POOL_ACCOUNT_EMAIL_DOMAIN', 'READY_IDLE_TARGET',
  'POOL_MAX_ACCOUNTS', 'CALLER_LEASE_TTL_SECONDS', 'PROVISIONAL_LEASE_TTL_SECONDS', 'PREWARM_POLL_SECONDS',
  'PREWARM_CONCURRENCY', 'POOL_LOGIN_MAX_PENDING', 'POOL_EXHAUSTED_RETRY_AFTER_SECONDS', 'POOL_WARMUP_MODEL',
  'POOL_REQUEST_TIMEOUT_SECONDS'];
const CHANGES = new Set(['prewarmConcurrency', 'loginMaxPending']);
const TABLES = Object.keys(MYSQL_SCHEMA);
const DB_NOW = "(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000)";
type Row = Record<string, unknown>;
export interface ExpectedPoolSettings {
  id: number; version: number; idle_target: number; max_accounts: number; lease_seconds: number;
  paused: number; next_ordinal: number; account_domain: string; owner: string | null; owner_until: number;
}
export interface ReconfigureConcurrencyOptions {
  /** Already acquired, dedicated mysql2 connection; caller owns release/close. No acquisition here. */
  connection: PoolConnection;
  expectedDatabase: string;
  oldEnv: NodeJS.ProcessEnv;
  newEnv: NodeJS.ProcessEnv;
  expectedSettings: ExpectedPoolSettings;
  confirmAllProxiesStopped: boolean;
  confirmExternalWritersStopped: boolean;
  confirmLoginDrained: boolean;
  /** May lower, never extend, the five-second total SQL budget. */
  sqlBudgetMs?: number;
}
export class ReconfigureConcurrencyError extends Error {}
function requireSafe(value: unknown, code: string): asserts value {
  if (!value) throw new ReconfigureConcurrencyError(code);
}

/** Matches current MysqlPoolStore.initialize exactly. Keep regression parity on production upgrades. */
export function concurrencyConfigFingerprint(options: PoolConfig): string {
  const { idleTarget: _idle, maxAccounts: _max, leaseSeconds: _lease, enabled: _enabled,
    callerDomain: _legacy, ...invariants } = normalizePoolConfig(options);
  return createHash('sha256').update(JSON.stringify(Object.entries(invariants)
    .sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}
function explicitConfig(env: NodeJS.ProcessEnv): PoolConfig {
  requireSafe(env && ENV_KEYS.every(key => typeof env[key] === 'string' && env[key]!.length > 0)
    && Object.keys(env).every(key => ENV_KEYS.includes(key))
    && env.ACCOUNT_ROUTING_MODE === 'caller-lease' && env.STORAGE_DRIVER === 'mysql', 'explicit_config_required');
  try { return normalizePoolConfig(readPoolConfig({ ...env })); }
  catch { throw new ReconfigureConcurrencyError('invalid_pool_config'); }
}
function cell(value: unknown): unknown {
  return Buffer.isBuffer(value) ? ['buffer', value.toString('base64')]
    : value instanceof Date ? ['date', value.toISOString()] : value;
}
function digest(rows: Row[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map(row => Object.entries(row)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, cell(value)])))).digest('hex');
}

/** Offline, concurrency-only maintenance. Never runs migrations, providers, or a worker.
 * Confirmations are operator attestations, not proof that other processes/browser tasks stopped.
 * All tables are range-locked and compared; historical task correlations are retained.
 * On uncertain COMMIT the caller must inspect privately, not retry or resume the pool.
 */
export async function reconfigureConcurrency(options: ReconfigureConcurrencyOptions): Promise<{ changed: true }> {
  let transaction = false, committing = false, destroyed = false;
  const raw = options.connection;
  const destroy = () => { destroyed = true; try { raw.destroy(); } catch { /* Never expose driver data. */ } };
  let connection: PoolConnection | undefined;
  try {
    requireSafe(options.confirmAllProxiesStopped === true && options.confirmExternalWritersStopped === true
      && options.confirmLoginDrained === true, 'offline_confirmations_required');
    const oldConfig = explicitConfig(options.oldEnv), newConfig = explicitConfig(options.newEnv);
    requireSafe(Object.entries(oldConfig).every(([key, value]) => CHANGES.has(key)
      || newConfig[key as keyof PoolConfig] === value), 'only_concurrency_may_change');
    const oldFingerprint = concurrencyConfigFingerprint(oldConfig), newFingerprint = concurrencyConfigFingerprint(newConfig);
    requireSafe(oldFingerprint !== newFingerprint, 'concurrency_change_required');
    const transport = (raw as unknown as { connection?: {
      config?: { host?: string; database?: string; socketPath?: string }; stream?: { remoteAddress?: string };
    } }).connection;
    requireSafe(transport?.config && ['127.0.0.1', '::1'].includes(transport.config.host ?? '')
      && !transport.config.socketPath && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(transport.stream?.remoteAddress ?? '')
      && typeof options.expectedDatabase === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(options.expectedDatabase)
      && transport.config.database === options.expectedDatabase, 'literal_loopback_database_required');
    const expected = options.expectedSettings as unknown as Row;
    const keys = Object.keys(MYSQL_SCHEMA.user_pool_settings.columns).filter(key => key !== 'config_fingerprint');
    requireSafe(expected && Object.keys(expected).length === keys.length && keys.every(key => key in expected)
      && keys.filter(key => !['account_domain', 'owner'].includes(key)).every(key => Number.isSafeInteger(expected[key])
        && Number(expected[key]) >= 0) && expected.id === 1 && expected.paused === 1 && Number(expected.version) >= 1
      && Number(expected.max_accounts) >= 1 && Number(expected.max_accounts) <= NAME_CAPACITY
      && Number(expected.idle_target) <= Number(expected.max_accounts) && Number(expected.next_ordinal) <= NAME_CAPACITY
      && Number(expected.lease_seconds) >= 60 && Number(expected.lease_seconds) <= 2592000
      && expected.account_domain === oldConfig.accountDomain
      && (expected.owner === null || typeof expected.owner === 'string'), 'invalid_expected_settings');
    const budget = options.sqlBudgetMs ?? 5000;
    requireSafe(Number.isInteger(budget) && budget >= 1 && budget <= 5000, 'invalid_sql_budget');
    const deadline = new MysqlDeadline(budget);
    connection = new Proxy(raw, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (['query', 'execute', 'beginTransaction', 'commit', 'rollback'].includes(String(key))) {
        return (...args: unknown[]) => deadline.run(String(key), async () => {
          if (destroyed) throw new ReconfigureConcurrencyError('connection_destroyed');
          return Reflect.apply(value, target, args);
        }, destroy);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const rows = async (sql: string, values: unknown[] = []): Promise<Row[]> =>
      (await connection!.query<RowDataPacket[]>(sql, values))[0];
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    transaction = true; // A lost BEGIN response must not leave an unchecked transaction behind.
    await connection.beginTransaction();
    const settings = await rows('SELECT * FROM user_pool_settings WHERE id=1 FOR UPDATE');
    requireSafe(settings.length === 1 && keys.every(key => typeof expected[key] === 'number'
      ? String(settings[0][key]) === String(expected[key]) : settings[0][key] === expected[key])
      && settings[0].config_fingerprint === oldFingerprint, 'old_settings_or_fingerprint_mismatch');
    const [metadata] = await rows(`SELECT DATABASE() AS db, VERSION() AS version, ${DB_NOW} AS now`);
    requireSafe(metadata?.db === options.expectedDatabase && /^8\./.test(String(metadata.version))
      && !/mariadb/i.test(String(metadata.version)), 'unsupported_database');
    requireSafe(/^\d+$/.test(String(metadata.now)) && BigInt(String(settings[0].owner_until)) <= BigInt(String(metadata.now)), 'live_owner');
    const tables = await rows('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    requireSafe(tables.length === TABLES.length && tables.every(row => TABLES.includes(String(row.TABLE_NAME))), 'unsupported_tables');
    await validateMysqlSchema(connection, TABLES);
    await validateMysqlCredentialFence(connection);
    const snapshot: Record<string, Row[]> = {};
    for (const table of TABLES) snapshot[table] = await rows(`SELECT * FROM \`${table}\` ORDER BY \`${MYSQL_SCHEMA[table].primary}\` FOR UPDATE`);
    requireSafe(snapshot.user_pool_settings.length === 1, 'invalid_settings_count');
    requireSafe(['user_pool_holds', 'user_pool_catalog_holds', 'proxy_identity_initializations']
      .every(table => snapshot[table].length === 0), 'undrained_transient_rows');
    requireSafe(snapshot.proxy_accounts.every(row => ['valid', 'expired', 'missing', 'failed'].includes(String(row.copilot_oauth_status))
      && row.copilot_oauth_attempt_id === null), 'unresolved_credentials');
    const accounts = new Map(snapshot.proxy_accounts.map(row => [row.identity, row]));
    requireSafe(snapshot.user_pool_accounts.every(row => {
      const account = accounts.get(row.identity);
      return row.state === 'ready' && row.stage === 'ready' && row.verified_at != null && row.sso_created_at != null
        && account && account.sso_user === row.identity && typeof account.gh_login === 'string' && account.gh_login.length > 0
        && account.copilot_oauth_status === 'valid' && typeof account.copilot_oauth_token === 'string'
        && account.copilot_oauth_token.length > 0 && account.copilot_oauth_updated_at != null
        && ((row.task_id === null && row.oauth_attempt_id === null)
          || (typeof row.task_id === 'string' && row.task_id.length > 0 && typeof row.oauth_attempt_id === 'string' && row.oauth_attempt_id.length > 0))
        && !/ambiguous|unconfirmed|stalled|sso_name_conflict|oauth_task_invalid/i.test(String(row.last_error ?? ''));
    }), 'inventory_not_quiescent_ready');
    const before = Object.fromEntries(TABLES.map(table => [table, digest(snapshot[table])]));
    const [updated] = await connection.execute<ResultSetHeader>(`UPDATE user_pool_settings SET config_fingerprint=?
      WHERE id=1 AND config_fingerprint=? AND paused=1 AND owner_until<=${DB_NOW}
      AND ${keys.map(key => `\`${key}\` <=> ?`).join(' AND ')}`, [newFingerprint, oldFingerprint, ...keys.map(key => expected[key] as string | number | null)]);
    requireSafe(updated.affectedRows === 1, 'fingerprint_cas_failed');
    for (const table of TABLES) {
      const after = await rows(`SELECT * FROM \`${table}\` ORDER BY \`${MYSQL_SCHEMA[table].primary}\` FOR UPDATE`);
      if (table === 'user_pool_settings') {
        requireSafe(after.length === 1 && after[0].config_fingerprint === newFingerprint, 'fingerprint_verification_failed');
        after[0].config_fingerprint = oldFingerprint;
      }
      requireSafe(digest(after) === before[table], 'preservation_verification_failed');
    }
    committing = true;
    await connection.commit();
    committing = false;
    transaction = false;
    return { changed: true };
  } catch (error) {
    if (committing) { destroy(); throw new ReconfigureConcurrencyError('commit_outcome_unknown_do_not_retry_or_resume'); }
    if (transaction) {
      if (destroyed) throw new ReconfigureConcurrencyError('transaction_outcome_unconfirmed_do_not_resume');
      try { await connection!.rollback(); }
      catch { destroy(); throw new ReconfigureConcurrencyError('rollback_unconfirmed_do_not_retry_or_resume'); }
    }
    throw new ReconfigureConcurrencyError(error instanceof ReconfigureConcurrencyError ? error.message : 'maintenance_failed_details_suppressed');
  }
}
