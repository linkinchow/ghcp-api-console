import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { EnterpriseComponent } from './enterprise.js';
import {
  canonicalEnterpriseIdentityRegistryV3, parseEnterpriseRegistryV3, parseEnterpriseProfileV3,
  ENTERPRISE_V3_SCHEMA, ENTERPRISE_V3_CONTRACT, ENTERPRISE_V3_CAPABILITY,
  type EnterpriseRegistryV3, type EnterpriseProfileV3,
} from './enterpriseV3.js';
import {
  EnterpriseStorageError, requireEnterpriseStorage as check, enterpriseComponentLayout,
  enterpriseSqliteObjects, canonicalEnterpriseSql, checkSqliteIntegrity, validateEnterprisePoolSettings,
  type EnterpriseLayout, type EnterprisePoolInitSettings, type EnterpriseSchemaObject,
} from './enterpriseStorage.js';
import { createEnterpriseV1SqliteSchema } from './enterpriseSqliteV1.js';
export type { EnterpriseLayout, EnterprisePoolInitSettings } from './enterpriseStorage.js';

export const ENTERPRISE_V3_MIGRATION_ID = 'enterprise-schema3-contract2';
export interface EnterpriseInitOptionsV3 {
  layout?: EnterpriseLayout;
  pool?: { fingerprint?: string; settings: EnterprisePoolInitSettings };
}
export interface EnterpriseStorageStateV3 {
  registry: EnterpriseRegistryV3;
  legacyEnterpriseId: string;
  layout: EnterpriseLayout;
  maxAccounts?: number;
}
export const enterpriseRegistryHashV3 = (registry: EnterpriseRegistryV3): string =>
  createHash('sha256').update(canonicalEnterpriseIdentityRegistryV3(registry)).digest('hex');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
/** UUID v4 shape is enforced by both the SQL schema and the pure registry parser. */
export function enterpriseUuidCheckV3(name: string): string {
  return `length(${name})=36 AND ${name} NOT GLOB '*[^0-9a-f-]*' AND substr(${name},9,1)='-' AND substr(${name},14,1)='-' AND substr(${name},19,1)='-' AND substr(${name},24,1)='-' AND length(replace(${name},'-',''))=32 AND substr(${name},15,1)='4' AND substr(${name},20,1) IN ('8','9','a','b')`;
}
const scopeColumn = 'enterprise_id TEXT NOT NULL REFERENCES enterprise_profiles(id) ON DELETE RESTRICT';
const REGISTRY_SQL = `
CREATE TABLE enterprise_profiles (
  id TEXT PRIMARY KEY NOT NULL CHECK(${enterpriseUuidCheckV3('id')}),
  slug TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision>=1), profile_json TEXT NOT NULL,
  max_accounts INTEGER NOT NULL CHECK(max_accounts BETWEEN 1 AND 10000)
) STRICT;
CREATE TABLE enterprise_registry (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  legacy_enterprise_id TEXT NOT NULL REFERENCES enterprise_profiles(id) ON DELETE RESTRICT,
  registry_revision INTEGER NOT NULL CHECK(registry_revision>=1),
  registry_sha256 TEXT NOT NULL CHECK(length(registry_sha256)=64)
) STRICT;
CREATE TABLE enterprise_schema (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), component TEXT NOT NULL CHECK(component IN ('proxy','sso','login')),
  schema_version INTEGER NOT NULL CHECK(schema_version=3), contract_version INTEGER NOT NULL CHECK(contract_version=2),
  capability TEXT NOT NULL CHECK(capability='enterprise-isolation-legacy-pool'),
  layout TEXT NOT NULL CHECK(layout IN ('direct','pool','sso','login')),
  registry_sha256 TEXT NOT NULL CHECK(length(registry_sha256)=64), migration_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state='complete')
) STRICT;
CREATE TABLE enterprise_migration_receipt (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  backup_reference TEXT NOT NULL, baseline TEXT NOT NULL, original_columns_sha256 TEXT NOT NULL
) STRICT;
CREATE TABLE enterprise_migration_receipt_v3 (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64), backup_reference TEXT NOT NULL,
  source_registry_sha256 TEXT NOT NULL CHECK(length(source_registry_sha256)=64),
  original_columns_sha256 TEXT NOT NULL CHECK(length(original_columns_sha256)=64),
  source_metadata_json TEXT NOT NULL, incarnation_mapping_sha256 TEXT NOT NULL CHECK(length(incarnation_mapping_sha256)=64)
) STRICT;
CREATE TRIGGER enterprise_profiles_identity_immutable BEFORE UPDATE OF id,slug,revision,profile_json ON enterprise_profiles
  WHEN OLD.id IS NOT NEW.id OR OLD.slug IS NOT NEW.slug OR OLD.revision IS NOT NEW.revision OR OLD.profile_json IS NOT NEW.profile_json
  BEGIN SELECT RAISE(ABORT,'enterprise_profile_immutable'); END;
CREATE TRIGGER enterprise_profiles_no_delete BEFORE DELETE ON enterprise_profiles
  BEGIN SELECT RAISE(ABORT,'enterprise_profile_required'); END;
CREATE TRIGGER enterprise_registry_legacy_immutable BEFORE UPDATE ON enterprise_registry
  WHEN OLD.singleton IS NOT NEW.singleton OR OLD.legacy_enterprise_id IS NOT NEW.legacy_enterprise_id
    OR NEW.registry_revision<>OLD.registry_revision+1 OR NEW.registry_sha256 IS OLD.registry_sha256
  BEGIN SELECT RAISE(ABORT,'enterprise_registry_cas_required'); END;
CREATE TRIGGER enterprise_registry_no_delete BEFORE DELETE ON enterprise_registry
  BEGIN SELECT RAISE(ABORT,'enterprise_registry_required'); END;
`;
const AUTHORIZATION_SQL = `
CREATE TABLE proxy_authorization_attempts (
  oauth_attempt_id TEXT PRIMARY KEY NOT NULL CHECK(${enterpriseUuidCheckV3('oauth_attempt_id')}),
  ${scopeColumn}, enterprise_revision INTEGER NOT NULL CHECK(enterprise_revision>=1),
  identity TEXT NOT NULL, account_incarnation TEXT NOT NULL CHECK(${enterpriseUuidCheckV3('account_incarnation')}),
  expected_gh_login TEXT NOT NULL CHECK(length(expected_gh_login)>0), expected_github_user_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','succeeded','failed','cancelled')),
  result_fingerprint TEXT, result_gh_login TEXT, result_github_user_id TEXT, failure_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(result_fingerprint IS NULL OR (length(result_fingerprint)>=32 AND length(result_fingerprint)<=256)),
  CHECK(status<>'active' OR (result_fingerprint IS NULL AND result_gh_login IS NULL AND result_github_user_id IS NULL)),
  CHECK(status<>'succeeded' OR (result_fingerprint IS NOT NULL AND result_gh_login IS NOT NULL))
) STRICT;
CREATE INDEX idx_proxy_authorization_binding ON proxy_authorization_attempts(enterprise_id,identity,account_incarnation,status);
CREATE TRIGGER proxy_authorization_attempts_no_delete BEFORE DELETE ON proxy_authorization_attempts
  BEGIN SELECT RAISE(ABORT,'authorization_attempt_evidence_required'); END;
CREATE TRIGGER proxy_authorization_attempts_terminal_immutable BEFORE UPDATE ON proxy_authorization_attempts
  WHEN OLD.status<>'active' AND (OLD.status IS NOT NEW.status OR OLD.result_fingerprint IS NOT NEW.result_fingerprint
    OR OLD.result_gh_login IS NOT NEW.result_gh_login OR OLD.result_github_user_id IS NOT NEW.result_github_user_id
    OR OLD.failure_reason IS NOT NEW.failure_reason OR OLD.updated_at IS NOT NEW.updated_at)
  BEGIN SELECT RAISE(ABORT,'authorization_attempt_terminal'); END;
`;
const LOGIN_LEDGER_SQL = `
CREATE TABLE login_nonce_ledger (
  ${scopeColumn}, oauth_attempt_id TEXT NOT NULL CHECK(${enterpriseUuidCheckV3('oauth_attempt_id')}),
  enterprise_revision INTEGER NOT NULL CHECK(enterprise_revision>=1), identity TEXT NOT NULL,
  account_incarnation TEXT NOT NULL CHECK(${enterpriseUuidCheckV3('account_incarnation')}),
  expected_gh_login TEXT NOT NULL CHECK(length(expected_gh_login)>0), expected_github_user_id TEXT,
  task_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  PRIMARY KEY(oauth_attempt_id)
) STRICT;
CREATE TABLE login_legacy_nonce_tombstones (
  oauth_attempt_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL,
  ${scopeColumn}
) STRICT;
CREATE TRIGGER login_legacy_nonce_tombstones_no_update BEFORE UPDATE ON login_legacy_nonce_tombstones
  BEGIN SELECT RAISE(ABORT,'login_nonce_immutable'); END;
CREATE TRIGGER login_legacy_nonce_tombstones_no_delete BEFORE DELETE ON login_legacy_nonce_tombstones
  BEGIN SELECT RAISE(ABORT,'login_nonce_evidence_required'); END;
CREATE TRIGGER login_nonce_ledger_no_update BEFORE UPDATE ON login_nonce_ledger
  BEGIN SELECT RAISE(ABORT,'login_nonce_immutable'); END;
CREATE TRIGGER login_nonce_ledger_no_delete BEFORE DELETE ON login_nonce_ledger
  BEGIN SELECT RAISE(ABORT,'login_nonce_evidence_required'); END;
`;
function immutable(db: Database.Database, table: string, fields: string[]): void {
  db.exec(`CREATE TRIGGER ${table}_binding_immutable BEFORE UPDATE OF ${fields.map(quote).join(',')} ON ${quote(table)}
    WHEN ${fields.map(field => `OLD.${quote(field)} COLLATE BINARY IS NOT NEW.${quote(field)}`).join(' OR ')}
    BEGIN SELECT RAISE(ABORT,'enterprise_binding_immutable'); END`);
}
function ssoTableSql(name: string, sql: string): string {
  sql = sql.replace('(', `(${scopeColumn}, `);
  switch (name) {
    case 'sso_users': return sql.replace('sso_user TEXT PRIMARY KEY', `operation_fence TEXT CHECK(operation_fence IS NULL OR length(operation_fence) BETWEEN 1 AND 128), user_incarnation TEXT NOT NULL UNIQUE CHECK(${enterpriseUuidCheckV3('user_incarnation')}), sso_user TEXT COLLATE NOCASE NOT NULL`)
      .replace(/\)\s*$/, ', PRIMARY KEY(enterprise_id,sso_user))');
    case 'sso_pool_managed_users': return `CREATE TABLE sso_pool_managed_users (${scopeColumn}, sso_user TEXT COLLATE NOCASE NOT NULL,
      PRIMARY KEY(enterprise_id,sso_user), FOREIGN KEY(enterprise_id,sso_user) REFERENCES sso_users(enterprise_id,sso_user) ON DELETE RESTRICT)`;
    case 'sso_runtime_settings': return sql.replace('id INTEGER PRIMARY KEY', 'id INTEGER NOT NULL')
      .replace(/\)\s*$/, ', PRIMARY KEY(enterprise_id,id))');
    case 'sso_budget_cache': return sql.replace('period_key TEXT PRIMARY KEY', 'period_key TEXT NOT NULL')
      .replace(/\)\s*$/, ', PRIMARY KEY(enterprise_id,period_key))');
    case 'sso_emu_import_plans': return sql.replace('id TEXT PRIMARY KEY', 'id TEXT NOT NULL')
      .replace(/\)\s*$/, ', PRIMARY KEY(enterprise_id,id))');
    case 'sso_emu_import_plan_rows': return sql.replace('plan_id TEXT NOT NULL', `expected_user_incarnation TEXT CHECK(expected_user_incarnation IS NULL OR (${enterpriseUuidCheckV3('expected_user_incarnation')})), plan_id TEXT NOT NULL`)
      .replace('PRIMARY KEY (plan_id, row_index)', 'PRIMARY KEY (enterprise_id,plan_id,row_index)')
      .replace('FOREIGN KEY (plan_id) REFERENCES sso_emu_import_plans(id)', 'FOREIGN KEY (enterprise_id,plan_id) REFERENCES sso_emu_import_plans(enterprise_id,id)');
    default: throw new EnterpriseStorageError('enterprise_unknown_sso_table');
  }
}
/** Offline-only DDL builder. Runtime validators never call this on the supplied database. */
export function createEnterpriseSqliteSchemaV3(db: Database.Database, layout: EnterpriseLayout): void {
  const fixture = new Database(':memory:');
  try {
    createEnterpriseV1SqliteSchema(fixture, layout);
    const objects = enterpriseSqliteObjects(fixture);
    db.exec(REGISTRY_SQL);
    for (const object of objects.filter(row => row.type === 'table' && row.name !== 'sqlite_sequence')) {
      let sql = object.sql!;
      if (layout === 'sso') sql = ssoTableSql(object.name, sql);
      if (object.name === 'proxy_accounts') sql = sql.replace('(', `(${scopeColumn}, account_incarnation TEXT NOT NULL UNIQUE CHECK(${enterpriseUuidCheckV3('account_incarnation')}), `);
      if (object.name === 'proxy_identity_initializations') sql = sql.replace('(', `(${scopeColumn}, `);
      if (object.name === 'user_pool_settings') sql = sql.replace(/max_accounts INTEGER NOT NULL,\s*/, '');
      if (object.name === 'login_tasks') sql = sql.replace('(', `(${scopeColumn}, binding_version INTEGER NOT NULL CHECK(binding_version IN (1,2)),
        enterprise_revision INTEGER, account_incarnation TEXT, expected_gh_login TEXT, expected_github_user_id TEXT,
        authority_close_state TEXT CHECK(authority_close_state IN ('pending','uncertain','confirmed')),
        authority_close_action TEXT CHECK(authority_close_action IN ('cancel','fail','reconcile','success')), `)
        .replace(/\)\s*$/, `, CHECK((binding_version=1 AND enterprise_revision IS NULL AND account_incarnation IS NULL
          AND expected_gh_login IS NULL AND expected_github_user_id IS NULL AND status IN ('success','failed','cancelled'))
          OR (binding_version=2 AND enterprise_revision IS NOT NULL AND enterprise_revision>=1 AND account_incarnation IS NOT NULL
          AND ${enterpriseUuidCheckV3('account_incarnation')} AND expected_gh_login IS NOT NULL AND length(expected_gh_login)>0
          AND oauth_attempt_id IS NOT NULL AND ${enterpriseUuidCheckV3('oauth_attempt_id')})))`);
      db.exec(sql);
    }
    for (const object of objects.filter(row => ['index','trigger'].includes(row.type) && row.sql !== null)) {
      let sql = object.sql!;
      if (object.name === 'idx_sso_emu_import_plan_rows_status') sql = sql.replace('(plan_id, status, row_index)', '(enterprise_id, plan_id, status, row_index)');
      if (object.name === 'idx_login_tasks_status_created_at') sql = sql.replace('(status, created_at)', '(enterprise_id, status, created_at)');
      db.exec(sql);
    }
    if (layout === 'sso') {
      for (const table of objects.filter(row => row.type === 'table').map(row => row.name)) {
        immutable(db, table, table==='sso_users' ? ['enterprise_id','sso_user','user_incarnation'] : ['enterprise_id']);
      }
    }
    if (layout === 'login') {
      db.exec(LOGIN_LEDGER_SQL);
      immutable(db, 'login_tasks', ['id','enterprise_id','binding_version','enterprise_revision','identity','account_incarnation',
        'oauth_attempt_id','expected_gh_login','expected_github_user_id','sso_user','sso_type']);
      db.exec('CREATE UNIQUE INDEX idx_login_tasks_binding_nonce ON login_tasks(enterprise_id,oauth_attempt_id) WHERE binding_version=2');
    }
    if (layout === 'direct' || layout === 'pool') {
      immutable(db, 'proxy_accounts', ['identity','enterprise_id','account_incarnation']);
      immutable(db, 'proxy_identity_initializations', ['identity','enterprise_id']);
      db.exec('CREATE INDEX idx_proxy_accounts_enterprise ON proxy_accounts(enterprise_id)');
      db.exec(AUTHORIZATION_SQL);
      immutable(db, 'proxy_authorization_attempts', ['oauth_attempt_id','enterprise_id','enterprise_revision','identity',
        'account_incarnation','expected_gh_login','expected_github_user_id','created_at']);
    }
    if (layout === 'pool') for (const event of ['INSERT','UPDATE'] as const) db.exec(`CREATE TRIGGER user_pool_legacy_only_${event.toLowerCase()}
      BEFORE ${event} ON user_pool_accounts WHEN NOT EXISTS(SELECT 1 FROM proxy_accounts a JOIN enterprise_registry r
      ON a.enterprise_id=r.legacy_enterprise_id WHERE r.singleton=1 AND a.identity=NEW.identity)
      BEGIN SELECT RAISE(ABORT,'enterprise_pool_legacy_only'); END`);
  } finally { fixture.close(); }
}

function objectKey(row: EnterpriseSchemaObject): string {
  return JSON.stringify([row.type,row.name,row.tbl_name,row.sql === null ? null : canonicalEnterpriseSql(row.sql)]);
}
function metadata(db: Database.Database, objects: EnterpriseSchemaObject[]): string {
  return JSON.stringify(objects.filter(row => row.type === 'table').map(row => [row.name,
    db.prepare(`PRAGMA table_xinfo(${quote(row.name)})`).all(), db.prepare(`PRAGMA foreign_key_list(${quote(row.name)})`).all(),
    (db.prepare(`PRAGMA index_list(${quote(row.name)})`).all() as { name: string; seq: number }[])
      .sort((a,b) => a.name.localeCompare(b.name)).map(({seq: _seq,...index}) => [index,db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all()]),
  ]));
}
const expected = new Map<EnterpriseLayout,{ objects: EnterpriseSchemaObject[]; metadata: string }>();
export function getExpectedEnterpriseSqliteV3(layout: EnterpriseLayout): { objects: EnterpriseSchemaObject[]; metadata: string } {
  if (!expected.has(layout)) {
    const db = new Database(':memory:');
    try { createEnterpriseSqliteSchemaV3(db, layout); const objects = enterpriseSqliteObjects(db); expected.set(layout,{ objects,metadata:metadata(db,objects) }); }
    finally { db.close(); }
  }
  return structuredClone(expected.get(layout)!);
}
export function matchesEnterpriseSqliteSchemaV3(db: Database.Database, layout: EnterpriseLayout): boolean {
  const actual = enterpriseSqliteObjects(db), shape = getExpectedEnterpriseSqliteV3(layout);
  return JSON.stringify(actual.map(objectKey))===JSON.stringify(shape.objects.map(objectKey)) && metadata(db,actual)===shape.metadata;
}
export function seedEnterpriseRegistrySqliteV3(db: Database.Database, value: EnterpriseRegistryV3): void {
  const registry = parseEnterpriseRegistryV3(value);
  const insert = db.prepare('INSERT INTO enterprise_profiles(id,slug,revision,profile_json,max_accounts) VALUES(?,?,?,?,?)');
  for (const profile of registry.profiles) insert.run(profile.id,profile.slug,profile.revision,JSON.stringify(profile),profile.maxAccounts);
  db.prepare('INSERT INTO enterprise_registry(singleton,legacy_enterprise_id,registry_revision,registry_sha256) VALUES(1,?,?,?)')
    .run(registry.legacyEnterpriseId,registry.registryRevision,enterpriseRegistryHashV3(registry));
}
export function completeEnterpriseSqliteV3(db: Database.Database, component: EnterpriseComponent, registry: EnterpriseRegistryV3, layout: EnterpriseLayout): void {
  db.prepare(`INSERT INTO enterprise_schema(singleton,component,schema_version,contract_version,capability,layout,registry_sha256,migration_id,state)
    VALUES(1,?,?,?,?,?,?,?,'complete')`).run(component,ENTERPRISE_V3_SCHEMA,ENTERPRISE_V3_CONTRACT,ENTERPRISE_V3_CAPABILITY,layout,enterpriseRegistryHashV3(registry),ENTERPRISE_V3_MIGRATION_ID);
}
/** Read-only fail-closed runtime gate: no seed, migration, data cleanup or database pragma writes. */
export function validateEnterpriseSqliteV3(db: Database.Database, component: EnterpriseComponent, expectedRegistry?: EnterpriseRegistryV3): EnterpriseStorageStateV3 {
  check(db.pragma('foreign_keys',{simple:true})===1,'enterprise_foreign_keys_disabled');
  const layouts: EnterpriseLayout[] = component==='proxy' ? ['direct','pool'] : [component];
  const layout = layouts.find(value => matchesEnterpriseSqliteSchemaV3(db,value));
  check(layout,'enterprise_v3_partial_or_unknown_schema');
  const registryRows = db.prepare('SELECT * FROM enterprise_registry').all() as Record<string,unknown>[];
  check(registryRows.length===1 && registryRows[0].singleton===1,'enterprise_v3_registry_missing');
  const row = registryRows[0];
  const profiles = db.prepare('SELECT * FROM enterprise_profiles ORDER BY id').all() as {
    id:string; slug:string; revision:number; profile_json:string; max_accounts:number;
  }[];
  let registry: EnterpriseRegistryV3;
  try {
    registry = parseEnterpriseRegistryV3({version:3,registryRevision:row.registry_revision,legacyEnterpriseId:row.legacy_enterprise_id,
      profiles:profiles.map(profile => JSON.parse(profile.profile_json))});
  } catch { throw new EnterpriseStorageError('enterprise_v3_registry_invalid'); }
  check(profiles.every(stored => {
    const profile = registry.profiles.find(value => value.id===stored.id);
    return profile && profile.slug===stored.slug && profile.revision===stored.revision && JSON.stringify(profile)===stored.profile_json
      && Number.isInteger(stored.max_accounts) && stored.max_accounts>=1 && stored.max_accounts<=10000;
  }),'enterprise_v3_profile_mismatch');
  check(profiles.reduce((total,profile)=>total+profile.max_accounts,0)<=10000,'enterprise_registry_capacity');
  const hash = enterpriseRegistryHashV3(registry);
  check(row.registry_sha256===hash,'enterprise_v3_registry_hash');
  if (expectedRegistry) check(hash===enterpriseRegistryHashV3(expectedRegistry),'enterprise_v3_registry_mismatch');
  const markers = db.prepare('SELECT * FROM enterprise_schema').all() as Record<string,unknown>[];
  const marker = markers[0];
  check(markers.length===1 && marker.singleton===1 && marker.component===component && marker.layout===layout
    && marker.schema_version===ENTERPRISE_V3_SCHEMA && marker.contract_version===ENTERPRISE_V3_CONTRACT
    && marker.capability===ENTERPRISE_V3_CAPABILITY && marker.registry_sha256===hash
    && marker.migration_id===ENTERPRISE_V3_MIGRATION_ID && marker.state==='complete','enterprise_v3_marker');
  const legacy = registry.profiles.find(profile => profile.id===registry.legacyEnterpriseId)!;
  const cap = profiles.find(profile => profile.id===legacy.id)!.max_accounts;
  if (layout==='pool') {
    const settings = db.prepare('SELECT * FROM user_pool_settings').all() as EnterprisePoolInitSettings[];
    check(settings.length===1 && settings[0].account_domain===legacy.accountDomain,'enterprise_pool_settings_mismatch');
    validateEnterprisePoolSettings(settings[0],cap);
    check(!db.prepare(`SELECT 1 FROM user_pool_accounts p LEFT JOIN proxy_accounts a ON a.identity=p.identity
      WHERE a.enterprise_id IS NOT ? LIMIT 1`).get(legacy.id),'enterprise_pool_legacy_only');
  }
  if (layout==='sso') {
    const settings = db.prepare('SELECT enterprise_id,id FROM sso_runtime_settings').all() as {enterprise_id:string;id:number}[];
    check(settings.length===profiles.length && profiles.every(profile => settings.some(setting => setting.enterprise_id===profile.id && setting.id===1)),
      'enterprise_sso_settings_missing');
  }
  if (layout==='login') {
    check(!db.prepare(`SELECT 1 FROM login_tasks t LEFT JOIN login_legacy_nonce_tombstones n ON n.oauth_attempt_id=t.oauth_attempt_id
      WHERE t.binding_version=1 AND t.oauth_attempt_id IS NOT NULL AND (n.task_id IS NOT t.id OR n.enterprise_id IS NOT t.enterprise_id) LIMIT 1`).get(),
      'enterprise_login_history_nonce_mismatch');
    check(!db.prepare(`SELECT 1 FROM login_nonce_ledger n JOIN login_legacy_nonce_tombstones h ON h.oauth_attempt_id=n.oauth_attempt_id LIMIT 1`).get(),
      'enterprise_login_nonce_collision');
    check(!db.prepare(`SELECT 1 FROM login_tasks t LEFT JOIN login_nonce_ledger n ON n.enterprise_id=t.enterprise_id AND n.oauth_attempt_id=t.oauth_attempt_id
      WHERE t.binding_version=2 AND (n.task_id IS NOT t.id OR n.enterprise_revision IS NOT t.enterprise_revision OR n.identity IS NOT t.identity
      OR n.account_incarnation IS NOT t.account_incarnation OR n.expected_gh_login IS NOT t.expected_gh_login
      OR n.expected_github_user_id IS NOT t.expected_github_user_id) LIMIT 1`).get(),'enterprise_login_nonce_mismatch');
    check((db.prepare('SELECT COUNT(*) AS n FROM login_runtime_settings WHERE id=1').get() as {n:number}).n===1,'enterprise_login_settings_missing');
  }
  checkSqliteIntegrity(db);
  return {registry,legacyEnterpriseId:registry.legacyEnterpriseId,layout,...(layout==='pool'?{maxAccounts:cap}:{})};
}
export function seedEnterpriseSsoSettingsV3(db: Database.Database, profile: EnterpriseProfileV3, now = new Date().toISOString()): void {
  db.prepare(`INSERT INTO sso_runtime_settings(enterprise_id,id,max_sso_users,user_prefix,email_domain,bulk_sync_concurrency,
    scim_request_delay_ms,scim_max_retries,scim_retry_base_delay_ms,version,updated_at) VALUES(?,1,NULL,?,?,3,250,3,1000,1,?)`)
    .run(profile.id,profile.sso.userPrefix,profile.sso.emailDomain,now);
}
export function initEnterpriseSqliteV3(db: Database.Database, component: EnterpriseComponent, value: EnterpriseRegistryV3,
  options: EnterpriseInitOptionsV3 = {}): EnterpriseStorageStateV3 {
  const registry = parseEnterpriseRegistryV3(value), layout = enterpriseComponentLayout(component,options.layout);
  check(enterpriseSqliteObjects(db).length===0,'enterprise_init_requires_empty_database');
  const legacy = registry.profiles.find(profile => profile.id===registry.legacyEnterpriseId)!;
  check(layout==='pool' || options.pool===undefined,'enterprise_unexpected_pool_options');
  if (layout==='pool') {
    check(options.pool,'enterprise_pool_init_options_required');
    check(options.pool.settings.account_domain===legacy.accountDomain,'enterprise_pool_domain_mismatch');
    validateEnterprisePoolSettings(options.pool.settings,legacy.maxAccounts);
  }
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    createEnterpriseSqliteSchemaV3(db,layout); seedEnterpriseRegistrySqliteV3(db,registry);
    const now = new Date().toISOString();
    if (component==='proxy') db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run('2026-07-23-copilot-oauth-direct',now);
    if (layout==='pool') {
      const s = options.pool!.settings;
      db.prepare(`INSERT INTO user_pool_settings(id,version,idle_target,lease_seconds,paused,next_ordinal,account_domain,owner,owner_until)
        VALUES(1,?,?,?,?,?,?,?,?)`).run(s.version,s.idle_target,s.lease_seconds,s.paused,s.next_ordinal,s.account_domain,s.owner,s.owner_until);
    }
    if (layout==='sso') for (const profile of registry.profiles) seedEnterpriseSsoSettingsV3(db,profile,now);
    if (layout==='login') db.prepare(`INSERT INTO login_runtime_settings(id,concurrency,auth_timeout_ms,auth_debug_logs,auth_debug_artifacts,version,updated_at)
      VALUES(1,1,60000,0,0,1,?)`).run(now);
    completeEnterpriseSqliteV3(db,component,registry,layout);
    validateEnterpriseSqliteV3(db,component,registry);
  }).immediate();
  return validateEnterpriseSqliteV3(db,component,registry);
}
/** Offline registration requires evidence that all in-flight writers have drained, not only an operator flag. */
export function assertEnterpriseSqliteDrainedV3(db: Database.Database, component: EnterpriseComponent, layout: EnterpriseLayout): void {
  const absent=(sql:string)=>check(!db.prepare(sql).get(),'enterprise_registry_writers_not_drained');
  if (component==='login') absent("SELECT 1 FROM login_tasks WHERE status NOT IN ('success','failed','cancelled') LIMIT 1");
  if (component==='sso') {
    absent('SELECT 1 FROM sso_users WHERE operation_fence IS NOT NULL LIMIT 1');
    absent("SELECT 1 FROM sso_emu_import_plans WHERE status IN ('applying','running','pending') LIMIT 1");
    absent("SELECT 1 FROM sso_emu_import_plan_rows WHERE status IN ('applying','running') LIMIT 1");
  }
  if (component==='proxy') {
    absent("SELECT 1 FROM proxy_authorization_attempts WHERE status='active' LIMIT 1");
    absent('SELECT 1 FROM proxy_accounts WHERE copilot_oauth_attempt_id IS NOT NULL LIMIT 1');
    absent('SELECT 1 FROM proxy_identity_initializations LIMIT 1');
    if (layout==='pool') {
      absent('SELECT 1 FROM user_pool_holds LIMIT 1'); absent('SELECT 1 FROM user_pool_catalog_holds LIMIT 1');
      absent("SELECT 1 FROM user_pool_accounts WHERE state='provisioning' LIMIT 1");
      const settings=db.prepare('SELECT paused,owner_until FROM user_pool_settings WHERE id=1').get() as {paused:number;owner_until:number};
      check(settings.paused===1 && settings.owner_until<=Date.now(),'enterprise_registry_writers_not_drained');
    }
  }
}
/** Offline append-only registration. Existing public configuration/identity and legacy pin cannot change. */
export function registerEnterpriseSqliteV3(db: Database.Database, component: EnterpriseComponent,
  previous: EnterpriseRegistryV3, nextValue: EnterpriseRegistryV3): EnterpriseStorageStateV3 {
  const next = parseEnterpriseRegistryV3(nextValue), before = parseEnterpriseRegistryV3(previous);
  check(next.legacyEnterpriseId===before.legacyEnterpriseId && next.registryRevision===before.registryRevision+1
    && next.profiles.length>before.profiles.length && before.profiles.every(profile => next.profiles.some(candidate =>
      candidate.id===profile.id && JSON.stringify(candidate)===JSON.stringify(profile))),'enterprise_registry_append_only');
  db.transaction(() => {
    const state=validateEnterpriseSqliteV3(db,component,before);
    assertEnterpriseSqliteDrainedV3(db,component,state.layout);
    for (const profile of next.profiles.filter(profile => !before.profiles.some(old => old.id===profile.id))) {
      db.prepare('INSERT INTO enterprise_profiles(id,slug,revision,profile_json,max_accounts) VALUES(?,?,?,?,?)')
        .run(profile.id,profile.slug,profile.revision,JSON.stringify(parseEnterpriseProfileV3(profile)),profile.maxAccounts);
      if (component==='sso') seedEnterpriseSsoSettingsV3(db,profile);
    }
    const hash = enterpriseRegistryHashV3(next);
    const changed = db.prepare(`UPDATE enterprise_registry SET registry_revision=?,registry_sha256=? WHERE singleton=1
      AND registry_revision=? AND registry_sha256=? AND legacy_enterprise_id=?`)
      .run(next.registryRevision,hash,before.registryRevision,enterpriseRegistryHashV3(before),before.legacyEnterpriseId);
    check(changed.changes===1,'enterprise_registry_cas_conflict');
    db.prepare('UPDATE enterprise_schema SET registry_sha256=? WHERE singleton=1').run(hash);
    validateEnterpriseSqliteV3(db,component,next);
  }).immediate();
  return validateEnterpriseSqliteV3(db,component,next);
}
