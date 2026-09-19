import { createHash } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3, type EnterpriseProfileV3 } from './enterpriseV3.js';
import { EnterpriseMysqlError, requireEnterpriseMysql as check, mysqlEnterpriseRows, enterpriseMysqlObjects, validateEnterpriseMysqlHistory,
  validateEnterpriseMysqlCheckpoint, withEnterpriseMysqlDeadline, type EnterpriseMysqlLayout, type EnterpriseMysqlInitOptions } from './enterpriseMysql.js';
import { mysqlCreateTable, type MysqlConnection } from './enterpriseMysqlV1.js';
import { validateEnterpriseMysqlShapeV3, readEnterpriseMysqlRegistryV3, enterpriseMysqlRegistryHashV3, isEnterpriseMysqlHashV3,
  isEnterpriseMysqlUuidV3, enterpriseMysqlLegacyProfileV3, validateEnterpriseMysqlCheckpointV3, withEnterpriseMysqlLockV3,
  insertEnterpriseMysqlProfileV3, insertEnterpriseMysqlRegistryV3, type EnterpriseMysqlRegisterOptionsV3 } from './enterpriseMysqlV3.js';
import { getExpectedEnterpriseMysqlV3, enterpriseMysqlCreateTriggerV3 } from './enterpriseMysqlSchemaV3.js';
import { getExpectedEnterpriseMysqlV4, ENTERPRISE_MYSQL_V4_MIGRATION, ENTERPRISE_MYSQL_V4_FINAL_STEP } from './enterpriseMysqlSchemaV4.js';
import { enterpriseProfileIdentityHashV4 } from './enterpriseRuntimeV4.js';
import { assertPoolNameCatalogCompatible, NAME_CAPACITY, PoolNameCatalogCompatibilityError, type PoolNameInventoryRow } from './poolNames.js';
import { parseEnterpriseMigrationEvidenceV4, validateEnterpriseMigrationEvidenceBindingV4, validateEnterprisePolicyBindingV4,
  enterprisePolicyRecordFromRowV4, validateEnterprisePoolSettingsV4, type EnterpriseMigrationEvidenceV4 } from './enterpriseStorageV4.js';
export { getExpectedEnterpriseMysqlV4, enterpriseMysqlSchemaV4 } from './enterpriseMysqlSchemaV4.js';
export type { MysqlConnection, EnterpriseMysqlLayout, EnterpriseMysqlInitOptions };
export interface EnterpriseMysqlValidationV4 { registry:EnterpriseRegistryV3;legacyEnterpriseId:string;layout:EnterpriseMysqlLayout;maxAccounts?:number }
export interface EnterpriseMysqlEvidenceV4 {
  version:1;metadata:EnterpriseMigrationEvidenceV4;counts:Record<string,number>;columns:Record<string,Record<string,string>>;
  marker:Record<string,unknown>;eventSequence:string|null;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const keys=(v:unknown,names:string[])=>!!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===names.length && names.every(k=>Object.hasOwn(v,k));
export function parseEnterpriseMysqlEvidenceV4(raw:unknown,sha:string,layout:EnterpriseMysqlLayout):EnterpriseMysqlEvidenceV4 {
  check(typeof raw==='string' && raw.length<=4*1024*1024 && hash(raw)===sha,'enterprise_mysql_v4_evidence');
  let e:EnterpriseMysqlEvidenceV4;try{e=JSON.parse(raw);}catch{throw new EnterpriseMysqlError('enterprise_mysql_v4_evidence');}
  const schema=getExpectedEnterpriseMysqlV3(layout).schema;delete schema.enterprise_schema;
  check(keys(e,['version','metadata','counts','columns','marker','eventSequence']) && e.version===1 && keys(e.counts,Object.keys(schema)) && keys(e.columns,Object.keys(schema))
    && Object.entries(schema).every(([t,d])=>Number.isInteger(e.counts[t]) && e.counts[t]>=0 && e.counts[t]<=100000 && keys(e.columns[t],Object.keys(d.columns)) && Object.values(e.columns[t]).every(isEnterpriseMysqlHashV3))
    && keys(e.marker,['singleton','component','schema_version','contract_version','capability','layout','registry_sha256','migration_id','state'])
    && Number(e.marker.singleton)===1 && e.marker.component==='proxy' && Number(e.marker.schema_version)===3 && Number(e.marker.contract_version)===2
    && e.marker.capability==='enterprise-isolation-legacy-pool' && e.marker.layout===layout && isEnterpriseMysqlHashV3(e.marker.registry_sha256)
    && e.marker.migration_id==='enterprise-schema3-contract2' && e.marker.state==='complete'
    && (layout==='pool'?e.eventSequence===null || typeof e.eventSequence==='string' && /^\d+$/.test(e.eventSequence):e.eventSequence===null),'enterprise_mysql_v4_evidence');
  try{parseEnterpriseMigrationEvidenceV4(e.metadata);}catch{throw new EnterpriseMysqlError('enterprise_mysql_v4_evidence');}
  check(e.metadata.layout===layout && e.metadata.registrySha256===e.marker.registry_sha256,'enterprise_mysql_v4_evidence');return e;
}
export function validateEnterpriseMysqlCheckpointV4(row:Record<string,unknown>,database:string,layout:EnterpriseMysqlLayout,registry:EnterpriseRegistryV3):EnterpriseMysqlEvidenceV4 {
  check(Number(row.singleton)===1 && row.database_name===database && row.layout===layout && row.state==='complete' && row.checkpoint_state==='after'
    && Number(row.step)===ENTERPRISE_MYSQL_V4_FINAL_STEP && typeof row.migration_id==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(row.migration_id)
    && ['manifest_sha256','backup_sha256','source_sha256','registry_sha256'].every(k=>isEnterpriseMysqlHashV3(row[k]))
    && typeof row.backup_reference==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.backup_reference)
    && Number.isSafeInteger(Number(row.migrated_at)) && Number(row.migrated_at)>=0,'enterprise_mysql_v4_checkpoint');
  const e=parseEnterpriseMysqlEvidenceV4(row.evidence_json,row.source_sha256 as string,layout);
  check(e.metadata.registrySha256===row.registry_sha256,'enterprise_mysql_v4_checkpoint');
  try{validateEnterpriseMigrationEvidenceBindingV4(e.metadata,registry,layout);}catch{throw new EnterpriseMysqlError('enterprise_mysql_v4_checkpoint');}return e;
}
/** Bounded SELECT-only catalog barrier, shared with final v4 offline preflight. */
export async function validatePoolNameCatalogMysqlV4(c: MysqlConnection): Promise<void> {
  // A replica may start while another writer reserves a name. Cursor and rows
  // must come from one InnoDB statement snapshot, never a prior settings read.
  // LEFT JOIN preserves the cursor even for an empty inventory; no writer locks.
  const rows = await mysqlEnterpriseRows(c, `SELECT s.next_ordinal,p.identity,p.ordinal,a.sso_user FROM user_pool_settings s LEFT JOIN user_pool_accounts p ON 1=1 LEFT JOIN proxy_accounts a ON BINARY a.identity=BINARY p.identity WHERE s.id=1 ORDER BY p.ordinal LIMIT ${NAME_CAPACITY + 1}`);
  if (!rows.length) throw new PoolNameCatalogCompatibilityError();
  const cursor = Number(rows[0].next_ordinal);
  const empty = rows.length === 1 && rows[0].identity === null && rows[0].ordinal === null && rows[0].sso_user === null;
  assertPoolNameCatalogCompatible(cursor, empty ? [] : rows.map(row => ({ identity: row.identity,
    ordinal: row.ordinal === null ? NaN : Number(row.ordinal), sso_user: row.sso_user })) as PoolNameInventoryRow[]);
}

/** SELECT-only strict v4 gate. Historical data can change after migration; receipt syntax and binding cannot. */
export async function validateEnterpriseMysqlV4(connection:MysqlConnection,component:'proxy',expectedRegistry?:EnterpriseRegistryV3):Promise<EnterpriseMysqlValidationV4>{
  check(component==='proxy','enterprise_mysql_v4_proxy_only');return withEnterpriseMysqlDeadline(connection,async c=>{try{
    const names=await enterpriseMysqlObjects(c);check(['enterprise_profiles','enterprise_registry','enterprise_schema','enterprise_pool_policy','enterprise_upgrade_v4'].every(n=>names.includes(n)),'enterprise_mysql_v4_upgrade_required');
    const registry=await readEnterpriseMysqlRegistryV3(c,expectedRegistry),markers=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_schema'),m=markers[0];
    check(markers.length===1 && Number(m.singleton)===1 && m.component==='proxy' && Number(m.schema_version)===4 && Number(m.contract_version)===2
      && m.capability==='enterprise-multi-pool' && ['direct','pool'].includes(m.layout) && m.registry_sha256===enterpriseMysqlRegistryHashV3(registry)
      && m.migration_id===ENTERPRISE_MYSQL_V4_MIGRATION && m.state==='complete','enterprise_mysql_v4_marker');
    const layout=m.layout as EnterpriseMysqlLayout,expected=getExpectedEnterpriseMysqlV4(layout);await validateEnterpriseMysqlShapeV3(c,expected.schema,expected.triggers);await validateEnterpriseMysqlHistory(c,layout);
    const database=(await mysqlEnterpriseRows(c,'SELECT DATABASE() AS name'))[0]?.name;
    const legacy=registry.profiles.find(p=>p.id===registry.legacyEnterpriseId)!;
    const old=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_upgrade');check(old.length<=1,'enterprise_mysql_checkpoint');if(old.length)validateEnterpriseMysqlCheckpoint(old[0],enterpriseMysqlLegacyProfileV3(legacy),layout,database);
    const v3=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_upgrade_v3');check(v3.length<=1,'enterprise_mysql_checkpoint');if(v3.length)validateEnterpriseMysqlCheckpointV3(v3[0],database,layout,registry);
    const receipts=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_upgrade_v4');check(receipts.length<=1,'enterprise_mysql_v4_checkpoint');
    const migrated=receipts.length?validateEnterpriseMysqlCheckpointV4(receipts[0],database,layout,registry).metadata:undefined;
    const policies=await mysqlEnterpriseRows(c,'SELECT p.*,e.max_accounts FROM enterprise_pool_policy p JOIN enterprise_profiles e ON e.id=p.enterprise_id');
    check(policies.length===registry.profiles.length,'enterprise_mysql_v4_policy_missing');
    for(const row of policies)validateEnterprisePolicyBindingV4(enterprisePolicyRecordFromRowV4(row),registry,migrated);
    for(const [table,d] of Object.entries(expected.schema))for(const [column,target,reference] of d.foreign??[]){
      const rows=await mysqlEnterpriseRows(c,`SELECT COUNT(*) AS n FROM ${table} a LEFT JOIN ${target} b ON a.${column}=b.${reference} WHERE a.${column} IS NOT NULL AND b.${reference} IS NULL`);
      check(Number(rows[0]?.n)===0,'enterprise_mysql_orphan');
    }
    const accounts=await mysqlEnterpriseRows(c,'SELECT account_incarnation FROM proxy_accounts');check(accounts.every(r=>isEnterpriseMysqlUuidV3(r.account_incarnation)) && new Set(accounts.map(r=>r.account_incarnation)).size===accounts.length,'enterprise_mysql_incarnation');
    const attempts=await mysqlEnterpriseRows(c,'SELECT * FROM proxy_authorization_attempts');
    check(attempts.every(r=>isEnterpriseMysqlUuidV3(r.oauth_attempt_id) && isEnterpriseMysqlUuidV3(r.account_incarnation) && Number.isSafeInteger(Number(r.enterprise_revision)) && Number(r.enterprise_revision)>=1
      && typeof r.identity==='string' && r.identity.length>=1 && r.identity.length<=255 && typeof r.expected_gh_login==='string' && r.expected_gh_login.length>=1
      && ['active','succeeded','failed','cancelled'].includes(r.status) && (r.result_fingerprint===null || isEnterpriseMysqlHashV3(r.result_fingerprint))
      && (r.status!=='active' || r.result_fingerprint===null && r.result_gh_login===null && r.result_github_user_id===null)
      && (r.status!=='succeeded' || isEnterpriseMysqlHashV3(r.result_fingerprint) && typeof r.result_gh_login==='string' && r.result_gh_login.length>=1)),'enterprise_mysql_authorization_evidence');
    let maxAccounts:number|undefined;
    if(layout==='pool'){
      const settings=await mysqlEnterpriseRows(c,'SELECT * FROM user_pool_settings'),s=settings[0];check(settings.length===1 && Number(s.id)===1 && s.account_domain===legacy.accountDomain && isEnterpriseMysqlHashV3(s.config_fingerprint),'enterprise_mysql_settings');
      validateEnterprisePoolSettingsV4({version:Number(s.version),idle_target:Number(s.idle_target),lease_seconds:Number(s.lease_seconds),paused:Number(s.paused) as 0|1,next_ordinal:Number(s.next_ordinal),account_domain:String(s.account_domain),owner:s.owner,owner_until:Number(s.owner_until)});
      await validatePoolNameCatalogMysqlV4(c);
      maxAccounts=Number((await mysqlEnterpriseRows(c,'SELECT SUM(max_accounts) AS n FROM enterprise_profiles'))[0]?.n);
    }
    return{registry,legacyEnterpriseId:registry.legacyEnterpriseId,layout,...(maxAccounts===undefined?{}:{maxAccounts})};
  }catch(error){if(error instanceof EnterpriseMysqlError || error instanceof PoolNameCatalogCompatibilityError)throw error;throw new EnterpriseMysqlError('enterprise_mysql_v4_schema');}});
}
export async function insertEnterpriseMysqlPolicyV4(c:MysqlConnection,p:EnterpriseProfileV3,migrated=false,now=Date.now()):Promise<void>{
  await c.query(`INSERT INTO enterprise_pool_policy(enterprise_id,state,policy_version,identity_sha256,validation_kind,validation_evidence_json,validated_at,updated_at) VALUES(?,?,1,?,?,NULL,?,?)`,
    [p.id,migrated?'active':'draft',enterpriseProfileIdentityHashV4(p),migrated?'migration_preserved_v3':null,migrated?now:null,now]);
}
export async function insertEnterpriseMysqlMarkerV4(c:MysqlConnection,registry:EnterpriseRegistryV3,layout:EnterpriseMysqlLayout):Promise<void>{
  await c.query(`INSERT INTO enterprise_schema(singleton,component,schema_version,contract_version,capability,layout,registry_sha256,migration_id,state) VALUES(1,'proxy',4,2,'enterprise-multi-pool',?,?,?,'complete')`,[layout,enterpriseMysqlRegistryHashV3(registry),ENTERPRISE_MYSQL_V4_MIGRATION]);
}
export async function initEnterpriseMysqlV4(connection:MysqlConnection,component:'proxy',input:EnterpriseRegistryV3,options:EnterpriseMysqlInitOptions={}):Promise<void>{
  check(component==='proxy','enterprise_mysql_v4_proxy_only');const registry=parseEnterpriseRegistryV3(input),layout=options.layout??(options.pool?'pool':'direct'),legacy=registry.profiles.find(p=>p.id===registry.legacyEnterpriseId)!;
  check(['direct','pool'].includes(layout) && (layout==='pool'?!!options.pool:options.pool===undefined) && options.maxAccounts===undefined,'enterprise_mysql_v4_settings');
  if(options.pool){const s=options.pool.settings;validateEnterprisePoolSettingsV4(s);check(isEnterpriseMysqlHashV3(options.pool.fingerprint) && s.paused===1 && s.owner===null && s.owner_until===0 && s.next_ordinal===0 && s.account_domain===legacy.accountDomain,'enterprise_mysql_v4_init_must_be_empty_paused');}
  await withEnterpriseMysqlLockV3(connection,async c=>{
    check((await enterpriseMysqlObjects(c)).length===0 && (await mysqlEnterpriseRows(c,'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')).length===0,'enterprise_mysql_init_requires_empty');
    const expected=getExpectedEnterpriseMysqlV4(layout);for(const t of Object.keys(expected.schema))await c.query(mysqlCreateTable(t,expected.schema));
    for(const p of registry.profiles){await insertEnterpriseMysqlProfileV3(c,p);await insertEnterpriseMysqlPolicyV4(c,p);}
    await insertEnterpriseMysqlRegistryV3(c,registry);
    for(const id of ['2026-08-27-proxy-mysql-initial','2026-08-27-proxy-token-binary-collation',...(layout==='pool'?['2026-09-12-user-pool-mysql-v1']:[])])await c.query('INSERT INTO schema_migrations(id,applied_at) VALUES(?,UTC_TIMESTAMP(3))',[id]);
    if(options.pool){const s=options.pool.settings;await c.query('INSERT INTO user_pool_settings(id,version,idle_target,lease_seconds,paused,next_ordinal,account_domain,config_fingerprint,owner,owner_until) VALUES(1,?,?,?,?,?,?,?,?,?)',[s.version,s.idle_target,s.lease_seconds,1,s.next_ordinal,s.account_domain,options.pool.fingerprint,s.owner,s.owner_until]);}
    for(const [n,t]of Object.entries(expected.triggers))await c.query(enterpriseMysqlCreateTriggerV3(n,t));
    await insertEnterpriseMysqlMarkerV4(c,registry,layout);await validateEnterpriseMysqlV4(c,'proxy',registry);
  });
}
/** Offline registration preserves all previous policy/cap rows; only registry revision and marker hash advance. */
export async function registerEnterpriseMysqlV4(connection:MysqlConnection,previous:EnterpriseRegistryV3,next:EnterpriseRegistryV3,options:EnterpriseMysqlRegisterOptionsV3):Promise<EnterpriseMysqlValidationV4>{
  previous=parseEnterpriseRegistryV3(previous);next=parseEnterpriseRegistryV3(next);
  check(options.confirmOffline===true && options.confirmDrained===true,'enterprise_mysql_maintenance_required');
  check(options.expectedRegistryRevision===previous.registryRevision && next.registryRevision===previous.registryRevision+1 && next.legacyEnterpriseId===previous.legacyEnterpriseId
    && next.profiles.length>previous.profiles.length && previous.profiles.every(p=>JSON.stringify(p)===JSON.stringify(next.profiles.find(n=>n.id===p.id))),'enterprise_mysql_registry_add_only');
  return withEnterpriseMysqlLockV3(connection,async c=>{
    const current=await validateEnterpriseMysqlV4(c,'proxy',previous);await assertEnterpriseMysqlDrainedV4(c,current.layout);
    await c.query('START TRANSACTION');let commitSent=false;
    try{
      const rows=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_registry WHERE singleton=1 FOR UPDATE');check(rows.length===1 && Number(rows[0].registry_revision)===previous.registryRevision && rows[0].registry_sha256===enterpriseMysqlRegistryHashV3(previous),'enterprise_mysql_registry_cas');
      for(const p of next.profiles.filter(p=>!previous.profiles.some(old=>old.id===p.id))){await insertEnterpriseMysqlProfileV3(c,p);await insertEnterpriseMysqlPolicyV4(c,p);}
      const [u]=await c.query<ResultSetHeader>('UPDATE enterprise_registry SET registry_revision=?,registry_sha256=? WHERE singleton=1 AND registry_revision=? AND registry_sha256=?',[next.registryRevision,enterpriseMysqlRegistryHashV3(next),previous.registryRevision,enterpriseMysqlRegistryHashV3(previous)]);check(u.affectedRows===1,'enterprise_mysql_registry_cas');
      const [m]=await c.query<ResultSetHeader>('UPDATE enterprise_schema SET registry_sha256=? WHERE singleton=1 AND registry_sha256=?',[enterpriseMysqlRegistryHashV3(next),enterpriseMysqlRegistryHashV3(previous)]);check(m.affectedRows===1,'enterprise_mysql_registry_cas');
      const result=await validateEnterpriseMysqlV4(c,'proxy',next);commitSent=true;await c.query('COMMIT');return result;
    }catch(error){if(commitSent){c.destroy();throw new EnterpriseMysqlError('enterprise_mysql_registration_commit_unknown');}try{await c.query('ROLLBACK');}catch{c.destroy();}throw error;}
  },options.deadlineMs);
}
export async function assertEnterpriseMysqlDrainedV4(c:MysqlConnection,layout:EnterpriseMysqlLayout):Promise<void>{
  for(const table of ['proxy_identity_initializations','proxy_authorization_attempts',...(layout==='pool'?['user_pool_holds','user_pool_catalog_holds']:[])]){
    check(Number((await mysqlEnterpriseRows(c,`SELECT COUNT(*) AS n FROM ${table}${table==='proxy_authorization_attempts'?" WHERE status='active'":''}`))[0]?.n)===0,'enterprise_mysql_not_drained');
  }
  check(Number((await mysqlEnterpriseRows(c,"SELECT COUNT(*) AS n FROM proxy_accounts WHERE copilot_oauth_attempt_id IS NOT NULL OR copilot_oauth_status NOT IN ('valid','expired','missing','failed')"))[0]?.n)===0,'enterprise_mysql_unresolved_oauth');
  if(layout==='pool'){
    const s=(await mysqlEnterpriseRows(c,'SELECT *,CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS server_now FROM user_pool_settings'))[0];check(s && Number(s.paused)===1 && Number(s.owner_until)<=Number(s.server_now),'enterprise_mysql_settings_not_drained');
    const rows=await mysqlEnterpriseRows(c,`SELECT COUNT(*) AS n FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity WHERE p.state='provisioning'
      OR p.last_error REGEXP 'ambiguous|unconfirmed|stalled|sso_name_conflict|oauth_task_invalid'
      OR ((p.task_id IS NOT NULL OR p.oauth_attempt_id IS NOT NULL) AND NOT(p.state IN ('ready','cooling') AND p.stage='ready' AND p.verified_at IS NOT NULL AND p.sso_created_at IS NOT NULL AND p.task_id IS NOT NULL AND p.oauth_attempt_id IS NOT NULL AND a.gh_login IS NOT NULL AND LENGTH(a.gh_login)>0 AND a.copilot_oauth_status='valid'))`);
    check(Number(rows[0]?.n)===0,'enterprise_mysql_unresolved_provisioning');
  }
}
