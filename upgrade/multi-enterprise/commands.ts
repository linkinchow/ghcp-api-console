import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { canonicalEnterpriseIdentityRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { validateEnterpriseMysqlV3, initEnterpriseMysqlV3, registerEnterpriseMysqlV3 } from '../../src/packages/shared/src/enterpriseMysqlV3.js';
import { validateEnterpriseSqliteV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
import { readStandaloneSqlite } from '../default-enterprise/sqlite.js';
import { safeEnterpriseToolError } from '../default-enterprise/commands.js';
import { parseEnterpriseManifestV3, enterpriseManifestHashV3, insist, type MysqlServiceV3, type EnterpriseManifestV3 } from './manifest.js';
import { applyEnterpriseSqliteV3, initEnterpriseSqliteFileV3, inspectEnterpriseSqliteV3, preflightEnterpriseSqliteV3,
  verifyEnterpriseSqliteV3, registerEnterpriseSqliteFileV3 } from './sqlite.js';
import { preflightEnterpriseMysqlV3, applyEnterpriseMysqlV3, verifyEnterpriseMysqlMigrationV3, inspectEnterpriseMysqlV3 } from './mysql.js';
export { safeEnterpriseToolError };
export type EnterpriseCommandV3='init'|'preflight'|'apply'|'verify'|'inspect'|'register';
export interface EnterpriseCommandResultV3 { command:EnterpriseCommandV3; ready:boolean; pairedRegistry:boolean; components:Record<string,unknown>[] }
async function connect(service:MysqlServiceV3,env:NodeJS.ProcessEnv):Promise<Connection> {
  const value=env[service.location.connectionEnv];insist(value,'mysql_explicit_connection_environment_required');
  let url:URL;try{url=new URL(value);}catch{throw new Error('mysql_invalid_connection_environment');}
  insist(url.protocol==='mysql:' && !url.search && !url.hash && url.hostname.toLowerCase()===service.location.host.toLowerCase()
    && Number(url.port||3306)===service.location.port && decodeURIComponent(url.pathname.slice(1))===service.location.database,'mysql_manifest_location_mismatch');
  const local=['127.0.0.1','[::1]'].includes(url.hostname.toLowerCase()),ca=env[`${service.location.connectionEnv}_CA_FILE`];
  insist(local||ca,'mysql_verified_tls_required');
  const c=await createConnection({uri:value,timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,
    charset:'utf8mb4',connectTimeout:10000,...(ca?{ssl:{ca:readFileSync(ca,'utf8'),rejectUnauthorized:true,verifyIdentity:true}}:{})});
  if(!ca){const transport=(c as unknown as {connection:{stream?:{remoteAddress?:string};config?:{socketPath?:string}}}).connection;
    if(transport.config?.socketPath || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(transport.stream?.remoteAddress??'')){c.destroy();insist(false,'mysql_literal_loopback_peer_required');}}
  return c;
}
function mysqlBinding(service:MysqlServiceV3,manifest:EnterpriseManifestV3) {
  insist(service.sourceSha256 && service.backup && service.accountIncarnations,'mysql_bound_plan_required');
  return {migrationId:'enterprise-schema3-contract2',expectedSourceSha256:service.sourceSha256,manifestSha256:enterpriseManifestHashV3(manifest),
    backupReference:service.backup.reference,backupSha256:service.backup.sha256,expectedDatabase:service.location.database,
    accountIncarnations:service.accountIncarnations,layout:service.layout};
}
export async function runEnterpriseCommandV3(command:EnterpriseCommandV3,value:unknown,
  options:{resume?:boolean;env?:NodeJS.ProcessEnv;planOut?:string}={}):Promise<EnterpriseCommandResultV3> {
  insist(['init','preflight','apply','verify','inspect','register'].includes(command),'enterprise_invalid_command');
  insist(!options.resume || command==='apply','enterprise_resume_only_apply');
  insist(!options.planOut || command==='preflight' && isAbsolute(options.planOut),'enterprise_plan_out_requires_preflight_absolute_path');
  insist(command!=='preflight' || options.planOut,'enterprise_protected_plan_output_required');
  const manifest=parseEnterpriseManifestV3(value);
  if (command === 'init') for (const service of manifest.services) {
    insist(!service.backup && !service.sourceSha256 && !(service.driver === 'sqlite' && service.source), 'enterprise_init_cannot_migrate');
    if (service.driver === 'mysql') insist(service.init !== undefined, 'mysql_explicit_init_options_required');
  }
  insist(['register','verify','inspect'].includes(command) || !manifest.previousRegistry,'enterprise_previous_registry_only_register');
  if(command==='apply')for(const service of manifest.services) {
    insist(!service.init && service.sourceSha256 && (service.driver==='mysql' || service.originalColumnsSha256)
      && (service.component!=='proxy' || service.accountIncarnations!==undefined)
      && (service.component!=='sso' || service.driver==='sqlite' && service.userIncarnations!==undefined),'enterprise_bound_plan_required');
    if(service.driver==='sqlite')preflightEnterpriseSqliteV3(service,manifest.registry);
  }
  if(command==='register') {
    insist(manifest.previousRegistry,'enterprise_previous_registry_required');
    for(const service of manifest.services)if(service.driver==='sqlite') {
      insist(service.source && service.backup,'sqlite_register_source_and_previous_required');const {db,sourceSha256}=readStandaloneSqlite(service.source);
      try{insist(sourceSha256===service.backup.sha256,'sqlite_backup_hash_mismatch');const state=validateEnterpriseSqliteV3(db,service.component,manifest.previousRegistry);insist(state.layout===service.layout,'sqlite_layout_mismatch');}finally{db.close();}
    }
  }
  const components:Record<string,unknown>[]=[],observed:string[]=[];
  for(const service of manifest.services) {
    if(service.driver==='sqlite') {
      const result=command==='init'?initEnterpriseSqliteFileV3(service,manifest):command==='preflight'?preflightEnterpriseSqliteV3(service,manifest.registry)
        :command==='apply'?applyEnterpriseSqliteV3(service,manifest):command==='verify'?verifyEnterpriseSqliteV3(service,manifest)
        :command==='register'?registerEnterpriseSqliteFileV3(service,manifest):inspectEnterpriseSqliteV3(service,manifest.registry);
      components.push(result);if(['initialized','verified','complete','already-complete','registered'].includes(result.state as string))observed.push(canonicalEnterpriseIdentityRegistryV3(manifest.registry));continue;
    }
    const c=await connect(service,options.env??process.env);
    try {
      if(command==='preflight') {
        insist(service.backup && !service.init,'mysql_backup_attestation_required');
        const result=await preflightEnterpriseMysqlV3(c,manifest.registry,service.layout);
        insist(result.database===service.location.database && (!service.sourceSha256 || result.sourceSha256===service.sourceSha256),'mysql_source_binding_mismatch');
        if(service.accountIncarnations) {
          insist(service.sourceSha256===result.sourceSha256 && service.accountIncarnations.length===result.accountIncarnations.length
            && result.accountIncarnations.every(row=>service.accountIncarnations!.some(item=>item.identity===row.identity)),'mysql_incarnation_plan_mismatch');
        }else service.accountIncarnations=result.accountIncarnations;
        service.sourceSha256=result.sourceSha256;
        components.push({component:'proxy',driver:'mysql',state:'preflight',layout:result.layout,counts:result.counts});
      }else if(command==='inspect')components.push({component:'proxy',driver:'mysql',...await inspectEnterpriseMysqlV3(c,manifest.registry)});
      else {
        if(command==='init') {
          insist(service.init!==undefined && !service.backup && !service.sourceSha256,'mysql_explicit_init_options_required');
          await initEnterpriseMysqlV3(c,'proxy',manifest.registry,{...service.init,layout:service.layout});
        }else if(command==='apply')await applyEnterpriseMysqlV3(c,manifest.registry,{...mysqlBinding(service,manifest),confirmOffline:true,confirmBackup:true,confirmDrained:true,resume:options.resume});
        else if(command==='register')await registerEnterpriseMysqlV3(c,manifest.previousRegistry!,manifest.registry,{confirmOffline:true,confirmDrained:true,expectedRegistryRevision:manifest.previousRegistry!.registryRevision});
        else if(!service.init && !manifest.previousRegistry)await verifyEnterpriseMysqlMigrationV3(c,manifest.registry,mysqlBinding(service,manifest));
        const state=await validateEnterpriseMysqlV3(c,'proxy',manifest.registry);insist(state.layout===service.layout,'mysql_layout_mismatch');
        observed.push(canonicalEnterpriseIdentityRegistryV3(state.registry));components.push({component:'proxy',driver:'mysql',state:command==='init'?'initialized':command==='register'?'registered':command==='verify'?'verified':'complete',layout:state.layout});
      }
    }finally{try{await c.end();}catch{/* A bounded operation may already have destroyed the connection. */}}
  }
  if(options.planOut) {
    const fd=openSync(options.planOut,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify(manifest,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  }
  const pairedRegistry=observed.length===3 && new Set(observed).size===1;
  return {command,ready:['init','apply','verify','register'].includes(command) && pairedRegistry,pairedRegistry,components};
}
