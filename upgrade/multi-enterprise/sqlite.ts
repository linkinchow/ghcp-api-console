import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import Database from 'better-sqlite3';
import { enterpriseSqliteObjects, validateEnterpriseSqlite, checkSqliteIntegrity, enterpriseProfileHash } from '../../src/packages/shared/src/enterpriseStorage.js';
import {
  createEnterpriseSqliteSchemaV3, seedEnterpriseRegistrySqliteV3, completeEnterpriseSqliteV3,
  initEnterpriseSqliteV3, validateEnterpriseSqliteV3, registerEnterpriseSqliteV3, seedEnterpriseSsoSettingsV3,
} from '../../src/packages/shared/src/enterpriseStorageV3.js';
import type { EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { readStandaloneSqlite, sha256, standalone } from '../default-enterprise/sqlite.js';
import { EnterpriseToolError, insist, legacyProfileV2, enterpriseManifestHashV3, type EnterpriseManifestV3, type SqliteServiceV3 } from './manifest.js';
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
function exists(path:string):boolean { try { lstatSync(path);return true; } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error; } }
const tables=(db:Database.Database)=>enterpriseSqliteObjects(db).filter(row=>row.type==='table').map(row=>row.name);
const columns=(db:Database.Database,table:string)=>(db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all() as {name:string}[]).map(row=>row.name);
const originalTables=(db:Database.Database)=>tables(db).filter(table=>!['enterprise_profiles','enterprise_schema'].includes(table));
function sourceMetadata(db:Database.Database):string {
  return JSON.stringify(['enterprise_profiles','enterprise_schema'].map(table=>[table,columns(db,table),
    db.prepare(`SELECT * FROM ${quote(table)}`).raw(true).safeIntegers(true).all().map(row=>serialize(row).toString('hex')).sort()]));
}
/** Full original typed rows, including sqlite_sequence and the untouched schema2 migration receipt. */
export function originalColumnsHashV3(source:Database.Database,target=source):string {
  return sha256(JSON.stringify(originalTables(source).map(table=>{
    const names=columns(source,table);
    const scoped=names.includes('enterprise_id');
    const legacy=(source.prepare('SELECT id FROM enterprise_profiles WHERE singleton=1').get() as {id:string}).id;
    const statement=target.prepare(`SELECT ${names.map(quote).join(',')} FROM ${quote(table)}${scoped?' WHERE enterprise_id=?':''}`).raw(true).safeIntegers(true);
    const rows=scoped?statement.all(legacy):statement.all();
    return [table,names,rows.map(row=>serialize(row).toString('hex')).sort()];
  })));
}
const rowCounts=(db:Database.Database)=>Object.fromEntries(tables(db).filter(table=>!table.startsWith('enterprise_')).map(table=>[table,
  (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as {n:number}).n]));
function unchanged(path:string,hash:string):void { standalone(path);insist(sha256(readFileSync(path))===hash,'sqlite_source_changed'); }
function noRows(db:Database.Database,sql:string,code:string):void { insist(!db.prepare(sql).get(),code); }
function preflightData(db:Database.Database,service:SqliteServiceV3):void {
  checkSqliteIntegrity(db);
  for(const table of tables(db).filter(table=>table!=='sqlite_sequence')) {
    const fields=db.prepare(`PRAGMA table_info(${quote(table)})`).all() as {name:string;type:string;notnull:number;pk:number}[];
    for(const field of fields) {
      const identifier=quote(field.name),types=field.type==='INTEGER'?"'integer'":field.type==='REAL'?"'real','integer'":"'text'";
      noRows(db,`SELECT 1 FROM ${quote(table)} WHERE (${identifier} IS NOT NULL AND typeof(${identifier}) NOT IN (${types}))`
        +(field.notnull||field.pk?` OR ${identifier} IS NULL`:'')+' LIMIT 1','sqlite_invalid_stored_type');
    }
  }
  if(service.component==='login') {
    noRows(db,"SELECT 1 FROM login_tasks WHERE status NOT IN ('success','failed','cancelled') LIMIT 1",'sqlite_pending_login_tasks');
    noRows(db,'SELECT 1 FROM login_tasks WHERE oauth_attempt_id IS NOT NULL GROUP BY oauth_attempt_id HAVING COUNT(*)>1 LIMIT 1','sqlite_ambiguous_historical_nonce');
  } else if(service.component==='sso') {
    noRows(db,'SELECT 1 FROM sso_users GROUP BY enterprise_id,sso_user COLLATE NOCASE HAVING COUNT(*)>1 LIMIT 1','sqlite_case_ambiguous_identity');
    noRows(db,"SELECT 1 FROM sso_emu_import_plans WHERE status IN ('applying','running','pending') LIMIT 1",'sqlite_pending_sso_import');
    noRows(db,"SELECT 1 FROM sso_emu_import_plan_rows WHERE status IN ('applying','running') LIMIT 1",'sqlite_pending_sso_import');
  } else {
    noRows(db,'SELECT 1 FROM proxy_accounts WHERE copilot_oauth_attempt_id IS NOT NULL LIMIT 1','sqlite_pending_oauth');
    noRows(db,'SELECT 1 FROM proxy_identity_initializations LIMIT 1','sqlite_undrained_initialization_claims');
    if(service.layout==='pool') {
      const settings=db.prepare('SELECT paused,owner_until FROM user_pool_settings WHERE id=1').get() as {paused:number;owner_until:number};
      insist(settings.paused===1 && settings.owner_until<=Date.now(),'sqlite_pool_not_quiescent');
      for(const table of ['user_pool_holds','user_pool_catalog_holds'])noRows(db,`SELECT 1 FROM ${table} LIMIT 1`,'sqlite_undrained_holds');
      noRows(db,`SELECT 1 FROM user_pool_accounts WHERE state='provisioning' OR lower(coalesce(last_error,'')) LIKE '%ambiguous%'
        OR lower(coalesce(last_error,'')) LIKE '%unconfirmed%' OR lower(coalesce(last_error,'')) LIKE '%stalled%'
        OR lower(coalesce(last_error,'')) LIKE '%sso_name_conflict%' OR lower(coalesce(last_error,'')) LIKE '%oauth_task_invalid%' LIMIT 1`,'sqlite_pending_external_operation');
      noRows(db,`SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
        WHERE (p.task_id IS NOT NULL OR p.oauth_attempt_id IS NOT NULL) AND NOT(p.state IN ('ready','cooling') AND p.stage='ready'
        AND p.verified_at IS NOT NULL AND p.sso_created_at IS NOT NULL AND p.task_id IS NOT NULL AND p.oauth_attempt_id IS NOT NULL
        AND a.gh_login IS NOT NULL AND length(a.gh_login)>0 AND a.copilot_oauth_status='valid') LIMIT 1`,'sqlite_pending_login_evidence');
    }
  }
}
function loadSource(service:SqliteServiceV3,registry:EnterpriseRegistryV3):{db:Database.Database;hash:string} {
  insist(service.source && service.backup,'sqlite_source_backup_required');
  const {db,sourceSha256:hash}=readStandaloneSqlite(service.source);
  try {
    insist(hash===service.backup.sha256 && (!service.sourceSha256 || service.sourceSha256===hash),'sqlite_backup_hash_mismatch');
    const state=validateEnterpriseSqlite(db,service.component,legacyProfileV2(registry));
    insist(state.layout===service.layout,'sqlite_layout_mismatch');preflightData(db,service);unchanged(service.source,hash);return {db,hash};
  } catch(error) {db.close();throw error;}
}
function validateMappings(db:Database.Database,service:SqliteServiceV3):void {
  if(service.component==='proxy') {
    const rows=db.prepare('SELECT identity FROM proxy_accounts ORDER BY identity').all() as {identity:string}[];
    const mapping=service.accountIncarnations;
    insist(mapping && rows.length===mapping.length && rows.every(row=>mapping.some(item=>item.identity===row.identity)),'sqlite_incarnation_plan_required');
  }
  if(service.component==='sso') {
    const rows=db.prepare('SELECT enterprise_id,sso_user FROM sso_users ORDER BY enterprise_id,sso_user').all() as {enterprise_id:string;sso_user:string}[];
    const mapping=service.userIncarnations;
    insist(mapping && rows.length===mapping.length && rows.every(row=>mapping.some(item=>item.enterpriseId===row.enterprise_id && item.ssoUser===row.sso_user)),'sqlite_incarnation_plan_required');
  }
}
function mappingHash(service:SqliteServiceV3):string {return sha256(JSON.stringify({accounts:service.accountIncarnations??[],users:service.userIncarnations??[]}));}
export function preflightEnterpriseSqliteV3(service:SqliteServiceV3,registry:EnterpriseRegistryV3):Record<string,unknown> {
  const {db,hash}=loadSource(service,registry);
  try {
    const original=originalColumnsHashV3(db);
    if(service.originalColumnsSha256)insist(service.originalColumnsSha256===original,'sqlite_source_fidelity_checkpoint_mismatch');
    const hasMapping=service.accountIncarnations!==undefined || service.userIncarnations!==undefined;
    if(hasMapping)insist(service.sourceSha256===hash && service.originalColumnsSha256===original,'sqlite_mapping_without_source_checkpoint');
    if(service.component==='proxy' && !service.accountIncarnations)service.accountIncarnations=(db.prepare('SELECT identity FROM proxy_accounts ORDER BY identity').all() as {identity:string}[]).map(row=>({identity:row.identity,accountIncarnation:randomUUID()}));
    if(service.component==='sso' && !service.userIncarnations)service.userIncarnations=(db.prepare('SELECT enterprise_id,sso_user FROM sso_users ORDER BY enterprise_id,sso_user').all() as {enterprise_id:string;sso_user:string}[]).map(row=>({enterpriseId:row.enterprise_id,ssoUser:row.sso_user,userIncarnation:randomUUID()}));
    service.sourceSha256=hash;service.originalColumnsSha256=original;validateMappings(db,service);
    return {component:service.component,driver:'sqlite',layout:service.layout,state:'preflight',counts:rowCounts(db),sourceUnchanged:true};
  }finally{db.close();}
}
function reserve(path:string):number {standalone(path);insist(!exists(path),'sqlite_output_exists');return openSync(path,'wx',0o600);}
function flush(db:Database.Database,fd:number):void {writeFileSync(fd,db.serialize());fsyncSync(fd);}
function copyRows(source:Database.Database,target:Database.Database,service:SqliteServiceV3):void {
  const pending=new Set(originalTables(source).filter(table=>table!=='sqlite_sequence'));
  while(pending.size) {
    const table=[...pending].find(table=>(source.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as {table:string}[]).every(fk=>!pending.has(fk.table)));
    insist(table,'sqlite_unsupported_fk_cycle');pending.delete(table);
    const names=columns(source,table),extra=table==='proxy_accounts'?['account_incarnation']:table==='sso_users'?['user_incarnation']:table==='login_tasks'?['binding_version']:[];
    const output=[...names,...extra];
    const insert=target.prepare(`INSERT INTO ${quote(table)}(${output.map(quote).join(',')}) VALUES(${output.map(()=>'?').join(',')})`);
    const rows=source.prepare(`SELECT ${names.map(quote).join(',')} FROM ${quote(table)}`).raw(true).safeIntegers(true).all() as (string|number|bigint|Buffer|null)[][];
    for(const row of rows) {
      const identity=row[names.indexOf('identity')],ssoUser=row[names.indexOf('sso_user')],enterpriseId=row[names.indexOf('enterprise_id')];
      const added=table==='proxy_accounts'?[service.accountIncarnations!.find(item=>item.identity===identity)!.accountIncarnation]
        :table==='sso_users'?[service.userIncarnations!.find(item=>item.enterpriseId===enterpriseId && item.ssoUser===ssoUser)!.userIncarnation]
        :table==='login_tasks'?[1]:[];
      insert.run(...row,...added);
    }
  }
  if(tables(source).includes('sqlite_sequence')) {
    target.exec('DELETE FROM sqlite_sequence');
    const rows=source.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers(true).all() as {name:string;seq:bigint}[];
    for(const row of rows)target.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
  }
  if(service.component==='login')target.exec(`INSERT INTO login_legacy_nonce_tombstones(oauth_attempt_id,task_id,enterprise_id)
    SELECT oauth_attempt_id,id,enterprise_id FROM login_tasks WHERE oauth_attempt_id IS NOT NULL`);
}
export function applyEnterpriseSqliteV3(service:SqliteServiceV3,manifest:EnterpriseManifestV3):Record<string,unknown> {
  const {db:source,hash}=loadSource(service,manifest.registry);
  let target:Database.Database|undefined,fd:number|undefined;
  try {
    insist(service.sourceSha256===hash && service.originalColumnsSha256===originalColumnsHashV3(source),'sqlite_bound_plan_required');validateMappings(source,service);
    if(exists(service.target))return {...verifyEnterpriseSqliteV3(service,manifest),state:'already-complete'};
    fd=reserve(service.target);target=new Database(':memory:');target.pragma('foreign_keys=ON');const output=target;
    target.transaction(()=>{
      createEnterpriseSqliteSchemaV3(output,service.layout);seedEnterpriseRegistrySqliteV3(output,manifest.registry);
      // Stored cap is authority, not the registry seed value.
      const cap=source.prepare('SELECT max_accounts FROM enterprise_profiles WHERE singleton=1').get() as {max_accounts:number|null};
      if(cap.max_accounts!==null)output.prepare('UPDATE enterprise_profiles SET max_accounts=? WHERE id=?').run(cap.max_accounts,manifest.registry.legacyEnterpriseId);
      copyRows(source,output,service);
      if(service.component==='sso')for(const profile of manifest.registry.profiles.filter(profile=>profile.id!==manifest.registry.legacyEnterpriseId))seedEnterpriseSsoSettingsV3(output,profile);
      insist(originalColumnsHashV3(source,output)===service.originalColumnsSha256,'sqlite_original_columns_changed');
      output.prepare(`INSERT INTO enterprise_migration_receipt_v3(singleton,manifest_sha256,source_sha256,backup_reference,source_registry_sha256,
        original_columns_sha256,source_metadata_json,incarnation_mapping_sha256) VALUES(1,?,?,?,?,?,?,?)`)
        .run(enterpriseManifestHashV3(manifest),hash,service.backup!.reference,enterpriseProfileHash(legacyProfileV2(manifest.registry)),
          service.originalColumnsSha256,sourceMetadata(source),mappingHash(service));
      completeEnterpriseSqliteV3(output,service.component,manifest.registry,service.layout);validateEnterpriseSqliteV3(output,service.component,manifest.registry);
    }).immediate();
    unchanged(service.source!,hash);flush(target,fd);closeSync(fd);fd=undefined;unchanged(service.source!,hash);
    return {...verifyEnterpriseSqliteV3(service,manifest),state:'complete'};
  }catch(error){throw error instanceof EnterpriseToolError?error:new EnterpriseToolError('sqlite_apply_failed_output_unapproved');}
  finally{if(fd!==undefined)closeSync(fd);target?.close();source.close();}
}
function registrationRowsHash(source: Database.Database, target = source): string {
  const excluded = new Set(['enterprise_profiles', 'enterprise_registry', 'enterprise_schema']);
  const ids = (source.prepare('SELECT id FROM enterprise_profiles ORDER BY id').all() as { id: string }[]).map(row => row.id);
  return sha256(JSON.stringify(tables(source).filter(table => !excluded.has(table)).map(table => {
    const names = columns(source, table), scoped = names.includes('enterprise_id');
    const statement = target.prepare(`SELECT ${names.map(quote).join(',')} FROM ${quote(table)}${scoped ? ` WHERE enterprise_id IN (${ids.map(() => '?').join(',')})` : ''}`).raw(true).safeIntegers(true);
    const rows = scoped ? statement.all(...ids) : statement.all();
    return [table, names, rows.map(row => serialize(row).toString('hex')).sort()];
  })));
}

export function verifyEnterpriseSqliteV3(service:SqliteServiceV3,manifest:EnterpriseManifestV3):Record<string,unknown> {
  const {db:target}=readStandaloneSqlite(service.target);let source:Database.Database|undefined;
  try {
    const state=validateEnterpriseSqliteV3(target,service.component,manifest.registry);insist(state.layout===service.layout,'sqlite_layout_mismatch');
    if(service.source && !manifest.previousRegistry) {
      const loaded=loadSource(service,manifest.registry);source=loaded.db;validateMappings(source,service);
      const hash=originalColumnsHashV3(source);insist(hash===service.originalColumnsSha256 && hash===originalColumnsHashV3(source,target),'sqlite_original_columns_changed');
      const receipts=target.prepare('SELECT * FROM enterprise_migration_receipt_v3').all() as Record<string,unknown>[];
      const row=receipts[0];insist(receipts.length===1 && row.manifest_sha256===enterpriseManifestHashV3(manifest)
        && row.source_sha256===loaded.hash && row.backup_reference===service.backup!.reference && row.original_columns_sha256===hash
        && row.source_metadata_json===sourceMetadata(source) && row.incarnation_mapping_sha256===mappingHash(service)
        && row.source_registry_sha256===enterpriseProfileHash(legacyProfileV2(manifest.registry)),'sqlite_v3_receipt_mismatch');
      if(service.component==='proxy') for(const item of service.accountIncarnations!)insist((target.prepare('SELECT account_incarnation FROM proxy_accounts WHERE identity=?').get(item.identity) as {account_incarnation:string})?.account_incarnation===item.accountIncarnation,'sqlite_incarnation_changed');
      if(service.component==='sso')for(const item of service.userIncarnations!)insist((target.prepare('SELECT user_incarnation FROM sso_users WHERE enterprise_id=? AND sso_user=? COLLATE BINARY').get(item.enterpriseId,item.ssoUser) as {user_incarnation:string})?.user_incarnation===item.userIncarnation,'sqlite_incarnation_changed');
      unchanged(service.source,loaded.hash);
    } else if (service.source && manifest.previousRegistry) {
      insist(service.backup, 'sqlite_register_source_and_previous_required');
      const loaded = readStandaloneSqlite(service.source); source = loaded.db;
      insist(loaded.sourceSha256 === service.backup.sha256, 'sqlite_backup_hash_mismatch');
      validateEnterpriseSqliteV3(source, service.component, manifest.previousRegistry);
      insist(registrationRowsHash(source) === registrationRowsHash(source, target), 'sqlite_registration_business_rows_changed');
      const rows = source.prepare('SELECT id,slug,revision,profile_json,max_accounts FROM enterprise_profiles ORDER BY id').all() as {id:string;slug:string;revision:number;profile_json:string;max_accounts:number}[];
      for (const row of rows) {
        const current = target.prepare('SELECT id,slug,revision,profile_json,max_accounts FROM enterprise_profiles WHERE id=?').get(row.id);
        insist(JSON.stringify(row) === JSON.stringify(current), 'sqlite_registration_existing_profile_changed');
      }
      unchanged(service.source, loaded.sourceSha256);
    }
    return {component:service.component,driver:'sqlite',layout:state.layout,state:'verified',counts:rowCounts(target),...(source?{sourceUnchanged:true,originalColumnsPreserved:true}:{})};
  }finally{source?.close();target.close();}
}
export function initEnterpriseSqliteFileV3(service:SqliteServiceV3,manifest:EnterpriseManifestV3):Record<string,unknown> {
  insist(!service.source && !service.backup,'sqlite_init_cannot_migrate');const fd=reserve(service.target),db=new Database(':memory:');
  try {initEnterpriseSqliteV3(db,service.component,manifest.registry,{...service.init,layout:service.layout});flush(db,fd);return {...verifyEnterpriseSqliteV3(service,manifest),state:'initialized'};}
  finally{closeSync(fd);db.close();}
}
export function registerEnterpriseSqliteFileV3(service:SqliteServiceV3,manifest:EnterpriseManifestV3):Record<string,unknown> {
  insist(manifest.previousRegistry && service.source && service.backup,'sqlite_register_source_and_previous_required');
  const {db,sourceSha256}=readStandaloneSqlite(service.source);let fd:number|undefined;
  try {
    insist(sourceSha256===service.backup.sha256,'sqlite_backup_hash_mismatch');validateEnterpriseSqliteV3(db,service.component,manifest.previousRegistry);
    fd=reserve(service.target);registerEnterpriseSqliteV3(db,service.component,manifest.previousRegistry,manifest.registry);
    unchanged(service.source,sourceSha256);flush(db,fd);unchanged(service.source,sourceSha256);
    return {component:service.component,driver:'sqlite',layout:service.layout,state:'registered',counts:rowCounts(db),sourceUnchanged:true};
  }finally{if(fd!==undefined)closeSync(fd);db.close();}
}
export function inspectEnterpriseSqliteV3(service:SqliteServiceV3,registry:EnterpriseRegistryV3):Record<string,unknown> {
  if(!exists(service.target))return {component:service.component,driver:'sqlite',state:'absent'};
  let db:Database.Database|undefined;
  try{db=readStandaloneSqlite(service.target).db;const state=validateEnterpriseSqliteV3(db,service.component,registry);return {component:service.component,driver:'sqlite',state:'complete',layout:state.layout};}
  catch{return {component:service.component,driver:'sqlite',state:'unapproved'};}finally{db?.close();}
}
