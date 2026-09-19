import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { enterpriseId, parseEnterpriseProfile, type EnterpriseComponent } from '../../src/packages/shared/src/enterprise.js';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { enterpriseComponentLayout, validateEnterprisePoolSettings, type EnterpriseLayout } from '../../src/packages/shared/src/enterpriseStorage.js';
import type { EnterpriseInitOptionsV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
export { EnterpriseToolError, insist } from '../default-enterprise/manifest.js';
import { insist } from '../default-enterprise/manifest.js';
export interface BackupV3 { reference: string; sha256: string }
export interface IncarnationV3 { identity: string; accountIncarnation: string }
export interface UserIncarnationV3 { enterpriseId: string; ssoUser: string; userIncarnation: string }
export interface SqliteServiceV3 {
  component: EnterpriseComponent; driver: 'sqlite'; layout: EnterpriseLayout; source?: string; target: string;
  backup?: BackupV3; sourceSha256?: string; originalColumnsSha256?: string;
  accountIncarnations?: IncarnationV3[]; userIncarnations?: UserIncarnationV3[]; init?: EnterpriseInitOptionsV3;
}
export interface MysqlServiceV3 {
  component: 'proxy'; driver: 'mysql'; layout: 'direct'|'pool';
  location: { host: string; port: number; database: string; connectionEnv: string };
  backup?: BackupV3; sourceSha256?: string; accountIncarnations?: IncarnationV3[]; init?: EnterpriseInitOptionsV3;
}
export interface EnterpriseManifestV3 {
  manifestVersion: 3; sourceSchemaVersion: 2; registry: EnterpriseRegistryV3; previousRegistry?: EnterpriseRegistryV3;
  services: (SqliteServiceV3|MysqlServiceV3)[];
  attestations: { writersStopped:true; externalOperationsDrained:true; backupVerified:true };
}
function record(value: unknown, required: string[], optional: string[]=[]): Record<string,unknown> {
  insist(value && typeof value==='object' && !Array.isArray(value),'manifest_v3_invalid_object');
  const row=value as Record<string,unknown>;
  insist(required.every(key=>Object.hasOwn(row,key)) && Object.keys(row).every(key=>[...required,...optional].includes(key)),'manifest_v3_fields');
  return row;
}
function text(value:unknown, regex:RegExp):string { insist(typeof value==='string' && regex.test(value),'manifest_v3_invalid_value'); return value; }
function path(value:unknown):string { insist(typeof value==='string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value),'manifest_absolute_path_required'); return resolve(value); }
function backup(value:unknown):BackupV3 { const row=record(value,['reference','sha256']); return {reference:text(row.reference,/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),sha256:text(row.sha256,/^[a-f0-9]{64}$/)}; }
function init(value:unknown,layout:EnterpriseLayout,registry:EnterpriseRegistryV3):EnterpriseInitOptionsV3 {
  const row=record(value,[],['pool']);
  if (layout!=='pool') { insist(!Object.keys(row).length,'manifest_unexpected_pool_options');return {}; }
  const pool=record(row.pool,['settings'],['fingerprint']);
  const settings=record(pool.settings,['version','idle_target','lease_seconds','paused','next_ordinal','account_domain','owner','owner_until']) as unknown as NonNullable<EnterpriseInitOptionsV3['pool']>['settings'];
  const legacy=registry.profiles.find(profile=>profile.id===registry.legacyEnterpriseId)!;
  validateEnterprisePoolSettings(settings,legacy.maxAccounts);
  insist(settings.paused===1 && settings.owner===null && settings.owner_until===0 && settings.next_ordinal===0 && settings.account_domain===legacy.accountDomain,'manifest_init_must_be_empty_paused');
  return {pool:{settings,...(pool.fingerprint===undefined?{}:{fingerprint:text(pool.fingerprint,/^[a-f0-9]{64}$/)})}};
}
export function parseEnterpriseManifestV3(value:unknown):EnterpriseManifestV3 {
  const row=record(value,['manifestVersion','sourceSchemaVersion','registry','services','attestations'],['previousRegistry']);
  insist(row.manifestVersion===3 && row.sourceSchemaVersion===2,'manifest_v3_version');
  const registry=parseEnterpriseRegistryV3(row.registry), previousRegistry=row.previousRegistry===undefined?undefined:parseEnterpriseRegistryV3(row.previousRegistry);
  const attestations=record(row.attestations,['writersStopped','externalOperationsDrained','backupVerified']);
  insist(Object.values(attestations).every(value=>value===true),'manifest_operator_attestation_required');
  insist(Array.isArray(row.services) && row.services.length===3,'manifest_three_services_required');
  const seen=new Set<string>();
  const services=row.services.map((value:unknown):SqliteServiceV3|MysqlServiceV3=>{
    const item=record(value,['component','driver','layout'],['source','target','backup','sourceSha256','originalColumnsSha256','accountIncarnations','userIncarnations','init','location']);
    insist(['proxy','sso','login'].includes(item.component as string) && !seen.has(item.component as string),'manifest_service_pairing_invalid');seen.add(item.component as string);
    const component=item.component as EnterpriseComponent,layout=enterpriseComponentLayout(component,item.layout as EnterpriseLayout);
    insist(layout===item.layout,'manifest_layout_required');
    const common={component,layout,...(item.backup===undefined?{}:{backup:backup(item.backup)}),
      ...(item.sourceSha256===undefined?{}:{sourceSha256:text(item.sourceSha256,/^[a-f0-9]{64}$/)}),
      ...(item.init===undefined?{}:{init:init(item.init,layout,registry)})};
    let accountIncarnations:IncarnationV3[]|undefined,userIncarnations:UserIncarnationV3[]|undefined;
    if (item.accountIncarnations!==undefined) {
      insist(component==='proxy' && Array.isArray(item.accountIncarnations),'manifest_v3_mapping');
      accountIncarnations=item.accountIncarnations.map((value:unknown)=>{ const r=record(value,['identity','accountIncarnation']);return {identity:text(r.identity,/^[^\x00-\x1f]{1,255}$/),accountIncarnation:enterpriseId(r.accountIncarnation)}; });
      insist(new Set(accountIncarnations.map(row=>row.identity)).size===accountIncarnations.length && new Set(accountIncarnations.map(row=>row.accountIncarnation)).size===accountIncarnations.length,'manifest_v3_mapping_duplicate');
    }
    if (item.userIncarnations!==undefined) {
      insist(component==='sso' && Array.isArray(item.userIncarnations),'manifest_v3_mapping');
      userIncarnations=item.userIncarnations.map((value:unknown)=>{const r=record(value,['enterpriseId','ssoUser','userIncarnation']);return {enterpriseId:enterpriseId(r.enterpriseId),ssoUser:text(r.ssoUser,/^[^\x00-\x1f]{1,255}$/),userIncarnation:enterpriseId(r.userIncarnation)};});
      insist(new Set(userIncarnations.map(row=>JSON.stringify([row.enterpriseId,row.ssoUser]))).size===userIncarnations.length && new Set(userIncarnations.map(row=>row.userIncarnation)).size===userIncarnations.length,'manifest_v3_mapping_duplicate');
    }
    if(item.driver==='sqlite') {
      insist(item.location===undefined,'manifest_driver_field_mismatch');
      const target=path(item.target),source=item.source===undefined?undefined:path(item.source);
      insist(source!==target && ((source===undefined)===(common.backup===undefined)) && !(source && common.init),'manifest_sqlite_source_fields');
      return {...common,driver:'sqlite',target,...(source?{source}:{}),...(accountIncarnations?{accountIncarnations}:{}),...(userIncarnations?{userIncarnations}:{}),
        ...(item.originalColumnsSha256===undefined?{}:{originalColumnsSha256:text(item.originalColumnsSha256,/^[a-f0-9]{64}$/)})};
    }
    insist(item.driver==='mysql' && component==='proxy' && (layout==='direct'||layout==='pool') && item.source===undefined && item.target===undefined
      && item.userIncarnations===undefined && item.originalColumnsSha256===undefined,'manifest_driver_not_supported');
    const loc=record(item.location,['host','port','database','connectionEnv']);
    insist(Number.isInteger(loc.port) && Number(loc.port)>0 && Number(loc.port)<=65535,'manifest_invalid_mysql_port');
    return {...common,component:'proxy',layout,driver:'mysql',location:{host:text(loc.host,/^(?:[a-zA-Z0-9.-]+|\[::1\])$/),port:loc.port as number,
      database:text(loc.database,/^[a-zA-Z0-9_]{1,64}$/),connectionEnv:text(loc.connectionEnv,/^ENTERPRISE_MYSQL_[A-Z0-9_]+$/)},...(accountIncarnations?{accountIncarnations}:{})};
  });
  const paths=services.flatMap(service=>service.driver==='sqlite'?[service.source,service.target].filter((value):value is string=>!!value):[])
    .map(value=>process.platform==='win32'?value.toLowerCase():value);
  insist(new Set(paths).size===paths.length,'manifest_path_reused');
  services.sort((a,b)=>['proxy','sso','login'].indexOf(a.component)-['proxy','sso','login'].indexOf(b.component));
  return {manifestVersion:3,sourceSchemaVersion:2,registry,...(previousRegistry?{previousRegistry}:{}),services,attestations:attestations as EnterpriseManifestV3['attestations']};
}
export const enterpriseManifestHashV3=(manifest:EnterpriseManifestV3):string=>createHash('sha256').update(JSON.stringify(parseEnterpriseManifestV3(manifest))).digest('hex');
export function legacyProfileV2(registry:EnterpriseRegistryV3) {
  const profile=registry.profiles.find(profile=>profile.id===registry.legacyEnterpriseId)!;
  return parseEnterpriseProfile(Object.fromEntries(['id','slug','shortcode','accountDomain','revision','routes'].map(key=>[key,profile[key as keyof typeof profile]])));
}
