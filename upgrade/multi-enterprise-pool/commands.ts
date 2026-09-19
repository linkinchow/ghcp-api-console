import { closeSync,fsyncSync,openSync,readFileSync,writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { canonicalEnterpriseIdentityRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { validateEnterpriseSqliteV3 } from '../../src/packages/shared/src/enterpriseStorageV3.js';
import { validateEnterpriseSqliteV4 } from '../../src/packages/shared/src/enterpriseStorageV4.js';
import { validateEnterpriseMysqlV3 } from '../../src/packages/shared/src/enterpriseMysqlV3.js';
import { validateEnterpriseMysqlV4,initEnterpriseMysqlV4,registerEnterpriseMysqlV4 } from '../../src/packages/shared/src/enterpriseMysqlV4.js';
import { readStandaloneSqlite } from '../default-enterprise/sqlite.js';
import { safeEnterpriseToolError } from '../default-enterprise/commands.js';
import { parseEnterpriseManifestV4,enterpriseManifestHashV4,insist,type EnterpriseManifestV4,type MysqlServiceV4 } from './manifest.js';
import { applyEnterpriseSqliteV4,initEnterpriseSqliteFileV4,inspectEnterpriseSqliteV4,preflightEnterpriseSqliteV4,registerEnterpriseSqliteFileV4,verifyEnterpriseSqliteV4,assertSqliteQuiescentV4 } from './sqlite.js';
import { applyEnterpriseMysqlV4,preflightEnterpriseMysqlV4,verifyEnterpriseMysqlMigrationV4,inspectEnterpriseMysqlV4 } from './mysql.js';
export { safeEnterpriseToolError };
export type EnterpriseCommandV4='init'|'preflight'|'apply'|'verify'|'inspect'|'register';
export interface EnterpriseCommandResultV4 {command:EnterpriseCommandV4;ready:boolean;pairedRegistry:boolean;components:Record<string,unknown>[]}
async function connect(s:MysqlServiceV4,env:NodeJS.ProcessEnv):Promise<Connection>{
  const value=env[s.location.connectionEnv];insist(value,'mysql_explicit_connection_environment_required');let url:URL;try{url=new URL(value);}catch{throw new Error('mysql_invalid_connection_environment');}
  insist(url.protocol==='mysql:' && !url.search && !url.hash && url.hostname.toLowerCase()===s.location.host.toLowerCase() && Number(url.port||3306)===s.location.port && decodeURIComponent(url.pathname.slice(1))===s.location.database,'mysql_manifest_location_mismatch');
  const local=['127.0.0.1','[::1]'].includes(url.hostname.toLowerCase()),ca=env[`${s.location.connectionEnv}_CA_FILE`];insist(local||ca,'mysql_verified_tls_required');
  const {createConnection}=await import('mysql2/promise');const c=await createConnection({uri:value,timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,charset:'utf8mb4',connectTimeout:10000,...(ca?{ssl:{ca:readFileSync(ca,'utf8'),rejectUnauthorized:true,verifyIdentity:true}}:{})});
  if(!ca){const transport=(c as unknown as {connection:{stream?:{remoteAddress?:string};config?:{socketPath?:string}}}).connection;if(transport.config?.socketPath||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(transport.stream?.remoteAddress??'')){c.destroy();insist(false,'mysql_literal_loopback_peer_required');}}
  return c;
}
function binding(s:MysqlServiceV4,m:EnterpriseManifestV4){insist(s.sourceSha256 && s.backup,'mysql_bound_plan_required');return{migrationId:'enterprise-schema4-contract2',expectedSourceSha256:s.sourceSha256,manifestSha256:enterpriseManifestHashV4(m),backupReference:s.backup.reference,backupSha256:s.backup.sha256,expectedDatabase:s.location.database,layout:s.layout};}
/** No dotenv import or implicit environment fallback. Programmatic callers must explicitly provide connection variables. */
export async function runEnterpriseCommandV4(command:EnterpriseCommandV4,value:unknown,options:{resume?:boolean;env?:NodeJS.ProcessEnv;planOut?:string}={}):Promise<EnterpriseCommandResultV4>{
  insist(['init','preflight','apply','verify','inspect','register'].includes(command),'enterprise_invalid_command');insist(!options.resume||command==='apply','enterprise_resume_only_apply');
  insist(!options.planOut||command==='preflight' && isAbsolute(options.planOut),'enterprise_plan_out_requires_preflight_absolute_path');insist(command!=='preflight'||options.planOut,'enterprise_protected_plan_output_required');
  const m=parseEnterpriseManifestV4(value);insist(['register','verify','inspect'].includes(command)||!m.previousRegistry,'enterprise_previous_registry_only_register');
  if(command==='init')for(const s of m.services){insist(!s.backup && !s.sourceSha256 && !(s.driver==='sqlite' && s.source),'enterprise_init_cannot_migrate');if(s.driver==='mysql')insist(s.init!==undefined,'mysql_explicit_init_options_required');}
  // Validate every SQLite participant BEFORE any service mutates. Never copy/upgrade old SSO/Login v2 here.
  if(['apply','register','preflight'].includes(command))for(const s of m.services)if(s.driver==='sqlite'){
    if(command==='register'){insist(m.previousRegistry && s.source && s.backup,'sqlite_register_source_and_previous_required');const{db,sourceSha256}=readStandaloneSqlite(s.source);try{insist(sourceSha256===s.backup.sha256,'sqlite_backup_hash_mismatch');const state=s.component==='proxy'?validateEnterpriseSqliteV4(db,'proxy',m.previousRegistry):validateEnterpriseSqliteV3(db,s.component,m.previousRegistry);insist(state.layout===s.layout,'sqlite_layout_mismatch');assertSqliteQuiescentV4(db,s);}finally{db.close();}}
    else{if(command==='apply')insist(!s.init && s.sourceSha256 && s.originalColumnsSha256,'enterprise_bound_plan_required');preflightEnterpriseSqliteV4(s,m.registry);}
  }
  if(command==='register')insist(m.previousRegistry,'enterprise_previous_registry_required');
  const components:Record<string,unknown>[]=[],observed:string[]=[];
  for(const s of m.services){
    if(s.driver==='sqlite'){
      const result=command==='init'?initEnterpriseSqliteFileV4(s,m):command==='preflight'?{component:s.component,driver:'sqlite',layout:s.layout,state:'preflight',schemaVersion:s.component==='proxy'?4:3}:command==='apply'?applyEnterpriseSqliteV4(s,m):command==='verify'?verifyEnterpriseSqliteV4(s,m):command==='register'?registerEnterpriseSqliteFileV4(s,m):inspectEnterpriseSqliteV4(s,m.registry);
      components.push(result);if(['initialized','verified','complete','already-complete','registered'].includes(result.state as string))observed.push(canonicalEnterpriseIdentityRegistryV3(m.registry));continue;
    }
    const c=await connect(s,options.env??{});try{
      if(command==='preflight'){insist(s.backup && !s.init,'mysql_backup_attestation_required');const result=await preflightEnterpriseMysqlV4(c,m.registry,s.layout);insist(result.database===s.location.database && (!s.sourceSha256||result.sourceSha256===s.sourceSha256),'mysql_source_binding_mismatch');s.sourceSha256=result.sourceSha256;components.push({component:'proxy',driver:'mysql',state:'preflight',layout:result.layout,counts:result.counts});}
      else if(command==='inspect')components.push({component:'proxy',driver:'mysql',...await inspectEnterpriseMysqlV4(c,m.registry)});
      else{
        if(command==='init'){insist(s.init!==undefined,'mysql_explicit_init_options_required');await initEnterpriseMysqlV4(c,'proxy',m.registry,{...s.init,layout:s.layout});}
        else if(command==='apply')await applyEnterpriseMysqlV4(c,m.registry,{...binding(s,m),confirmOffline:true,confirmBackup:true,confirmDrained:true,resume:options.resume});
        else if(command==='register')await registerEnterpriseMysqlV4(c,m.previousRegistry!,m.registry,{confirmOffline:true,confirmDrained:true,expectedRegistryRevision:m.previousRegistry!.registryRevision});
        else if(!s.init && !m.previousRegistry)await verifyEnterpriseMysqlMigrationV4(c,m.registry,binding(s,m));
        const state=await validateEnterpriseMysqlV4(c,'proxy',m.registry);insist(state.layout===s.layout,'mysql_layout_mismatch');observed.push(canonicalEnterpriseIdentityRegistryV3(state.registry));components.push({component:'proxy',driver:'mysql',state:command==='init'?'initialized':command==='register'?'registered':command==='verify'?'verified':'complete',layout:state.layout,schemaVersion:4});
      }
    }finally{try{await c.end();}catch{/* Deadline may have destroyed connection. */}}
  }
  if(options.planOut){const fd=openSync(options.planOut,'wx',0o600);try{writeFileSync(fd,JSON.stringify(m,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
  const pairedRegistry=observed.length===3 && new Set(observed).size===1;return{command,ready:['init','apply','verify','register'].includes(command) && pairedRegistry,pairedRegistry,components};
}
