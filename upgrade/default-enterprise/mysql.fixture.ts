import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalEnterpriseProfile } from '../../src/packages/shared/src/enterprise.js';
import { FOREIGN_NAMES, mysqlCreateTable, type TableSchema } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { ENTERPRISE_MYSQL_TABLES, ENTERPRISE_MYSQL_TRIGGERS, ENTERPRISE_MYSQL_MIGRATION, MYSQL_FENCE_TRIGGER,
  enterpriseMysqlSchema, enterpriseMysqlProfileHash, enterpriseMysqlCreateTrigger,
  type EnterpriseMysqlLayout, type MysqlConnection, type EnterpriseMysqlTrigger } from '../../src/packages/shared/src/enterpriseMysql.js';
export const profile = { id: '3f22df8a-1f0e-448a-a6d9-14fb9c5e2f64', slug: 'default', shortcode: 'team', accountDomain: 'example.test', revision: 1,
  routes: { proxyInternalUrl: 'http://proxy.test', ssoInternalUrl: 'http://sso.test', loginInternalUrl: 'http://login.test', ssoPublicUrl: 'https://sso.example.test' } };
export type Row = Record<string, any>;
export function fixture(layout: EnterpriseMysqlLayout = 'pool', version: 1 | 2 | 0 = 2) {
  let schema: Record<string, TableSchema> = version === 0 ? {} : enterpriseMysqlSchema(layout, version);
  let triggers: Record<string, EnterpriseMysqlTrigger> = version === 0 ? {} : { ...(layout === 'pool' ? { user_pool_credential_fence: MYSQL_FENCE_TRIGGER } : {}),
    ...(version === 2 ? structuredClone(ENTERPRISE_MYSQL_TRIGGERS) : {}) };
  const data: Record<string, Row[]> = Object.fromEntries(Object.keys(schema).map(name => [name, []]));
  let destroyed = false;
  const statements: string[] = [];
  const mutations: string[] = [];
  let metadataAlter: (kind: string, table: string, rows: Row[]) => Row[] = (_kind, _table, rows) => rows;
  let fail: (sql: string) => boolean = () => false;
  let loseAfter: (sql: string) => boolean = () => false;
  if (version !== 0) {
    data.schema_migrations = ['2026-08-27-proxy-mysql-initial', '2026-08-27-proxy-token-binary-collation', ...(layout === 'pool' ? ['2026-09-12-user-pool-mysql-v1'] : [])]
      .map(id => ({ id, applied_at: '2026-09-18 00:00:00.000' }));
    data.proxy_accounts = [{ identity: 'alice', sso_user: 'alice', gh_login: 'Alice', copilot_oauth_token: '  ByteSensitive token\0x  ',
      copilot_oauth_status: 'valid', copilot_oauth_updated_at: '2026-09-18 00:00:00.123', copilot_oauth_attempt_id: null,
      created_at: '2026-09-17 00:00:00.000', updated_at: '2026-09-18 00:00:00.000', ...(version === 2 ? { enterprise_id: profile.id } : {}) }];
    if (layout === 'pool') data.user_pool_settings = [{ id: 1, version: 4, idle_target: 2, ...(version === 1 ? { max_accounts: 6 } : {}), lease_seconds: 172800,
      paused: 1, next_ordinal: 0, account_domain: profile.accountDomain, config_fingerprint: 'a'.repeat(64), owner: null, owner_until: 0 }];
    if (version === 2) {
      data.enterprise_profiles = [{ singleton: 1, id: profile.id, slug: profile.slug, profile_json: canonicalEnterpriseProfile(profile), revision: 1, max_accounts: layout === 'pool' ? 6 : null }];
      data.enterprise_schema = [{ singleton: 1, component: 'proxy', schema_version: 2, contract_version: 1, capability: 'enterprise-single-profile',
        layout, profile_sha256: enterpriseMysqlProfileHash(profile), migration_id: ENTERPRISE_MYSQL_MIGRATION, state: 'complete' }];
    }
  }
  function columns(name: string): Row[] {
    const table = schema[name];
    return Object.entries(table.columns).map(([column, definition]) => {
      const defaults = definition.match(/DEFAULT (?:'([^']*)'|(\d+))/);
      return { COLUMN_NAME: column, COLUMN_TYPE: definition.match(/^\w+(?:\(\d+\))?(?: UNSIGNED)?/)![0].toLowerCase(),
        IS_NULLABLE: column === table.primary || definition.includes('NOT NULL') ? 'NO' : 'YES',
        COLLATION_NAME: definition.match(/COLLATE (\w+)/)?.[1] ?? (/^(?:VARCHAR|CHAR|TEXT|LONGTEXT)/.test(definition) ? table.pool ? 'utf8mb4_bin' : 'utf8mb4_0900_ai_ci' : null),
        COLUMN_DEFAULT: defaults ? defaults[1] ?? defaults[2] : null, EXTRA: definition.includes('AUTO_INCREMENT') ? 'auto_increment' : '', GENERATION_EXPRESSION: '' };
    });
  }
  function indexes(name: string): Row[] {
    const table = schema[name];
    const key = (name: string, column: string, unique: boolean, seq = 1, direction = 'A') => ({ INDEX_NAME: name, COLUMN_NAME: column,
      NON_UNIQUE: unique ? 0 : 1, SEQ_IN_INDEX: seq, SUB_PART: null, COLLATION: direction, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES', EXPRESSION: null });
    const rows = [key('PRIMARY', table.primary, true), ...(table.unique ?? []).map(column => key(column, column, true))];
    for (const index of table.indexes ?? []) {
      const match = index.match(/^(\w+) \((.+)\)$/)!;
      match[2].split(',').forEach((part, i) => { const [column, desc] = part.trim().split(/\s+/); rows.push(key(match[1], column, false, i + 1, desc === 'DESC' ? 'D' : 'A')); });
    }
    return rows;
  }
  async function query(sql: string, values: any[] = []): Promise<any> {
    statements.push(sql);
    if (destroyed) throw new Error('socket closed');
    if (fail(sql)) throw new Error('private driver error with credential');
    if (sql.startsWith('SELECT DATABASE()')) return [[{ name: 'ghcp_enterprise_test_unit', autocommit: 1, foreign_keys: 1 }]];
    if (sql.startsWith('SET SESSION lock_wait_timeout=')) return [{}];
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
    if (sql.includes('information_schema.ROUTINES') || sql.includes('information_schema.EVENTS')) return [[]];
    if (sql.includes('SELECT AUTO_INCREMENT')) return [[{ AUTO_INCREMENT: layout === 'pool' ? '11' : null }]];
    if (sql.includes('information_schema.TABLES')) return [metadataAlter('tables', '', Object.keys(schema).map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', TABLE_COLLATION: schema[TABLE_NAME].pool ? 'utf8mb4_bin' : 'utf8mb4_0900_ai_ci' })))];
    if (sql.includes('information_schema.COLUMNS')) return [metadataAlter('columns', values[0], columns(values[0]))];
    if (sql.includes('information_schema.STATISTICS')) return [metadataAlter('indexes', values[0], indexes(values[0]))];
    if (sql.includes('information_schema.CHECK_CONSTRAINTS')) return [metadataAlter('checks', values[0], (schema[values[0]].checks ?? []).map(CHECK_CLAUSE => ({ CHECK_CLAUSE, ENFORCED: 'YES' })))];
    if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [metadataAlter('foreign', values[0], (schema[values[0]].foreign ?? []).map(([column, table, referenced, onDelete]) => ({
      COLUMN_NAME: column, REFERENCED_TABLE_NAME: table, REFERENCED_COLUMN_NAME: referenced, CONSTRAINT_NAME: FOREIGN_NAMES[values[0]] ?? `fk_${values[0]}_${column}`,
      ORDINAL_POSITION: 1, DELETE_RULE: onDelete, UPDATE_RULE: 'RESTRICT', local_reference: 1 })))];
    if (sql.includes('information_schema.TRIGGERS')) return [metadataAlter('triggers', '', Object.entries(triggers).map(([TRIGGER_NAME, t]) => ({ TRIGGER_NAME,
      EVENT_OBJECT_TABLE: t.table, ACTION_TIMING: t.timing, EVENT_MANIPULATION: t.event, ACTION_STATEMENT: t.body, ACTION_ORIENTATION: 'ROW' })))];
    if (sql.startsWith('SELECT HEX') || sql.startsWith('SELECT (SELECT HEX')) {
      const table = sql.match(/ FROM `([^`]+)` ORDER BY/)! [1];
      const names = [...sql.matchAll(/ AS `([^`]+)`/g)].map(match => match[1]);
      return [data[table].map(row => Object.fromEntries(names.map(name => {
        const value = name === 'max_accounts' && !Object.hasOwn(schema[table].columns, name) ? data.enterprise_profiles[0].max_accounts : row[name];
        return [name, value === null || value === undefined ? null : Buffer.from(String(value)).toString('hex').toUpperCase()];
      })))];
    }
    if (sql.startsWith('SELECT COUNT(*)')) {
      const table = sql.match(/FROM (\w+)/)![1];
      if (sql.includes('enterprise_id IS NOT NULL')) return [[{ n: data.proxy_accounts.filter(row => row.enterprise_id !== null).length }]];
      if (sql.includes('enterprise_id IS NULL OR')) return [[{ n: data.proxy_accounts.filter(row => row.enterprise_id == null || row.enterprise_id !== values[0]).length }]];
      if (!sql.includes('WHERE') && !sql.includes('JOIN')) return [[{ n: data[table].length }]];
      return [[{ n: 0 }]];
    }
    if (sql.includes('AS server_now FROM user_pool_settings')) return [data.user_pool_settings.map(row => ({ ...row, server_now: Date.now() }))];
    if (/^SELECT (?:\*|id|max_accounts) FROM \w+$/.test(sql)) return [structuredClone(data[sql.match(/FROM (\w+)/)![1]])];
    mutations.push(sql);
    if (sql.startsWith('CREATE TABLE')) {
      const name = sql.match(/CREATE TABLE `([^`]+)`/)![1];
      const definitions = { ...enterpriseMysqlSchema(layout), ...ENTERPRISE_MYSQL_TABLES };
      assert.equal(sql, mysqlCreateTable(name, definitions));
      assert.equal(schema[name], undefined); schema[name] = structuredClone(definitions[name]); data[name] = [];
    } else if (sql.startsWith('CREATE TRIGGER')) {
      const name = sql.match(/CREATE TRIGGER (\w+)/)![1];
      const t = name === 'user_pool_credential_fence' ? MYSQL_FENCE_TRIGGER : ENTERPRISE_MYSQL_TRIGGERS[name];
      assert.equal(sql, enterpriseMysqlCreateTrigger(name, t)); triggers[name] = t;
    } else if (sql.startsWith('ALTER TABLE proxy_accounts ADD')) {
      schema.proxy_accounts.columns.enterprise_id = 'VARCHAR(36) COLLATE ascii_bin';
      schema.proxy_accounts.indexes!.push('idx_proxy_accounts_enterprise (enterprise_id)');
      schema.proxy_accounts.foreign = [['enterprise_id', 'enterprise_profiles', 'id', 'RESTRICT']];
      for (const row of data.proxy_accounts) row.enterprise_id = null;
    } else if (sql.startsWith('ALTER TABLE proxy_accounts MODIFY')) schema.proxy_accounts.columns.enterprise_id = 'VARCHAR(36) COLLATE ascii_bin NOT NULL';
    else if (sql.startsWith('ALTER TABLE user_pool_settings DROP')) { delete schema.user_pool_settings.columns.max_accounts; for (const row of data.user_pool_settings) delete row.max_accounts; }
    else if (sql.startsWith('UPDATE proxy_accounts SET enterprise_id')) for (const row of data.proxy_accounts) row.enterprise_id = values[0];
    else if (sql.startsWith('INSERT INTO enterprise_profiles')) data.enterprise_profiles.push(Object.fromEntries(['singleton', 'id', 'slug', 'profile_json', 'revision', 'max_accounts'].map((key, i) => [key, [1, ...values][i]])));
    else if (sql.startsWith('INSERT INTO enterprise_schema')) data.enterprise_schema.push({ singleton: 1, component: 'proxy', schema_version: 2, contract_version: 1, capability: 'enterprise-single-profile', layout: values[0], profile_sha256: values[1], migration_id: values[2], state: 'complete' });
    else if (sql.startsWith('INSERT INTO schema_migrations')) data.schema_migrations.push({ id: values[0], applied_at: '2026-09-18 00:00:00.000' });
    else if (sql.startsWith('INSERT INTO user_pool_settings')) data.user_pool_settings.push(Object.fromEntries(['id', 'version', 'idle_target', 'lease_seconds', 'paused', 'next_ordinal', 'account_domain', 'config_fingerprint', 'owner', 'owner_until'].map((key, i) => [key, [1, ...values][i]])));
    else if (sql.startsWith('INSERT INTO enterprise_upgrade')) data.enterprise_upgrade.push({ singleton: 1, migration_id: values[0], database_name: values[1], manifest_sha256: values[2], backup_reference: values[3], backup_sha256: values[4], profile_sha256: values[5], source_sha256: values[6], layout: values[7], state: 'applying', step: 0, checkpoint_state: 'after', evidence_json: values[8] });
    else if (sql.startsWith('UPDATE enterprise_upgrade SET step=')) { data.enterprise_upgrade[0].step = values[0]; data.enterprise_upgrade[0].checkpoint_state = sql.includes("'before'") ? 'before' : 'after'; if (sql.includes('state=?')) data.enterprise_upgrade[0].state = values[1]; }
    else if (sql.startsWith("UPDATE enterprise_upgrade SET checkpoint_state='unknown'")) data.enterprise_upgrade[0].checkpoint_state = 'unknown';
    else if (sql.startsWith("UPDATE enterprise_upgrade SET checkpoint_state='after',state=")) { data.enterprise_upgrade[0].checkpoint_state = 'after'; data.enterprise_upgrade[0].state = values[0]; }
    else assert.fail(`Unhandled mock statement: ${sql}`);
    if (loseAfter(sql)) throw new Error('lost response after commit');
    return [{ affectedRows: 1 }];
  }
  const connection = { query, destroy() { destroyed = true; } } as unknown as MysqlConnection;
  return { connection, data, statements, mutations, get schema() { return schema; }, get triggers() { return triggers; },
    get destroyed() { return destroyed; }, reconnect() { destroyed = false; fail = () => false; loseAfter = () => false; },
    alterMetadata(fn: typeof metadataAlter) { metadataAlter = fn; }, failWhen(fn: typeof fail) { fail = fn; }, loseResponseWhen(fn: typeof loseAfter) { loseAfter = fn; } };
}
export const plan = (sourceSha256: string) => ({ migrationId: 'unit-upgrade-1', confirmOffline: true, confirmBackup: true, confirmDrained: true,
  expectedSourceSha256: sourceSha256, manifestSha256: createHash('sha256').update('manifest').digest('hex'), backupReference: 'unit-backup',
  backupSha256: createHash('sha256').update('backup').digest('hex'), expectedDatabase: 'ghcp_enterprise_test_unit' });
