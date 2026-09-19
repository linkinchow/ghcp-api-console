import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

const IDENTITY = 'VARCHAR(255) COLLATE utf8mb4_bin';
const UUID = 'VARCHAR(36) COLLATE ascii_bin';
const CALLER = 'VARCHAR(71) COLLATE ascii_bin';
type ForeignKey = readonly [column: string, table: string, referenced: string, onDelete: 'RESTRICT' | 'CASCADE'];
interface TableSchema {
  columns: Record<string, string>;
  primary: string;
  unique?: string[];
  foreign?: ForeignKey[];
  indexes?: string[];
  checks?: string[];
  pool?: boolean;
}

/** The same definitions create new schemas and validate existing ones. No repair of altered definitions. */
export const MYSQL_SCHEMA: Record<string, TableSchema> = {
  schema_migrations: { primary: 'id', columns: { id: 'VARCHAR(191) COLLATE utf8mb4_bin', applied_at: 'DATETIME(3) NOT NULL' } },
  proxy_accounts: { primary: 'identity', columns: {
    identity: IDENTITY, sso_user: 'VARCHAR(255) NOT NULL', gh_login: 'VARCHAR(255)',
    copilot_oauth_token: 'TEXT COLLATE utf8mb4_bin', copilot_oauth_status: "VARCHAR(32) NOT NULL DEFAULT 'missing'",
    copilot_oauth_updated_at: 'DATETIME(3)', copilot_oauth_attempt_id: 'CHAR(36) COLLATE ascii_bin',
    created_at: 'DATETIME(3) NOT NULL', updated_at: 'DATETIME(3) NOT NULL',
  }, indexes: ['idx_proxy_accounts_sso_user (sso_user)', 'idx_proxy_accounts_updated_at (updated_at)'] },
  proxy_request_stats: { primary: 'id', columns: {
    id: 'VARCHAR(64) COLLATE ascii_bin', identity: `${IDENTITY} NOT NULL`, gh_login: 'VARCHAR(255)', requested_at: 'DATETIME(3) NOT NULL',
    path: 'VARCHAR(128) NOT NULL', model: 'VARCHAR(255)', success: 'TINYINT(1) NOT NULL', failure_reason: 'TEXT',
    input_tokens: 'BIGINT', output_tokens: 'BIGINT', cache_tokens: 'BIGINT', cache_input_tokens: 'BIGINT', cache_write_tokens: 'BIGINT',
    caller_id: CALLER, lease_id: 'CHAR(36) COLLATE ascii_bin',
  }, indexes: ['idx_proxy_request_stats_identity_time (identity, requested_at DESC, id DESC)', 'idx_proxy_request_stats_time (requested_at DESC, id DESC)'] },
  proxy_identity_initializations: { primary: 'identity', columns: {
    identity: IDENTITY, claim_id: 'CHAR(36) COLLATE ascii_bin NOT NULL', lease_expires_at: 'DATETIME(3) NOT NULL',
    created_at: 'DATETIME(3) NOT NULL', updated_at: 'DATETIME(3) NOT NULL',
  }, indexes: ['idx_proxy_identity_initializations_lease (lease_expires_at)'] },
  user_pool_settings: { pool: true, primary: 'id', columns: {
    id: 'TINYINT', version: 'INT NOT NULL DEFAULT 1', idle_target: 'INT NOT NULL', max_accounts: 'INT NOT NULL', lease_seconds: 'INT NOT NULL',
    paused: 'TINYINT NOT NULL DEFAULT 0', next_ordinal: 'INT NOT NULL DEFAULT 0', account_domain: 'VARCHAR(253) COLLATE ascii_bin NOT NULL',
    config_fingerprint: 'CHAR(64) COLLATE ascii_bin NOT NULL', owner: UUID, owner_until: 'BIGINT NOT NULL DEFAULT 0',
  }, checks: ['id = 1', 'paused IN (0, 1)'] },
  user_pool_accounts: { pool: true, primary: 'identity', unique: ['ordinal'], columns: {
    identity: IDENTITY, ordinal: 'INT NOT NULL', state: 'VARCHAR(16) COLLATE ascii_bin NOT NULL',
    stage: "VARCHAR(64) COLLATE ascii_bin NOT NULL DEFAULT 'new'", attempt_id: `${UUID} NOT NULL`, oauth_attempt_id: UUID,
    sso_created_at: 'VARCHAR(64)', task_id: 'VARCHAR(255) COLLATE utf8mb4_bin', attempts: 'INT NOT NULL DEFAULT 0', retry_at: 'BIGINT NOT NULL DEFAULT 0',
    last_error: 'TEXT', updated_at: 'BIGINT NOT NULL', cooldown_until: 'BIGINT NOT NULL DEFAULT 0', verified_at: 'BIGINT',
    generation: 'BIGINT NOT NULL DEFAULT 0', reauth_count: 'INT NOT NULL DEFAULT 0', reauth_window_at: 'BIGINT NOT NULL DEFAULT 0',
  }, foreign: [['identity', 'proxy_accounts', 'identity', 'RESTRICT']],
  checks: ["state IN ('provisioning', 'ready', 'cooling', 'failed', 'disabled')"],
  indexes: ['idx_user_pool_pending (state, retry_at, ordinal)', 'idx_user_pool_available (state, updated_at, ordinal)',
    'idx_user_pool_cooling (state, cooldown_until)', 'idx_user_pool_verification (state, verified_at)'] },
  user_pool_leases: { pool: true, primary: 'caller_id', unique: ['member_identity', 'lease_id'], columns: {
    caller_id: CALLER, member_identity: `${IDENTITY} NOT NULL`, lease_id: `${UUID} NOT NULL`, phase: 'VARCHAR(16) COLLATE ascii_bin NOT NULL',
    assigned_at: 'BIGINT NOT NULL', last_success_at: 'BIGINT', expires_at: 'BIGINT NOT NULL',
  }, foreign: [['member_identity', 'user_pool_accounts', 'identity', 'RESTRICT']], checks: ["phase IN ('provisional', 'active')"],
  indexes: ['idx_user_pool_lease_expiry (expires_at)', 'idx_user_pool_lease_assigned (assigned_at)'] },
  user_pool_holds: { pool: true, primary: 'request_id', columns: {
    request_id: UUID, lease_id: `${UUID} NOT NULL`, expires_at: 'BIGINT NOT NULL', deadline_at: 'BIGINT NOT NULL', generation: 'BIGINT NOT NULL',
  }, foreign: [['lease_id', 'user_pool_leases', 'lease_id', 'CASCADE']],
  indexes: ['idx_user_pool_hold_lease (lease_id, expires_at)', 'idx_user_pool_hold_expiry (expires_at)'] },
  user_pool_catalog_holds: { pool: true, primary: 'request_id', unique: ['lease_id'], columns: {
    request_id: UUID, lease_id: `${UUID} NOT NULL`, caller_id: `${CALLER} NOT NULL`, member_identity: `${IDENTITY} NOT NULL`,
    assigned_at: 'BIGINT NOT NULL', expires_at: 'BIGINT NOT NULL', deadline_at: 'BIGINT NOT NULL', generation: 'BIGINT NOT NULL',
  }, foreign: [['member_identity', 'user_pool_accounts', 'identity', 'RESTRICT']], indexes: ['idx_user_pool_catalog_member (member_identity, expires_at)',
    'idx_user_pool_catalog_caller (caller_id, assigned_at)', 'idx_user_pool_catalog_expiry (expires_at)'] },
  user_pool_catalog_cooldowns: { pool: true, primary: 'caller_id', columns: {
    caller_id: CALLER, member_identity: `${IDENTITY} NOT NULL`, expires_at: 'BIGINT NOT NULL',
  }, foreign: [['member_identity', 'user_pool_accounts', 'identity', 'RESTRICT']], indexes: ['idx_user_pool_catalog_cooldown_expiry (expires_at)'] },
  user_pool_events: { pool: true, primary: 'id', columns: {
    id: 'BIGINT UNSIGNED AUTO_INCREMENT', at: 'BIGINT NOT NULL', action: 'VARCHAR(64) NOT NULL', identity: IDENTITY,
    caller_id: CALLER, lease_id: UUID, detail: 'TEXT',
  }, indexes: ['idx_user_pool_event_time (at)', 'idx_user_pool_event_member (identity, id)'] },
};
export const MYSQL_BASE_TABLES = Object.keys(MYSQL_SCHEMA).filter(name => !MYSQL_SCHEMA[name].pool);
export const MYSQL_POOL_TABLES = Object.keys(MYSQL_SCHEMA).filter(name => MYSQL_SCHEMA[name].pool);
const FOREIGN_NAMES: Record<string, string> = {
  user_pool_accounts: 'fk_user_pool_account', user_pool_leases: 'fk_user_pool_lease_member', user_pool_holds: 'fk_user_pool_hold_lease',
  user_pool_catalog_holds: 'fk_user_pool_catalog_member', user_pool_catalog_cooldowns: 'fk_user_pool_cooldown_member',
};
export function mysqlCreateTable(name: string): string {
  const table = MYSQL_SCHEMA[name];
  const definitions = Object.entries(table.columns).map(([column, definition]) => `\`${column}\` ${definition}`);
  definitions.push(`PRIMARY KEY (\`${table.primary}\`)`);
  for (const column of table.unique ?? []) definitions.push(`UNIQUE (\`${column}\`)`);
  for (const [column, target, referenced, onDelete] of table.foreign ?? []) {
    definitions.push(`CONSTRAINT ${FOREIGN_NAMES[name]} FOREIGN KEY (${column}) REFERENCES ${target}(${referenced}) ON DELETE ${onDelete}`);
  }
  for (const index of table.indexes ?? []) definitions.push(`INDEX ${index}`);
  for (const check of table.checks ?? []) definitions.push(`CHECK (${check})`);
  return `CREATE TABLE IF NOT EXISTS \`${name}\` (${definitions.join(',\n')}) ENGINE=InnoDB`
    + (table.pool ? ' DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin' : '');
}

export class MysqlSchemaError extends Error {}
function requireSchema(condition: unknown, context: string): asserts condition {
  if (!condition) throw new MysqlSchemaError(`Unsupported MySQL schema: ${context}; use a separately reviewed schema upgrade.`);
}
const columnType = (value: string) => value.toLowerCase().replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/g, '$1');

/** Validate existing tables before DDL, then require completeness afterwards. Importer calls this too. */
export async function validateMysqlSchema(connection: PoolConnection, names: readonly string[],
  options: { allowMissingTables?: boolean; allowLegacyStats?: boolean; allowLegacyTokenCollation?: boolean } = {}): Promise<void> {
  const [tables] = await connection.query<RowDataPacket[]>('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  for (const name of names) {
    const table = MYSQL_SCHEMA[name];
    const existing = tables.find(row => row.TABLE_NAME === name);
    if (!existing && options.allowMissingTables) continue;
    requireSchema(existing?.ENGINE === 'InnoDB', `${name} engine or missing table`);
    const [columns] = await connection.query<RowDataPacket[]>(`SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME, COLUMN_DEFAULT, EXTRA
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [name]);
    const optional = options.allowLegacyStats && name === 'proxy_request_stats' ? ['caller_id', 'lease_id'] : [];
    requireSchema(columns.every(row => row.COLUMN_NAME in table.columns)
      && Object.keys(table.columns).every(column => optional.includes(column) || columns.some(row => row.COLUMN_NAME === column)), `${name} columns`);
    for (const row of columns) {
      const definition = table.columns[row.COLUMN_NAME];
      const type = definition.match(/^\w+(?:\(\d+\))?(?: UNSIGNED)?/)![0];
      const collation = definition.match(/COLLATE (\w+)/)?.[1]
        ?? (table.pool && /^(?:VARCHAR|CHAR|TEXT)/.test(type) ? 'utf8mb4_bin' : undefined);
      const nullable = row.COLUMN_NAME !== table.primary && !definition.includes('NOT NULL');
      const defaultValue = definition.match(/DEFAULT (?:'([^']*)'|(\d+))/);
      requireSchema(columnType(String(row.COLUMN_TYPE)) === columnType(type)
        && row.IS_NULLABLE === (nullable ? 'YES' : 'NO')
        && (!collation || row.COLLATION_NAME === collation
          || (options.allowLegacyTokenCollation && name === 'proxy_accounts' && row.COLUMN_NAME === 'copilot_oauth_token'
            && ['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_unicode_ci'].includes(row.COLLATION_NAME)))
        && String(row.EXTRA).toLowerCase() === (definition.includes('AUTO_INCREMENT') ? 'auto_increment' : '')
        && (defaultValue ? String(row.COLUMN_DEFAULT) === (defaultValue[1] ?? defaultValue[2]) : row.COLUMN_DEFAULT === null), `${name}.${row.COLUMN_NAME}`);
    }
    // Exact full-column unique keys, not merely a prefix/composite/non-unique index with the right name.
    const [indexes] = await connection.query<RowDataPacket[]>(`SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [name]);
    const unique = new Map<string, RowDataPacket[]>();
    for (const row of indexes.filter(row => Number(row.NON_UNIQUE) === 0)) unique.set(row.INDEX_NAME, [...(unique.get(row.INDEX_NAME) ?? []), row]);
    const expectedKeys = [table.primary, ...table.unique ?? []];
    requireSchema(unique.size === expectedKeys.length && expectedKeys.every(column => [...unique.entries()].some(([key, rows]) =>
      (column !== table.primary || key === 'PRIMARY') && rows.length === 1 && rows[0].COLUMN_NAME === column && rows[0].SUB_PART === null)), `${name} primary/unique keys`);
    for (const index of table.indexes ?? []) {
      const [indexName, ...parts] = index.replace(/[(),]/g, ' ').trim().split(/\s+/);
      const columns = parts.filter(part => part !== 'DESC');
      const actual = indexes.filter(row => row.INDEX_NAME === indexName);
      requireSchema(actual.length === columns.length && actual.every((row, i) => row.COLUMN_NAME === columns[i]
        && row.SUB_PART === null), `${name}.${indexName} index`);
    }
    const [checks] = await connection.query<RowDataPacket[]>(`SELECT c.CHECK_CLAUSE, t.ENFORCED
      FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
        ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
      WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = ? AND t.CONSTRAINT_TYPE = 'CHECK'`, [name]);
    requireSchema(checks.length === (table.checks ?? []).length && (table.checks ?? []).every(check => checks.some(row =>
      row.ENFORCED === 'YES' && canonicalMysqlCheck(row.CHECK_CLAUSE) === canonicalMysqlCheck(check))), `${name} check constraints`);
    const [foreign] = await connection.query<RowDataPacket[]>(`SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
      r.DELETE_RULE, r.UPDATE_RULE, (k.REFERENCED_TABLE_SCHEMA = DATABASE()) AS local_reference
      FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ?`, [name]);
    requireSchema(foreign.length === (table.foreign ?? []).length && (table.foreign ?? []).every(([column, target, referenced, onDelete]) =>
      foreign.some(row => row.COLUMN_NAME === column && row.REFERENCED_TABLE_NAME === target && row.REFERENCED_COLUMN_NAME === referenced
        && Number(row.local_reference) === 1 && ['RESTRICT', 'NO ACTION'].includes(row.UPDATE_RULE)
        && (onDelete === 'RESTRICT' ? ['RESTRICT', 'NO ACTION'].includes(row.DELETE_RULE) : row.DELETE_RULE === onDelete))), `${name} foreign keys`);
  }
}

// Only these simple equality/IN checks are supported. MySQL CHECK_CLAUSE may serialize
// enum delimiters as \\' and add charset introducers. Parse that narrow metadata grammar;
// never unescape arbitrary SQL, literal contents, or credential trigger bodies.
function canonicalMysqlCheck(sql: string): string | undefined {
  let expression = sql.trim();
  while (expression.startsWith('(') && expression.endsWith(')')) expression = expression.slice(1, -1).trim();
  const match = expression.match(/^(`?)(id|paused|state|phase)\1\s*(?:=\s*(\d+)|[iI][nN]\s*\((.*)\))$/s);
  if (!match) return undefined;
  if (match[3] !== undefined) return `${match[2]} = ${match[3]}`;
  const values = match[4].split(',').map(value => {
    const token = value.trim();
    if (/^\d+$/.test(token)) return token;
    const literal = token.match(/^(?:_(?:utf8mb4|ascii)\s*)?(\\?')([a-zA-Z]+)\1$/);
    return literal ? `'${literal[2]}'` : undefined;
  });
  return values.length > 0 && values.every(value => value !== undefined) ? `${match[2]} in (${values.join(',')})` : undefined;
}

export const MYSQL_CREDENTIAL_FENCE_BODY = `BEGIN
  IF NOT (CAST(OLD.copilot_oauth_token AS BINARY) <=> CAST(NEW.copilot_oauth_token AS BINARY))
    OR NOT (CAST(OLD.copilot_oauth_status AS BINARY) <=> CAST(NEW.copilot_oauth_status AS BINARY))
    OR NOT (CAST(OLD.copilot_oauth_attempt_id AS BINARY) <=> CAST(NEW.copilot_oauth_attempt_id AS BINARY))
    OR NOT (OLD.copilot_oauth_updated_at <=> NEW.copilot_oauth_updated_at)
    OR NOT (CAST(OLD.sso_user AS BINARY) <=> CAST(NEW.sso_user AS BINARY))
    OR NOT (CAST(OLD.gh_login AS BINARY) <=> CAST(NEW.gh_login AS BINARY)) THEN
    UPDATE user_pool_accounts SET generation = generation + 1, verified_at = NULL WHERE identity = NEW.identity;
  END IF;
END`;
export const MYSQL_CREDENTIAL_FENCE_DDL = `CREATE TRIGGER user_pool_credential_fence AFTER UPDATE ON proxy_accounts FOR EACH ROW ${MYSQL_CREDENTIAL_FENCE_BODY}`;
// Must match the canonical SQLite store trigger. The importer tests instantiate that store, not this string.
export const SQLITE_CREDENTIAL_FENCE_DDL = `CREATE TRIGGER user_pool_credential_fence
  AFTER UPDATE OF copilot_oauth_token, copilot_oauth_status, copilot_oauth_attempt_id,
    copilot_oauth_updated_at, sso_user, gh_login ON proxy_accounts
  WHEN OLD.copilot_oauth_token IS NOT NEW.copilot_oauth_token
    OR OLD.copilot_oauth_status IS NOT NEW.copilot_oauth_status
    OR OLD.copilot_oauth_attempt_id IS NOT NEW.copilot_oauth_attempt_id
    OR OLD.copilot_oauth_updated_at IS NOT NEW.copilot_oauth_updated_at
    OR OLD.sso_user IS NOT NEW.sso_user OR OLD.gh_login IS NOT NEW.gh_login
  BEGIN
    UPDATE user_pool_accounts SET generation = generation + 1, verified_at = NULL WHERE identity = NEW.identity;
  END`;

/** Token comparison ignores only SQL formatting/identifier quoting, never comments or string bytes. */
const SQL_KEYWORDS = new Set('create trigger after update of on when old new is not or begin set null where end if for each row cast as binary then in'.split(' '));
export function canonicalSql(sql: string): string {
  return (sql.match(/'(?:''|\\.|[^'\\])*'|`(?:``|[^`])*`|[a-zA-Z_][a-zA-Z_0-9]*|\d+|<=>|\S/g) ?? [])
    .map(token => {
      if (token.startsWith("'")) return token;
      if (token.startsWith('`')) {
        const name = token.slice(1, -1);
        return /^[a-z_][a-z_0-9]*$/.test(name) && !SQL_KEYWORDS.has(name) ? name : token;
      }
      // Table/trigger identifier case can change meaning on Linux MySQL. Do not fold it.
      return SQL_KEYWORDS.has(token.toLowerCase()) ? token.toLowerCase() : token;
    }).join(' ');
}
export async function validateMysqlCredentialFence(connection: PoolConnection, allowMissing = false): Promise<boolean> {
  const [triggers] = await connection.query<RowDataPacket[]>(`SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
    FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`);
  requireSchema(triggers.every(row => row.TRIGGER_NAME === 'user_pool_credential_fence' && row.EVENT_OBJECT_TABLE === 'proxy_accounts'
    && row.ACTION_TIMING === 'AFTER' && row.EVENT_MANIPULATION === 'UPDATE'
    && canonicalSql(String(row.ACTION_STATEMENT)) === canonicalSql(MYSQL_CREDENTIAL_FENCE_BODY)), 'credential fence trigger definition');
  requireSchema(triggers.length === 1 || allowMissing, 'credential fence is missing');
  return triggers.length === 1;
}
