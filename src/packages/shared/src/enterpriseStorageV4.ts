import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { EnterpriseStorageError, requireEnterpriseStorage as check, enterpriseSqliteObjects, canonicalEnterpriseSql,
  checkSqliteIntegrity, validateEnterprisePoolSettings, type EnterpriseSchemaObject, type EnterprisePoolInitSettings } from './enterpriseStorage.js';
import { getExpectedEnterpriseSqliteV3, enterpriseRegistryHashV3, seedEnterpriseRegistrySqliteV3,
  assertEnterpriseSqliteDrainedV3, type EnterpriseInitOptionsV3 } from './enterpriseStorageV3.js';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3 } from './enterpriseV3.js';
import { parseEnterprisePoolPolicyRecord, parseEnterpriseValidationEvidenceJsonV1, type EnterprisePoolPolicyRecord } from './enterprisePoolV4.js';
import { enterpriseProfileIdentityHashV4 } from './enterpriseRuntimeV4.js';
import { assertPoolNameCatalogCompatible, NAME_CAPACITY, type PoolNameInventoryRow } from './poolNames.js';

export type EnterpriseLayoutV4 = 'direct' | 'pool';
export type EnterpriseInitOptionsV4 = Omit<EnterpriseInitOptionsV3, 'layout'> & { layout?: EnterpriseLayoutV4 };
export interface EnterpriseStorageStateV4 { registry: EnterpriseRegistryV3; legacyEnterpriseId: string; layout: EnterpriseLayoutV4; maxAccounts?: number }
export const ENTERPRISE_V4_MIGRATION_ID = 'enterprise-schema4-contract2';
const quote = (name: string) => '"' + name.replaceAll('"','""') + '"';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const ENTERPRISE_POLICY_SQLITE_V4 = `
CREATE TABLE enterprise_pool_policy (
  enterprise_id TEXT PRIMARY KEY NOT NULL REFERENCES enterprise_profiles(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('draft','validated','active','draining')),
  policy_version INTEGER NOT NULL CHECK(policy_version>=1),
  identity_sha256 TEXT NOT NULL CHECK(length(identity_sha256)=64 AND identity_sha256 NOT GLOB '*[^a-f0-9]*'),
  validation_kind TEXT CHECK(validation_kind IN ('local_service_readiness_v1','migration_preserved_v3')),
  validation_evidence_json TEXT CHECK(validation_evidence_json IS NULL OR length(validation_evidence_json)<=16384),
  validated_at INTEGER CHECK(validated_at IS NULL OR validated_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=0)
) STRICT;
CREATE TRIGGER enterprise_pool_policy_identity_immutable BEFORE UPDATE OF enterprise_id ON enterprise_pool_policy
  WHEN OLD.enterprise_id IS NOT NEW.enterprise_id BEGIN SELECT RAISE(ABORT,'enterprise_policy_immutable'); END;
CREATE TRIGGER enterprise_pool_policy_no_delete BEFORE DELETE ON enterprise_pool_policy
  BEGIN SELECT RAISE(ABORT,'enterprise_policy_required'); END;
CREATE TABLE enterprise_migration_receipt_v4 (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64), backup_reference TEXT NOT NULL,
  source_registry_sha256 TEXT NOT NULL CHECK(length(source_registry_sha256)=64),
  original_columns_sha256 TEXT NOT NULL CHECK(length(original_columns_sha256)=64),
  source_metadata_json TEXT NOT NULL, evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64), migrated_at INTEGER NOT NULL CHECK(migrated_at>=0)
) STRICT;
CREATE TRIGGER enterprise_migration_receipt_v4_no_update BEFORE UPDATE ON enterprise_migration_receipt_v4
  BEGIN SELECT RAISE(ABORT,'enterprise_migration_receipt_immutable'); END;
CREATE TRIGGER enterprise_migration_receipt_v4_no_delete BEFORE DELETE ON enterprise_migration_receipt_v4
  BEGIN SELECT RAISE(ABORT,'enterprise_migration_receipt_required'); END;
`;
/** Derive the exact frozen v3 structure; only marker, policy, durable scopes and legacy-only guards change. */
export function createEnterpriseSqliteSchemaV4(db: Database.Database, layout: EnterpriseLayoutV4): void {
  check(['direct','pool'].includes(layout),'enterprise_v4_proxy_only');
  const source = getExpectedEnterpriseSqliteV3(layout).objects;
  for (const object of source.filter(o => o.type === 'table' && o.name !== 'sqlite_sequence')) {
    let sql = object.sql!;
    if (object.name === 'enterprise_schema') sql = sql.replace('schema_version=3','schema_version=4').replace("'enterprise-isolation-legacy-pool'","'enterprise-multi-pool'");
    if (['proxy_request_stats','user_pool_events'].includes(object.name)) sql = sql.replace('(', '(enterprise_id TEXT REFERENCES enterprise_profiles(id) ON DELETE RESTRICT, ');
    db.exec(sql);
  }
  for (const object of source.filter(o => ['index','trigger'].includes(o.type) && o.sql !== null && !['user_pool_legacy_only_insert','user_pool_legacy_only_update'].includes(o.name))) db.exec(object.sql!);
  db.exec(ENTERPRISE_POLICY_SQLITE_V4);
  for (const table of ['proxy_request_stats', ...(layout === 'pool' ? ['user_pool_events'] : [])]) {
    db.exec(`CREATE INDEX idx_${table}_enterprise ON ${table}(enterprise_id,${table === 'proxy_request_stats' ? 'requested_at DESC' : 'at DESC'},id DESC)`);
    db.exec(`CREATE TRIGGER ${table}_enterprise_immutable BEFORE UPDATE OF enterprise_id ON ${table}
      WHEN OLD.enterprise_id IS NOT NEW.enterprise_id BEGIN SELECT RAISE(ABORT,'enterprise_history_immutable'); END`);
  }
}
function objectKey(row: EnterpriseSchemaObject): string { return JSON.stringify([row.type,row.name,row.tbl_name,row.sql === null ? null : canonicalEnterpriseSql(row.sql)]); }
function metadata(db: Database.Database, objects: EnterpriseSchemaObject[]): string {
  return JSON.stringify(objects.filter(row => row.type === 'table').map(row => [row.name,
    db.prepare(`PRAGMA table_xinfo(${quote(row.name)})`).all(),db.prepare(`PRAGMA foreign_key_list(${quote(row.name)})`).all(),
    (db.prepare(`PRAGMA index_list(${quote(row.name)})`).all() as {name:string;seq:number}[]).sort((a,b) => a.name.localeCompare(b.name))
      .map(({seq:_seq,...index}) => [index,db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all()]) ]));
}
const expected = new Map<EnterpriseLayoutV4,{objects:EnterpriseSchemaObject[];metadata:string}>();
export function getExpectedEnterpriseSqliteV4(layout: EnterpriseLayoutV4) {
  if (!expected.has(layout)) { const db = new Database(':memory:'); try { createEnterpriseSqliteSchemaV4(db,layout); const objects=enterpriseSqliteObjects(db); expected.set(layout,{objects,metadata:metadata(db,objects)}); } finally {db.close();} }
  return structuredClone(expected.get(layout)!);
}
export function matchesEnterpriseSqliteSchemaV4(db: Database.Database, layout: EnterpriseLayoutV4): boolean {
  const actual=enterpriseSqliteObjects(db), shape=getExpectedEnterpriseSqliteV4(layout);
  return JSON.stringify(actual.map(objectKey))===JSON.stringify(shape.objects.map(objectKey)) && metadata(db,actual)===shape.metadata;
}
export function validateEnterprisePoolSettingsV4(settings: EnterprisePoolInitSettings): void {
  // Global target is independent of currently active or registered capacity.
  validateEnterprisePoolSettings(settings,10000);
}
export interface EnterpriseMigrationEvidenceV4 {
  version:1; sourceSchemaVersion:3; layout:EnterpriseLayoutV4; registryRevision:number; registrySha256:string; legacyEnterpriseId:string;
  profiles:{enterpriseId:string;identitySha256:string;maxAccounts:number}[];
}
export function parseEnterpriseMigrationEvidenceV4(value: unknown): EnterpriseMigrationEvidenceV4 {
  const keys=(v:unknown,names:string[])=>!!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===names.length && names.every(k=>Object.hasOwn(v,k));
  check(keys(value,['version','sourceSchemaVersion','layout','registryRevision','registrySha256','legacyEnterpriseId','profiles']),'enterprise_v4_receipt');
  const v=value as EnterpriseMigrationEvidenceV4;
  check(v.version===1 && v.sourceSchemaVersion===3 && ['direct','pool'].includes(v.layout) && Number.isSafeInteger(v.registryRevision) && v.registryRevision>=1
    && isHash(v.registrySha256) && Array.isArray(v.profiles) && v.profiles.length>=1 && v.profiles.length<=100,'enterprise_v4_receipt');
  const uuid=(x:unknown)=>typeof x==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
  check(uuid(v.legacyEnterpriseId) && v.profiles.every(p=>keys(p,['enterpriseId','identitySha256','maxAccounts']) && uuid(p.enterpriseId) && isHash(p.identitySha256)
    && Number.isInteger(p.maxAccounts) && p.maxAccounts>=1 && p.maxAccounts<=10000)
    && new Set(v.profiles.map(p=>p.enterpriseId)).size===v.profiles.length && v.profiles.some(p=>p.enterpriseId===v.legacyEnterpriseId)
    && v.profiles.reduce((n,p)=>n+p.maxAccounts,0)<=10000,'enterprise_v4_receipt');
  return v;
}
export function validateEnterpriseMigrationEvidenceBindingV4(e: EnterpriseMigrationEvidenceV4, registry: EnterpriseRegistryV3, layout: EnterpriseLayoutV4): void {
  check(e.layout===layout && e.legacyEnterpriseId===registry.legacyEnterpriseId && e.registryRevision<=registry.registryRevision
    && (e.registryRevision!==registry.registryRevision || e.registrySha256===enterpriseRegistryHashV3(registry))
    && e.profiles.every(p=>registry.profiles.some(profile=>profile.id===p.enterpriseId && enterpriseProfileIdentityHashV4(profile)===p.identitySha256)), 'enterprise_v4_receipt_binding');
}
export function validateEnterpriseSqliteReceiptV4(db: Database.Database, registry: EnterpriseRegistryV3, layout: EnterpriseLayoutV4): EnterpriseMigrationEvidenceV4 | undefined {
  const rows=db.prepare('SELECT * FROM enterprise_migration_receipt_v4').all() as Record<string,unknown>[];
  check(rows.length<=1,'enterprise_v4_receipt'); if(!rows.length)return undefined;
  const r=rows[0];
  check(r.singleton===1 && ['manifest_sha256','source_sha256','source_registry_sha256','original_columns_sha256','evidence_sha256'].every(k=>isHash(r[k]))
    && typeof r.backup_reference==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(r.backup_reference)
    && Number.isSafeInteger(r.migrated_at) && Number(r.migrated_at)>=0 && typeof r.source_metadata_json==='string' && r.source_metadata_json.length<=32768
    && hash(r.source_metadata_json)===r.evidence_sha256,'enterprise_v4_receipt');
  let e:EnterpriseMigrationEvidenceV4; try{e=parseEnterpriseMigrationEvidenceV4(JSON.parse(r.source_metadata_json));}catch{throw new EnterpriseStorageError('enterprise_v4_receipt');}
  check(e.registrySha256===r.source_registry_sha256,'enterprise_v4_receipt');validateEnterpriseMigrationEvidenceBindingV4(e,registry,layout);return e;
}
export function enterprisePolicyRecordFromRowV4(row: Record<string,unknown>): EnterprisePoolPolicyRecord {
  return parseEnterprisePoolPolicyRecord({enterpriseId:row.enterprise_id,state:row.state,policyVersion:Number(row.policy_version),maxAccounts:Number(row.max_accounts),
    identitySha256:row.identity_sha256,validationKind:row.validation_kind,
    validationEvidence:row.validation_evidence_json===null?null:parseEnterpriseValidationEvidenceJsonV1(row.validation_evidence_json),
    validatedAt:row.validated_at===null?null:Number(row.validated_at),updatedAt:Number(row.updated_at)});
}
export function validateEnterprisePolicyBindingV4(policy: EnterprisePoolPolicyRecord, registry: EnterpriseRegistryV3, migrated?: EnterpriseMigrationEvidenceV4): void {
  const profile=registry.profiles.find(p=>p.id===policy.enterpriseId);
  check(profile && policy.identitySha256===enterpriseProfileIdentityHashV4(profile),'enterprise_v4_policy_identity');
  const e=policy.validationEvidence;
  if(e)check(e.enterpriseRevision===profile.revision && e.legacyEnterpriseId===registry.legacyEnterpriseId && e.registryRevision<=registry.registryRevision
    && (e.registryRevision!==registry.registryRevision || e.registrySha256===enterpriseRegistryHashV3(registry)),'enterprise_v4_policy_evidence');
  if(policy.validationKind==='migration_preserved_v3')check(migrated && policy.enterpriseId===registry.legacyEnterpriseId
    && migrated.profiles.some(p=>p.enterpriseId===policy.enterpriseId && p.identitySha256===policy.identitySha256),'enterprise_v4_migration_evidence_missing');
}
/** Bounded read-only catalog barrier; also used before final v3 -> v4 writes. */
export function validatePoolNameCatalogSqliteV4(db: Database.Database, nextOrdinal?: number): void {
  const cursor = nextOrdinal ?? (db.prepare('SELECT next_ordinal FROM user_pool_settings WHERE id=1').get() as { next_ordinal?: number } | undefined)?.next_ordinal;
  const inventory = db.prepare(`SELECT p.identity,p.ordinal,a.sso_user FROM user_pool_accounts p
    LEFT JOIN proxy_accounts a ON a.identity=p.identity ORDER BY p.ordinal LIMIT ${NAME_CAPACITY + 1}`).all() as PoolNameInventoryRow[];
  assertPoolNameCatalogCompatible(cursor as number, inventory);
}

/** SELECT/PRAGMA-read only. Never initializes, migrates, seeds or repairs supplied storage. */
export function validateEnterpriseSqliteV4(db: Database.Database, component:'proxy', expectedRegistry?:EnterpriseRegistryV3):EnterpriseStorageStateV4 {
  check(component==='proxy','enterprise_v4_proxy_only'); check(db.pragma('foreign_keys',{simple:true})===1,'enterprise_foreign_keys_disabled');
  const layout=(['direct','pool'] as const).find(l=>matchesEnterpriseSqliteSchemaV4(db,l));check(layout,'enterprise_v4_partial_or_unknown_schema');
  const rs=db.prepare('SELECT * FROM enterprise_registry').all() as Record<string,unknown>[],profiles=db.prepare('SELECT * FROM enterprise_profiles ORDER BY id').all() as Record<string,unknown>[];
  check(rs.length===1 && rs[0].singleton===1,'enterprise_v4_registry'); let registry:EnterpriseRegistryV3;
  try{registry=parseEnterpriseRegistryV3({version:3,registryRevision:rs[0].registry_revision,legacyEnterpriseId:rs[0].legacy_enterprise_id,profiles:profiles.map(p=>JSON.parse(String(p.profile_json)))});}catch{throw new EnterpriseStorageError('enterprise_v4_registry');}
  const sha=enterpriseRegistryHashV3(registry),total=profiles.reduce((n,p)=>n+Number(p.max_accounts),0);
  check(rs[0].registry_sha256===sha && (!expectedRegistry || sha===enterpriseRegistryHashV3(expectedRegistry)) && total<=10000 && profiles.every(p=>{
    const profile=registry.profiles.find(v=>v.id===p.id);return profile && profile.slug===p.slug && profile.revision===p.revision && JSON.stringify(profile)===p.profile_json && Number.isInteger(p.max_accounts) && Number(p.max_accounts)>=1 && Number(p.max_accounts)<=10000;
  }),'enterprise_v4_registry');
  const markers=db.prepare('SELECT * FROM enterprise_schema').all() as Record<string,unknown>[],m=markers[0];
  check(markers.length===1 && m.singleton===1 && m.component==='proxy' && m.schema_version===4 && m.contract_version===2 && m.capability==='enterprise-multi-pool'
    && m.layout===layout && m.registry_sha256===sha && m.migration_id===ENTERPRISE_V4_MIGRATION_ID && m.state==='complete','enterprise_v4_marker');
  const migrated=validateEnterpriseSqliteReceiptV4(db,registry,layout);
  const policies=db.prepare('SELECT p.*,e.max_accounts FROM enterprise_pool_policy p JOIN enterprise_profiles e ON e.id=p.enterprise_id').all() as Record<string,unknown>[];
  check(policies.length===profiles.length,'enterprise_v4_policy_missing');
  for(const row of policies)validateEnterprisePolicyBindingV4(enterprisePolicyRecordFromRowV4(row),registry,migrated);
  if(layout==='pool'){
    const settings=db.prepare('SELECT * FROM user_pool_settings').all() as EnterprisePoolInitSettings[];
    check(settings.length===1 && settings[0].account_domain===registry.profiles.find(p=>p.id===registry.legacyEnterpriseId)!.accountDomain,'enterprise_v4_settings');validateEnterprisePoolSettingsV4(settings[0]);
    validatePoolNameCatalogSqliteV4(db, settings[0].next_ordinal);
  }
  const history=db.prepare('SELECT id FROM schema_migrations').all() as {id:string}[];
  check(history.length===1 && history[0].id==='2026-07-23-copilot-oauth-direct','enterprise_v4_history');
  checkSqliteIntegrity(db);return{registry,legacyEnterpriseId:registry.legacyEnterpriseId,layout,...(layout==='pool'?{maxAccounts:total}:{})};
}
export function seedEnterprisePoliciesSqliteV4(db:Database.Database,registry:EnterpriseRegistryV3,migrated=false,now=Date.now()):void {
  const insert=db.prepare(`INSERT INTO enterprise_pool_policy(enterprise_id,state,policy_version,identity_sha256,validation_kind,validation_evidence_json,validated_at,updated_at) VALUES(?,?,1,?,?,NULL,?,?)`);
  for(const p of registry.profiles){const legacy=migrated && p.id===registry.legacyEnterpriseId;insert.run(p.id,legacy?'active':'draft',enterpriseProfileIdentityHashV4(p),legacy?'migration_preserved_v3':null,legacy?now:null,now);}
}
export function completeEnterpriseSqliteV4(db:Database.Database,component:'proxy',registry:EnterpriseRegistryV3,layout:EnterpriseLayoutV4):void {
  check(component==='proxy','enterprise_v4_proxy_only');db.prepare(`INSERT INTO enterprise_schema(singleton,component,schema_version,contract_version,capability,layout,registry_sha256,migration_id,state) VALUES(1,'proxy',4,2,'enterprise-multi-pool',?,?,?,'complete')`).run(layout,enterpriseRegistryHashV3(registry),ENTERPRISE_V4_MIGRATION_ID);
}
export function initEnterpriseSqliteV4(db:Database.Database,component:'proxy',value:EnterpriseRegistryV3,options:EnterpriseInitOptionsV4={}):EnterpriseStorageStateV4 {
  check(component==='proxy','enterprise_v4_proxy_only');const registry=parseEnterpriseRegistryV3(value),layout=options.layout??(options.pool?'pool':'direct');
  check(enterpriseSqliteObjects(db).length===0,'enterprise_init_requires_empty_database');check(layout==='pool'?!!options.pool:options.pool===undefined,'enterprise_v4_settings');
  if(options.pool){const s=options.pool.settings;validateEnterprisePoolSettingsV4(s);check(s.paused===1 && s.next_ordinal===0 && s.owner===null && s.owner_until===0
    && s.account_domain===registry.profiles.find(p=>p.id===registry.legacyEnterpriseId)!.accountDomain,'enterprise_v4_init_must_be_empty_paused');}
  db.pragma('foreign_keys=ON');db.transaction(()=>{
    createEnterpriseSqliteSchemaV4(db,layout);seedEnterpriseRegistrySqliteV3(db,registry);seedEnterprisePoliciesSqliteV4(db,registry);
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run('2026-07-23-copilot-oauth-direct',new Date().toISOString());
    if(options.pool){const s=options.pool.settings;db.prepare('INSERT INTO user_pool_settings(id,version,idle_target,lease_seconds,paused,next_ordinal,account_domain,owner,owner_until) VALUES(1,?,?,?,?,?,?,?,?)').run(s.version,s.idle_target,s.lease_seconds,1,s.next_ordinal,s.account_domain,s.owner,s.owner_until);}
    completeEnterpriseSqliteV4(db,'proxy',registry,layout);validateEnterpriseSqliteV4(db,'proxy',registry);
  }).immediate();return validateEnterpriseSqliteV4(db,'proxy',registry);
}
export function assertEnterpriseSqliteDrainedV4(db:Database.Database,layout:EnterpriseLayoutV4):void {
  assertEnterpriseSqliteDrainedV3(db,'proxy',layout);
  const absent=(sql:string)=>check(!db.prepare(sql).get(),'enterprise_registry_writers_not_drained');
  absent("SELECT 1 FROM proxy_accounts WHERE copilot_oauth_status NOT IN ('valid','expired','missing','failed') LIMIT 1");
  if(layout==='pool') {
    absent(`SELECT 1 FROM user_pool_accounts WHERE lower(coalesce(last_error,'')) LIKE '%ambiguous%' OR lower(coalesce(last_error,'')) LIKE '%unconfirmed%'
      OR lower(coalesce(last_error,'')) LIKE '%stalled%' OR lower(coalesce(last_error,'')) LIKE '%sso_name_conflict%' OR lower(coalesce(last_error,'')) LIKE '%oauth_task_invalid%' LIMIT 1`);
    absent(`SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity WHERE (p.task_id IS NOT NULL OR p.oauth_attempt_id IS NOT NULL)
      AND NOT(p.state IN ('ready','cooling') AND p.stage='ready' AND p.verified_at IS NOT NULL AND p.sso_created_at IS NOT NULL AND p.task_id IS NOT NULL AND p.oauth_attempt_id IS NOT NULL
      AND a.gh_login IS NOT NULL AND length(a.gh_login)>0 AND a.copilot_oauth_status='valid') LIMIT 1`);
  }
}
export function registerEnterpriseSqliteV4(db:Database.Database,component:'proxy',previous:EnterpriseRegistryV3,nextValue:EnterpriseRegistryV3):EnterpriseStorageStateV4 {
  check(component==='proxy','enterprise_v4_proxy_only');const before=parseEnterpriseRegistryV3(previous),next=parseEnterpriseRegistryV3(nextValue);
  check(next.legacyEnterpriseId===before.legacyEnterpriseId && next.registryRevision===before.registryRevision+1 && next.profiles.length>before.profiles.length
    && before.profiles.every(p=>JSON.stringify(p)===JSON.stringify(next.profiles.find(n=>n.id===p.id))),'enterprise_registry_append_only');
  db.transaction(()=>{const state=validateEnterpriseSqliteV4(db,'proxy',before);assertEnterpriseSqliteDrainedV4(db,state.layout);
    for(const p of next.profiles.filter(p=>!before.profiles.some(old=>old.id===p.id))){
      db.prepare('INSERT INTO enterprise_profiles(id,slug,revision,profile_json,max_accounts) VALUES(?,?,?,?,?)').run(p.id,p.slug,p.revision,JSON.stringify(p),p.maxAccounts);
      db.prepare('INSERT INTO enterprise_pool_policy(enterprise_id,state,policy_version,identity_sha256,validation_kind,validation_evidence_json,validated_at,updated_at) VALUES(?,\'draft\',1,?,NULL,NULL,NULL,?)').run(p.id,enterpriseProfileIdentityHashV4(p),Date.now());
    }
    const sha=enterpriseRegistryHashV3(next);check(db.prepare('UPDATE enterprise_registry SET registry_revision=?,registry_sha256=? WHERE singleton=1 AND registry_revision=? AND registry_sha256=?').run(next.registryRevision,sha,before.registryRevision,enterpriseRegistryHashV3(before)).changes===1,'enterprise_registry_cas_conflict');
    db.prepare('UPDATE enterprise_schema SET registry_sha256=? WHERE singleton=1').run(sha);validateEnterpriseSqliteV4(db,'proxy',next);
  }).immediate();return validateEnterpriseSqliteV4(db,'proxy',next);
}
