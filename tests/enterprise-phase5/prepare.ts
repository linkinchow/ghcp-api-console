import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { normalizePoolConfig, readPoolConfig } from '../../src/proxy/src/userPool/config.js';
// No service config, dotenv or database driver is imported while preparing files.
// @ts-ignore JS safety module is shared with host-only controllers.
import { absolutePath, assertOwnedContainer, DATABASES, exclusiveJson, exclusiveWrite, insist, loadState, noSymlinkPath, safeError, validateState, within } from './safety.mjs';

type Options = { runId:string; root:string; mode:'init'|'migration'; head:string; sourceSha256:string; mysqlPort?:number; restorePort?:number; uiPort?:number; mysqlImage?:string; haproxyImage?:string; toolingImage?:string; dryRun?:boolean; adoptEmptyOwnedDirs?:boolean };
const ids = ['a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002'];
const secret = () => `p5_${randomBytes(24).toString('hex')}`;
export function createFixtureDescription(options:Options) {
  options={...options,root:absolutePath(options.root)}; noSymlinkPath(options.root);
  insist(/^[a-z0-9][a-z0-9-]{0,31}$/.test(options.runId) && basename(options.root) === `phase5-${options.runId}`, 'root_run_id');
  insist(['init','migration'].includes(options.mode), 'mode');
  const project = `ghcp-enterprise-phase5-${options.runId}`;
  const credentials = {internalApiToken:secret(),fixtureToken:secret(),defaultPassword:secret(),consoleUsername:'phase5-admin',consolePassword:secret(),sessionSecret:secret(),mysqlRootPassword:secret(),mysqlPassword:secret(),apiKey:secret(),enterprises:Object.fromEntries(ids.map(id => [id,{scimToken:secret(),githubPat:secret(),defaultPassword:secret()}]))};
  const registry = parseEnterpriseRegistryV3({version:3,registryRevision:1,legacyEnterpriseId:ids[0],profiles:ids.map((id,index) => {
    const letter = index === 0 ? 'a' : 'b', base = index === 0 ? 'http://sso:7001' : `http://sso:7001/profiles/${id}`;
    return {id,slug:`phase5-${letter}`,shortcode:`p5${letter}${letter}`,accountDomain:`pool-${letter}.invalid`,revision:1,maxAccounts:6,
      routes:{proxyInternalUrl:'http://proxy-lb:3000',ssoInternalUrl:'http://sso:7001',loginInternalUrl:'http://login:7003',ssoPublicUrl:'http://sso:7001'},
      sso:{entityId:`${base}/metadata`,ssoUrl:`${base}/sso`,loginUrl:`${base}/login`,logoutUrl:`${base}/logout`,spEntityId:`http://provider:8000/sp/${id}`,spAcsUrl:`http://provider:8000/acs/${id}`,scimBaseUrl:`http://provider:8000/scim/v2/enterprises/phase5-${letter}`,githubApiBaseUrl:`http://provider:8000/github/${id}`,emailDomain:`pool-${letter}.invalid`,userPrefix:'user',signingCertRef:{file:`/fixture/secrets/${id}/cert.pem`},signingKeyRef:{file:`/fixture/secrets/${id}/key.pem`},sessionSecretRef:{file:`/fixture/secrets/${id}/session.txt`},scimTokenRef:{file:`/fixture/secrets/${id}/scim.txt`},seatPatRef:{file:`/fixture/secrets/${id}/pat.txt`},defaultPasswordRef:{file:`/fixture/secrets/${id}/password.txt`}},
      login:{provider:'custom',allowedLoginUrls:[`${base}/login`],selectors:{ssoUsernameInput:'input[name="username"]',ssoPasswordInput:'input[name="password"]',ssoSubmit:'button[type="submit"]'}}};
  })});
  const pool = {version:1,idle_target:0,lease_seconds:120,paused:1,next_ordinal:0,account_domain:'pool-a.invalid',owner:null,owner_until:0};
  const poolConfig = normalizePoolConfig(readPoolConfig({ACCOUNT_ROUTING_MODE:'caller-lease',STORAGE_DRIVER:'mysql',POOL_ACCOUNT_EMAIL_DOMAIN:'pool-a.invalid',READY_IDLE_TARGET:'0',POOL_MAX_ACCOUNTS:'12',CALLER_LEASE_TTL_SECONDS:'120',PROVISIONAL_LEASE_TTL_SECONDS:'20',PREWARM_POLL_SECONDS:'1',PREWARM_CONCURRENCY:'2',POOL_LOGIN_MAX_PENDING:'5',POOL_EXHAUSTED_RETRY_AFTER_SECONDS:'2',POOL_WARMUP_MODEL:'phase5-synthetic',POOL_REQUEST_TIMEOUT_SECONDS:'30'}));
  const {idleTarget:_idle,maxAccounts:_max,leaseSeconds:_lease,enabled:_enabled,callerDomain:_caller,...invariants}=poolConfig;
  const fingerprint=createHash('sha256').update(JSON.stringify(Object.entries(invariants).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  const state = {fixtureVersion:1,syntheticOnly:true,runId:options.runId,project,root:options.root,mode:options.mode,registryFile:'/fixture/registry.json',legacyEnterpriseId:ids[0],enterpriseIds:ids,
    origins:{proxy:'http://proxy-lb:3000',sso:'http://sso:7001',login:'http://login:7003',console:'http://console:7004',provider:'http://provider:8000',proxyReplicas:[1,2,3].map(n=>`http://proxy-${n}:3000`)},credentials,pool,poolConfig,fingerprint,
    paths:{fixture:'/fixture',state:'/fixture/state.json',registry:'/fixture/registry.json',secrets:'/fixture/secrets',ssoDb:'/fixture/data/sso/sso.sqlite',loginDb:'/fixture/data/login/login.sqlite',adminsFile:'/fixture/data/console/admins.json',results:'/results',backups:'/backups',initManifest:'/fixture/init-v4.json'},
    hostPaths:{fixture:join(options.root,'fixture'),results:join(options.root,'results'),backups:join(options.root,'backups'),source:join(options.root,'workspace')},
    source:{head:options.head,bundleSha256:options.sourceSha256,dirty:true},
    database:{host:'mysql',port:3306,hostAddress:'127.0.0.1',hostPort:options.mysqlPort??33195,restoreHostPort:options.restorePort??33196,name:options.mode==='migration'?'ghcp_enterprise_test_phase5_chain':DATABASES[0],username:'phase5',password:credentials.mysqlPassword,rootPassword:credentials.mysqlRootPassword,schemas:[...DATABASES]},uiPort:options.uiPort??18195,
    images:{tooling:options.toolingImage??`ghcp-phase5-tooling:${options.runId}`,proxy:`ghcp-phase5-proxy:${options.runId}`,sso:`ghcp-phase5-sso:${options.runId}`,login:`ghcp-phase5-login:${options.runId}`,console:`ghcp-phase5-console:${options.runId}`,mysql:options.mysqlImage??'mysql:8.4',haproxy:options.haproxyImage??'haproxy:3.0-alpine'},ownership:{containers:{}}};
  validateState(state);
  const manifest = {manifestVersion:4,sourceSchemaVersion:3,registry,services:[
    {component:'proxy',driver:'mysql',layout:'pool',location:{host:'127.0.0.1',port:state.database.hostPort,database:state.database.name,connectionEnv:'ENTERPRISE_MYSQL_PHASE5_INIT'},init:{pool:{settings:pool,fingerprint}}},
    {component:'sso',driver:'sqlite',layout:'sso',target:state.paths.ssoDb},
    {component:'login',driver:'sqlite',layout:'login',target:state.paths.loginDb},
  ],attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true}};
  return {state,registry,manifest};
}
export async function prepare(options:Options) {
  const {state,registry,manifest} = createFixtureDescription(options);
  if (options.dryRun) return {ok:true,dryRun:true,dbConnections:0,filesWritten:0,runId:state.runId,mode:state.mode,profiles:registry.profiles.length,paused:state.pool.paused,initialPolicy:state.mode==='init'?'draft':'not-initialized'};
  insist(existsSync(state.root) && realpathSync(state.root) === state.root, 'existing_run_root_required');
  // Main may already have created empty output directories during source upload.
  // Adopting them is explicit, requires the same run marker, and never deletes contents.
  insist(!existsSync(state.hostPaths.fixture), 'output_exists');
  if(options.adoptEmptyOwnedDirs) {
    const marker=join(state.root,'owner.json');noSymlinkPath(marker);
    const owner=JSON.parse(readFileSync(marker,'utf8'));
    insist(owner.runId===state.runId && owner.syntheticOnly===true,'root_owner');
  }
  for(const path of [state.hostPaths.results,state.hostPaths.backups]) {
    noSymlinkPath(path);
    if(existsSync(path)) insist(options.adoptEmptyOwnedDirs && statSync(path).isDirectory() && readdirSync(path).length===0,'output_exists');
  }
  for (const path of [state.hostPaths.fixture,state.hostPaths.results,state.hostPaths.backups]) if(!existsSync(path))mkdirSync(path,{mode:0o700});
  const fixture=state.hostPaths.fixture;
  for(const path of ['secrets','data','data/sso','data/login','data/login/logs','data/console']) mkdirSync(join(fixture,path),{mode:0o700});
  for(const id of ids) {
    const directory=join(fixture,'secrets',id);mkdirSync(directory,{mode:0o700});
    const child=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj',`/CN=phase5-${state.runId}-${id.slice(0,8)}.invalid`,'-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdio:'ignore',timeout:30000});
    insist(!child.error && child.status===0,'certificate_generation');
    for(const name of ['key.pem','cert.pem']) chmodSync(join(directory,name),0o600);
    // Secret readers preserve bytes; a newline changes passwords and bearer tokens.
    for(const [name,value] of Object.entries({session:secret(),scim:state.credentials.enterprises[id]!.scimToken,pat:state.credentials.enterprises[id]!.githubPat,password:state.credentials.enterprises[id]!.defaultPassword})) exclusiveWrite(join(directory,`${name}.txt`),value);
  }
  if(state.mode==='init') {
    const salt=randomBytes(16).toString('hex');
    exclusiveJson(join(fixture,'data/console/admins.json'),[{username:state.credentials.consoleUsername,password_hash:scryptSync(state.credentials.consolePassword,salt,64).toString('hex'),salt,role:'admin',enabled:true}]);
    exclusiveJson(join(fixture,'init-v4.json'),manifest);
  }
  exclusiveJson(join(fixture,'registry.json'),registry);
  exclusiveJson(join(fixture,'state.json'),state);
  const runtimeUrl=`mysql://${state.database.username}:${state.database.password}@mysql:3306/${state.database.name}`;
  const env={PHASE5_RUN_ID:state.runId,PHASE5_FIXTURE_DIR:fixture,PHASE5_RESULTS_DIR:state.hostPaths.results,PHASE5_SOURCE_DIR:state.hostPaths.source,PHASE5_INTERNAL_TOKEN:state.credentials.internalApiToken,PHASE5_SESSION_SECRET:state.credentials.sessionSecret,PHASE5_DEFAULT_PASSWORD:state.credentials.defaultPassword,PHASE5_API_KEY:state.credentials.apiKey,PHASE5_MYSQL_ROOT_PASSWORD:state.database.rootPassword,PHASE5_RUNTIME_MYSQL_URL:runtimeUrl,PHASE5_MYSQL_PORT:String(state.database.hostPort),PHASE5_RESTORE_PORT:String(state.database.restoreHostPort),PHASE5_UI_PORT:String(state.uiPort),...Object.fromEntries(Object.entries(state.images).map(([key,value])=>[`PHASE5_${key.toUpperCase()}_IMAGE`,value]))};
  insist(Object.values(env).every(value=>!/['\r\n\x00]/u.test(value)),'env_value');
  exclusiveWrite(join(fixture,'compose.env'),Object.entries(env).map(([key,value])=>`${key}='${value}'`).join('\n')+'\n');
  exclusiveJson(join(fixture,'file-hashes.json'),{composeEnv:createHash('sha256').update(readFileSync(join(fixture,'compose.env'))).digest('hex')});
  // Dedicated integration URLs are private output, not deployment defaults. No MYSQL_URL fallback.
  exclusiveWrite(join(fixture,'test.env'),state.database.schemas.map((name:string)=>`PHASE5_URL_${name.replace('ghcp_enterprise_test_phase5_','').toUpperCase()}='mysql://root:${state.database.rootPassword}@127.0.0.1:${state.database.hostPort}/${name}'`).join('\n')+'\n');
  return {ok:true,dryRun:false,dbConnections:0,runId:state.runId,mode:state.mode,paused:1,initialPolicy:state.mode==='init'?'draft':'not-initialized',next:state.mode==='init'?'guarded-db-prepare-then-initialize':'owner-a-migration-chain'};
}
export async function initialize(stateFile:string,inspectFile:string,output:string) {
  const state=loadState(stateFile);
  insist(process.env.PHASE5_SYNTHETIC_ONLY==='1' && process.env.PHASE5_DB_ALLOW_DDL==='1','explicit_ddl_gate');
  insist(state.mode==='init' && stateFile==='/fixture/state.json','init_only_in_tooling');
  within('/results',inspectFile);within('/results',output);
  insist(!existsSync(output),'init_output');
  noSymlinkPath(inspectFile);noSymlinkPath(output);
  insist(Date.now()-statSync(inspectFile).mtimeMs<300000 && Date.now()-statSync(inspectFile).mtimeMs>=-30000,'stale_inspect');
  const inspection=JSON.parse(readFileSync(inspectFile,'utf8'));
  assertOwnedContainer(state,inspection,'mysql');
  insist(!existsSync(state.paths.ssoDb) && !existsSync(state.paths.loginDb),'init_target_exists');
  // Import only after all gates. Public tool enforces numeric loopback + actual peer.
  const {runEnterpriseCommandV4}=await import('../../upgrade/multi-enterprise-pool/commands.js');
  const manifest=JSON.parse(readFileSync(state.paths.initManifest,'utf8'));
  insist(JSON.stringify(manifest.registry)===JSON.stringify(JSON.parse(readFileSync(state.registryFile,'utf8'))),'init_registry_binding');
  insist(manifest.services[0]?.location?.host==='127.0.0.1' && manifest.services[0]?.location?.port===state.database.hostPort && manifest.services[0]?.location?.database===state.database.name,'init_db_binding');
  insist(manifest.services[1]?.target===state.paths.ssoDb && manifest.services[2]?.target===state.paths.loginDb,'init_sqlite_binding');
  const env={ENTERPRISE_MYSQL_PHASE5_INIT:`mysql://root:${state.database.rootPassword}@127.0.0.1:${state.database.hostPort}/${state.database.name}`};
  const initialized=await runEnterpriseCommandV4('init',manifest,{env});
  const verified=await runEnterpriseCommandV4('verify',manifest,{env});
  insist(initialized.ready && verified.ready,'init_not_ready');
  const result={ok:true,runId:state.runId,stage:'fresh-init',paused:true,policy:'all-draft',initialized,verified};
  exclusiveJson(output,result);return result;
}
async function main() {
  const args=process.argv.slice(2),flags=new Map<string,string|true>();
  while(args.length){const key=args.shift()!;insist(!flags.has(key),'duplicate_flag');if(['--dry-run','--initialize','--adopt-empty-owned-dirs'].includes(key))flags.set(key,true);else{const value=args.shift();insist(value&&!value.startsWith('--'),'flag_value');flags.set(key,value!);}}
  let result:unknown;
  if(flags.has('--initialize')) {
    insist([...flags.keys()].every(k=>['--initialize','--state','--inspect','--output'].includes(k)),'unknown_flag');
    result=await initialize(String(flags.get('--state')),String(flags.get('--inspect')),String(flags.get('--output')));
  } else {
    insist([...flags.keys()].every(k=>['--run-id','--root','--mode','--head','--source-sha256','--mysql-port','--restore-port','--ui-port','--mysql-image','--haproxy-image','--tooling-image','--dry-run','--adopt-empty-owned-dirs'].includes(k)),'unknown_flag');
    result=await prepare({runId:String(flags.get('--run-id')),root:String(flags.get('--root')),mode:String(flags.get('--mode')) as Options['mode'],head:String(flags.get('--head')),sourceSha256:String(flags.get('--source-sha256')),dryRun:flags.has('--dry-run'),adoptEmptyOwnedDirs:flags.has('--adopt-empty-owned-dirs'),...(flags.has('--mysql-port')?{mysqlPort:Number(flags.get('--mysql-port'))}:{}),...(flags.has('--restore-port')?{restorePort:Number(flags.get('--restore-port'))}:{}),...(flags.has('--ui-port')?{uiPort:Number(flags.get('--ui-port'))}:{}),...(flags.has('--mysql-image')?{mysqlImage:String(flags.get('--mysql-image'))}:{}),...(flags.has('--haproxy-image')?{haproxyImage:String(flags.get('--haproxy-image'))}:{}),...(flags.has('--tooling-image')?{toolingImage:String(flags.get('--tooling-image'))}:{})});
  }
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{process.stderr.write(JSON.stringify({ok:false,error:safeError(error)})+'\n');process.exitCode=1;});
