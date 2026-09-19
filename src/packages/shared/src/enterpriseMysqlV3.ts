import { validateEnterprisePoolSettings } from './enterpriseStorage.js';
import { createHash } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import { canonicalEnterpriseIdentityRegistryV3, parseEnterpriseRegistryV3, parseEnterpriseProfileV3,
  ENTERPRISE_V3_SCHEMA, ENTERPRISE_V3_CONTRACT, ENTERPRISE_V3_CAPABILITY, type EnterpriseRegistryV3, type EnterpriseProfileV3 } from './enterpriseV3.js';
import { parseEnterpriseProfile, type EnterpriseProfile } from './enterprise.js';
import { canonicalSql, mysqlCreateTable, validateMysqlTables, type MysqlConnection, type TableSchema } from './enterpriseMysqlV1.js';
import { EnterpriseMysqlError, ENTERPRISE_MYSQL_LOCK, ENTERPRISE_MYSQL_MIGRATION, enterpriseMysqlProfileHash, enterpriseMysqlSchema, mysqlEnterpriseRows, requireEnterpriseMysql as requireSafe,
  enterpriseMysqlObjects, validateEnterpriseMysqlHistory, validateEnterpriseMysqlCheckpoint, withEnterpriseMysqlDeadline,
  type EnterpriseMysqlLayout, type EnterpriseMysqlInitOptions } from './enterpriseMysql.js';
import { ENTERPRISE_MYSQL_V3_MIGRATION, ENTERPRISE_MYSQL_V3_FINAL_STEP, getExpectedEnterpriseMysqlV3,
  enterpriseMysqlCreateTriggerV3, type EnterpriseMysqlTriggerV3 } from './enterpriseMysqlSchemaV3.js';
export { enterpriseMysqlSchemaV3, getExpectedEnterpriseMysqlV3 } from './enterpriseMysqlSchemaV3.js';
export type { MysqlConnection, EnterpriseMysqlLayout, EnterpriseMysqlInitOptions };
export interface EnterpriseMysqlValidationV3 { registry: EnterpriseRegistryV3; legacyEnterpriseId: string; layout: EnterpriseMysqlLayout; maxAccounts?: number }
export const enterpriseMysqlRegistryHashV3 = (registry: EnterpriseRegistryV3) => createHash('sha256').update(canonicalEnterpriseIdentityRegistryV3(registry)).digest('hex');
export const isEnterpriseMysqlHashV3 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isEnterpriseMysqlUuidV3 = (value: unknown): value is string =>     typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function enterpriseMysqlLegacyProfileV3(profile: EnterpriseProfileV3): EnterpriseProfile {
  return parseEnterpriseProfile(Object.fromEntries(['id', 'slug', 'shortcode', 'accountDomain', 'revision', 'routes'].map(key => [key, profile[key as keyof EnterpriseProfileV3]])));
}
export async function validateEnterpriseMysqlShapeV3(c: MysqlConnection, schema: Record<string, TableSchema>, triggers: Record<string, EnterpriseMysqlTriggerV3>): Promise<void> {
  const names = await enterpriseMysqlObjects(c);
  requireSafe(names.length === Object.keys(schema).length && names.every(name => Object.hasOwn(schema, name)), 'enterprise_mysql_table_set');
  await validateMysqlTables(c, schema);
  const actual = await mysqlEnterpriseRows(c, `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT,
    ACTION_ORIENTATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`);
  requireSafe(actual.length === Object.keys(triggers).length && actual.every(row => {
    const expected = triggers[row.TRIGGER_NAME];
    return expected && row.EVENT_OBJECT_TABLE === expected.table && row.ACTION_TIMING === expected.timing && row.EVENT_MANIPULATION === expected.event
      && row.ACTION_ORIENTATION === 'ROW' && canonicalSql(row.ACTION_STATEMENT) === canonicalSql(expected.body);
  }), 'enterprise_mysql_triggers');
}
export async function readEnterpriseMysqlRegistryV3(c: MysqlConnection, expected?: EnterpriseRegistryV3): Promise<EnterpriseRegistryV3> {
  const rows = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_registry');
  const profiles = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_profiles ORDER BY BINARY id');
  requireSafe(rows.length === 1 && Number(rows[0].singleton) === 1, 'enterprise_mysql_registry');
  let registry: EnterpriseRegistryV3;
  try { registry = parseEnterpriseRegistryV3({ version: 3, registryRevision: Number(rows[0].registry_revision), legacyEnterpriseId: rows[0].legacy_enterprise_id,
    profiles: profiles.map(row => JSON.parse(row.profile_json)) }); } catch { throw new EnterpriseMysqlError('enterprise_mysql_registry'); }
  requireSafe(rows[0].registry_sha256 === enterpriseMysqlRegistryHashV3(registry) && profiles.length === registry.profiles.length
    && profiles.every(row => { const profile = registry.profiles.find(p => p.id === row.id); return profile && row.slug === profile.slug
      && Number(row.revision) === profile.revision && row.profile_json === JSON.stringify(profile)
      && Number.isInteger(Number(row.max_accounts)) && Number(row.max_accounts) >= 1 && Number(row.max_accounts) <= 10000; }), 'enterprise_mysql_registry');
  requireSafe(profiles.reduce((total,row)=>total+Number(row.max_accounts),0)<=10000,'enterprise_mysql_capacity');
  requireSafe(!expected || canonicalEnterpriseIdentityRegistryV3(registry) === canonicalEnterpriseIdentityRegistryV3(expected), 'enterprise_mysql_registry_mismatch');
  return registry;
}
/** Validate only immutable receipt syntax. Live business rows may legitimately change after startup. */
export function validateEnterpriseMysqlCheckpointV3(row: Record<string, unknown>, database: string, layout: EnterpriseMysqlLayout,
  registry?: EnterpriseRegistryV3): void {
  requireSafe(Number(row.singleton) === 1 && row.database_name === database && row.layout === layout && row.state === 'complete'
    && row.checkpoint_state === 'after' && Number(row.step) === ENTERPRISE_MYSQL_V3_FINAL_STEP
    && typeof row.migration_id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(row.migration_id)
    && ['manifest_sha256', 'backup_sha256', 'registry_sha256', 'source_sha256', 'mapping_sha256'].every(key => isEnterpriseMysqlHashV3(row[key]))
    && typeof row.backup_reference === 'string' && row.backup_reference.length > 0 && row.backup_reference.length <= 255
    && !/[\x00-\x1f\x7f]/.test(row.backup_reference) && typeof row.evidence_json === 'string' && typeof row.mapping_json === 'string', 'enterprise_mysql_checkpoint');
  try {
    const evidence = JSON.parse(row.evidence_json as string), mapping = JSON.parse(row.mapping_json as string);
    const schema = enterpriseMysqlSchema(layout);
    delete schema.enterprise_profiles; delete schema.enterprise_schema;
    const keys = (value: unknown, names: string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
    requireSafe(keys(evidence, ['counts', 'columns', 'profile', 'marker', 'eventSequence'])
      && keys(evidence.counts, Object.keys(schema)) && keys(evidence.columns, Object.keys(schema))
      && Object.entries(schema).every(([table, def]) => Number.isSafeInteger(evidence.counts[table]) && evidence.counts[table] >= 0 && evidence.counts[table] <= 100000
        && keys(evidence.columns[table], Object.keys(def.columns)) && Object.values(evidence.columns[table]).every(isEnterpriseMysqlHashV3))
      && keys(evidence.profile, ['singleton', 'id', 'slug', 'profile_json', 'revision', 'max_accounts'])
      && keys(evidence.marker, ['singleton', 'component', 'schema_version', 'contract_version', 'capability', 'layout', 'profile_sha256', 'migration_id', 'state'])
      && (layout === 'pool' ? evidence.eventSequence === null || typeof evidence.eventSequence === 'string' && /^\d+$/.test(evidence.eventSequence) : evidence.eventSequence === null)
      && Array.isArray(mapping) && mapping.length === evidence.counts.proxy_accounts && mapping.length <= 100000
      && mapping.every((item: any) => item && Object.keys(item).sort().join(',') === 'accountIncarnation,identity'
        && typeof item.identity === 'string' && item.identity.length >= 1 && item.identity.length <= 255 && isEnterpriseMysqlUuidV3(item.accountIncarnation))
      && new Set(mapping.map((item: any) => item.identity)).size === mapping.length
      && new Set(mapping.map((item: any) => item.accountIncarnation)).size === mapping.length
      && createHash('sha256').update(row.evidence_json as string).digest('hex') === row.source_sha256
      && createHash('sha256').update(row.mapping_json as string).digest('hex') === row.mapping_sha256, 'enterprise_mysql_checkpoint');
    const profile = parseEnterpriseProfile(JSON.parse(evidence.profile.profile_json));
    requireSafe(Number(evidence.profile.singleton) === 1 && profile.id === evidence.profile.id && profile.slug === evidence.profile.slug
      && profile.revision === Number(evidence.profile.revision) && JSON.stringify(profile) === evidence.profile.profile_json
      && (layout === 'pool' ? Number.isInteger(Number(evidence.profile.max_accounts)) && Number(evidence.profile.max_accounts) >= 1 && Number(evidence.profile.max_accounts) <= 10000 : evidence.profile.max_accounts === null)
      && Number(evidence.marker.singleton) === 1 && evidence.marker.component === 'proxy' && Number(evidence.marker.schema_version) === 2
      && Number(evidence.marker.contract_version) === 1 && evidence.marker.capability === 'enterprise-single-profile' && evidence.marker.layout === layout
      && evidence.marker.profile_sha256 === enterpriseMysqlProfileHash(profile) && evidence.marker.migration_id === ENTERPRISE_MYSQL_MIGRATION && evidence.marker.state === 'complete'
      && (!registry || registry.legacyEnterpriseId === profile.id
        && JSON.stringify(enterpriseMysqlLegacyProfileV3(registry.profiles.find(p => p.id === profile.id)!)) === JSON.stringify(profile)), 'enterprise_mysql_checkpoint');
  } catch { throw new EnterpriseMysqlError('enterprise_mysql_checkpoint'); }
}
/** SELECT-only schema3/contract2 runtime gate. Expected config capacity is not the mutable DB capacity. */
export async function validateEnterpriseMysqlV3(connection: MysqlConnection, component: 'proxy', expectedRegistry?: EnterpriseRegistryV3): Promise<EnterpriseMysqlValidationV3> {
  requireSafe(component === 'proxy', 'enterprise_mysql_component');
  return withEnterpriseMysqlDeadline(connection, async c => {
    try {
      const names = await enterpriseMysqlObjects(c);
      requireSafe(['enterprise_profiles', 'enterprise_registry', 'enterprise_schema', 'enterprise_upgrade', 'enterprise_upgrade_v3'].every(name => names.includes(name)), 'enterprise_mysql_upgrade_required');
      const registry = await readEnterpriseMysqlRegistryV3(c, expectedRegistry);
      const markers = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_schema'); const marker = markers[0];
      requireSafe(markers.length === 1 && Number(marker.singleton) === 1 && marker.component === 'proxy'
        && Number(marker.schema_version) === ENTERPRISE_V3_SCHEMA && Number(marker.contract_version) === ENTERPRISE_V3_CONTRACT
        && marker.capability === ENTERPRISE_V3_CAPABILITY && ['direct', 'pool'].includes(marker.layout)
        && marker.registry_sha256 === enterpriseMysqlRegistryHashV3(registry) && marker.migration_id === ENTERPRISE_MYSQL_V3_MIGRATION
        && marker.state === 'complete', 'enterprise_mysql_marker');
      const layout = marker.layout as EnterpriseMysqlLayout;
      const expected = getExpectedEnterpriseMysqlV3(layout);
      await validateEnterpriseMysqlShapeV3(c, expected.schema, expected.triggers);
      await validateEnterpriseMysqlHistory(c, layout);
      const legacy = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
      const database = (await mysqlEnterpriseRows(c, 'SELECT DATABASE() AS name'))[0]?.name;
      const old = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_upgrade');
      requireSafe(old.length <= 1, 'enterprise_mysql_checkpoint');
      if (old.length) validateEnterpriseMysqlCheckpoint(old[0], enterpriseMysqlLegacyProfileV3(legacy), layout, database);
      const checkpoints = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_upgrade_v3');
      requireSafe(checkpoints.length <= 1, 'enterprise_mysql_checkpoint');
      if (checkpoints.length) validateEnterpriseMysqlCheckpointV3(checkpoints[0], database, layout, registry);
      // Do not assume FKs were always enabled on historical writes.
      for (const [table, definition] of Object.entries(expected.schema)) for (const [column, target, reference] of definition.foreign ?? []) {
        const rows = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${table} a LEFT JOIN ${target} b ON a.${column}=b.${reference} WHERE b.${reference} IS NULL`);
        requireSafe(Number(rows[0]?.n) === 0, 'enterprise_mysql_orphan');
      }
      const accounts = await mysqlEnterpriseRows(c, 'SELECT account_incarnation FROM proxy_accounts');
      requireSafe(accounts.every(row => isEnterpriseMysqlUuidV3(row.account_incarnation))
        && new Set(accounts.map(row => row.account_incarnation)).size === accounts.length, 'enterprise_mysql_incarnation');
      const attempts = await mysqlEnterpriseRows(c, 'SELECT * FROM proxy_authorization_attempts');
      requireSafe(attempts.every(row => isEnterpriseMysqlUuidV3(row.oauth_attempt_id) && isEnterpriseMysqlUuidV3(row.account_incarnation)
        && Number.isSafeInteger(Number(row.enterprise_revision)) && Number(row.enterprise_revision)>=1
        && typeof row.identity==='string' && row.identity.length>=1 && row.identity.length<=255
        && typeof row.expected_gh_login==='string' && row.expected_gh_login.length>=1
        && ['active','succeeded','failed','cancelled'].includes(row.status)
        && (row.result_fingerprint===null || isEnterpriseMysqlHashV3(row.result_fingerprint))
        && (row.status!=='active' || row.result_fingerprint===null && row.result_gh_login===null && row.result_github_user_id===null)
        && (row.status!=='succeeded' || isEnterpriseMysqlHashV3(row.result_fingerprint) && typeof row.result_gh_login==='string' && row.result_gh_login.length>=1)),
        'enterprise_mysql_authorization_evidence');
      let maxAccounts: number | undefined;
      if (layout === 'pool') {
        const bad = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM user_pool_accounts p LEFT JOIN proxy_accounts a ON a.identity=p.identity
          WHERE a.identity IS NULL OR BINARY a.enterprise_id <> BINARY ?`, [registry.legacyEnterpriseId]);
        requireSafe(Number(bad[0]?.n) === 0, 'enterprise_mysql_pool_legacy_only');
        const settings = await mysqlEnterpriseRows(c, 'SELECT * FROM user_pool_settings');
        requireSafe(settings.length === 1 && Number(settings[0].id) === 1 && settings[0].account_domain === legacy.accountDomain, 'enterprise_mysql_settings');
        const caps = await mysqlEnterpriseRows(c, 'SELECT max_accounts FROM enterprise_profiles WHERE id=?', [registry.legacyEnterpriseId]);
        maxAccounts = Number(caps[0]?.max_accounts);
        validateEnterprisePoolSettings({ version:Number(settings[0].version),idle_target:Number(settings[0].idle_target),
          lease_seconds:Number(settings[0].lease_seconds),paused:Number(settings[0].paused) as 0|1,next_ordinal:Number(settings[0].next_ordinal),
          account_domain:String(settings[0].account_domain),owner:settings[0].owner,owner_until:Number(settings[0].owner_until) },maxAccounts);
        requireSafe(isEnterpriseMysqlHashV3(settings[0].config_fingerprint),'enterprise_mysql_settings');
      }
      return { registry, legacyEnterpriseId: registry.legacyEnterpriseId, layout, ...(maxAccounts === undefined ? {} : { maxAccounts }) };
    } catch (error) {
      if (error instanceof EnterpriseMysqlError) throw error;
      throw new EnterpriseMysqlError('enterprise_mysql_schema');
    }
  });
}
/** Share the old migration lock; bound statements, metadata locks and cleanup to one total budget. */
export async function withEnterpriseMysqlLockV3<T>(connection: MysqlConnection, run: (c: MysqlConnection) => Promise<T>, deadlineMs = 60000): Promise<T> {
  return withEnterpriseMysqlDeadline(connection, async c => {
    let locked = false, failed = false;
    try {
      const lock = await mysqlEnterpriseRows(c, 'SELECT GET_LOCK(?, 5) AS acquired', [ENTERPRISE_MYSQL_LOCK]);
      if (Number(lock[0]?.acquired) !== 1) {
        if (lock[0]?.acquired !== 0 && lock[0]?.acquired !== '0') c.destroy();
        throw new EnterpriseMysqlError('enterprise_mysql_lock_unavailable');
      }
      locked = true;
      await c.query('SET SESSION lock_wait_timeout=5, innodb_lock_wait_timeout=5');
      return await run(c);
    } catch (error) { failed = true; throw error; }
    finally {
      if (locked) try {
        const rows = await mysqlEnterpriseRows(c, 'SELECT RELEASE_LOCK(?) AS released', [ENTERPRISE_MYSQL_LOCK]);
        requireSafe(Number(rows[0]?.released) === 1, 'enterprise_mysql_lock_release_unknown');
      } catch { c.destroy(); if (!failed) throw new EnterpriseMysqlError('enterprise_mysql_lock_release_unknown'); }
    }
  }, deadlineMs);
}
export async function insertEnterpriseMysqlProfileV3(c: MysqlConnection, profile: EnterpriseProfileV3, cap = profile.maxAccounts): Promise<void> {
  await c.query('INSERT INTO enterprise_profiles (id,slug,revision,profile_json,max_accounts) VALUES (?,?,?,?,?)',
    [profile.id, profile.slug, profile.revision, JSON.stringify(parseEnterpriseProfileV3(profile)), cap]);
}
export async function insertEnterpriseMysqlRegistryV3(c: MysqlConnection, registry: EnterpriseRegistryV3): Promise<void> {
  await c.query('INSERT INTO enterprise_registry (singleton,legacy_enterprise_id,registry_revision,registry_sha256) VALUES (1,?,?,?)',
    [registry.legacyEnterpriseId, registry.registryRevision, enterpriseMysqlRegistryHashV3(registry)]);
}
export async function insertEnterpriseMysqlMarkerV3(c: MysqlConnection, registry: EnterpriseRegistryV3, layout: EnterpriseMysqlLayout): Promise<void> {
  await c.query(`INSERT INTO enterprise_schema (singleton,component,schema_version,contract_version,capability,layout,registry_sha256,migration_id,state)
    VALUES (1,'proxy',3,2,'enterprise-isolation-legacy-pool',?,?,?,'complete')`, [layout, enterpriseMysqlRegistryHashV3(registry), ENTERPRISE_MYSQL_V3_MIGRATION]);
}
/** Explicit offline/fixture operation. No runtime auto-init and no rollback claim for independently committing DDL. */
export async function initEnterpriseMysqlV3(connection: MysqlConnection, component: 'proxy', input: EnterpriseRegistryV3, options: EnterpriseMysqlInitOptions = {}): Promise<void> {
  requireSafe(component === 'proxy', 'enterprise_mysql_component');
  const registry = parseEnterpriseRegistryV3(input), legacy = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
  const layout = options.layout ?? (options.pool ? 'pool' : 'direct'), cap = legacy.maxAccounts;
  requireSafe(options.maxAccounts===undefined || options.maxAccounts===cap,'enterprise_mysql_capacity_seed_mismatch');
  requireSafe(['direct', 'pool'].includes(layout), 'enterprise_mysql_layout');
  requireSafe(Number.isInteger(cap) && cap >= 1 && cap <= 10000, 'enterprise_mysql_capacity');
  requireSafe(layout === 'pool' ? !!options.pool : options.pool === undefined && options.maxAccounts === undefined, 'enterprise_mysql_settings');
  if (options.pool) {
    const { settings: s, fingerprint } = options.pool;
    requireSafe(isEnterpriseMysqlHashV3(fingerprint) && s.account_domain === legacy.accountDomain
      && Number.isInteger(s.version) && s.version >= 1 && Number.isInteger(s.idle_target) && s.idle_target >= 0 && s.idle_target <= cap
      && Number.isInteger(s.lease_seconds) && s.lease_seconds >= 60 && s.lease_seconds <= 2592000 && [0, 1].includes(s.paused)
      && Number.isInteger(s.next_ordinal) && s.next_ordinal >= 0 && s.next_ordinal <= 10000
      && (s.owner === null || isEnterpriseMysqlUuidV3(s.owner)) && Number.isSafeInteger(s.owner_until) && s.owner_until >= 0, 'enterprise_mysql_settings');
  }
  await withEnterpriseMysqlLockV3(connection, async c => {
    requireSafe((await enterpriseMysqlObjects(c)).length === 0 && (await mysqlEnterpriseRows(c, 'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()')).length === 0, 'enterprise_mysql_init_requires_empty');
    const expected = getExpectedEnterpriseMysqlV3(layout);
    for (const name of Object.keys(expected.schema)) await c.query(mysqlCreateTable(name, expected.schema));
    for (const profile of registry.profiles) await insertEnterpriseMysqlProfileV3(c, profile, profile.id === legacy.id ? cap : profile.maxAccounts);
    await insertEnterpriseMysqlRegistryV3(c, registry);
    for (const id of ['2026-08-27-proxy-mysql-initial', '2026-08-27-proxy-token-binary-collation', ...(layout === 'pool' ? ['2026-09-12-user-pool-mysql-v1'] : [])])
      await c.query('INSERT INTO schema_migrations (id,applied_at) VALUES (?,UTC_TIMESTAMP(3))', [id]);
    if (options.pool) {
      const { settings: s, fingerprint } = options.pool;
      await c.query(`INSERT INTO user_pool_settings (id,version,idle_target,lease_seconds,paused,next_ordinal,account_domain,config_fingerprint,owner,owner_until)
        VALUES (1,?,?,?,?,?,?,?,?,?)`, [s.version, s.idle_target, s.lease_seconds, s.paused, s.next_ordinal, s.account_domain, fingerprint, s.owner, s.owner_until]);
    }
    for (const [name, trigger] of Object.entries(expected.triggers)) await c.query(enterpriseMysqlCreateTriggerV3(name, trigger));
    await validateEnterpriseMysqlShapeV3(c, expected.schema, expected.triggers);
    await validateEnterpriseMysqlHistory(c, layout); await readEnterpriseMysqlRegistryV3(c, registry);
    for (const name of Object.keys(expected.schema).filter(name => !['enterprise_profiles', 'enterprise_registry', 'schema_migrations', 'user_pool_settings'].includes(name)))
      requireSafe(Number((await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${name}`))[0]?.n) === 0, 'enterprise_mysql_init_data');
    await insertEnterpriseMysqlMarkerV3(c, registry, layout);
    await validateEnterpriseMysqlV3(c, 'proxy', registry);
  });
}
export interface EnterpriseMysqlRegisterOptionsV3 { confirmOffline: boolean; confirmDrained: boolean; expectedRegistryRevision: number; deadlineMs?: number }
/** Add-only offline registration: old config and stored caps are never rewritten. Secret refs remain refs. */
export async function registerEnterpriseMysqlV3(connection: MysqlConnection, previous: EnterpriseRegistryV3, next: EnterpriseRegistryV3, options: EnterpriseMysqlRegisterOptionsV3): Promise<EnterpriseMysqlValidationV3> {
  previous = parseEnterpriseRegistryV3(previous); next = parseEnterpriseRegistryV3(next);
  requireSafe(options.confirmOffline === true && options.confirmDrained === true, 'enterprise_mysql_maintenance_required');
  requireSafe(options.expectedRegistryRevision === previous.registryRevision && next.registryRevision === previous.registryRevision + 1
    && next.legacyEnterpriseId === previous.legacyEnterpriseId && next.profiles.length > previous.profiles.length
    && previous.profiles.every(p => JSON.stringify(p) === JSON.stringify(next.profiles.find(n => n.id === p.id))), 'enterprise_mysql_registry_add_only');
  return withEnterpriseMysqlLockV3(connection, async c => {
    const current = await validateEnterpriseMysqlV3(c, 'proxy', previous);
    requireSafe(Number((await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM proxy_accounts WHERE copilot_oauth_attempt_id IS NOT NULL
      OR copilot_oauth_status NOT IN ('valid','expired','missing','failed')`))[0]?.n) === 0, 'enterprise_mysql_unresolved_oauth');
    if (current.layout === 'pool') {
      const settings = await mysqlEnterpriseRows(c, 'SELECT *, CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS server_now FROM user_pool_settings');
      requireSafe(settings.length === 1 && Number(settings[0].paused) === 1 && Number(settings[0].owner_until) <= Number(settings[0].server_now), 'enterprise_mysql_settings_not_drained');
      requireSafe(Number((await mysqlEnterpriseRows(c, "SELECT COUNT(*) AS n FROM user_pool_accounts WHERE state='provisioning'"))[0]?.n) === 0, 'enterprise_mysql_unresolved_provisioning');
    }
    for (const table of ['proxy_identity_initializations', 'proxy_authorization_attempts', 'user_pool_holds', 'user_pool_catalog_holds']) {
      if (table.startsWith('user_pool_') && !(await enterpriseMysqlObjects(c)).includes(table)) continue;
      const where = table === 'proxy_authorization_attempts' ? " WHERE status='active'" : '';
      requireSafe(Number((await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${table}${where}`))[0]?.n) === 0, 'enterprise_mysql_not_drained');
    }
    await c.query('START TRANSACTION');
    try {
      const rows = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_registry WHERE singleton=1 FOR UPDATE');
      requireSafe(rows.length === 1 && Number(rows[0].registry_revision) === previous.registryRevision && rows[0].registry_sha256 === enterpriseMysqlRegistryHashV3(previous), 'enterprise_mysql_registry_cas');
      for (const profile of next.profiles.filter(p => !previous.profiles.some(old => old.id === p.id))) await insertEnterpriseMysqlProfileV3(c, profile);
      const [update] = await c.query<ResultSetHeader>('UPDATE enterprise_registry SET registry_revision=?,registry_sha256=? WHERE singleton=1 AND registry_revision=? AND registry_sha256=?',
        [next.registryRevision, enterpriseMysqlRegistryHashV3(next), previous.registryRevision, enterpriseMysqlRegistryHashV3(previous)]);
      requireSafe(update.affectedRows === 1, 'enterprise_mysql_registry_cas');
      const [marker] = await c.query<ResultSetHeader>('UPDATE enterprise_schema SET registry_sha256=? WHERE singleton=1 AND registry_sha256=?',
        [enterpriseMysqlRegistryHashV3(next), enterpriseMysqlRegistryHashV3(previous)]);
      requireSafe(marker.affectedRows === 1, 'enterprise_mysql_registry_cas');
      const result = await validateEnterpriseMysqlV3(c, 'proxy', next);
      await c.query('COMMIT'); return result;
    } catch (error) { try { await c.query('ROLLBACK'); } catch { c.destroy(); } throw error; }
  }, options.deadlineMs);
}
