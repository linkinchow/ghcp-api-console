import { createHash, randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import { canonicalEnterpriseProfile } from '../../src/packages/shared/src/enterprise.js';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { mysqlCreateTable, validateMysqlTables, canonicalMysqlCheck, type TableSchema, type MysqlConnection } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { enterpriseMysqlSchema, ENTERPRISE_MYSQL_TRIGGERS, MYSQL_FENCE_TRIGGER, EnterpriseMysqlError,
  enterpriseMysqlObjects, mysqlEnterpriseRows, requireEnterpriseMysql as requireSafe, validateEnterpriseMysql,
  validateEnterpriseMysqlHistory, withEnterpriseMysqlDeadline, type EnterpriseMysqlLayout } from '../../src/packages/shared/src/enterpriseMysql.js';
import { ENTERPRISE_MYSQL_V3_TABLES, ENTERPRISE_MYSQL_V3_TRIGGERS, ENTERPRISE_MYSQL_V3_POOL_TRIGGERS,
  ENTERPRISE_MYSQL_V3_FINAL_STEP, enterpriseMysqlCreateTriggerV3, type EnterpriseMysqlTriggerV3 } from '../../src/packages/shared/src/enterpriseMysqlSchemaV3.js';
import { enterpriseMysqlLegacyProfileV3, enterpriseMysqlRegistryHashV3, isEnterpriseMysqlHashV3, isEnterpriseMysqlUuidV3,
  validateEnterpriseMysqlShapeV3, validateEnterpriseMysqlV3, withEnterpriseMysqlLockV3,
  insertEnterpriseMysqlProfileV3, insertEnterpriseMysqlRegistryV3, insertEnterpriseMysqlMarkerV3 } from '../../src/packages/shared/src/enterpriseMysqlV3.js';
export { registerEnterpriseMysqlV3, initEnterpriseMysqlV3 } from '../../src/packages/shared/src/enterpriseMysqlV3.js';

export interface EnterpriseMysqlAccountIncarnationV3 { identity: string; accountIncarnation: string }
export interface EnterpriseMysqlPreflightV3 {
  database: string; layout: EnterpriseMysqlLayout; maxAccounts?: number; counts: Record<string, number>;
  /** Protected plan material, never print source digests or identity mappings in a public report. */
  sourceSha256: string; accountIncarnations: EnterpriseMysqlAccountIncarnationV3[];
}
export interface EnterpriseMysqlApplyOptionsV3 {
  migrationId: string; confirmOffline: boolean; confirmBackup: boolean; confirmDrained: boolean;
  expectedSourceSha256: string; manifestSha256: string; backupReference: string; backupSha256: string;
  expectedDatabase: string; accountIncarnations: EnterpriseMysqlAccountIncarnationV3[];
  resume?: boolean; deadlineMs?: number; layout?: EnterpriseMysqlLayout;
}
export interface EnterpriseMysqlMigrationResultV3 extends EnterpriseMysqlPreflightV3 { migrationId: string; resumed: boolean }
interface Evidence {
  counts: Record<string, number>; columns: Record<string, Record<string, string>>;
  profile: Record<string, unknown>; marker: Record<string, unknown>; eventSequence: string | null;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const MAX_ROWS = 100000;
const triggerStages: Record<number, string> = { 19: 'enterprise_profile_immutable', 20: 'enterprise_account_immutable', 21: 'enterprise_claim_immutable',
  22: 'enterprise_registry_immutable', 23: 'enterprise_registry_no_delete', 24: 'enterprise_authorization_immutable',
  25: 'enterprise_authorization_no_delete', 26: 'enterprise_pool_legacy_insert', 27: 'enterprise_pool_legacy_update' };

async function databaseName(c: MysqlConnection): Promise<string> {
  const rows = await mysqlEnterpriseRows(c, 'SELECT DATABASE() AS name, @@autocommit AS autocommit, @@foreign_key_checks AS foreign_keys');
  requireSafe(rows.length === 1 && typeof rows[0].name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rows[0].name)
    && Number(rows[0].autocommit) === 1 && Number(rows[0].foreign_keys) === 1, 'enterprise_mysql_session_not_dedicated');
  return rows[0].name;
}
function sourceTables(layout: EnterpriseMysqlLayout): Record<string, TableSchema> {
  return Object.fromEntries(Object.entries(enterpriseMysqlSchema(layout)).filter(([name]) => !['enterprise_profiles', 'enterprise_schema'].includes(name)));
}
/** Explicit stages; the old checkpoint/history and every business column are never changed. */
export function enterpriseMysqlStageSchemaV3(layout: EnterpriseMysqlLayout, step: number): Record<string, TableSchema> {
  const schema = structuredClone(enterpriseMysqlSchema(layout));
  schema.enterprise_upgrade_v3 = structuredClone(ENTERPRISE_MYSQL_V3_TABLES.enterprise_upgrade_v3);
  if (step >= 3 && step < 8) schema.proxy_accounts.foreign = [];
  if (step >= 4) schema.enterprise_profiles.checks = schema.enterprise_profiles.checks!.filter(check => check !== 'singleton = 1');
  if (step >= 5) {
    delete schema.enterprise_profiles.columns.singleton;
    schema.enterprise_profiles.primary = 'id'; schema.enterprise_profiles.unique = ['slug'];
  }
  if (step >= 7) schema.enterprise_profiles.columns.max_accounts = 'INT NOT NULL';
  if (step >= 9) schema.enterprise_registry = structuredClone(ENTERPRISE_MYSQL_V3_TABLES.enterprise_registry);
  if (step >= 11) {
    schema.proxy_accounts.columns.account_incarnation = `VARCHAR(36) COLLATE ascii_bin${step >= 13 ? ' NOT NULL' : ''}`;
    schema.proxy_accounts.unique = ['account_incarnation'];
  }
  if (step >= 14) {
    schema.proxy_identity_initializations.columns.enterprise_id = 'VARCHAR(36) COLLATE ascii_bin NOT NULL';
    schema.proxy_identity_initializations.foreign = [['enterprise_id', 'enterprise_profiles', 'id', 'RESTRICT']];
    schema.proxy_identity_initializations.indexes!.push('idx_proxy_initializations_enterprise (enterprise_id)');
  }
  if (step >= 15) schema.proxy_authorization_attempts = structuredClone(ENTERPRISE_MYSQL_V3_TABLES.proxy_authorization_attempts);
  if (step === 16) delete schema.enterprise_schema;
  if (step >= 17) schema.enterprise_schema = structuredClone(ENTERPRISE_MYSQL_V3_TABLES.enterprise_schema);
  return schema;
}
export function enterpriseMysqlStageTriggersV3(layout: EnterpriseMysqlLayout, step: number): Record<string, EnterpriseMysqlTriggerV3> {
  const triggers: Record<string, EnterpriseMysqlTriggerV3> = structuredClone({ ...ENTERPRISE_MYSQL_TRIGGERS,
    ...(layout === 'pool' ? { user_pool_credential_fence: MYSQL_FENCE_TRIGGER } : {}) });
  if (step >= 1) delete triggers.enterprise_profile_immutable;
  if (step >= 2) delete triggers.enterprise_account_immutable;
  for (const [index, name] of Object.entries(triggerStages)) if (step >= Number(index) && (Number(index) < 26 || layout === 'pool'))
    triggers[name] = structuredClone(ENTERPRISE_MYSQL_V3_TRIGGERS[name] ?? ENTERPRISE_MYSQL_V3_POOL_TRIGGERS[name]);
  return triggers;
}
async function snapshot(c: MysqlConnection, layout: EnterpriseMysqlLayout, original?: Pick<Evidence, 'profile' | 'marker'>): Promise<Evidence> {
  const evidence: Evidence = { counts: {}, columns: {}, profile: original?.profile ?? {}, marker: original?.marker ?? {}, eventSequence: null };
  for (const [table, definition] of Object.entries(sourceTables(layout))) {
    const columns = Object.keys(definition.columns);
    const expressions = columns.map(column => `HEX(CAST(\`${column}\` AS BINARY)) AS \`${column}\``);
    const rows = await mysqlEnterpriseRows(c, `SELECT ${expressions.join(',')} FROM \`${table}\` ORDER BY BINARY \`${definition.primary}\` LIMIT ${MAX_ROWS + 1}`);
    requireSafe(rows.length <= MAX_ROWS, 'enterprise_mysql_offline_row_limit');
    evidence.counts[table] = rows.length;
    evidence.columns[table] = Object.fromEntries(columns.map(column => [column, hash(JSON.stringify(rows.map(row => row[column])))]));
  }
  if (!original) {
    const profiles = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_profiles');
    const markers = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_schema');
    requireSafe(profiles.length === 1 && markers.length === 1, 'enterprise_mysql_source_metadata');
    evidence.profile = profiles[0]; evidence.marker = markers[0];
  }
  if (layout === 'pool') {
    const rows = await mysqlEnterpriseRows(c, "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_pool_events'");
    evidence.eventSequence = rows[0]?.AUTO_INCREMENT === null ? null : String(rows[0]?.AUTO_INCREMENT);
  }
  return evidence;
}
async function assertDrained(c: MysqlConnection, layout: EnterpriseMysqlLayout, registry: EnterpriseRegistryV3, cap?: number): Promise<void> {
  for (const table of ['proxy_identity_initializations', ...(layout === 'pool' ? ['user_pool_holds', 'user_pool_catalog_holds'] : [])])
    requireSafe(Number((await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${table}`))[0]?.n) === 0, 'enterprise_mysql_not_drained');
  const accounts = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM proxy_accounts WHERE copilot_oauth_attempt_id IS NOT NULL
    OR copilot_oauth_status NOT IN ('valid','expired','missing','failed')
    OR (copilot_oauth_status='valid' AND (copilot_oauth_token IS NULL OR LENGTH(copilot_oauth_token)=0 OR copilot_oauth_updated_at IS NULL))`);
  requireSafe(Number(accounts[0]?.n) === 0, 'enterprise_mysql_unresolved_oauth');
  if (layout === 'pool') {
    const s = (await mysqlEnterpriseRows(c, 'SELECT *, CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS server_now FROM user_pool_settings'))[0];
    const legacy = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
    requireSafe(s && Number(s.id) === 1 && Number(s.paused) === 1 && Number(s.owner_until) <= Number(s.server_now)
      && Number.isInteger(cap) && cap! >= 1 && cap! <= 10000 && Number(s.version) >= 1
      && Number(s.idle_target) >= 0 && Number(s.idle_target) <= cap! && Number(s.lease_seconds) >= 60 && Number(s.lease_seconds) <= 2592000
      && Number(s.next_ordinal) >= 0 && Number(s.next_ordinal) <= 10000 && s.account_domain === legacy.accountDomain
      && isEnterpriseMysqlHashV3(s.config_fingerprint), 'enterprise_mysql_settings_not_drained');
    const bad = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM user_pool_accounts p LEFT JOIN proxy_accounts a ON a.identity=p.identity
      WHERE a.identity IS NULL OR BINARY a.enterprise_id <> BINARY ? OR p.state='provisioning' OR p.ordinal < 0 OR p.ordinal >= ?
      OR p.stage NOT IN ('new','sso-created','scim-synced','synced','warmup','ready')
      OR p.last_error REGEXP 'ambiguous|unconfirmed|stalled|sso_name_conflict|oauth_task_invalid'
      OR ((p.task_id IS NOT NULL OR p.oauth_attempt_id IS NOT NULL OR p.state IN ('ready','cooling')) AND NOT
        (p.state IN ('ready','cooling') AND p.stage='ready' AND p.verified_at IS NOT NULL AND p.sso_created_at IS NOT NULL
        AND a.gh_login IS NOT NULL AND LENGTH(a.gh_login)>0 AND a.copilot_oauth_status='valid'
        AND ((p.task_id IS NULL AND p.oauth_attempt_id IS NULL) OR (p.task_id IS NOT NULL AND p.oauth_attempt_id IS NOT NULL))))`,
    [registry.legacyEnterpriseId, Number(s.next_ordinal)]);
    requireSafe(Number(bad[0]?.n) === 0, 'enterprise_mysql_unresolved_provisioning');
  }
  for (const [table, definition] of Object.entries(sourceTables(layout))) for (const [column, target, reference] of definition.foreign ?? []) {
    const rows = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${table} a LEFT JOIN ${target} b ON a.${column}=b.${reference} WHERE b.${reference} IS NULL`);
    requireSafe(Number(rows[0]?.n) === 0, 'enterprise_mysql_orphan');
  }
}
function mappingValidated(input: EnterpriseMysqlAccountIncarnationV3[]): EnterpriseMysqlAccountIncarnationV3[] {
  requireSafe(Array.isArray(input) && input.length <= MAX_ROWS && input.every(item => item && Object.keys(item).sort().join(',') === 'accountIncarnation,identity'
    && typeof item.identity === 'string' && item.identity.length >= 1 && item.identity.length <= 255 && isEnterpriseMysqlUuidV3(item.accountIncarnation))
    && new Set(input.map(item => item.identity)).size === input.length && new Set(input.map(item => item.accountIncarnation)).size === input.length, 'enterprise_mysql_invalid_incarnation_plan');
  return input.map(item => ({ identity: item.identity, accountIncarnation: item.accountIncarnation }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.identity), Buffer.from(b.identity)));
}
async function preflight(c: MysqlConnection, registry: EnterpriseRegistryV3, expectedLayout?: EnterpriseMysqlLayout) {
  const database = await databaseName(c);
  const legacy = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
  const result = await validateEnterpriseMysql(c, 'proxy', enterpriseMysqlLegacyProfileV3(legacy));
  requireSafe(!expectedLayout || expectedLayout === result.layout, 'enterprise_mysql_layout');
  await assertDrained(c, result.layout, registry, result.maxAccounts);
  const evidence = await snapshot(c, result.layout);
  const accounts = await mysqlEnterpriseRows(c, `SELECT identity FROM proxy_accounts ORDER BY BINARY identity LIMIT ${MAX_ROWS + 1}`);
  requireSafe(accounts.length <= MAX_ROWS, 'enterprise_mysql_offline_row_limit');
  return { database, layout: result.layout, ...(result.maxAccounts === undefined ? {} : { maxAccounts: result.maxAccounts }),
    counts: evidence.counts, sourceSha256: hash(JSON.stringify(evidence)), identities: accounts.map(row => String(row.identity)), evidence };
}
/** SELECT-only preflight; generated UUIDs are returned only as protected plan material, never regenerated on apply/resume. */
export async function preflightEnterpriseMysqlV3(connection: MysqlConnection, input: EnterpriseRegistryV3, layout?: EnterpriseMysqlLayout): Promise<EnterpriseMysqlPreflightV3> {
  const registry = parseEnterpriseRegistryV3(input);
  return withEnterpriseMysqlDeadline(connection, async c => {
    const { identities, evidence: _, ...result } = await preflight(c, registry, layout);
    return { ...result, accountIncarnations: identities.map(identity => ({ identity, accountIncarnation: randomUUID() })) };
  });
}
function parseEvidence(raw: unknown, expectedHash: string, layout: EnterpriseMysqlLayout): Evidence {
  requireSafe(typeof raw === 'string' && hash(raw) === expectedHash, 'enterprise_mysql_checkpoint_evidence');
  let value: Evidence;
  try { value = JSON.parse(raw); } catch { throw new EnterpriseMysqlError('enterprise_mysql_checkpoint_evidence'); }
  const tables = sourceTables(layout);
  const keys = (object: unknown, names: string[]) => !!object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === names.length && names.every(name => Object.hasOwn(object, name));
  requireSafe(keys(value, ['counts', 'columns', 'profile', 'marker', 'eventSequence']) && keys(value.counts, Object.keys(tables))
    && keys(value.columns, Object.keys(tables)) && Object.entries(tables).every(([table, def]) => Number.isSafeInteger(value.counts[table])
      && value.counts[table] >= 0 && value.counts[table] <= MAX_ROWS && keys(value.columns[table], Object.keys(def.columns))
      && Object.values(value.columns[table]).every(isEnterpriseMysqlHashV3))
    && keys(value.profile, ['singleton', 'id', 'slug', 'profile_json', 'revision', 'max_accounts'])
    && keys(value.marker, ['singleton', 'component', 'schema_version', 'contract_version', 'capability', 'layout', 'profile_sha256', 'migration_id', 'state'])
    && (layout === 'pool' ? value.eventSequence === null || typeof value.eventSequence === 'string' && /^\d+$/.test(value.eventSequence) : value.eventSequence === null), 'enterprise_mysql_checkpoint_evidence');
  return value;
}
async function validateStage(c: MysqlConnection, registry: EnterpriseRegistryV3, layout: EnterpriseMysqlLayout, step: number,
  evidence: Evidence, mapping: EnterpriseMysqlAccountIncarnationV3[]): Promise<void> {
  await validateEnterpriseMysqlShapeV3(c, enterpriseMysqlStageSchemaV3(layout, step), enterpriseMysqlStageTriggersV3(layout, step));
  await validateEnterpriseMysqlHistory(c, layout);
  const profiles = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_profiles ORDER BY BINARY id');
  const legacy = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
  const selected = step >= 10 ? registry.profiles : [legacy];
  requireSafe(profiles.length === selected.length && selected.every(profile => {
    const row = profiles.find(r => r.id === profile.id);
    const cap = profile.id === legacy.id ? step >= 6 ? evidence.profile.max_accounts ?? legacy.maxAccounts : evidence.profile.max_accounts : profile.maxAccounts;
    return row && row.slug === profile.slug && Number(row.revision) === profile.revision
      && row.profile_json === (step >= 6 ? JSON.stringify(profile) : canonicalEnterpriseProfile(enterpriseMysqlLegacyProfileV3(profile)))
      && (row.max_accounts === null ? null : Number(row.max_accounts)) === (cap === null ? null : Number(cap))
      && (step >= 5 ? !Object.hasOwn(row, 'singleton') : Number(row.singleton) === 1);
  }), 'enterprise_mysql_checkpoint_profile');
  if (step >= 9) {
    const rows = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_registry');
    requireSafe(step === 9 ? rows.length === 0 : rows.length === 1 && Number(rows[0].singleton) === 1
      && rows[0].legacy_enterprise_id === registry.legacyEnterpriseId && Number(rows[0].registry_revision) === registry.registryRevision
      && rows[0].registry_sha256 === enterpriseMysqlRegistryHashV3(registry), 'enterprise_mysql_checkpoint_registry');
  }
  const accounts = await mysqlEnterpriseRows(c, `SELECT identity,enterprise_id${step >= 11 ? ',account_incarnation' : ''} FROM proxy_accounts ORDER BY BINARY identity LIMIT ${MAX_ROWS + 1}`);
  requireSafe(accounts.length === mapping.length && accounts.every((row, index) => row.identity === mapping[index]?.identity && row.enterprise_id === registry.legacyEnterpriseId
    && (step < 11 || (step === 11 ? row.account_incarnation === null : row.account_incarnation === mapping[index].accountIncarnation))), 'enterprise_mysql_checkpoint_incarnations');
  if (step >= 15) requireSafe(Number((await mysqlEnterpriseRows(c, 'SELECT COUNT(*) AS n FROM proxy_authorization_attempts'))[0]?.n) === 0, 'enterprise_mysql_not_drained');
  if (step !== 16) {
    const markers = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_schema');
    if (step < 16) requireSafe(same(markers, [evidence.marker]), 'enterprise_mysql_checkpoint_marker');
    else if (step === 17) requireSafe(markers.length === 0, 'enterprise_mysql_checkpoint_marker');
    else requireSafe(markers.length === 1 && markers[0].registry_sha256 === enterpriseMysqlRegistryHashV3(registry)
      && markers[0].schema_version === 3 && markers[0].contract_version === 2 && markers[0].layout === layout
      && markers[0].state === 'complete', 'enterprise_mysql_checkpoint_marker');
  }
  requireSafe(same(await snapshot(c, layout, evidence), evidence), 'enterprise_mysql_source_changed');
  await assertDrained(c, layout, registry, layout === 'pool' ? Number(evidence.profile.max_accounts) : undefined);
}
async function transaction(c: MysqlConnection, run: () => Promise<void>): Promise<void> {
  await c.query('START TRANSACTION');
  try { await run(); await c.query('COMMIT'); }
  catch (error) { try { await c.query('ROLLBACK'); } catch { c.destroy(); } throw error; }
}
async function runStep(c: MysqlConnection, step: number, registry: EnterpriseRegistryV3, layout: EnterpriseMysqlLayout, mapping: EnterpriseMysqlAccountIncarnationV3[]): Promise<void> {
  const legacy = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
  if (step === 1) await c.query('DROP TRIGGER enterprise_profile_immutable');
  else if (step === 2) await c.query('DROP TRIGGER enterprise_account_immutable');
  else if (step === 3) await c.query('ALTER TABLE proxy_accounts DROP FOREIGN KEY fk_proxy_accounts_enterprise_id');
  else if (step === 4) {
    const checks = await mysqlEnterpriseRows(c, `SELECT c.CHECK_CLAUSE,t.CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS t
      JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
      WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='enterprise_profiles' AND t.CONSTRAINT_TYPE='CHECK'`);
    const singleton = checks.filter(row => canonicalMysqlCheck(row.CHECK_CLAUSE) === canonicalMysqlCheck('singleton = 1'));
    requireSafe(singleton.length === 1 && typeof singleton[0].CONSTRAINT_NAME === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(singleton[0].CONSTRAINT_NAME), 'enterprise_mysql_checkpoint_check_name');
    await c.query(`ALTER TABLE enterprise_profiles DROP CHECK \`${singleton[0].CONSTRAINT_NAME}\``);
  } else if (step === 5) await c.query('ALTER TABLE enterprise_profiles DROP PRIMARY KEY, DROP INDEX id, DROP COLUMN singleton, ADD PRIMARY KEY (id)');
  else if (step === 6) await c.query('UPDATE enterprise_profiles SET profile_json=?,max_accounts=COALESCE(max_accounts,?) WHERE id=?', [JSON.stringify(legacy), legacy.maxAccounts, legacy.id]);
  else if (step === 7) await c.query('ALTER TABLE enterprise_profiles MODIFY max_accounts INT NOT NULL');
  else if (step === 8) await c.query('ALTER TABLE proxy_accounts ADD CONSTRAINT fk_proxy_accounts_enterprise_id FOREIGN KEY (enterprise_id) REFERENCES enterprise_profiles(id) ON DELETE RESTRICT');
  else if (step === 9) await c.query(mysqlCreateTable('enterprise_registry', ENTERPRISE_MYSQL_V3_TABLES));
  else if (step === 10) await transaction(c, async () => {
    for (const profile of registry.profiles.filter(p => p.id !== legacy.id)) await insertEnterpriseMysqlProfileV3(c, profile);
    await insertEnterpriseMysqlRegistryV3(c, registry);
  });
  else if (step === 11) await c.query('ALTER TABLE proxy_accounts ADD COLUMN account_incarnation VARCHAR(36) COLLATE ascii_bin NULL, ADD UNIQUE (account_incarnation)');
  else if (step === 12) await transaction(c, async () => {
    for (const row of mapping) {
      const [result] = await c.query<ResultSetHeader>('UPDATE proxy_accounts SET account_incarnation=? WHERE BINARY identity=BINARY ? AND account_incarnation IS NULL', [row.accountIncarnation, row.identity]);
      requireSafe(result.affectedRows === 1, 'enterprise_mysql_incarnation_cas');
    }
  });
  else if (step === 13) await c.query('ALTER TABLE proxy_accounts MODIFY account_incarnation VARCHAR(36) COLLATE ascii_bin NOT NULL');
  else if (step === 14) await c.query(`ALTER TABLE proxy_identity_initializations ADD COLUMN enterprise_id VARCHAR(36) COLLATE ascii_bin NOT NULL,
    ADD INDEX idx_proxy_initializations_enterprise (enterprise_id), ADD CONSTRAINT fk_proxy_identity_initializations_enterprise_id
    FOREIGN KEY (enterprise_id) REFERENCES enterprise_profiles(id) ON DELETE RESTRICT`);
  else if (step === 15) await c.query(mysqlCreateTable('proxy_authorization_attempts', ENTERPRISE_MYSQL_V3_TABLES));
  else if (step === 16) await c.query('DROP TABLE enterprise_schema');
  else if (step === 17) await c.query(mysqlCreateTable('enterprise_schema', ENTERPRISE_MYSQL_V3_TABLES));
  else if (step === 18) await insertEnterpriseMysqlMarkerV3(c, registry, layout);
  else if (step >= 19 && (step < 26 || layout === 'pool')) {
    const name = triggerStages[step]; await c.query(enterpriseMysqlCreateTriggerV3(name, ENTERPRISE_MYSQL_V3_TRIGGERS[name] ?? ENTERPRISE_MYSQL_V3_POOL_TRIGGERS[name]));
  }
}
function validateOptions(options: Omit<EnterpriseMysqlApplyOptionsV3, 'confirmOffline' | 'confirmBackup' | 'confirmDrained' | 'resume'>): EnterpriseMysqlAccountIncarnationV3[] {
  requireSafe(/^[a-zA-Z0-9_-]{1,64}$/.test(options.migrationId) && /^[a-zA-Z0-9_-]{1,64}$/.test(options.expectedDatabase)
    && isEnterpriseMysqlHashV3(options.expectedSourceSha256) && isEnterpriseMysqlHashV3(options.manifestSha256) && isEnterpriseMysqlHashV3(options.backupSha256)
    && typeof options.backupReference === 'string' && options.backupReference.length >= 1 && options.backupReference.length <= 255
    && !/[\x00-\x1f\x7f]/.test(options.backupReference) && (options.layout === undefined || ['direct', 'pool'].includes(options.layout)), 'enterprise_mysql_invalid_plan');
  return mappingValidated(options.accountIncarnations);
}
async function checkpoint(c: MysqlConnection, registry: EnterpriseRegistryV3, options: EnterpriseMysqlApplyOptionsV3 | Omit<EnterpriseMysqlApplyOptionsV3, 'confirmOffline' | 'confirmBackup' | 'confirmDrained' | 'resume'>,
  mapping: EnterpriseMysqlAccountIncarnationV3[]) {
  await validateMysqlTables(c, { enterprise_upgrade_v3: ENTERPRISE_MYSQL_V3_TABLES.enterprise_upgrade_v3 });
  const rows = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_upgrade_v3');
  requireSafe(rows.length === 1, 'enterprise_mysql_checkpoint_missing_manual_inspection_required');
  const row = rows[0];
  requireSafe(Number(row.singleton) === 1 && row.migration_id === options.migrationId && row.database_name === options.expectedDatabase
    && row.manifest_sha256 === options.manifestSha256 && row.backup_reference === options.backupReference && row.backup_sha256 === options.backupSha256
    && row.source_sha256 === options.expectedSourceSha256 && row.registry_sha256 === enterpriseMysqlRegistryHashV3(registry)
    && row.mapping_sha256 === hash(JSON.stringify(mapping)) && row.mapping_json === JSON.stringify(mapping)
    && ['direct', 'pool'].includes(row.layout) && (!options.layout || options.layout === row.layout)
    && ['applying', 'complete'].includes(row.state) && ['before', 'after', 'unknown'].includes(row.checkpoint_state)
    && Number.isInteger(Number(row.step)) && Number(row.step) >= 0 && Number(row.step) <= ENTERPRISE_MYSQL_V3_FINAL_STEP, 'enterprise_mysql_checkpoint_binding');
  return { row, evidence: parseEvidence(row.evidence_json, options.expectedSourceSha256, row.layout), layout: row.layout as EnterpriseMysqlLayout };
}
function result(database: string, layout: EnterpriseMysqlLayout, evidence: Evidence, mapping: EnterpriseMysqlAccountIncarnationV3[], options: { expectedSourceSha256: string; migrationId: string }, resumed: boolean): EnterpriseMysqlMigrationResultV3 {
  return { database, layout, counts: evidence.counts, ...(layout === 'pool' ? { maxAccounts: Number(evidence.profile.max_accounts) } : {}),
    sourceSha256: options.expectedSourceSha256, accountIncarnations: mapping, migrationId: options.migrationId, resumed };
}
/** DDL unknown is deliberately NOT an automatic resume state. Never infer completion from marker/table presence. */
export async function applyEnterpriseMysqlV3(connection: MysqlConnection, input: EnterpriseRegistryV3, options: EnterpriseMysqlApplyOptionsV3): Promise<EnterpriseMysqlMigrationResultV3> {
  const registry = parseEnterpriseRegistryV3(input), mapping = validateOptions(options);
  requireSafe(options.confirmOffline === true && options.confirmBackup === true && options.confirmDrained === true, 'enterprise_mysql_maintenance_required');
  return withEnterpriseMysqlLockV3(connection, async c => {
    try {
      const database = await databaseName(c);
      requireSafe(database === options.expectedDatabase, 'enterprise_mysql_database_mismatch');
      const names = await enterpriseMysqlObjects(c);
      let evidence: Evidence, layout: EnterpriseMysqlLayout, step = 0, resumed = false;
      if (!names.includes('enterprise_upgrade_v3')) {
        requireSafe(!options.resume, 'enterprise_mysql_resume_without_checkpoint');
        const source = await preflight(c, registry, options.layout);
        requireSafe(source.sourceSha256 === options.expectedSourceSha256 && same(source.identities, mapping.map(item => item.identity)), 'enterprise_mysql_source_changed');
        evidence = source.evidence; layout = source.layout;
        await c.query(mysqlCreateTable('enterprise_upgrade_v3', ENTERPRISE_MYSQL_V3_TABLES));
        await c.query(`INSERT INTO enterprise_upgrade_v3 (singleton,migration_id,database_name,manifest_sha256,backup_reference,backup_sha256,
          registry_sha256,source_sha256,mapping_sha256,layout,state,step,checkpoint_state,evidence_json,mapping_json)
          VALUES (1,?,?,?,?,?,?,?,?,?,'applying',0,'after',?,?)`, [options.migrationId, database, options.manifestSha256, options.backupReference,
          options.backupSha256, enterpriseMysqlRegistryHashV3(registry), options.expectedSourceSha256, hash(JSON.stringify(mapping)), layout, JSON.stringify(evidence), JSON.stringify(mapping)]);
      } else {
        requireSafe(options.resume === true, 'enterprise_mysql_resume_required'); resumed = true;
        const saved = await checkpoint(c, registry, options, mapping); evidence = saved.evidence; layout = saved.layout;
        const row = saved.row; step = Number(row.step);
        requireSafe(row.checkpoint_state !== 'unknown', 'enterprise_mysql_unknown_manual_inspection_required');
        if (row.state === 'complete') {
          requireSafe(step === ENTERPRISE_MYSQL_V3_FINAL_STEP && row.checkpoint_state === 'after', 'enterprise_mysql_checkpoint_binding');
          await validateEnterpriseMysqlV3(c, 'proxy', registry); await validateStage(c, registry, layout, step, evidence, mapping);
          return result(database, layout, evidence, mapping, options, resumed);
        }
        if (row.checkpoint_state === 'before') {
          requireSafe(step >= 1, 'enterprise_mysql_checkpoint_binding');
          // 'before' is persisted before marking unknown and sending the statement, so only the exact prior stage is acceptable.
          await validateStage(c, registry, layout, step - 1, evidence, mapping); step--;
        } else await validateStage(c, registry, layout, step, evidence, mapping);
      }
      await validateStage(c, registry, layout, step, evidence, mapping);
      for (let next = step + 1; next <= ENTERPRISE_MYSQL_V3_FINAL_STEP; next++) {
        await c.query("UPDATE enterprise_upgrade_v3 SET step=?,checkpoint_state='before' WHERE singleton=1", [next]);
        await c.query("UPDATE enterprise_upgrade_v3 SET checkpoint_state='unknown' WHERE singleton=1");
        await runStep(c, next, registry, layout, mapping);
        await validateStage(c, registry, layout, next, evidence, mapping);
        await c.query("UPDATE enterprise_upgrade_v3 SET checkpoint_state='after',state=? WHERE singleton=1", [next === ENTERPRISE_MYSQL_V3_FINAL_STEP ? 'complete' : 'applying']);
      }
      await validateEnterpriseMysqlV3(c, 'proxy', registry);
      return result(database, layout, evidence, mapping, options, resumed);
    } catch (error) {
      if (error instanceof EnterpriseMysqlError) throw error;
      throw new EnterpriseMysqlError('enterprise_mysql_migration_failed_inspect_checkpoint');
    }
  }, options.deadlineMs);
}
export async function verifyEnterpriseMysqlMigrationV3(connection: MysqlConnection, input: EnterpriseRegistryV3,
  options: Omit<EnterpriseMysqlApplyOptionsV3, 'confirmOffline' | 'confirmBackup' | 'confirmDrained' | 'resume'>): Promise<EnterpriseMysqlMigrationResultV3> {
  const registry = parseEnterpriseRegistryV3(input), mapping = validateOptions(options);
  return withEnterpriseMysqlDeadline(connection, async c => {
    const database = await databaseName(c); requireSafe(database === options.expectedDatabase, 'enterprise_mysql_database_mismatch');
    const saved = await checkpoint(c, registry, options, mapping);
    requireSafe(saved.row.state === 'complete' && Number(saved.row.step) === ENTERPRISE_MYSQL_V3_FINAL_STEP && saved.row.checkpoint_state === 'after', 'enterprise_mysql_incomplete');
    await validateEnterpriseMysqlV3(c, 'proxy', registry);
    await validateStage(c, registry, saved.layout, ENTERPRISE_MYSQL_V3_FINAL_STEP, saved.evidence, mapping);
    return result(database, saved.layout, saved.evidence, mapping, options, false);
  }, options.deadlineMs);
}
/** Read-only inspection never blesses partial/unknown state or mutates a checkpoint. */
export async function inspectEnterpriseMysqlV3(connection: MysqlConnection, registry?: EnterpriseRegistryV3): Promise<{ state: 'empty' | 'v2' | 'v3' | 'partial'; layout?: EnterpriseMysqlLayout; checkpointState?: string; step?: number }> {
  return withEnterpriseMysqlDeadline(connection, async c => {
    const names = await enterpriseMysqlObjects(c);
    if (!names.length) return { state: 'empty' };
    try {
      if (names.includes('enterprise_registry')) {
        const result = await validateEnterpriseMysqlV3(c, 'proxy', registry); return { state: 'v3', layout: result.layout };
      }
      const result = await validateEnterpriseMysql(c, 'proxy', registry ? enterpriseMysqlLegacyProfileV3(registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!) : undefined);
      return { state: 'v2', layout: result.layout };
    } catch (error) {
      if (error instanceof EnterpriseMysqlError && ['enterprise_mysql_deadline', 'enterprise_mysql_statement_outcome_unknown'].includes(error.code)) throw error;
      if (names.includes('enterprise_upgrade_v3')) {
        const rows = await mysqlEnterpriseRows(c, 'SELECT step,checkpoint_state FROM enterprise_upgrade_v3');
        if (rows.length === 1 && Number.isInteger(Number(rows[0].step)) && Number(rows[0].step) >= 0 && Number(rows[0].step) <= ENTERPRISE_MYSQL_V3_FINAL_STEP
          && ['before', 'after', 'unknown'].includes(rows[0].checkpoint_state)) return { state: 'partial', step: Number(rows[0].step), checkpointState: rows[0].checkpoint_state };
      }
      return { state: 'partial' };
    }
  });
}
