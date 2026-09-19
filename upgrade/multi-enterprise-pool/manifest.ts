import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { validateEnterprisePoolSettingsV4, type EnterpriseInitOptionsV4 } from '../../src/packages/shared/src/enterpriseStorageV4.js';
export { EnterpriseToolError, insist } from '../default-enterprise/manifest.js';
import { insist } from '../default-enterprise/manifest.js';
export interface BackupV4 {reference:string;sha256:string}
export interface SqliteServiceV4 {
  component:'proxy'|'sso'|'login';driver:'sqlite';layout:'direct'|'pool'|'sso'|'login';source?:string;target:string;backup?:BackupV4;
  sourceSha256?:string;originalColumnsSha256?:string;init?:EnterpriseInitOptionsV4;
}
export interface MysqlServiceV4 {
  component:'proxy';driver:'mysql';layout:'direct'|'pool';location:{host:string;port:number;database:string;connectionEnv:string};
  backup?:BackupV4;sourceSha256?:string;init?:EnterpriseInitOptionsV4;
}
export interface EnterpriseManifestV4 {
  manifestVersion:4;sourceSchemaVersion:3;registry:EnterpriseRegistryV3;previousRegistry?:EnterpriseRegistryV3;
  services:(SqliteServiceV4|MysqlServiceV4)[];attestations:{writersStopped:true;externalOperationsDrained:true;backupVerified:true};
}
function record(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{insist(v && typeof v==='object' && !Array.isArray(v),'manifest_v4_object');const r=v as Record<string,unknown>;insist(required.every(k=>Object.hasOwn(r,k)) && Object.keys(r).every(k=>required.includes(k)||optional.includes(k)),'manifest_v4_fields');return r;}
function text(v:unknown,re:RegExp):string{insist(typeof v==='string' && re.test(v),'manifest_v4_value');return v;}
function path(v:unknown):string{insist(typeof v==='string' && isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v),'manifest_absolute_path_required');return resolve(v);}
function backup(v:unknown):BackupV4{const r=record(v,['reference','sha256']);return{reference:text(r.reference,/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),sha256:text(r.sha256,/^[a-f0-9]{64}$/)};}
function init(v:unknown,layout:string,registry:EnterpriseRegistryV3):EnterpriseInitOptionsV4{
  const r=record(v,[],['pool']);if(layout!=='pool'){insist(Object.keys(r).length===0,'manifest_unexpected_pool_options');return{};}
  const p=record(r.pool,['settings'],['fingerprint']),s=record(p.settings,['version','idle_target','lease_seconds','paused','next_ordinal','account_domain','owner','owner_until']) as unknown as NonNullable<EnterpriseInitOptionsV4['pool']>['settings'];
  validateEnterprisePoolSettingsV4(s);insist(s.paused===1 && s.next_ordinal===0 && s.owner===null && s.owner_until===0 && s.account_domain===registry.profiles.find(p=>p.id===registry.legacyEnterpriseId)!.accountDomain,'manifest_init_must_be_empty_paused');
  return{pool:{settings:s,...(p.fingerprint===undefined?{}:{fingerprint:text(p.fingerprint,/^[a-f0-9]{64}$/)})}};
}
/** Registry remains JSON3. SSO/Login are schema3; no incarnation maps are accepted or generated. */
export function parseEnterpriseManifestV4(v:unknown):EnterpriseManifestV4{
  const r=record(v,['manifestVersion','sourceSchemaVersion','registry','services','attestations'],['previousRegistry']);insist(r.manifestVersion===4 && r.sourceSchemaVersion===3,'manifest_v4_version');
  const registry=parseEnterpriseRegistryV3(r.registry),previous=r.previousRegistry===undefined?undefined:parseEnterpriseRegistryV3(r.previousRegistry);
  const att=record(r.attestations,['writersStopped','externalOperationsDrained','backupVerified']);insist(Object.values(att).every(x=>x===true),'manifest_operator_attestation_required');
  insist(Array.isArray(r.services) && r.services.length===3,'manifest_three_services_required');const seen=new Set<string>();
  const services=r.services.map((v):SqliteServiceV4|MysqlServiceV4=>{
    const s=record(v,['component','driver','layout'],['source','target','backup','sourceSha256','originalColumnsSha256','init','location']);
    insist(['proxy','sso','login'].includes(s.component as string) && !seen.has(s.component as string),'manifest_service_pairing_invalid');seen.add(s.component as string);
    const component=s.component as SqliteServiceV4['component'],layout=s.layout as SqliteServiceV4['layout'];insist(component==='proxy'?['direct','pool'].includes(layout):component===layout,'manifest_layout_required');
    const common={component,layout,...(s.backup===undefined?{}:{backup:backup(s.backup)}),...(s.sourceSha256===undefined?{}:{sourceSha256:text(s.sourceSha256,/^[a-f0-9]{64}$/)}),...(s.init===undefined?{}:{init:init(s.init,layout,registry)})};
    if(s.driver==='sqlite'){
      insist(s.location===undefined,'manifest_driver_field_mismatch');const target=path(s.target),source=s.source===undefined?undefined:path(s.source);
      insist(source!==target && (source===undefined)===(common.backup===undefined) && !(source && common.init),'manifest_sqlite_source_fields');
      return{...common,driver:'sqlite',target,...(source?{source}:{}),...(s.originalColumnsSha256===undefined?{}:{originalColumnsSha256:text(s.originalColumnsSha256,/^[a-f0-9]{64}$/)})};
    }
    insist(s.driver==='mysql' && component==='proxy' && ['direct','pool'].includes(layout) && s.source===undefined && s.target===undefined && s.originalColumnsSha256===undefined,'manifest_driver_not_supported');
    const l=record(s.location,['host','port','database','connectionEnv']);insist(Number.isInteger(l.port) && Number(l.port)>=1 && Number(l.port)<=65535,'manifest_invalid_mysql_port');
    return{...common,component:'proxy',driver:'mysql',layout:layout as 'direct'|'pool',location:{host:text(l.host,/^(?:[a-zA-Z0-9.-]+|\[::1\])$/),port:l.port as number,database:text(l.database,/^[a-zA-Z0-9_]{1,64}$/),connectionEnv:text(l.connectionEnv,/^ENTERPRISE_MYSQL_[A-Z0-9_]+$/)}};
  });
  const paths=services.flatMap(s=>s.driver==='sqlite'?[s.source,s.target].filter((p):p is string=>!!p):[]).map(p=>process.platform==='win32'?p.toLowerCase():p);insist(new Set(paths).size===paths.length,'manifest_path_reused');
  services.sort((a,b)=>['proxy','sso','login'].indexOf(a.component)-['proxy','sso','login'].indexOf(b.component));
  return{manifestVersion:4,sourceSchemaVersion:3,registry,...(previous?{previousRegistry:previous}:{}),services,attestations:att as EnterpriseManifestV4['attestations']};
}
export const enterpriseManifestHashV4=(m:EnterpriseManifestV4)=>createHash('sha256').update(JSON.stringify(parseEnterpriseManifestV4(m))).digest('hex');
