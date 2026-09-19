import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RowDataPacket } from 'mysql2/promise';
import { canonicalEnterpriseProfile, parseEnterpriseProfile, type EnterpriseProfile } from './enterprise.js';
import { MYSQL_SCHEMA, MYSQL_BASE_TABLES, MYSQL_POOL_TABLES, MYSQL_CREDENTIAL_FENCE_BODY,
  canonicalSql, mysqlCreateTable, validateMysqlTables, type MysqlConnection, type TableSchema } from './enterpriseMysqlV1.js';

export type { MysqlConnection } from './enterpriseMysqlV1.js';
export type EnterpriseMysqlLayout = 'direct' | 'pool';
export const ENTERPRISE_MYSQL_MIGRATION = '8ad76d5-enterprise-schema2-contract1';
export const ENTERPRISE_MYSQL_FINAL_STEP = 12;
export const ENTERPRISE_MYSQL_LOCK = 'ghcp_proxy_schema_migrations';
export interface EnterpriseMysqlPoolSettings {
  version: number; idle_target: number; lease_seconds: number; paused: 0 | 1; next_ordinal: number;
  account_domain: string; owner: string | null; owner_until: number;
}
export interface EnterpriseMysqlInitOptions {
  layout?: EnterpriseMysqlLayout;
  maxAccounts?: number;
  pool?: { fingerprint?: string; settings: EnterpriseMysqlPoolSettings };
}
export interface EnterpriseMysqlValidation {
  profile: EnterpriseProfile; maxAccounts?: number; layout: EnterpriseMysqlLayout;
}
export class EnterpriseMysqlError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EnterpriseMysqlError'; }
}
export function requireEnterpriseMysql(condition: unknown, code: string): asserts condition {
  if (!condition) throw new EnterpriseMysqlError(code);
}
export const enterpriseMysqlProfileHash = (profile: EnterpriseProfile) => createHash('sha256').update(canonicalEnterpriseProfile(profile)).digest('hex');
const ascii = 'COLLATE ascii_bin';
export const ENTERPRISE_MYSQL_TABLES: Record<string, TableSchema> = {
  enterprise_profiles: { pool: true, primary: 'singleton', unique: ['id', 'slug'], columns: {
    singleton: 'TINYINT', id: `VARCHAR(36) ${ascii} NOT NULL`, slug: `VARCHAR(100) ${ascii} NOT NULL`,
    profile_json: 'TEXT NOT NULL', revision: 'INT NOT NULL', max_accounts: 'INT',
  }, checks: ['singleton = 1', 'revision >= 1', 'max_accounts >= 1 AND max_accounts <= 10000'] },
  enterprise_schema: { pool: true, primary: 'singleton', columns: {
    singleton: 'TINYINT', component: `VARCHAR(16) ${ascii} NOT NULL`, schema_version: 'INT NOT NULL', contract_version: 'INT NOT NULL',
    capability: `VARCHAR(64) ${ascii} NOT NULL`, layout: `VARCHAR(16) ${ascii} NOT NULL`,
    profile_sha256: `CHAR(64) ${ascii} NOT NULL`, migration_id: `VARCHAR(64) ${ascii} NOT NULL`, state: `VARCHAR(16) ${ascii} NOT NULL`,
  }, checks: ['singleton = 1', "component = 'proxy'", 'schema_version = 2', 'contract_version = 1',
    "capability = 'enterprise-single-profile'", "layout IN ('direct', 'pool')", "state = 'complete'"] },
  enterprise_upgrade: { pool: true, primary: 'singleton', columns: {
    singleton: 'TINYINT', migration_id: `VARCHAR(64) ${ascii} NOT NULL`, database_name: `VARCHAR(64) ${ascii} NOT NULL`,
    manifest_sha256: `CHAR(64) ${ascii} NOT NULL`, backup_reference: 'VARCHAR(255) NOT NULL', backup_sha256: `CHAR(64) ${ascii} NOT NULL`,
    profile_sha256: `CHAR(64) ${ascii} NOT NULL`, source_sha256: `CHAR(64) ${ascii} NOT NULL`,
    layout: `VARCHAR(16) ${ascii} NOT NULL`, state: `VARCHAR(16) ${ascii} NOT NULL`, step: 'INT NOT NULL',
    checkpoint_state: `VARCHAR(16) ${ascii} NOT NULL`, evidence_json: 'LONGTEXT NOT NULL',
  }, checks: ['singleton = 1', "layout IN ('direct', 'pool')", "state IN ('applying', 'complete')",
    'step >= 0 AND step <= 12', "checkpoint_state IN ('before', 'after', 'unknown')"] },
};
export interface EnterpriseMysqlTrigger { table: string; timing: 'BEFORE' | 'AFTER'; event: 'UPDATE' | 'DELETE'; body: string }
export const ENTERPRISE_MYSQL_TRIGGERS: Record<string, EnterpriseMysqlTrigger> = {
  enterprise_profile_immutable: { table: 'enterprise_profiles', timing: 'BEFORE', event: 'UPDATE', body: `BEGIN
  IF NOT (OLD.singleton <=> NEW.singleton)
    OR NOT (CAST(OLD.id AS BINARY) <=> CAST(NEW.id AS BINARY))
    OR NOT (CAST(OLD.slug AS BINARY) <=> CAST(NEW.slug AS BINARY))
    OR NOT (CAST(OLD.profile_json AS BINARY) <=> CAST(NEW.profile_json AS BINARY))
    OR NOT (OLD.revision <=> NEW.revision) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'enterprise_profile_immutable';
  END IF;
END` },
  enterprise_profile_no_delete: { table: 'enterprise_profiles', timing: 'BEFORE', event: 'DELETE', body: `BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'enterprise_profile_immutable';
END` },
  enterprise_account_immutable: { table: 'proxy_accounts', timing: 'BEFORE', event: 'UPDATE', body: `BEGIN
  IF NOT (CAST(OLD.enterprise_id AS BINARY) <=> CAST(NEW.enterprise_id AS BINARY)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'enterprise_account_immutable';
  END IF;
END` },
};
export const MYSQL_FENCE_TRIGGER: EnterpriseMysqlTrigger = {
  table: 'proxy_accounts', timing: 'AFTER', event: 'UPDATE', body: MYSQL_CREDENTIAL_FENCE_BODY,
};
export function enterpriseMysqlCreateTrigger(name: string, trigger: EnterpriseMysqlTrigger): string {
  return `CREATE TRIGGER ${name} ${trigger.timing} ${trigger.event} ON ${trigger.table} FOR EACH ROW ${trigger.body}`;
}
export function enterpriseMysqlSchema(layout: EnterpriseMysqlLayout, version: 1 | 2 = 2): Record<string, TableSchema> {
  const tables = Object.fromEntries([...MYSQL_BASE_TABLES, ...(layout === 'pool' ? MYSQL_POOL_TABLES : [])]
    .map(name => [name, structuredClone(MYSQL_SCHEMA[name])]));
  if (version === 1) return tables;
  tables.proxy_accounts.columns.enterprise_id = `VARCHAR(36) ${ascii} NOT NULL`;
  tables.proxy_accounts.foreign = [['enterprise_id', 'enterprise_profiles', 'id', 'RESTRICT']];
  tables.proxy_accounts.indexes!.push('idx_proxy_accounts_enterprise (enterprise_id)');
  if (layout === 'pool') delete tables.user_pool_settings.columns.max_accounts;
  return { enterprise_profiles: ENTERPRISE_MYSQL_TABLES.enterprise_profiles, ...tables,
    enterprise_schema: ENTERPRISE_MYSQL_TABLES.enterprise_schema, enterprise_upgrade: ENTERPRISE_MYSQL_TABLES.enterprise_upgrade };
}
export async function mysqlEnterpriseRows(connection: MysqlConnection, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await connection.query<RowDataPacket[]>(sql, values);
  return rows;
}
export async function enterpriseMysqlObjects(connection: MysqlConnection): Promise<string[]> {
  const rows = await mysqlEnterpriseRows(connection, 'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  requireEnterpriseMysql(rows.every(row => row.TABLE_TYPE === 'BASE TABLE'), 'enterprise_mysql_unknown_objects');
  const routines = await mysqlEnterpriseRows(connection, 'SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()');
  const events = await mysqlEnterpriseRows(connection, 'SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()');
  requireEnterpriseMysql(routines.length === 0 && events.length === 0, 'enterprise_mysql_unknown_objects');
  return rows.map(row => String(row.TABLE_NAME));
}
export async function validateEnterpriseMysqlShape(connection: MysqlConnection, schema: Record<string, TableSchema>,
  triggers: Record<string, EnterpriseMysqlTrigger>): Promise<void> {
  const names = await enterpriseMysqlObjects(connection);
  requireEnterpriseMysql(names.length === Object.keys(schema).length && names.every(name => Object.hasOwn(schema, name)), 'enterprise_mysql_table_set');
  await validateMysqlTables(connection, schema);
  const actual = await mysqlEnterpriseRows(connection, `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT,
    ACTION_ORIENTATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`);
  requireEnterpriseMysql(actual.length === Object.keys(triggers).length && actual.every(row => {
    const expected = triggers[row.TRIGGER_NAME];
    return expected && row.EVENT_OBJECT_TABLE === expected.table && row.ACTION_TIMING === expected.timing
      && row.EVENT_MANIPULATION === expected.event && row.ACTION_ORIENTATION === 'ROW'
      && canonicalSql(row.ACTION_STATEMENT) === canonicalSql(expected.body);
  }), 'enterprise_mysql_triggers');
}
export async function validateEnterpriseMysqlHistory(connection: MysqlConnection, layout: EnterpriseMysqlLayout): Promise<void> {
  const actual = await mysqlEnterpriseRows(connection, 'SELECT id FROM schema_migrations');
  const expected = ['2026-08-27-proxy-mysql-initial', '2026-08-27-proxy-token-binary-collation',
    ...(layout === 'pool' ? ['2026-09-12-user-pool-mysql-v1'] : [])];
  requireEnterpriseMysql(actual.length === expected.length && actual.every(row => expected.includes(row.id)), 'enterprise_mysql_history');
}
export async function validateEnterpriseMysqlProfile(connection: MysqlConnection, expected?: EnterpriseProfile): Promise<EnterpriseMysqlValidation> {
  const rows = await mysqlEnterpriseRows(connection, 'SELECT * FROM enterprise_profiles');
  requireEnterpriseMysql(rows.length === 1 && Number(rows[0].singleton) === 1, 'enterprise_mysql_profile_count');
  const row = rows[0];
  let profile: EnterpriseProfile;
  try { profile = parseEnterpriseProfile(JSON.parse(row.profile_json)); } catch { throw new EnterpriseMysqlError('enterprise_mysql_profile'); }
  requireEnterpriseMysql(row.id === profile.id && row.slug === profile.slug && Number(row.revision) === profile.revision
    && row.profile_json === canonicalEnterpriseProfile(profile), 'enterprise_mysql_profile');
  requireEnterpriseMysql(!expected || canonicalEnterpriseProfile(expected) === canonicalEnterpriseProfile(profile), 'enterprise_mysql_profile_mismatch');
  const maxAccounts = row.max_accounts === null ? undefined : Number(row.max_accounts);
  requireEnterpriseMysql(maxAccounts === undefined || Number.isInteger(maxAccounts) && maxAccounts >= 1 && maxAccounts <= 10000, 'enterprise_mysql_capacity');
  const markers = await mysqlEnterpriseRows(connection, 'SELECT * FROM enterprise_schema');
  const marker = markers[0];
  requireEnterpriseMysql(markers.length === 1 && Number(marker.singleton) === 1 && marker.component === 'proxy'
    && Number(marker.schema_version) === 2 && Number(marker.contract_version) === 1
    && marker.capability === 'enterprise-single-profile' && ['direct', 'pool'].includes(marker.layout)
    && marker.profile_sha256 === enterpriseMysqlProfileHash(profile) && marker.migration_id === ENTERPRISE_MYSQL_MIGRATION
    && marker.state === 'complete', 'enterprise_mysql_marker');
  requireEnterpriseMysql(marker.layout === 'pool' ? maxAccounts !== undefined : maxAccounts === undefined, 'enterprise_mysql_capacity');
  return { profile, layout: marker.layout, ...(maxAccounts === undefined ? {} : { maxAccounts }) };
}

/** One monotonic budget includes all calls and cleanup; a timed-out socket is never reusable. */
export async function withEnterpriseMysqlDeadline<T>(connection: MysqlConnection, run: (bounded: MysqlConnection) => Promise<T>, deadlineMs = 60000): Promise<T> {
  requireEnterpriseMysql(Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 60000, 'enterprise_mysql_invalid_deadline');
  const expires = performance.now() + deadlineMs;
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; try { connection.destroy(); } catch { /* Already closed. */ } } };
  const bounded = new Proxy(connection, { get(target, property) {
    if (property === 'destroy') return destroy;
    if (property !== 'query') return Reflect.get(target, property, target);
    return (...args: unknown[]) => new Promise((resolve, reject) => {
      const remaining = expires - performance.now();
      if (destroyed || remaining <= 0) { destroy(); reject(new EnterpriseMysqlError('enterprise_mysql_deadline')); return; }
      let settled = false;
      const expire = () => { if (!settled) { settled = true; destroy(); reject(new EnterpriseMysqlError('enterprise_mysql_deadline')); } };
      const timer = setTimeout(expire, Math.ceil(remaining));
      Promise.resolve().then(() => Reflect.apply(target.query, target, args)).then(value => {
        if (performance.now() >= expires) expire();
        if (!settled) { settled = true; resolve(value); }
      }, (error: unknown) => {
        if (!settled) {
          settled = true; destroy();
          reject(error instanceof EnterpriseMysqlError && error.code === 'enterprise_mysql_deadline'
            ? error : new EnterpriseMysqlError('enterprise_mysql_statement_outcome_unknown'));
        }
      }).finally(() => clearTimeout(timer));
    });
  } });
  return run(bounded);
}

/** Validate persisted evidence syntax and binding without comparing live data after normal runtime writes. */
export function validateEnterpriseMysqlCheckpoint(row: Record<string, unknown>, profile: EnterpriseProfile, layout: EnterpriseMysqlLayout, database: string): void {
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  requireEnterpriseMysql(Number(row.singleton) === 1 && row.state === 'complete' && Number(row.step) === ENTERPRISE_MYSQL_FINAL_STEP
    && row.checkpoint_state === 'after' && row.profile_sha256 === enterpriseMysqlProfileHash(profile) && row.layout === layout
    && typeof row.migration_id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(row.migration_id)
    && row.database_name === database && hash(row.manifest_sha256) && hash(row.backup_sha256) && hash(row.source_sha256)
    && typeof row.backup_reference === 'string' && row.backup_reference.length >= 1 && row.backup_reference.length <= 255
    && !/[\x00-\x1f\x7f]/.test(row.backup_reference) && typeof row.evidence_json === 'string', 'enterprise_mysql_checkpoint');
  let evidence: { counts: Record<string, number>; columns: Record<string, Record<string, string>>; maxAccounts?: number; eventSequence: string | null };
  try { evidence = JSON.parse(row.evidence_json); } catch { throw new EnterpriseMysqlError('enterprise_mysql_checkpoint'); }
  const schema = enterpriseMysqlSchema(layout, 1);
  const keys = (value: unknown, names: string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  requireEnterpriseMysql(keys(evidence, ['counts', 'columns', 'eventSequence', ...(layout === 'pool' ? ['maxAccounts'] : [])])
    && keys(evidence.counts, Object.keys(schema)) && keys(evidence.columns, Object.keys(schema))
    && Object.entries(schema).every(([table, definition]) => Number.isSafeInteger(evidence.counts[table]) && evidence.counts[table] >= 0
      && keys(evidence.columns[table], Object.keys(definition.columns)) && Object.values(evidence.columns[table]).every(hash))
    && (layout === 'pool' ? Number.isInteger(evidence.maxAccounts) && evidence.maxAccounts! >= 1 && evidence.maxAccounts! <= 10000
      && (evidence.eventSequence === null || typeof evidence.eventSequence === 'string' && /^\d+$/.test(evidence.eventSequence))
      : evidence.eventSequence === null)
    && createHash('sha256').update(JSON.stringify(evidence)).digest('hex') === row.source_sha256, 'enterprise_mysql_checkpoint');
}

/** Runtime gate: no writes, no DDL, no implicit upgrade of empty/legacy/partial databases. */
export async function validateEnterpriseMysql(connection: MysqlConnection, component: 'proxy', expectedProfile?: EnterpriseProfile): Promise<EnterpriseMysqlValidation> {
  requireEnterpriseMysql(component === 'proxy', 'enterprise_mysql_component');
  return withEnterpriseMysqlDeadline(connection, async c => {
    try {
      const names = await enterpriseMysqlObjects(c);
      requireEnterpriseMysql(names.includes('enterprise_schema') && names.includes('enterprise_profiles') && names.includes('enterprise_upgrade'), 'enterprise_mysql_upgrade_required');
      const result = await validateEnterpriseMysqlProfile(c, expectedProfile);
      const triggers = { ...(result.layout === 'pool' ? { user_pool_credential_fence: MYSQL_FENCE_TRIGGER } : {}), ...ENTERPRISE_MYSQL_TRIGGERS };
      await validateEnterpriseMysqlShape(c, enterpriseMysqlSchema(result.layout), triggers);
      await validateEnterpriseMysqlHistory(c, result.layout);
      const checkpoints = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_upgrade');
      requireEnterpriseMysql(checkpoints.length <= 1, 'enterprise_mysql_incomplete');
      if (checkpoints.length) {
        const database = await mysqlEnterpriseRows(c, 'SELECT DATABASE() AS name');
        validateEnterpriseMysqlCheckpoint(checkpoints[0], result.profile, result.layout, database[0]?.name);
      }
      const mismatches = await mysqlEnterpriseRows(c, 'SELECT COUNT(*) AS n FROM proxy_accounts WHERE enterprise_id IS NULL OR BINARY enterprise_id <> BINARY ?', [result.profile.id]);
      requireEnterpriseMysql(Number(mismatches[0]?.n) === 0, 'enterprise_mysql_account_profile');
      if (result.layout === 'pool') {
        const settings = await mysqlEnterpriseRows(c, 'SELECT * FROM user_pool_settings');
        requireEnterpriseMysql(settings.length === 1 && Number(settings[0].id) === 1 && settings[0].account_domain === result.profile.accountDomain,
          'enterprise_mysql_settings');
      }
      return result;
    } catch (error) {
      if (error instanceof EnterpriseMysqlError) throw error;
      throw new EnterpriseMysqlError('enterprise_mysql_schema');
    }
  });
}

/** Explicit empty-schema fixtures only. A partial DDL failure is NOT rolled back or retried. */
export async function initEnterpriseMysql(connection: MysqlConnection, component: 'proxy', profile: EnterpriseProfile,
  options: EnterpriseMysqlInitOptions = {}): Promise<void> {
  requireEnterpriseMysql(component === 'proxy', 'enterprise_mysql_component');
  profile = parseEnterpriseProfile(profile);
  const layout = options.layout ?? (options.pool ? 'pool' : 'direct');
  requireEnterpriseMysql(['direct', 'pool'].includes(layout), 'enterprise_mysql_layout');
  const cap = options.maxAccounts;
  requireEnterpriseMysql(cap === undefined || layout === 'pool' && Number.isInteger(cap) && cap >= 1 && cap <= 10000, 'enterprise_mysql_capacity');
  requireEnterpriseMysql(layout === 'pool' ? !!options.pool && cap !== undefined : options.pool === undefined, 'enterprise_mysql_settings');
  if (options.pool) {
    const { settings: s, fingerprint } = options.pool;
    requireEnterpriseMysql(typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint)
      && s.account_domain === profile.accountDomain && Number.isInteger(s.version) && s.version >= 1
      && Number.isInteger(s.idle_target) && s.idle_target >= 0 && s.idle_target <= cap!
      && Number.isInteger(s.lease_seconds) && s.lease_seconds >= 60 && s.lease_seconds <= 2592000
      && [0, 1].includes(s.paused) && Number.isInteger(s.next_ordinal) && s.next_ordinal >= 0 && s.next_ordinal <= 10000
      && (s.owner === null || /^[0-9a-f-]{36}$/.test(s.owner)) && Number.isSafeInteger(s.owner_until) && s.owner_until >= 0,
    'enterprise_mysql_settings');
  }
  await withEnterpriseMysqlDeadline(connection, async c => {
    let locked = false;
    let failed = false;
    try {
      const lock = await mysqlEnterpriseRows(c, 'SELECT GET_LOCK(?, 5) AS acquired', [ENTERPRISE_MYSQL_LOCK]);
      if (Number(lock[0]?.acquired) !== 1) {
        if (lock[0]?.acquired !== 0 && lock[0]?.acquired !== '0') c.destroy();
        throw new EnterpriseMysqlError('enterprise_mysql_lock_unavailable');
      }
      locked = true;
      // Empty-schema inspection and every independently committing DDL statement share the apply lock.
      const names = await enterpriseMysqlObjects(c);
      const triggers = await mysqlEnterpriseRows(c, 'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
      requireEnterpriseMysql(names.length === 0 && triggers.length === 0, 'enterprise_mysql_init_requires_empty');
      const schema = enterpriseMysqlSchema(layout);
      for (const name of Object.keys(schema)) await c.query(mysqlCreateTable(name, schema));
      await c.query('INSERT INTO enterprise_profiles (singleton,id,slug,profile_json,revision,max_accounts) VALUES (1,?,?,?,?,?)',
        [profile.id, profile.slug, canonicalEnterpriseProfile(profile), profile.revision, cap ?? null]);
      for (const id of ['2026-08-27-proxy-mysql-initial', '2026-08-27-proxy-token-binary-collation',
        ...(layout === 'pool' ? ['2026-09-12-user-pool-mysql-v1'] : [])]) {
        await c.query('INSERT INTO schema_migrations (id,applied_at) VALUES (?,UTC_TIMESTAMP(3))', [id]);
      }
      if (options.pool) {
        const { settings: s, fingerprint } = options.pool;
        await c.query(`INSERT INTO user_pool_settings (id,version,idle_target,lease_seconds,paused,next_ordinal,account_domain,config_fingerprint,owner,owner_until)
          VALUES (1,?,?,?,?,?,?,?,?,?)`, [s.version, s.idle_target, s.lease_seconds, s.paused, s.next_ordinal, s.account_domain, fingerprint, s.owner, s.owner_until]);
      }
      const expectedTriggers = { ...(layout === 'pool' ? { user_pool_credential_fence: MYSQL_FENCE_TRIGGER } : {}), ...ENTERPRISE_MYSQL_TRIGGERS };
      for (const [name, trigger] of Object.entries(expectedTriggers)) await c.query(enterpriseMysqlCreateTrigger(name, trigger));
      // Do not publish a complete marker until exact structure AND all fixture data have been checked.
      await validateEnterpriseMysqlShape(c, schema, expectedTriggers);
      await validateEnterpriseMysqlHistory(c, layout);
      const registry = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_profiles');
      requireEnterpriseMysql(registry.length === 1 && Number(registry[0].singleton) === 1 && registry[0].id === profile.id
        && registry[0].slug === profile.slug && registry[0].profile_json === canonicalEnterpriseProfile(profile)
        && Number(registry[0].revision) === profile.revision
        && (registry[0].max_accounts === null ? undefined : Number(registry[0].max_accounts)) === cap, 'enterprise_mysql_init_profile');
      for (const name of Object.keys(schema).filter(name => !['enterprise_profiles', 'schema_migrations', 'user_pool_settings'].includes(name))) {
        const rows = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${name}`);
        requireEnterpriseMysql(Number(rows[0]?.n) === 0, 'enterprise_mysql_init_data');
      }
      if (options.pool) {
        const settings = await mysqlEnterpriseRows(c, 'SELECT * FROM user_pool_settings');
        const expected = { id: 1, ...options.pool.settings, config_fingerprint: options.pool.fingerprint };
        requireEnterpriseMysql(settings.length === 1 && Object.entries(expected).every(([key, value]) =>
          typeof value === 'number' ? Number(settings[0][key]) === value : settings[0][key] === value), 'enterprise_mysql_init_settings');
      }
      await insertEnterpriseMysqlMarker(c, profile, layout);
      await validateEnterpriseMysql(c, 'proxy', profile);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (locked) {
        try {
          const rows = await mysqlEnterpriseRows(c, 'SELECT RELEASE_LOCK(?) AS released', [ENTERPRISE_MYSQL_LOCK]);
          if (Number(rows[0]?.released) !== 1) throw new EnterpriseMysqlError('enterprise_mysql_lock_release_unknown');
        } catch {
          c.destroy();
          if (!failed) throw new EnterpriseMysqlError('enterprise_mysql_lock_release_unknown');
        }
      }
    }
  });
}
export async function insertEnterpriseMysqlMarker(connection: MysqlConnection, profile: EnterpriseProfile, layout: EnterpriseMysqlLayout): Promise<void> {
  await connection.query(`INSERT INTO enterprise_schema (singleton,component,schema_version,contract_version,capability,layout,profile_sha256,migration_id,state)
    VALUES (1,'proxy',2,1,'enterprise-single-profile',?,?,?,'complete')`, [layout, enterpriseMysqlProfileHash(profile), ENTERPRISE_MYSQL_MIGRATION]);
}
