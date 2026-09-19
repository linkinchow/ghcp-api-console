import { createHash } from 'node:crypto';
import { parseEnterpriseRegistryV3,type EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { mysqlCreateTable,validateMysqlTables,type TableSchema,type MysqlConnection } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { EnterpriseMysqlError,mysqlEnterpriseRows,enterpriseMysqlObjects,requireEnterpriseMysql as check,withEnterpriseMysqlDeadline,validateEnterpriseMysqlHistory,type EnterpriseMysqlLayout } from '../../src/packages/shared/src/enterpriseMysql.js';
import { validateEnterpriseMysqlV3,validateEnterpriseMysqlShapeV3,enterpriseMysqlRegistryHashV3,withEnterpriseMysqlLockV3,isEnterpriseMysqlHashV3 } from '../../src/packages/shared/src/enterpriseMysqlV3.js';
import { getExpectedEnterpriseMysqlV3,enterpriseMysqlCreateTriggerV3,type EnterpriseMysqlTriggerV3 } from '../../src/packages/shared/src/enterpriseMysqlSchemaV3.js';
import { getExpectedEnterpriseMysqlV4,ENTERPRISE_MYSQL_V4_TABLES,ENTERPRISE_MYSQL_V4_TRIGGERS,ENTERPRISE_MYSQL_V4_FINAL_STEP,ENTERPRISE_MYSQL_V4_MIGRATION } from '../../src/packages/shared/src/enterpriseMysqlSchemaV4.js';
import { validateEnterpriseMysqlV4,validatePoolNameCatalogMysqlV4,insertEnterpriseMysqlPolicyV4,insertEnterpriseMysqlMarkerV4,assertEnterpriseMysqlDrainedV4,parseEnterpriseMysqlEvidenceV4,type EnterpriseMysqlEvidenceV4 } from '../../src/packages/shared/src/enterpriseMysqlV4.js';
import { enterpriseProfileIdentityHashV4 } from '../../src/packages/shared/src/enterpriseRuntimeV4.js';
export { initEnterpriseMysqlV4,registerEnterpriseMysqlV4 } from '../../src/packages/shared/src/enterpriseMysqlV4.js';
export interface EnterpriseMysqlPreflightV4 {database:string;layout:EnterpriseMysqlLayout;maxAccounts?:number;counts:Record<string,number>;sourceSha256:string}
export interface EnterpriseMysqlApplyOptionsV4 {
  migrationId:string;confirmOffline:boolean;confirmBackup:boolean;confirmDrained:boolean;expectedSourceSha256:string;manifestSha256:string;
  backupReference:string;backupSha256:string;expectedDatabase:string;resume?:boolean;deadlineMs?:number;layout?:EnterpriseMysqlLayout;
}
export interface EnterpriseMysqlMigrationResultV4 extends EnterpriseMysqlPreflightV4 {migrationId:string;resumed:boolean}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const MAX_ROWS=100000;
async function databaseName(c:MysqlConnection):Promise<string>{const r=await mysqlEnterpriseRows(c,'SELECT DATABASE() AS name, @@autocommit AS autocommit, @@foreign_key_checks AS foreign_keys');check(r.length===1 && typeof r[0].name==='string' && /^[a-zA-Z0-9_]{1,64}$/.test(r[0].name) && Number(r[0].autocommit)===1 && Number(r[0].foreign_keys)===1,'enterprise_mysql_session_not_dedicated');return r[0].name;}
function sourceTables(layout:EnterpriseMysqlLayout){const s=getExpectedEnterpriseMysqlV3(layout).schema;delete s.enterprise_schema;return s;}
export function enterpriseMysqlStageSchemaV4(layout:EnterpriseMysqlLayout,step:number):Record<string,TableSchema>{
  const schema=getExpectedEnterpriseMysqlV3(layout).schema,final=getExpectedEnterpriseMysqlV4(layout).schema;
  schema.enterprise_upgrade_v4=structuredClone(ENTERPRISE_MYSQL_V4_TABLES.enterprise_upgrade_v4);
  if(step>=1)schema.enterprise_pool_policy=structuredClone(final.enterprise_pool_policy);
  if(step>=3)schema.proxy_request_stats=structuredClone(final.proxy_request_stats);
  if(step>=5 && layout==='pool')schema.user_pool_events=structuredClone(final.user_pool_events);
  if(step===9)delete schema.enterprise_schema;else if(step>=10)schema.enterprise_schema=structuredClone(final.enterprise_schema);
  return schema;
}
export function enterpriseMysqlStageTriggersV4(layout:EnterpriseMysqlLayout,step:number):Record<string,EnterpriseMysqlTriggerV3>{
  const triggers=getExpectedEnterpriseMysqlV3(layout).triggers;
  if(step>=7)delete triggers.enterprise_pool_legacy_insert;if(step>=8)delete triggers.enterprise_pool_legacy_update;
  for(const [n,name]of [[12,'enterprise_policy_immutable'],[13,'enterprise_policy_no_delete'],[14,'enterprise_stats_scope_immutable'],[15,'enterprise_events_scope_immutable']] as const)
    if(step>=n && (name!=='enterprise_events_scope_immutable'||layout==='pool'))triggers[name]=structuredClone(ENTERPRISE_MYSQL_V4_TRIGGERS[name]);
  return triggers;
}
async function snapshot(c:MysqlConnection,layout:EnterpriseMysqlLayout,registry:EnterpriseRegistryV3,original?:EnterpriseMysqlEvidenceV4):Promise<EnterpriseMysqlEvidenceV4>{
  const e:EnterpriseMysqlEvidenceV4={version:1,metadata:original?.metadata??{version:1,sourceSchemaVersion:3,layout,registryRevision:registry.registryRevision,registrySha256:enterpriseMysqlRegistryHashV3(registry),legacyEnterpriseId:registry.legacyEnterpriseId,profiles:[]},counts:{},columns:{},marker:original?.marker??{},eventSequence:null};
  for(const [table,d]of Object.entries(sourceTables(layout))){const columns=Object.keys(d.columns),r=await mysqlEnterpriseRows(c,`SELECT ${columns.map(n=>`HEX(CAST(\`${n}\` AS BINARY)) AS \`${n}\``).join(',')} FROM \`${table}\` ORDER BY BINARY \`${d.primary}\` LIMIT ${MAX_ROWS+1}`);check(r.length<=MAX_ROWS,'enterprise_mysql_offline_row_limit');e.counts[table]=r.length;e.columns[table]=Object.fromEntries(columns.map(n=>[n,hash(JSON.stringify(r.map(row=>row[n])))]));}
  if(!original){const profiles=await mysqlEnterpriseRows(c,'SELECT id,max_accounts FROM enterprise_profiles ORDER BY BINARY id');e.metadata.profiles=registry.profiles.map(p=>({enterpriseId:p.id,identitySha256:enterpriseProfileIdentityHashV4(p),maxAccounts:Number(profiles.find(r=>r.id===p.id)?.max_accounts)}));
    const markers=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_schema');check(markers.length===1,'enterprise_mysql_source_metadata');e.marker=markers[0];}
  if(layout==='pool'){const r=await mysqlEnterpriseRows(c,"SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_pool_events'");e.eventSequence=r[0]?.AUTO_INCREMENT===null?null:String(r[0]?.AUTO_INCREMENT);}
  return e;
}
async function preflight(c:MysqlConnection,r:EnterpriseRegistryV3,layout?:EnterpriseMysqlLayout){const database=await databaseName(c),state=await validateEnterpriseMysqlV3(c,'proxy',r);check(!layout || state.layout===layout,'enterprise_mysql_layout');await assertEnterpriseMysqlDrainedV4(c,state.layout);if(state.layout==='pool')await validatePoolNameCatalogMysqlV4(c);const evidence=await snapshot(c,state.layout,r);return{database,layout:state.layout,counts:evidence.counts,...(state.layout==='pool'?{maxAccounts:evidence.metadata.profiles.reduce((n,p)=>n+p.maxAccounts,0)}:{}),sourceSha256:hash(JSON.stringify(evidence)),evidence};}
export async function preflightEnterpriseMysqlV4(c:MysqlConnection,input:EnterpriseRegistryV3,layout?:EnterpriseMysqlLayout):Promise<EnterpriseMysqlPreflightV4>{const registry=parseEnterpriseRegistryV3(input);return withEnterpriseMysqlDeadline(c,async c=>{const{evidence:_,...result}=await preflight(c,registry,layout);return result;});}
export function reliableHistoryJoinMysqlV4(table:'proxy_request_stats'|'user_pool_events'):string {
  return table==='proxy_request_stats'
    ? 'BINARY h.identity=BINARY a.identity AND h.requested_at IS NOT NULL AND a.created_at IS NOT NULL AND h.requested_at>=a.created_at'
    : "BINARY h.identity=BINARY a.identity AND a.created_at IS NOT NULL AND h.at>=TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',a.created_at)/1000";
}
async function validateStage(c:MysqlConnection,r:EnterpriseRegistryV3,layout:EnterpriseMysqlLayout,step:number,e:EnterpriseMysqlEvidenceV4,now:number):Promise<void>{
  await validateEnterpriseMysqlShapeV3(c,enterpriseMysqlStageSchemaV4(layout,step),enterpriseMysqlStageTriggersV4(layout,step));await validateEnterpriseMysqlHistory(c,layout);
  check(same(await snapshot(c,layout,r,e),e),'enterprise_mysql_source_changed');await assertEnterpriseMysqlDrainedV4(c,layout);
  if(step>=1){const rows=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_pool_policy ORDER BY BINARY enterprise_id');
    check(step===1?rows.length===0:rows.length===r.profiles.length && r.profiles.every(p=>{const v=rows.find(x=>x.enterprise_id===p.id),legacy=p.id===r.legacyEnterpriseId;
      return v && v.state===(legacy?'active':'draft') && Number(v.policy_version)===1 && v.identity_sha256===enterpriseProfileIdentityHashV4(p)
        && v.validation_kind===(legacy?'migration_preserved_v3':null) && v.validation_evidence_json===null && (legacy?Number(v.validated_at)===now:v.validated_at===null) && Number(v.updated_at)===now;}),'enterprise_mysql_v4_policy_seed');}
  for(const [table,added,filled]of [['proxy_request_stats',3,4],['user_pool_events',5,6]] as const){if(table==='user_pool_events' && layout!=='pool'||step<added)continue;
    const sql=step<filled?`SELECT COUNT(*) AS n FROM ${table} WHERE enterprise_id IS NOT NULL`:`SELECT COUNT(*) AS n FROM ${table} h LEFT JOIN proxy_accounts a ON ${reliableHistoryJoinMysqlV4(table)} WHERE NOT (CAST(h.enterprise_id AS BINARY) <=> CAST(a.enterprise_id AS BINARY))`;
    check(Number((await mysqlEnterpriseRows(c,sql))[0]?.n)===0,'enterprise_mysql_v4_backfill_mismatch');}
  if(step!==9){const rows=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_schema');check(step<9?same(rows,[e.marker]):step===10?rows.length===0:
    rows.length===1 && Number(rows[0].singleton)===1 && rows[0].component==='proxy' && Number(rows[0].schema_version)===4 && Number(rows[0].contract_version)===2 && rows[0].capability==='enterprise-multi-pool' && rows[0].layout===layout && rows[0].registry_sha256===enterpriseMysqlRegistryHashV3(r) && rows[0].migration_id===ENTERPRISE_MYSQL_V4_MIGRATION && rows[0].state==='complete','enterprise_mysql_v4_marker');}
}
async function transaction(c:MysqlConnection,fn:()=>Promise<void>){await c.query('START TRANSACTION');let commit=false;try{await fn();commit=true;await c.query('COMMIT');}catch(e){if(commit){c.destroy();throw new EnterpriseMysqlError('enterprise_mysql_commit_outcome_unknown');}try{await c.query('ROLLBACK');}catch{c.destroy();}throw e;}}
async function addScope(c:MysqlConnection,table:'proxy_request_stats'|'user_pool_events'){
  await c.query(`ALTER TABLE ${table} ADD COLUMN enterprise_id VARCHAR(36) COLLATE ascii_bin NULL, ADD INDEX idx_${table}_enterprise (enterprise_id,${table==='proxy_request_stats'?'requested_at':'at'} DESC,id DESC), ADD CONSTRAINT fk_${table}_enterprise_id FOREIGN KEY (enterprise_id) REFERENCES enterprise_profiles(id) ON DELETE RESTRICT`);
}
async function runStep(c:MysqlConnection,step:number,r:EnterpriseRegistryV3,layout:EnterpriseMysqlLayout,now:number){
  if(step===1)await c.query(mysqlCreateTable('enterprise_pool_policy',ENTERPRISE_MYSQL_V4_TABLES));
  else if(step===2)await transaction(c,async()=>{for(const p of r.profiles)await insertEnterpriseMysqlPolicyV4(c,p,p.id===r.legacyEnterpriseId,now);});
  else if(step===3)await addScope(c,'proxy_request_stats');
  else if(step===4)await c.query(`UPDATE proxy_request_stats h JOIN proxy_accounts a ON ${reliableHistoryJoinMysqlV4('proxy_request_stats')} SET h.enterprise_id=a.enterprise_id`);
  else if(step===5 && layout==='pool')await addScope(c,'user_pool_events');
  else if(step===6 && layout==='pool')await c.query(`UPDATE user_pool_events h JOIN proxy_accounts a ON ${reliableHistoryJoinMysqlV4('user_pool_events')} SET h.enterprise_id=a.enterprise_id`);
  else if(step===7 && layout==='pool')await c.query('DROP TRIGGER enterprise_pool_legacy_insert');
  else if(step===8 && layout==='pool')await c.query('DROP TRIGGER enterprise_pool_legacy_update');
  else if(step===9)await c.query('DROP TABLE enterprise_schema');
  else if(step===10)await c.query(mysqlCreateTable('enterprise_schema',getExpectedEnterpriseMysqlV4(layout).schema));
  else if(step===11)await insertEnterpriseMysqlMarkerV4(c,r,layout);
  else if(step>=12 && (step!==15 || layout==='pool')){const name=['enterprise_policy_immutable','enterprise_policy_no_delete','enterprise_stats_scope_immutable','enterprise_events_scope_immutable'][step-12];await c.query(enterpriseMysqlCreateTriggerV3(name,ENTERPRISE_MYSQL_V4_TRIGGERS[name]));}
}
type Binding=Omit<EnterpriseMysqlApplyOptionsV4,'confirmOffline'|'confirmBackup'|'confirmDrained'|'resume'>;
function validateOptions(o:Binding){check(typeof o.migrationId==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(o.migrationId) && typeof o.expectedDatabase==='string' && /^[a-zA-Z0-9_]{1,64}$/.test(o.expectedDatabase)
  && [o.expectedSourceSha256,o.manifestSha256,o.backupSha256].every(isEnterpriseMysqlHashV3) && typeof o.backupReference==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(o.backupReference)
  && (o.layout===undefined||['direct','pool'].includes(o.layout)),'enterprise_mysql_invalid_plan');}
async function checkpoint(c:MysqlConnection,r:EnterpriseRegistryV3,o:Binding){
  await validateMysqlTables(c,{enterprise_upgrade_v4:ENTERPRISE_MYSQL_V4_TABLES.enterprise_upgrade_v4});const rows=await mysqlEnterpriseRows(c,'SELECT * FROM enterprise_upgrade_v4');check(rows.length===1,'enterprise_mysql_checkpoint_missing_manual_inspection_required');const v=rows[0];
  check(Number(v.singleton)===1 && v.migration_id===o.migrationId && v.database_name===o.expectedDatabase && v.manifest_sha256===o.manifestSha256 && v.backup_reference===o.backupReference && v.backup_sha256===o.backupSha256
    && v.registry_sha256===enterpriseMysqlRegistryHashV3(r) && v.source_sha256===o.expectedSourceSha256 && ['direct','pool'].includes(v.layout) && (!o.layout||o.layout===v.layout)
    && ['applying','complete'].includes(v.state) && ['before','after','unknown'].includes(v.checkpoint_state) && Number.isInteger(Number(v.step)) && Number(v.step)>=0 && Number(v.step)<=ENTERPRISE_MYSQL_V4_FINAL_STEP
    && Number.isSafeInteger(Number(v.migrated_at)) && Number(v.migrated_at)>=0,'enterprise_mysql_checkpoint_binding');
  const evidence=parseEnterpriseMysqlEvidenceV4(v.evidence_json,o.expectedSourceSha256,v.layout);check(evidence.metadata.registrySha256===v.registry_sha256 && evidence.metadata.registryRevision===r.registryRevision
    && evidence.metadata.legacyEnterpriseId===r.legacyEnterpriseId && evidence.metadata.profiles.length===r.profiles.length && evidence.metadata.profiles.every(p=>r.profiles.some(x=>x.id===p.enterpriseId && enterpriseProfileIdentityHashV4(x)===p.identitySha256)),'enterprise_mysql_checkpoint_binding');
  return{row:v,evidence,layout:v.layout as EnterpriseMysqlLayout,now:Number(v.migrated_at)};
}
const result=(database:string,layout:EnterpriseMysqlLayout,e:EnterpriseMysqlEvidenceV4,o:Binding,resumed:boolean):EnterpriseMysqlMigrationResultV4=>({database,layout,counts:e.counts,sourceSha256:o.expectedSourceSha256,migrationId:o.migrationId,resumed,...(layout==='pool'?{maxAccounts:e.metadata.profiles.reduce((n,p)=>n+p.maxAccounts,0)}:{})});
/** Explicit same-lock offline 3→4. Statement unknown is never guessed/replayed; resume accepts only exact before/after stages. */
export async function applyEnterpriseMysqlV4(connection:MysqlConnection,input:EnterpriseRegistryV3,o:EnterpriseMysqlApplyOptionsV4):Promise<EnterpriseMysqlMigrationResultV4>{
  const r=parseEnterpriseRegistryV3(input);validateOptions(o);check(o.confirmOffline===true && o.confirmBackup===true && o.confirmDrained===true,'enterprise_mysql_maintenance_required');
  return withEnterpriseMysqlLockV3(connection,async c=>{try{
    const database=await databaseName(c);check(database===o.expectedDatabase,'enterprise_mysql_database_mismatch');const names=await enterpriseMysqlObjects(c);
    let e:EnterpriseMysqlEvidenceV4,layout:EnterpriseMysqlLayout,step=0,now=Date.now(),resumed=false;
    if(!names.includes('enterprise_upgrade_v4')){
      check(!o.resume,'enterprise_mysql_resume_without_checkpoint');const source=await preflight(c,r,o.layout);check(source.sourceSha256===o.expectedSourceSha256,'enterprise_mysql_source_changed');e=source.evidence;layout=source.layout;
      await c.query(mysqlCreateTable('enterprise_upgrade_v4',ENTERPRISE_MYSQL_V4_TABLES));
      await c.query(`INSERT INTO enterprise_upgrade_v4(singleton,migration_id,database_name,manifest_sha256,backup_reference,backup_sha256,registry_sha256,source_sha256,layout,state,step,checkpoint_state,evidence_json,migrated_at) VALUES(1,?,?,?,?,?,?,?,?,'applying',0,'after',?,?)`,[o.migrationId,database,o.manifestSha256,o.backupReference,o.backupSha256,enterpriseMysqlRegistryHashV3(r),o.expectedSourceSha256,layout,JSON.stringify(e),now]);
    }else{
      check(o.resume===true,'enterprise_mysql_resume_required');resumed=true;const saved=await checkpoint(c,r,o);e=saved.evidence;layout=saved.layout;now=saved.now;step=Number(saved.row.step);
      check(saved.row.checkpoint_state!=='unknown','enterprise_mysql_unknown_manual_inspection_required');
      if(saved.row.state==='complete'){check(step===ENTERPRISE_MYSQL_V4_FINAL_STEP && saved.row.checkpoint_state==='after','enterprise_mysql_checkpoint_binding');await validateEnterpriseMysqlV4(c,'proxy',r);await validateStage(c,r,layout,step,e,now);return result(database,layout,e,o,resumed);}
      if(saved.row.checkpoint_state==='before'){check(step>=1,'enterprise_mysql_checkpoint_binding');await validateStage(c,r,layout,step-1,e,now);step--;}else await validateStage(c,r,layout,step,e,now);
    }
    await validateStage(c,r,layout,step,e,now);
    for(let next=step+1;next<=ENTERPRISE_MYSQL_V4_FINAL_STEP;next++){
      await c.query("UPDATE enterprise_upgrade_v4 SET step=?,checkpoint_state='before' WHERE singleton=1",[next]);await c.query("UPDATE enterprise_upgrade_v4 SET checkpoint_state='unknown' WHERE singleton=1");
      await runStep(c,next,r,layout,now);await validateStage(c,r,layout,next,e,now);
      await c.query("UPDATE enterprise_upgrade_v4 SET checkpoint_state='after',state=? WHERE singleton=1",[next===ENTERPRISE_MYSQL_V4_FINAL_STEP?'complete':'applying']);
    }
    await validateEnterpriseMysqlV4(c,'proxy',r);return result(database,layout,e,o,resumed);
  }catch(e){if(e instanceof EnterpriseMysqlError)throw e;throw new EnterpriseMysqlError('enterprise_mysql_v4_failed_inspect_checkpoint');}},o.deadlineMs);
}
export async function verifyEnterpriseMysqlMigrationV4(connection:MysqlConnection,input:EnterpriseRegistryV3,o:Binding):Promise<EnterpriseMysqlMigrationResultV4>{
  const r=parseEnterpriseRegistryV3(input);validateOptions(o);return withEnterpriseMysqlDeadline(connection,async c=>{const database=await databaseName(c);check(database===o.expectedDatabase,'enterprise_mysql_database_mismatch');const s=await checkpoint(c,r,o);
    check(s.row.state==='complete' && Number(s.row.step)===ENTERPRISE_MYSQL_V4_FINAL_STEP && s.row.checkpoint_state==='after','enterprise_mysql_incomplete');await validateEnterpriseMysqlV4(c,'proxy',r);await validateStage(c,r,s.layout,ENTERPRISE_MYSQL_V4_FINAL_STEP,s.evidence,s.now);return result(database,s.layout,s.evidence,o,false);},o.deadlineMs);
}
export async function inspectEnterpriseMysqlV4(connection:MysqlConnection,r?:EnterpriseRegistryV3):Promise<{state:'empty'|'v3'|'v4'|'partial';layout?:EnterpriseMysqlLayout;checkpointState?:string;step?:number}>{
  return withEnterpriseMysqlDeadline(connection,async c=>{const names=await enterpriseMysqlObjects(c);if(!names.length)return{state:'empty'};
    try{const v=names.includes('enterprise_upgrade_v4')?await validateEnterpriseMysqlV4(c,'proxy',r):await validateEnterpriseMysqlV3(c,'proxy',r);return{state:names.includes('enterprise_upgrade_v4')?'v4':'v3',layout:v.layout};}
    catch(e){if(e instanceof EnterpriseMysqlError && ['enterprise_mysql_deadline','enterprise_mysql_statement_outcome_unknown'].includes(e.code))throw e;
      if(names.includes('enterprise_upgrade_v4')){const rows=await mysqlEnterpriseRows(c,'SELECT step,checkpoint_state FROM enterprise_upgrade_v4');if(rows.length===1 && Number.isInteger(Number(rows[0].step)) && Number(rows[0].step)>=0 && Number(rows[0].step)<=ENTERPRISE_MYSQL_V4_FINAL_STEP && ['before','after','unknown'].includes(rows[0].checkpoint_state))return{state:'partial',step:Number(rows[0].step),checkpointState:rows[0].checkpoint_state};}return{state:'partial'};}
  });
}
