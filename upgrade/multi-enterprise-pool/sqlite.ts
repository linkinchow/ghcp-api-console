import { closeSync,fsyncSync,lstatSync,openSync,readFileSync,writeFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import Database from 'better-sqlite3';
import { enterpriseSqliteObjects,checkSqliteIntegrity } from '../../src/packages/shared/src/enterpriseStorage.js';
import { validateEnterpriseSqliteV3,initEnterpriseSqliteV3,registerEnterpriseSqliteV3,assertEnterpriseSqliteDrainedV3,enterpriseRegistryHashV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
import { createEnterpriseSqliteSchemaV4,completeEnterpriseSqliteV4,seedEnterprisePoliciesSqliteV4,initEnterpriseSqliteV4,
  validateEnterpriseSqliteV4,registerEnterpriseSqliteV4,validatePoolNameCatalogSqliteV4,type EnterpriseLayoutV4,type EnterpriseMigrationEvidenceV4 } from '../../src/packages/shared/src/enterpriseStorageV4.js';
import { enterpriseProfileIdentityHashV4 } from '../../src/packages/shared/src/enterpriseRuntimeV4.js';
import type { EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { readStandaloneSqlite,sha256,standalone } from '../default-enterprise/sqlite.js';
import { insist,enterpriseManifestHashV4,EnterpriseToolError,type SqliteServiceV4,type EnterpriseManifestV4 } from './manifest.js';
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const tables=(db:Database.Database)=>enterpriseSqliteObjects(db).filter(r=>r.type==='table').map(r=>r.name);
const columns=(db:Database.Database,t:string)=>(db.prepare(`PRAGMA table_xinfo(${q(t)})`).all() as {name:string}[]).map(r=>r.name);
function exists(path:string){try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
function unchanged(path:string,hash:string){standalone(path);insist(sha256(readFileSync(path))===hash,'sqlite_source_changed');}
function reserve(path:string){standalone(path);insist(!exists(path),'sqlite_output_exists');return openSync(path,'wx',0o600);}
function flush(db:Database.Database,fd:number){writeFileSync(fd,db.serialize());fsyncSync(fd);}
const rows=(db:Database.Database,t:string,names:string[])=>db.prepare(`SELECT ${names.map(q).join(',')} FROM ${q(t)}`).raw(true).safeIntegers(true).all().map(r=>serialize(r).toString('hex')).sort();
/** Every old column and storage class, including receipts, caps, incarnation, generations and sqlite_sequence. */
export function originalColumnsHashV4(source:Database.Database,target=source):string{
  return sha256(JSON.stringify(tables(source).filter(t=>t!=='enterprise_schema').map(t=>{const names=columns(source,t);return[t,names,rows(target,t,names)];})));
}
export function migrationEvidenceSqliteV4(db:Database.Database,registry:EnterpriseRegistryV3,layout:EnterpriseLayoutV4):EnterpriseMigrationEvidenceV4{
  return{version:1,sourceSchemaVersion:3,layout,registryRevision:registry.registryRevision,registrySha256:enterpriseRegistryHashV3(registry),legacyEnterpriseId:registry.legacyEnterpriseId,
    profiles:registry.profiles.map(p=>({enterpriseId:p.id,identitySha256:enterpriseProfileIdentityHashV4(p),maxAccounts:(db.prepare('SELECT max_accounts FROM enterprise_profiles WHERE id=?').get(p.id) as {max_accounts:number}).max_accounts}))};
}
export function assertSqliteQuiescentV4(db:Database.Database,s:SqliteServiceV4):void{
  assertEnterpriseSqliteDrainedV3(db,s.component,s.layout);checkSqliteIntegrity(db);
  const no=(sql:string)=>insist(!db.prepare(sql).get(),'sqlite_pending_external_operation');
  if(s.component==='proxy'){
    no("SELECT 1 FROM proxy_accounts WHERE copilot_oauth_status NOT IN ('valid','expired','missing','failed') LIMIT 1");
    if(s.layout==='pool'){
      validatePoolNameCatalogSqliteV4(db);
      no(`SELECT 1 FROM user_pool_accounts WHERE lower(coalesce(last_error,'')) LIKE '%ambiguous%' OR lower(coalesce(last_error,'')) LIKE '%unconfirmed%'
        OR lower(coalesce(last_error,'')) LIKE '%stalled%' OR lower(coalesce(last_error,'')) LIKE '%sso_name_conflict%' OR lower(coalesce(last_error,'')) LIKE '%oauth_task_invalid%' LIMIT 1`);
      no(`SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity WHERE (p.task_id IS NOT NULL OR p.oauth_attempt_id IS NOT NULL)
        AND NOT(p.state IN ('ready','cooling') AND p.stage='ready' AND p.verified_at IS NOT NULL AND p.sso_created_at IS NOT NULL AND p.task_id IS NOT NULL AND p.oauth_attempt_id IS NOT NULL AND a.gh_login IS NOT NULL AND length(a.gh_login)>0 AND a.copilot_oauth_status='valid') LIMIT 1`);
    }
  }
}
function loadSource(s:SqliteServiceV4,r:EnterpriseRegistryV3,version:3|4=3){
  insist(s.source && s.backup,'sqlite_source_backup_required');const loaded=readStandaloneSqlite(s.source);
  try{insist(loaded.sourceSha256===s.backup.sha256 && (!s.sourceSha256 || s.sourceSha256===loaded.sourceSha256),'sqlite_backup_hash_mismatch');
    const state=s.component==='proxy' && version===4?validateEnterpriseSqliteV4(loaded.db,'proxy',r):validateEnterpriseSqliteV3(loaded.db,s.component,r);
    insist(state.layout===s.layout,'sqlite_layout_mismatch');assertSqliteQuiescentV4(loaded.db,s);unchanged(s.source,loaded.sourceSha256);return loaded;
  }catch(e){loaded.db.close();throw e;}
}
export function preflightEnterpriseSqliteV4(s:SqliteServiceV4,r:EnterpriseRegistryV3):Record<string,unknown>{
  const{db,sourceSha256}=loadSource(s,r);try{const original=originalColumnsHashV4(db);insist(!s.originalColumnsSha256 || s.originalColumnsSha256===original,'sqlite_source_fidelity_checkpoint_mismatch');s.sourceSha256=sourceSha256;s.originalColumnsSha256=original;
    return{component:s.component,driver:'sqlite',layout:s.layout,state:'preflight',sourceUnchanged:true,schemaVersion:s.component==='proxy'?4:3};
  }finally{db.close();}
}
export function reliableHistoryJoinSqliteV4(table:'proxy_request_stats'|'user_pool_events'):string {
  const time=table==='proxy_request_stats'?'julianday(h.requested_at)':'(h.at / 86400000.0 + 2440587.5)';
  return `h.identity=a.identity COLLATE BINARY AND julianday(a.created_at) IS NOT NULL AND ${time} IS NOT NULL AND ${time}>=julianday(a.created_at)`;
}
function copyProxy(source:Database.Database,target:Database.Database):void{
  const pending=new Set(tables(source).filter(t=>!['enterprise_schema','sqlite_sequence'].includes(t)));
  while(pending.size){const table=[...pending].find(t=>(source.prepare(`PRAGMA foreign_key_list(${q(t)})`).all() as {table:string}[]).every(f=>!pending.has(f.table)));insist(table,'sqlite_unsupported_fk_cycle');pending.delete(table);
    const names=columns(source,table),scoped=['proxy_request_stats','user_pool_events'].includes(table),dest=[...names,...(scoped?['enterprise_id']:[])];
    const insert=target.prepare(`INSERT INTO ${q(table)}(${dest.map(q).join(',')}) VALUES(${dest.map(()=>'?').join(',')})`);
    const data=source.prepare(`SELECT ${names.map(q).join(',')} FROM ${q(table)}`).raw(true).safeIntegers(true).all() as (string|bigint|Buffer|null)[][];
    const scopedEnterprise=scoped?new Map((source.prepare(`SELECT h.id,a.enterprise_id FROM ${q(table)} h LEFT JOIN proxy_accounts a ON ${reliableHistoryJoinSqliteV4(table as 'proxy_request_stats'|'user_pool_events')}`).safeIntegers(true).all() as {id:string|bigint;enterprise_id:string|null}[]).map(r=>[r.id,r.enterprise_id])):undefined;
    for(const row of data)insert.run(...row,...(scoped?[scopedEnterprise!.get(row[names.indexOf('id')] as string|bigint)??null]:[]));
  }
  if(tables(source).includes('sqlite_sequence')){target.exec('DELETE FROM sqlite_sequence');for(const row of source.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers(true).all() as {name:string;seq:bigint}[])target.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);}
}
export function applyEnterpriseSqliteV4(s:SqliteServiceV4,m:EnterpriseManifestV4):Record<string,unknown>{
  const{db:source,sourceSha256}=loadSource(s,m.registry);let target:Database.Database|undefined,fd:number|undefined;
  try{insist(s.sourceSha256===sourceSha256 && s.originalColumnsSha256===originalColumnsHashV4(source),'sqlite_bound_plan_required');if(exists(s.target))return{...verifyEnterpriseSqliteV4(s,m),state:'already-complete'};
    fd=reserve(s.target);
    if(s.component!=='proxy'){unchanged(s.source!,sourceSha256);writeFileSync(fd,readFileSync(s.source!));fsyncSync(fd);}
    else{
      target=new Database(':memory:');target.pragma('foreign_keys=ON');const out=target,layout=s.layout as EnterpriseLayoutV4,now=Date.now();
      out.transaction(()=>{createEnterpriseSqliteSchemaV4(out,layout);copyProxy(source,out);seedEnterprisePoliciesSqliteV4(out,m.registry,true,now);
        insist(originalColumnsHashV4(source,out)===s.originalColumnsSha256,'sqlite_original_columns_changed');const evidence=JSON.stringify(migrationEvidenceSqliteV4(source,m.registry,layout));
        out.prepare(`INSERT INTO enterprise_migration_receipt_v4(singleton,manifest_sha256,source_sha256,backup_reference,source_registry_sha256,original_columns_sha256,source_metadata_json,evidence_sha256,migrated_at) VALUES(1,?,?,?,?,?,?,?,?)`)
          .run(enterpriseManifestHashV4(m),sourceSha256,s.backup!.reference,enterpriseRegistryHashV3(m.registry),s.originalColumnsSha256,evidence,sha256(evidence),now);
        completeEnterpriseSqliteV4(out,'proxy',m.registry,layout);validateEnterpriseSqliteV4(out,'proxy',m.registry);
      }).immediate();unchanged(s.source!,sourceSha256);flush(out,fd);
    }
    closeSync(fd);fd=undefined;unchanged(s.source!,sourceSha256);return{...verifyEnterpriseSqliteV4(s,m),state:'complete'};
  }catch(e){if(e instanceof EnterpriseToolError)throw e;throw new EnterpriseToolError('sqlite_v4_apply_failed_output_unapproved');}finally{if(fd!==undefined)closeSync(fd);target?.close();source.close();}
}
/** Compare old rows without dropping NULL-scoped historical events. Only the known new profile/settings/policy rows may be added. */
function verifyRegistration(source:Database.Database,target:Database.Database,s:SqliteServiceV4):void{
  const ids=(source.prepare('SELECT id FROM enterprise_profiles ORDER BY id').all() as {id:string}[]).map(r=>r.id);
  for(const table of tables(source).filter(t=>!['enterprise_registry','enterprise_schema'].includes(t))){const names=columns(source,table),old=rows(source,table,names);let current:string[];
    if(table==='enterprise_profiles' || table==='enterprise_pool_policy' || s.component==='sso' && table==='sso_runtime_settings'){
      const key=table==='enterprise_profiles'?'id':'enterprise_id';current=target.prepare(`SELECT ${names.map(q).join(',')} FROM ${q(table)} WHERE ${key} IN (${ids.map(()=>'?').join(',')})`).raw(true).safeIntegers(true).all(...ids).map(r=>serialize(r).toString('hex')).sort();
    }else current=rows(target,table,names);
    insist(JSON.stringify(old)===JSON.stringify(current),'sqlite_registration_existing_rows_changed');
  }
}
export function verifyEnterpriseSqliteV4(s:SqliteServiceV4,m:EnterpriseManifestV4):Record<string,unknown>{
  const{db:target}=readStandaloneSqlite(s.target);let source:Database.Database|undefined;
  try{const state=s.component==='proxy'?validateEnterpriseSqliteV4(target,'proxy',m.registry):validateEnterpriseSqliteV3(target,s.component,m.registry);insist(state.layout===s.layout,'sqlite_layout_mismatch');
    if(s.source){const loaded=loadSource(s,m.previousRegistry??m.registry,m.previousRegistry?4:3);source=loaded.db;
      if(m.previousRegistry)verifyRegistration(source,target,s);
      else{insist(originalColumnsHashV4(source)===s.originalColumnsSha256 && originalColumnsHashV4(source,target)===s.originalColumnsSha256,'sqlite_original_columns_changed');
        if(s.component==='proxy'){
          const r=target.prepare('SELECT * FROM enterprise_migration_receipt_v4').get() as Record<string,unknown>,e=JSON.stringify(migrationEvidenceSqliteV4(source,m.registry,s.layout as EnterpriseLayoutV4));
          insist(r.manifest_sha256===enterpriseManifestHashV4(m) && r.source_sha256===loaded.sourceSha256 && r.backup_reference===s.backup!.reference
            && r.original_columns_sha256===s.originalColumnsSha256 && r.source_metadata_json===e && r.evidence_sha256===sha256(e),'sqlite_v4_receipt_mismatch');
          for(const t of ['proxy_request_stats',...(s.layout==='pool'?['user_pool_events']:[])]){
            const src=source.prepare(`SELECT h.id,a.enterprise_id FROM ${t} h LEFT JOIN proxy_accounts a ON ${reliableHistoryJoinSqliteV4(t as 'proxy_request_stats'|'user_pool_events')} ORDER BY h.id`).all();
            const dst=target.prepare(`SELECT id,enterprise_id FROM ${t} ORDER BY id`).all();insist(JSON.stringify(src)===JSON.stringify(dst),'sqlite_v4_backfill_mismatch');
          }
        }else insist(sha256(readFileSync(s.target))===loaded.sourceSha256,'sqlite_v3_copy_changed');
      }unchanged(s.source,loaded.sourceSha256);
    }
    return{component:s.component,driver:'sqlite',layout:state.layout,state:'verified',schemaVersion:s.component==='proxy'?4:3,...(source?{sourceUnchanged:true,originalColumnsPreserved:true}:{})};
  }finally{source?.close();target.close();}
}
export function initEnterpriseSqliteFileV4(s:SqliteServiceV4,m:EnterpriseManifestV4):Record<string,unknown>{
  insist(!s.source && !s.backup,'sqlite_init_cannot_migrate');const fd=reserve(s.target),db=new Database(':memory:');try{
    if(s.component==='proxy')initEnterpriseSqliteV4(db,'proxy',m.registry,{...s.init,layout:s.layout as EnterpriseLayoutV4});else initEnterpriseSqliteV3(db,s.component,m.registry,{layout:s.layout});
    flush(db,fd);return{...verifyEnterpriseSqliteV4(s,m),state:'initialized'};
  }finally{closeSync(fd);db.close();}
}
export function registerEnterpriseSqliteFileV4(s:SqliteServiceV4,m:EnterpriseManifestV4):Record<string,unknown>{
  insist(m.previousRegistry && s.source && s.backup,'sqlite_register_source_and_previous_required');const{db,sourceSha256}=loadSource(s,m.previousRegistry,4);let fd:number|undefined;
  try{fd=reserve(s.target);if(s.component==='proxy')registerEnterpriseSqliteV4(db,'proxy',m.previousRegistry,m.registry);else registerEnterpriseSqliteV3(db,s.component,m.previousRegistry,m.registry);
    unchanged(s.source,sourceSha256);flush(db,fd);unchanged(s.source,sourceSha256);closeSync(fd);fd=undefined;return{...verifyEnterpriseSqliteV4(s,m),state:'registered'};
  }finally{if(fd!==undefined)closeSync(fd);db.close();}
}
export function inspectEnterpriseSqliteV4(s:SqliteServiceV4,r:EnterpriseRegistryV3):Record<string,unknown>{
  if(!exists(s.target))return{component:s.component,driver:'sqlite',state:'absent'};let db:Database.Database|undefined;
  try{db=readStandaloneSqlite(s.target).db;const state=s.component==='proxy'?validateEnterpriseSqliteV4(db,'proxy',r):validateEnterpriseSqliteV3(db,s.component,r);return{component:s.component,driver:'sqlite',state:'complete',layout:state.layout,schemaVersion:s.component==='proxy'?4:3};}
  catch{return{component:s.component,driver:'sqlite',state:'unapproved'};}finally{db?.close();}
}
