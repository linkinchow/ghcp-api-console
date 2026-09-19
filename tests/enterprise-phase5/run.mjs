import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolutePath, assertOwnedContainer, exclusiveJson, exclusiveWrite, insist, loadState, noSymlinkPath, safeError, SERVICES, validateState, within } from './safety.mjs';

const APP = SERVICES.filter(s => !['mysql','mysql-restore'].includes(s));
const here = dirname(fileURLToPath(import.meta.url));
// Per-invocation context is established only AFTER the full host state gate.
// Never fall back to cwd, HOME, a caller-supplied output directory, or .env.
const controllerContext = new AsyncLocalStorage();
export function recordDockerFailure(state,args,result) {
  validateState(state);
  const directory=join(state.hostPaths.results,'private');within(state.root,directory);noSymlinkPath(directory);
  if(!existsSync(directory))mkdirSync(directory,{mode:0o700});
  insist(statSync(directory).isDirectory() && realpathSync(directory)===directory,'diagnostic_directory');
  const path=join(directory,`controller-error-${Date.now()}-${randomBytes(8).toString('hex')}.json`);
  // Raw child output can contain credentials: private 0600 evidence ONLY.
  // Environment values are deliberately not captured. Public CLI stays safeError.
  exclusiveJson(path,{version:1,syntheticOnly:true,runId:state.runId,project:state.project,
    executable:'docker',args:['--context','default',...args],exitCode:result.status??null,
    signal:result.signal??null,errorCode:result.error?.code??null,
    errorMessage:result.error?.message??null,stderr:String(result.stderr??'').slice(0,1024*1024),
    stdout:String(result.stdout??'').slice(0,1024*1024)});
  return path;
}
// Never inherit Compose interpolation/default .env, deployment MYSQL_URL, or remote Docker context.
function docker(args, extraEnv={}, timeout=600000) {
  const env=Object.fromEntries(['PATH','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','TMP','TEMP','DOCKER_CONFIG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const result=spawnSync('docker',['--context','default',...args],{encoding:'utf8',timeout,maxBuffer:16*1024*1024,env:{...env,...extraEnv}});
  if(result.error || result.status!==0) {
    let diagnosticRecorded=false;
    const state=controllerContext.getStore();
    if(state)try{recordDockerFailure(state,args,result);diagnosticRecorded=true;}catch{/* Keep the original safe error if evidence storage fails. */}
    throw new Error('phase5_docker_command_failed',{cause:{diagnosticRecorded}});
  }
  return result.stdout.trim();
}
function compose(state,args,timeout=600000) {
  return docker(['compose','--project-name',state.project,'--project-directory',state.hostPaths.source,'--env-file',join(state.hostPaths.fixture,'compose.env'),'-f',join(state.hostPaths.source,'tests/enterprise-phase5/compose.yaml'),...args],{},timeout);
}
function inspect(id){return JSON.parse(docker(['inspect',id]));}
/** All inspect rows are exact owned IDs; no CLI-specific start --wait assumption. */
export function ownedStartupReady(state,services,rows) {
  insist(Array.isArray(services) && services.length>0 && new Set(services).size===services.length && services.every(s=>SERVICES.includes(s)),'startup_services');
  insist(Array.isArray(rows) && rows.length===services.length,'startup_inspections');
  let ready=true;
  for(const service of services) {
    const id=state.ownership.containers[service]?.id;
    const matches=rows.filter(row=>row.Id===id);insist(matches.length===1,'startup_container_missing');
    const row=assertOwnedContainer(state,matches[0],service),status=row.State;
    insist(status && !['dead','exited','removing','paused','restarting'].includes(status.Status),'startup_container_failed');
    const health=status.Health?.Status,hasHealth=Array.isArray(row.Config?.Healthcheck?.Test) && row.Config.Healthcheck.Test[0]!=='NONE';
    insist(health!=='unhealthy','startup_container_unhealthy');
    if(status.Running!==true || status.Status!=='running' || (hasHealth && health!=='healthy'))ready=false;
  }
  return ready;
}
async function startOwned(state,services) {
  insist(services.every(service=>SERVICES.includes(service) && state.ownership.containers[service]),'startup_services');
  const ids=services.map(service=>state.ownership.containers[service].id);
  const before=JSON.parse(docker(['inspect',...ids],{},10000));
  for(const service of services) {
    const rows=before.filter(row=>row.Id===state.ownership.containers[service].id);insist(rows.length===1,'startup_container_missing');assertOwnedContainer(state,rows[0],service);
  }
  const deadline=Date.now()+240000;
  // `start` never creates/recreates; Compose 2.40.3 does not support start --wait.
  compose(state,[...(services.includes('mysql-restore')?['--profile','restore']:[]),'start',...services],Math.max(1,deadline-Date.now()));
  let lastRows=[];
  try {
    while(Date.now()<deadline) {
      lastRows=JSON.parse(docker(['inspect',...ids],{},Math.max(1,Math.min(10000,deadline-Date.now()))));
      if(ownedStartupReady(state,services,lastRows))return;
      await new Promise(resolvePromise=>setTimeout(resolvePromise,Math.min(1000,Math.max(0,deadline-Date.now()))));
    }
    throw new Error('phase5_startup_deadline');
  } catch(error) {
    // Health logs may contain private application diagnostics. Same guarded sink.
    try{recordDockerFailure(state,['inspect',...ids],{status:null,error:{code:safeError(error)},stderr:JSON.stringify(lastRows),stdout:''});}catch{/* Preserve safe original error. */}
    throw error;
  }
}
function requireCachedImages(state,keys){
  for(const key of new Set(keys)) {
    const rows=JSON.parse(docker(['image','inspect',state.images[key]]));
    insist(rows.length===1 && /^sha256:[a-f0-9]{64}$/.test(rows[0]?.Id),'image_not_cached');
  }
}
function hostState(file){
  const state=loadState(file);
  insist(process.env.PHASE5_SYNTHETIC_ONLY==='1','synthetic_environment');
  insist(dirname(file)===state.hostPaths.fixture,'host_state_required');
  insist(realpathSync(join(state.hostPaths.source,'tests/enterprise-phase5'))===here,'source_location');
  for(const path of [state.root,...Object.values(state.hostPaths)])noSymlinkPath(path);
  insist(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT,'remote_docker_refused');
  // Bind generated secrets to immutable state. Never load arbitrary dotenv content.
  const env=readFileSync(join(state.hostPaths.fixture,'compose.env'),'utf8');
  insist(createHash('sha256').update(env).digest('hex')===JSON.parse(readFileSync(join(state.hostPaths.fixture,'file-hashes.json'),'utf8')).composeEnv,'compose_env_changed');
  return state;
}
async function portFree(port){
  await new Promise((resolvePromise,reject)=>{const server=createTcpServer();server.once('error',()=>reject(new Error('phase5_port_in_use')));server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(resolvePromise));});
}
function ownedResource(state,type,name) {
  const rows=JSON.parse(docker([type,'inspect',name]));const labels=rows[0]?.Labels;
  insist(labels?.['com.docker.compose.project']===state.project && labels?.['io.ghcp.phase5.run-id']===state.runId && labels?.['io.ghcp.phase5.synthetic']==='true','resource_labels');
}
function assertProject(state) {
  const ids=docker(['ps','-aq','--filter',`label=com.docker.compose.project=${state.project}`]).split(/\s+/).filter(Boolean);
  for(const id of ids){const rows=inspect(id),service=rows[0]?.Config?.Labels?.['com.docker.compose.service'];assertOwnedContainer(state,rows,service);}
  return ids;
}
function saveOwnership(state,services,leaf) {
  const containers={};
  for(const service of services){
    const id=compose(state,['ps','-aq',service]);insist(/^[a-f0-9]{64}$/.test(id),'created_container_id');
    containers[service]={id,name:`${state.project}-${service}-1`};
    const candidate={...state,ownership:{containers:{...state.ownership.containers,...containers}}};
    assertOwnedContainer(candidate,inspect(id),service);
  }
  exclusiveJson(join(state.hostPaths.fixture,leaf),{syntheticOnly:true,runId:state.runId,project:state.project,root:state.root,containers});
}
function outputPath(state,value){absolutePath(value);within(state.hostPaths.results,value);noSymlinkPath(value);insist(!existsSync(value),'output_exists');return value;}
function inspectionFile(state,service){
  const row=assertOwnedContainer(state,inspect(state.ownership.containers[service]?.id),service);
  const file=join(state.hostPaths.results,`${service}-inspect-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  exclusiveJson(file,[row]);return `/results/${file.slice(state.hostPaths.results.length+1)}`;
}
function hostTool(state,entry,args,writeFixture=false){
  requireCachedImages(state,['tooling']);
  const name=`${state.project}-tool-${randomBytes(5).toString('hex')}`;
  return docker(['run','--pull','never','--rm','--name',name,'--network','host','--label',`io.ghcp.phase5.run-id=${state.runId}`,'--label','io.ghcp.phase5.synthetic=true','--label',`com.docker.compose.project=${state.project}`,
    '--mount',`type=bind,source=${state.hostPaths.fixture},target=/fixture${writeFixture?'':',readonly'}`,
    '--mount',`type=bind,source=${state.hostPaths.results},target=/results`,
    '--mount',`type=bind,source=${state.hostPaths.backups},target=/backups`,
    '-e','PHASE5_SYNTHETIC_ONLY=1','-e','PHASE5_DB_ALLOW_DDL=1',state.images.tooling,'node','--import','tsx',`/app/tests/enterprise-phase5/${entry}`,...args]);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const MIGRATED_FILES = Object.freeze({sso:['chain/sso-v4.sqlite','data/sso/sso.sqlite'],login:['chain/login-v4.sqlite','data/login/login.sqlite'],admins:['chain/admins.json','data/console/admins.json']});
function readAdoption(state) {
  validateState(state);insist(state.mode==='migration','migration_mode_required');
  const root=state.hostPaths.fixture;
  const read=leaf=>{const path=join(root,leaf);within(root,path);noSymlinkPath(path);return readFileSync(path);};
  const bytes=read('chain/adoption.json'),proof=JSON.parse(bytes.toString('utf8'));
  insist(proof.version===1 && proof.syntheticOnly===true && proof.status==='PASS' && proof.stage==='verify' && proof.runtimeStarted===false,'adoption_not_verified');
  insist(proof.runId===state.runId && proof.project===state.project && proof.mysqlContainerId===state.ownership.containers.mysql?.id && proof.schema===state.database.name,'adoption_binding');
  insist(proof.sourceBundleSha256===state.source.bundleSha256 && proof.stateSha256===digest(read('state.json')),'adoption_source_binding');
  insist(proof.registrySha256===digest(read('registry.json')) && proof.v4PlanSha256===digest(read('chain/v4-plan.json')) && proof.baselineSha256===digest(read('chain/baseline.json')),'adoption_metadata_binding');
  insist(proof.files && Object.keys(proof.files).sort().join(',')==='admins,login,sso','adoption_files');
  const files={};
  for(const [key,[source,target]] of Object.entries(MIGRATED_FILES)) {
    const file=proof.files[key];insist(file?.path===`/fixture/${source}` && /^[a-f0-9]{64}$/.test(file.sha256),'adoption_file_path');
    if(key!=='admins') for(const suffix of ['-wal','-shm','-journal'])insist(!existsSync(join(root,source)+suffix),'adoption_sqlite_sidecar');
    const sourceBytes=read(source);insist(digest(sourceBytes)===file.sha256,'adoption_file_hash');
    files[key]={target:join(root,target),bytes:sourceBytes,sha256:file.sha256};
  }
  return {proof,files,evidenceSha256:digest(bytes)};
}
/** Host-only, no SQL. Caller must supply a fresh Docker inspection before copies. */
export function adoptMigratedFiles(state,inspection) {
  insist(process.env.PHASE5_SYNTHETIC_ONLY==='1','synthetic_environment');
  assertOwnedContainer(state,inspection,'mysql');
  insist(!Object.keys(state.ownership.containers).some(service=>APP.includes(service)) && !existsSync(join(state.hostPaths.fixture,'ownership-app.json')),'adoption_app_exists');
  const {proof,files,evidenceSha256}=readAdoption(state),receipt=join(state.hostPaths.fixture,'adoption-receipt.json');
  noSymlinkPath(receipt);insist(!existsSync(receipt),'adoption_exists');
  // Validate ALL targets before writing the first. A failed partial copy stays evidence.
  for(const file of Object.values(files)) {
    noSymlinkPath(file.target);insist(!existsSync(file.target),'adoption_target_exists');
    for(const suffix of ['-wal','-shm','-journal'])insist(!existsSync(file.target+suffix),'adoption_target_sidecar');
  }
  for(const file of Object.values(files)) {
    exclusiveWrite(file.target,file.bytes);insist(digest(readFileSync(file.target))===file.sha256,'adoption_copy_hash');
  }
  exclusiveJson(receipt,{version:1,status:'PASS',stage:'adopt-migrated',syntheticOnly:true,runId:state.runId,project:state.project,mysqlContainerId:proof.mysqlContainerId,schema:state.database.name,evidenceSha256,stateSha256:proof.stateSha256,files:Object.fromEntries(Object.entries(files).map(([key,file])=>[key,{path:`/fixture/${MIGRATED_FILES[key][1]}`,sha256:file.sha256}])),runtimeStarted:false});
  return {ok:true,command:'adopt-migrated',runId:state.runId,filesCopied:3,databaseMutated:false,runtimeStarted:false};
}
function assertAdoptedBeforeBoot(state) {
  const {proof,files,evidenceSha256}=readAdoption(state),path=join(state.hostPaths.fixture,'adoption-receipt.json');noSymlinkPath(path);
  const receipt=JSON.parse(readFileSync(path,'utf8'));
  insist(receipt.version===1 && receipt.status==='PASS' && receipt.stage==='adopt-migrated' && receipt.syntheticOnly===true && receipt.runId===state.runId && receipt.project===state.project && receipt.mysqlContainerId===proof.mysqlContainerId && receipt.schema===state.database.name && receipt.evidenceSha256===evidenceSha256 && receipt.stateSha256===proof.stateSha256 && receipt.runtimeStarted===false,'adoption_receipt');
  for(const [key,file] of Object.entries(files)) {
    noSymlinkPath(file.target);
    insist(receipt.files?.[key]?.path===`/fixture/${MIGRATED_FILES[key][1]}` && receipt.files[key].sha256===file.sha256 && digest(readFileSync(file.target))===file.sha256,'adoption_target_changed');
  }
}
export function consoleBridge(stateFile) {
  const state=loadState(stateFile);insist(process.env.PHASE5_SYNTHETIC_ONLY==='1' && stateFile==='/fixture/state.json','bridge_gate');
  const server=createServer((incoming,outgoing)=>{
    // Fixed target only; preserve browser Host (including port), Origin and cookies.
    // In particular do not disguise an origin mismatch by rewriting these headers.
    if(!incoming.url?.startsWith('/') || incoming.url.startsWith('//')){outgoing.writeHead(400);outgoing.end();return;}
    const target=request({hostname:'console',port:7004,path:incoming.url,method:incoming.method,headers:incoming.headers,timeout:65000},response=>{outgoing.writeHead(response.statusCode??502,response.headers);response.pipe(outgoing);});
    target.on('timeout',()=>target.destroy());
    target.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502,{'content-type':'text/plain'});outgoing.end('phase5_console_unavailable');});
    incoming.on('aborted',()=>target.destroy());outgoing.on('close',()=>target.destroy());incoming.pipe(target);
  });
  server.listen(18195,'0.0.0.0');return server;
}
export async function control(command,stateFile,options={}) {
  const state=hostState(stateFile);
  return controllerContext.run(state,()=>controlValidated(command,stateFile,options,state));
}
async function controlValidated(command,stateFile,options,state) {
  if(command==='mysql-up' || command==='restore-up') {
    const service=command==='mysql-up'?'mysql':'mysql-restore',isRestore=service==='mysql-restore';
    insist(!state.ownership.containers[service],'already_created');
    if(isRestore) {
      assertProject(state);
      ownedResource(state,'network',`${state.project}_database-access`);
    }
    else insist(docker(['ps','-aq','--filter',`label=com.docker.compose.project=${state.project}`])==='','project_exists');
    const volume=`${state.project}_${isRestore?'mysql-restore-data':'mysql-data'}`;
    insist(!docker(['volume','ls','--format','{{.Name}}']).split('\n').includes(volume),'volume_exists');
    if(!isRestore) for(const suffix of ['isolated','database-access','preview'])insist(!docker(['network','ls','--format','{{.Name}}']).split('\n').includes(`${state.project}_${suffix}`),'network_exists');
    await portFree(isRestore?state.database.restoreHostPort:state.database.hostPort);
    requireCachedImages(state,['mysql']);
    compose(state,[...(isRestore?['--profile','restore']:[]),'create','--pull','never','--no-build','--no-recreate',service]);
    saveOwnership(state,[service],isRestore?'ownership-restore.json':'ownership-mysql.json');
    const owned=loadState(stateFile);assertOwnedContainer(owned,inspect(owned.ownership.containers[service].id),service);
    ownedResource(owned,'volume',volume);ownedResource(owned,'network',`${state.project}_isolated`);
    ownedResource(owned,'network',`${state.project}_database-access`);
    await startOwned(owned,[service]);
    return {ok:true,command,service,runId:state.runId};
  }
  if(command==='start-owned') {
    insist(['mysql','mysql-restore'].includes(options.service),'startup_service');
    assertProject(state);ownedResource(state,'network',`${state.project}_database-access`);await startOwned(state,[options.service]);
    return {ok:true,command,runId:state.runId,service:options.service,recreated:false};
  }
  if(command==='db-prepare' || command==='init') {
    const service=options.service??'mysql';insist(['mysql','mysql-restore'].includes(service),'db_service');
    insist(command!=='init'||service==='mysql','init_service');assertProject(state);
    const output=outputPath(state,options.output),inspection=inspectionFile(state,service),containerOutput=`/results/${output.slice(state.hostPaths.results.length+1)}`;
    hostTool(state,command==='db-prepare'?'db-prepare.ts':'prepare.ts',[...(command==='init'?['--initialize']:[]),'--state','/fixture/state.json','--inspect',inspection,'--output',containerOutput,...(command==='db-prepare'?['--service',service]:[])],command==='init');
    const result=JSON.parse(readFileSync(output,'utf8'));insist(command==='db-prepare'?result.status==='PASS':result.ok===true,'stage_not_ok');return {ok:true,command,runId:state.runId};
  }
  if(command==='adopt-migrated') {
    assertProject(state);
    return adoptMigratedFiles(state,inspect(state.ownership.containers.mysql?.id));
  }
  if(command==='app-up') {
    assertProject(state);insist(!existsSync(join(state.hostPaths.fixture,'ownership-app.json')),'app_exists');
    if(state.mode==='migration')assertAdoptedBeforeBoot(state);
    for(const path of ['data/sso/sso.sqlite','data/login/login.sqlite','data/console/admins.json'])insist(existsSync(join(state.hostPaths.fixture,path)),'runtime_data_missing');
    await portFree(state.uiPort);
    requireCachedImages(state,['tooling','proxy','sso','login','console','haproxy']);
    compose(state,['create','--pull','never','--no-build','--no-recreate',...APP]);
    for(const service of Object.keys(state.ownership.containers))assertOwnedContainer(state,inspect(state.ownership.containers[service].id),service);
    saveOwnership(state,APP,'ownership-app.json');
    const owned=loadState(stateFile);assertProject(owned);ownedResource(owned,'network',`${state.project}_preview`);
    await startOwned(owned,APP);return {ok:true,command,runId:state.runId};
  }
  if(command==='fullstack' || command==='stable') {
    if(state.mode==='migration')insist(command==='fullstack' && options.mode==='migrated-smoke','migration_smoke_only');
    else insist(options.mode!=='migrated-smoke','migration_mode_required');
    assertProject(state);const output=outputPath(state,options.output),entry=command==='fullstack'?'fullstack.ts':'stable-window.ts';
    requireCachedImages(state,['tooling']);
    compose(state,['run','--pull','never','--rm','--no-deps','tooling','node','--import','tsx',`/app/tests/enterprise-phase5/${entry}`,'--state','/fixture/state.json','--output',`/results/${output.slice(state.hostPaths.results.length+1)}`,...(command==='fullstack'?['--mode',options.mode??'smoke']:[])]);
    insist(existsSync(output),'result_missing');return {ok:true,command,runId:state.runId,result:'inspect-output-for-assertions'};
  }
  if(command==='inspect') {assertProject(state);return {ok:true,command,runId:state.runId,services:Object.keys(state.ownership.containers)};}
  if(['stop','kill','restart','down'].includes(command)) {
    const ids=assertProject(state);insist(ids.length>0,'empty_project');
    if(command==='kill' || command==='restart') {
      insist(['proxy-1','proxy-2','proxy-3','mysql'].includes(options.service),'fault_service');
      const own=state.ownership.containers[options.service];assertOwnedContainer(state,inspect(own?.id),options.service);
      docker(command==='kill'?['kill','--signal','KILL',own.id]:['start',own.id]);
    } else if(command==='stop') {
      for(const id of ids)docker(['stop','--time','20',id]);
    } else {
      // Explicit down removes owned containers/networks only. Never -v or prune.
      for(const name of docker(['network','ls','--filter',`label=com.docker.compose.project=${state.project}`,'--format','{{.Name}}']).split('\n').filter(Boolean))ownedResource(state,'network',name);
      compose(state,['--profile','restore','down','--timeout','20']);
    }
    return {ok:true,command,runId:state.runId,volumesRetained:true};
  }
  throw new Error('phase5_unknown_command');
}
async function main(){
  const args=process.argv.slice(2),command=args.shift();
  if(command==='help' || !command){process.stdout.write('Phase5 host controller: mysql-up | restore-up | start-owned | db-prepare | init | adopt-migrated | app-up | inspect | fullstack | stable | stop | kill | restart | down --state <absolute state.json> [--output <exclusive results file>] [--service <owned service>] [--mode smoke|lifecycle|migrated-smoke]\n');return;}
  const flags={};while(args.length){const key=args.shift();insist(['--state','--output','--service','--mode'].includes(key)&&!Object.hasOwn(flags,key),'flag');const value=args.shift();insist(value&&!value.startsWith('--'),'flag_value');flags[key]=value;}
  insist(flags['--state'],'state_required');
  if(command==='console-bridge'){consoleBridge(flags['--state']);return;}
  const result=await control(command,flags['--state'],{output:flags['--output'],service:flags['--service'],mode:flags['--mode']});process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(JSON.stringify({ok:false,error:safeError(error)})+'\n');process.exitCode=1;});
