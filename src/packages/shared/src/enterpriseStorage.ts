import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  canonicalEnterpriseProfile, parseEnterpriseProfile, ENTERPRISE_SCHEMA_VERSION,
  ENTERPRISE_CONTRACT_VERSION, ENTERPRISE_CAPABILITY, type EnterpriseComponent, type EnterpriseProfile,
} from './enterprise.js';
import { createEnterpriseV1SqliteSchema, enterpriseOwnedTables, type EnterpriseLayout } from './enterpriseSqliteV1.js';
export type { EnterpriseLayout } from './enterpriseSqliteV1.js';
export { initEnterpriseMysql, validateEnterpriseMysql } from './enterpriseMysql.js';

export class EnterpriseStorageError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EnterpriseStorageError'; }
}
export interface EnterprisePoolInitSettings {
  version: number; idle_target: number; lease_seconds: number; paused: 0 | 1;
  next_ordinal: number; account_domain: string; owner: string | null; owner_until: number;
}
export interface EnterpriseInitOptions {
  layout?: EnterpriseLayout;
  maxAccounts?: number;
  pool?: { fingerprint?: string; settings: EnterprisePoolInitSettings };
}
export interface EnterpriseStorageState {
  profile: EnterpriseProfile;
  maxAccounts?: number;
  layout: EnterpriseLayout;
}
export interface EnterpriseSchemaObject { name: string; type: string; tbl_name: string; sql: string | null }
export const ENTERPRISE_MIGRATION_ID = '8ad76d5-enterprise-schema2-contract1';
export function enterpriseProfileHash(profile: EnterpriseProfile): string {
  return createHash('sha256').update(canonicalEnterpriseProfile(profile)).digest('hex');
}
export function requireEnterpriseStorage(condition: unknown, code: string): asserts condition {
  if (!condition) throw new EnterpriseStorageError(code);
}
const check: typeof requireEnterpriseStorage = requireEnterpriseStorage;
export function enterpriseComponentLayout(component: EnterpriseComponent, layout?: EnterpriseLayout): EnterpriseLayout {
  const value = layout ?? (component === 'proxy' ? 'direct' : component);
  check(component === 'proxy' ? ['direct', 'pool'].includes(value) : value === component, 'enterprise_component_layout_mismatch');
  return value;
}
const REGISTRY_SQL = `
CREATE TABLE enterprise_profiles (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE, profile_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  max_accounts INTEGER CHECK(max_accounts BETWEEN 1 AND 10000)
) STRICT;
CREATE TABLE enterprise_schema (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  component TEXT NOT NULL CHECK(component IN ('proxy', 'sso', 'login')),
  schema_version INTEGER NOT NULL CHECK(schema_version = 2),
  contract_version INTEGER NOT NULL CHECK(contract_version = 1),
  capability TEXT NOT NULL CHECK(capability = 'enterprise-single-profile'),
  layout TEXT NOT NULL CHECK(layout IN ('direct', 'pool', 'sso', 'login')),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256) = 64),
  migration_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state = 'complete')
) STRICT;
CREATE TABLE enterprise_migration_receipt (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  backup_reference TEXT NOT NULL, baseline TEXT NOT NULL, original_columns_sha256 TEXT NOT NULL
) STRICT;
CREATE TRIGGER enterprise_profiles_no_second BEFORE INSERT ON enterprise_profiles
  WHEN EXISTS(SELECT 1 FROM enterprise_profiles)
  BEGIN SELECT RAISE(ABORT, 'enterprise_profile_already_registered'); END;
CREATE TRIGGER enterprise_profiles_identity_immutable
  BEFORE UPDATE OF singleton, id, slug, profile_json, revision ON enterprise_profiles
  WHEN OLD.singleton IS NOT NEW.singleton OR OLD.id IS NOT NEW.id OR OLD.slug IS NOT NEW.slug
    OR OLD.profile_json IS NOT NEW.profile_json OR OLD.revision IS NOT NEW.revision
  BEGIN SELECT RAISE(ABORT, 'enterprise_profile_immutable'); END;
CREATE TRIGGER enterprise_profiles_no_delete BEFORE DELETE ON enterprise_profiles
  BEGIN SELECT RAISE(ABORT, 'enterprise_profile_required'); END;
`;
export function enterpriseSqliteObjects(db: Database.Database): EnterpriseSchemaObject[] {
  return db.prepare('SELECT name, type, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all() as EnterpriseSchemaObject[];
}
/** Token comparison discards formatting, not string literals, comments, constraints or triggers. */
export function canonicalEnterpriseSql(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|[a-zA-Z_][a-zA-Z_0-9]*|\d+|\S/g) ?? [])
    .map(token => token.startsWith("'") ? token : /^["`][a-z_][a-z_0-9]*["`]$/.test(token) ? token.slice(1, -1) : token.toLowerCase())
    .filter(token => token !== ';').join(' ');
}
function objectKey(row: EnterpriseSchemaObject): string {
  return JSON.stringify([row.type, row.name, row.tbl_name, row.sql === null ? null : canonicalEnterpriseSql(row.sql)]);
}
function structuralMetadata(db: Database.Database, objects: EnterpriseSchemaObject[]): string {
  return JSON.stringify(objects.filter(row => row.type === 'table').map(row => [row.name,
    db.prepare(`PRAGMA table_xinfo("${row.name}")`).all(),
    db.prepare(`PRAGMA foreign_key_list("${row.name}")`).all(),
    (db.prepare(`PRAGMA index_list("${row.name}")`).all() as { name: string }[])
      .sort((a, b) => a.name.localeCompare(b.name)).map(index => {
        // index_list.seq is creation-order metadata, not semantics.
        const { seq: _seq, ...metadata } = index as unknown as Record<string, unknown>;
        return [metadata, db.prepare(`PRAGMA index_xinfo("${index.name}")`).all()];
      }),
  ]));
}
const expectedSchemas = new Map<string, { keys: string[]; metadata: string }>();
function expectedSchema(layout: EnterpriseLayout, version: 1 | 2): { keys: string[]; metadata: string } {
  const key = `${version}:${layout}`;
  const cached = expectedSchemas.get(key);
  if (cached) return cached;
  const fixture = new Database(':memory:');
  try {
    if (version === 1) createEnterpriseV1SqliteSchema(fixture, layout);
    else createEnterpriseSqliteSchema(fixture, layout);
    const objects = enterpriseSqliteObjects(fixture);
    const shape = { keys: objects.map(objectKey), metadata: structuralMetadata(fixture, objects) };
    expectedSchemas.set(key, shape);
    return shape;
  } finally { fixture.close(); }
}
export function matchesEnterpriseSqliteSchema(db: Database.Database, layout: EnterpriseLayout, version: 1 | 2): boolean {
  const actual = enterpriseSqliteObjects(db);
  const expected = expectedSchema(layout, version);
  return JSON.stringify(actual.map(objectKey)) === JSON.stringify(expected.keys)
    && structuralMetadata(db, actual) === expected.metadata;
}
export function validateEnterpriseV1Sqlite(db: Database.Database, component: EnterpriseComponent): EnterpriseLayout {
  const layouts: EnterpriseLayout[] = component === 'proxy' ? ['direct', 'pool'] : [component];
  const layout = layouts.find(candidate => matchesEnterpriseSqliteSchema(db, candidate, 1));
  check(layout, 'enterprise_unknown_legacy_schema');
  checkSqliteIntegrity(db);
  if (component === 'proxy') {
    const migrations = db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[];
    check(migrations.length === 1 && migrations[0].id === '2026-07-23-copilot-oauth-direct', 'enterprise_unknown_legacy_history');
  }
  return layout;
}
export function checkSqliteIntegrity(db: Database.Database): void {
  check((db.pragma('integrity_check') as { integrity_check: string }[]).every(row => row.integrity_check === 'ok'), 'enterprise_integrity_failed');
  check((db.pragma('foreign_key_check') as unknown[]).length === 0, 'enterprise_foreign_key_failed');
}
/** Builds only the exact schema, without rows/marker. Explicit offline callers only. */
export function createEnterpriseSqliteSchema(db: Database.Database, layout: EnterpriseLayout): void {
  const fixture = new Database(':memory:');
  try {
    createEnterpriseV1SqliteSchema(fixture, layout);
    const objects = enterpriseSqliteObjects(fixture);
    db.exec(REGISTRY_SQL);
    for (const object of objects.filter(row => row.type === 'table' && row.name !== 'sqlite_sequence')) {
      let sql = object.sql!;
      if (enterpriseOwnedTables(layout).includes(object.name)) {
        sql = sql.replace('(', '(enterprise_id TEXT NOT NULL REFERENCES enterprise_profiles(id) ON DELETE RESTRICT, ');
      }
      if (object.name === 'user_pool_settings') sql = sql.replace(/max_accounts INTEGER NOT NULL,\s*/, '');
      db.exec(sql);
    }
    for (const object of objects.filter(row => ['index', 'trigger'].includes(row.type) && row.sql !== null)) db.exec(object.sql!);
    for (const table of enterpriseOwnedTables(layout)) {
      db.exec(`CREATE TRIGGER ${table}_enterprise_immutable BEFORE UPDATE OF enterprise_id ON ${table}
        WHEN OLD.enterprise_id IS NOT NEW.enterprise_id
        BEGIN SELECT RAISE(ABORT, 'enterprise_ownership_immutable'); END`);
    }
  } finally { fixture.close(); }
}
export function registerEnterpriseSqliteProfile(db: Database.Database, profile: EnterpriseProfile, maxAccounts?: number): void {
  const canonical = canonicalEnterpriseProfile(profile);
  check(maxAccounts === undefined || Number.isInteger(maxAccounts) && maxAccounts >= 1 && maxAccounts <= 10000, 'enterprise_invalid_capacity');
  db.prepare('INSERT INTO enterprise_profiles (singleton,id,slug,profile_json,revision,max_accounts) VALUES (1,?,?,?,?,?)')
    .run(profile.id, profile.slug, canonical, profile.revision, maxAccounts ?? null);
}
export function completeEnterpriseSqlite(db: Database.Database, component: EnterpriseComponent, profile: EnterpriseProfile, layout: EnterpriseLayout): void {
  db.prepare(`INSERT INTO enterprise_schema (singleton,component,schema_version,contract_version,capability,layout,profile_sha256,migration_id,state)
    VALUES (1,?,?,?,?,?,?,?,'complete')`).run(component, ENTERPRISE_SCHEMA_VERSION, ENTERPRISE_CONTRACT_VERSION,
    ENTERPRISE_CAPABILITY, layout, enterpriseProfileHash(profile), ENTERPRISE_MIGRATION_ID);
}
/** Read-only runtime gate. No schema repair, WAL switch, seed, ownership claim or cleanup. */
export function validateEnterpriseSqlite(db: Database.Database, component: EnterpriseComponent, expectedProfile?: EnterpriseProfile): EnterpriseStorageState {
  check(db.pragma('foreign_keys', { simple: true }) === 1, 'enterprise_foreign_keys_disabled');
  const objects = enterpriseSqliteObjects(db);
  if (objects.length === 0) throw new EnterpriseStorageError('enterprise_init_required');
  if (!objects.some(row => row.name === 'enterprise_schema')) {
    const layouts: EnterpriseLayout[] = component === 'proxy' ? ['direct', 'pool'] : [component];
    if (layouts.some(layout => matchesEnterpriseSqliteSchema(db, layout, 1))) throw new EnterpriseStorageError('enterprise_migrate_required');
    throw new EnterpriseStorageError('enterprise_partial_or_unknown_schema');
  }
  const layouts: EnterpriseLayout[] = component === 'proxy' ? ['direct', 'pool'] : [component];
  const layout = layouts.find(candidate => matchesEnterpriseSqliteSchema(db, candidate, 2));
  check(layout, 'enterprise_partial_or_unknown_schema');
  const profiles = db.prepare('SELECT * FROM enterprise_profiles').all() as {
    singleton: number; id: string; slug: string; profile_json: string; revision: number; max_accounts: number | null;
  }[];
  check(profiles.length === 1, 'enterprise_profile_missing_or_multiple');
  const stored = profiles[0];
  let profile: EnterpriseProfile;
  try { profile = parseEnterpriseProfile(JSON.parse(stored.profile_json)); }
  catch { throw new EnterpriseStorageError('enterprise_invalid_persisted_profile'); }
  check(stored.singleton === 1 && stored.id === profile.id && stored.slug === profile.slug && stored.revision === profile.revision
    && canonicalEnterpriseProfile(profile) === stored.profile_json, 'enterprise_profile_metadata_mismatch');
  if (expectedProfile) check(canonicalEnterpriseProfile(profile) === canonicalEnterpriseProfile(expectedProfile), 'enterprise_profile_mismatch');
  check(layout === 'pool' ? Number.isInteger(stored.max_accounts) && stored.max_accounts! >= 1 && stored.max_accounts! <= 10000
    : stored.max_accounts === null, 'enterprise_invalid_capacity');
  const markers = db.prepare('SELECT * FROM enterprise_schema').all() as Record<string, unknown>[];
  check(markers.length === 1, 'enterprise_incomplete_schema');
  const marker = markers[0];
  check(marker.singleton === 1 && marker.component === component && marker.schema_version === ENTERPRISE_SCHEMA_VERSION
    && marker.contract_version === ENTERPRISE_CONTRACT_VERSION && marker.capability === ENTERPRISE_CAPABILITY
    && marker.layout === layout && marker.profile_sha256 === enterpriseProfileHash(profile)
    && marker.migration_id === ENTERPRISE_MIGRATION_ID && marker.state === 'complete', 'enterprise_incomplete_schema');
  for (const table of enterpriseOwnedTables(layout)) {
    check(!db.prepare(`SELECT 1 FROM "${table}" WHERE enterprise_id IS NOT ? LIMIT 1`).get(profile.id), 'enterprise_ownership_mismatch');
  }
  if (layout === 'pool') {
    const settings = db.prepare('SELECT * FROM user_pool_settings').all() as EnterprisePoolInitSettings[];
    check(settings.length === 1 && settings[0].account_domain === profile.accountDomain, 'enterprise_pool_settings_mismatch');
    validateEnterprisePoolSettings(settings[0], stored.max_accounts!);
  }
  checkSqliteIntegrity(db);
  return { profile, layout, ...(stored.max_accounts === null ? {} : { maxAccounts: stored.max_accounts }) };
}
export function validateEnterprisePoolSettings(settings: EnterprisePoolInitSettings, cap: number): void {
  check(Number.isInteger(cap) && cap >= 1 && cap <= 10000 && Number.isSafeInteger(settings.version) && settings.version >= 1
    && Number.isInteger(settings.idle_target) && settings.idle_target >= 0 && settings.idle_target <= cap
    && Number.isInteger(settings.lease_seconds) && settings.lease_seconds >= 60 && settings.lease_seconds <= 2592000
    && [0, 1].includes(settings.paused) && Number.isSafeInteger(settings.next_ordinal) && settings.next_ordinal >= 0 && settings.next_ordinal <= 10000
    && Number.isSafeInteger(settings.owner_until) && settings.owner_until >= 0
    && (settings.owner === null || typeof settings.owner === 'string'), 'enterprise_invalid_pool_settings');
}
/** Explicit initializer for offline tooling and synthetic fixtures; never called by runtime constructors. */
export function initEnterpriseSqlite(db: Database.Database, component: EnterpriseComponent, value: EnterpriseProfile,
  options: EnterpriseInitOptions = {}): EnterpriseStorageState {
  const profile = parseEnterpriseProfile(value);
  const layout = enterpriseComponentLayout(component, options.layout);
  check(enterpriseSqliteObjects(db).length === 0, 'enterprise_init_requires_empty_database');
  check(layout === 'pool' || options.pool === undefined && options.maxAccounts === undefined, 'enterprise_unexpected_pool_options');
  if (layout === 'pool') {
    check(options.pool && options.maxAccounts !== undefined, 'enterprise_pool_init_options_required');
    check(options.pool.settings.account_domain === profile.accountDomain, 'enterprise_pool_domain_mismatch');
    validateEnterprisePoolSettings(options.pool.settings, options.maxAccounts);
  }
  db.pragma('foreign_keys = ON');
  check(db.pragma('foreign_keys', { simple: true }) === 1, 'enterprise_foreign_keys_disabled');
  db.transaction(() => {
    createEnterpriseSqliteSchema(db, layout);
    registerEnterpriseSqliteProfile(db, profile, options.maxAccounts);
    const now = new Date().toISOString();
    if (component === 'proxy') db.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)')
      .run('2026-07-23-copilot-oauth-direct', now);
    if (layout === 'pool') {
      const settings = options.pool!.settings;
      db.prepare(`INSERT INTO user_pool_settings (id,version,idle_target,lease_seconds,paused,next_ordinal,account_domain,owner,owner_until)
        VALUES (1,?,?,?,?,?,?,?,?)`).run(settings.version, settings.idle_target, settings.lease_seconds, settings.paused,
        settings.next_ordinal, settings.account_domain, settings.owner, settings.owner_until);
    }
    if (component === 'sso') db.prepare(`INSERT INTO sso_runtime_settings
      (enterprise_id,id,max_sso_users,user_prefix,email_domain,bulk_sync_concurrency,scim_request_delay_ms,scim_max_retries,scim_retry_base_delay_ms,version,updated_at)
      VALUES (?,1,NULL,'user',?,3,250,3,1000,1,?)`).run(profile.id, profile.accountDomain, now);
    if (component === 'login') db.prepare(`INSERT INTO login_runtime_settings
      (id,concurrency,auth_timeout_ms,auth_debug_logs,auth_debug_artifacts,version,updated_at) VALUES (1,1,60000,0,0,1,?)`).run(now);
    completeEnterpriseSqlite(db, component, profile, layout);
    validateEnterpriseSqlite(db, component, profile);
  }).immediate();
  return validateEnterpriseSqlite(db, component, profile);
}
