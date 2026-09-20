import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolutePath, assertOwnedContainer, exclusiveJson, loadState, noSymlinkPath, safeError, within } from '../enterprise-phase5/safety.mjs';

export const HARD_LIMIT_MS=480_000;
export const CASES=Object.freeze(['login-accepted','sso-commit','proxy-owner']);
const PROXIES=Object.freeze(['proxy-1','proxy-2','proxy-3']);
const REQUIRED=Object.freeze(['provider','login','sso',...PROXIES]);
const fail=code=>{throw new Error(`phase5_process_${code}`);};
const check=(value,code)=>{if(!value)fail(code);};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const hash=value=>createHash('sha256').update(value).digest('hex');
export function faultArgs(state,command,service){
  check(['kill','start'].includes(command)&&['login','sso',...PROXIES].includes(service),'fault_target');
  const id=state.ownership?.containers?.[service]?.id;check(/^[a-f0-9]{64}$/.test(id??''),'fault_id');
  return command==='kill'?['kill','--signal','KILL',id]:['start',id];
}
export function parseArgs(argv){
  if(argv.length===1&&argv[0]==='--self-test')return{selfTest:true};
  check(argv.length===6&&argv[0]==='--state'&&argv[2]==='--case'&&argv[4]==='--output'&&CASES.includes(argv[3]),'arguments');
  return{stateFile:absolutePath(argv[1]),scenario:argv[3],output:absolutePath(argv[5])};
}
/** Injectable only in-process for offline controller tests; CLI cannot supply commands/targets. */
export async function crashPlan(io,scenario){
  check(CASES.includes(scenario),'case');
  let target,killAttempted=false,restarted=false,arm,verified,error,paused=false;
  try{
    const initial=await io.probe('bootstrap');
    arm=await io.probe('arm',initial);target=arm.target;
    check(target===(scenario==='login-accepted'?'login':scenario==='sso-commit'?'sso':arm.owner)
      &&['login','sso',...PROXIES].includes(target),'armed_target');
    check(await io.running(target),'target_not_running');
    if(io.assertArmed)await io.assertArmed(arm);
    killAttempted=true;await io.kill(target);
    check(!await io.running(target),'kill_not_observed');
    if(scenario!=='proxy-owner'){await io.start(target);restarted=await io.waitHealthy(target);check(restarted,'restart_unhealthy');}
    verified=await io.probe('verify',arm);
  }catch(caught){error=caught;io.failure?.(caught);}
  finally{
    // No teardown/deletion. Even a failed kill ACK requires restart of that SAME ID.
    io.cleanup();
    if(error){try{await io.probe('pause');paused=true;}catch(caught){io.failure?.(caught);}}
    if(killAttempted&&target){
      try{await io.start(target);restarted=await io.waitHealthy(target);check(restarted,'final_restart_unhealthy');}
      catch(caught){error??=caught;io.failure?.(caught);restarted=false;}
    }
  }
  if(!error&&restarted){
    try{await io.probe('audit',arm);await io.probe('pause');paused=true;}
    catch(caught){error=caught;io.failure?.(caught);try{await io.probe('pause');paused=true;}catch(pauseError){io.failure?.(pauseError);}}
  }
  // If restart itself was the first failure, preserve/pause as well.
  if(error&&!paused){try{await io.probe('pause');paused=true;}catch(caught){io.failure?.(caught);}}
  return{status:!error&&restarted&&paused?'PASS':'FAIL',target:target??null,killAttempted,restarted,paused,
    error:error?safeError(error):undefined,checks:verified?.checks??null};
}
export async function runProcessCrash({stateFile,scenario,output}){
  const started=Date.now(),deadline=started+HARD_LIMIT_MS,nonce=randomUUID();
  check(CASES.includes(scenario),'case');
  const state=loadState(stateFile);
  check(process.env.PHASE5_SYNTHETIC_ONLY==='1'&&state.mode==='init','synthetic_fresh_init_only');
  check(!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT,'remote_docker_refused');
  check(dirname(stateFile)===state.hostPaths.fixture,'host_state_required');
  check(realpathSync(join(state.hostPaths.source,'tests/enterprise-phase7'))===dirname(fileURLToPath(import.meta.url)),'source_location');
  for(const path of [state.root,...Object.values(state.hostPaths)])noSymlinkPath(path);
  absolutePath(output);within(state.hostPaths.results,output);noSymlinkPath(output);check(!existsSync(output),'output_exists');
  check(hash(readFileSync(join(state.hostPaths.fixture,'compose.env')))===JSON.parse(readFileSync(join(state.hostPaths.fixture,'file-hashes.json'),'utf8')).composeEnv,'compose_env_changed');
  check(REQUIRED.every(service=>state.ownership.containers[service]),'ownership_missing');
  const privateDir=join(state.hostPaths.results,'private');noSymlinkPath(privateDir);mkdirSync(privateDir,{recursive:true,mode:0o700});
  const evidence=join(privateDir,`process-${scenario}-${nonce}.json`),events=[];
  // Exclusive run receipt prevents accidental reuse of a partially armed fixture.
  exclusiveJson(join(state.hostPaths.results,'process-scenario-started.json'),{version:1,runId:state.runId,scenario,nonce,startedAt:started});
  const env=Object.fromEntries(['PATH','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','TMP','TEMP','DOCKER_CONFIG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  let operationDeadline=deadline-65_000;
  function docker(args,limit=3000,input){
    const remaining=Math.min(limit,operationDeadline-Date.now());check(remaining>0,'hard_deadline');
    const result=spawnSync('docker',['--context','default',...args],{encoding:'utf8',input,env,timeout:remaining,killSignal:'SIGKILL',maxBuffer:3*1024*1024});
    events.push({kind:'child',operation:args[0],at:Date.now(),status:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr});
    // Persist incremental private evidence, so errors/timeouts before the final report retain context.
    exclusiveJson(join(privateDir,`process-${nonce}-${events.length}.json`),events.at(-1));
    check(!result.error&&result.status===0,'command_failed');return String(result.stdout).trim();
  }
  function inspect(services){
    check(services.every(s=>REQUIRED.includes(s)),'inspect_service');
    const rows=JSON.parse(docker(['inspect',...services.map(s=>state.ownership.containers[s].id)]));
    check(Array.isArray(rows)&&rows.length===services.length,'inspect_cardinality');
    for(const service of services)assertOwnedContainer(state,rows.filter(r=>r.Id===state.ownership.containers[service].id),service);
    return rows;
  }
  function probe(phase,prior){
    check(inspect(['provider'])[0].State?.Running===true,'provider_not_running');
    const value=JSON.parse(docker(['exec','-i',state.ownership.containers.provider.id,'node','--import','tsx',
      '/app/tests/enterprise-phase7/process-probe.ts',phase,scenario,state.runId,nonce],phase==='pause'?8000:115_000,prior?JSON.stringify(prior):''));
    check(value.runId===state.runId&&value.nonce===nonce&&value.phase===phase&&value.scenario===scenario,'probe_binding');
    return value;
  }
  const control=(command,service)=>{inspect([service]);docker(faultArgs(state,command,service),7000);};
  const io={probe,running:service=>inspect([service])[0].State?.Running===true,
    assertArmed(armed){
      const ids=scenario==='proxy-owner'?state.enterpriseIds:[state.enterpriseIds[0]];
      for(const id of ids){const row=armed.snapshot.provider.enterprises.find(e=>e.enterpriseId===id);
        check(row?.barriers.some(b=>b.channel===(scenario==='sso-commit'?'scim-create':'authorize')&&b.phase===(scenario==='sso-commit'?'after':'before')&&b.until>Date.now()+7500),'barrier_expired_before_kill');}
    },
    kill:service=>control('kill',service),start:service=>control('start',service),
    async waitHealthy(service){
      const until=Math.min(Date.now()+35_000,operationDeadline-10_000);
      for(let n=0;n<45&&Date.now()<until;n++){
        const row=inspect([service])[0];if(row.State?.Running===true&&row.State?.Health?.Status==='healthy')return true;
        await delay(750);
      }
      return false;
    },
    cleanup(){operationDeadline=deadline-500;},
    failure(error){events.push({kind:'failure',at:Date.now(),message:error?.message,stack:error?.stack});},
  };
  let result;
  try{
    check(inspect(REQUIRED).every(r=>r.State?.Running===true&&r.State?.Health?.Status==='healthy'),'initial_health');
    result=await crashPlan(io,scenario);
  }catch(error){io.cleanup();io.failure(error);let paused=false;try{probe('pause');paused=true;}catch{}result={status:'FAIL',error:safeError(error),paused,restarted:false,killAttempted:false,target:null,checks:null};}
  const report={version:1,syntheticOnly:true,runId:state.runId,scenario,stage:'actual-process-crash',...result,elapsedMs:Date.now()-started,
    hardLimitMs:HARD_LIMIT_MS,realLoginQueue:true,realGithubBrowserDeviceFlow:false,realUsers:0,retained:true,privateEvidenceRetained:true};
  exclusiveJson(evidence,{version:1,runId:state.runId,scenario,nonce,events});exclusiveJson(output,report);return report;
}
export async function selfTest(){
  const state={ownership:{containers:{login:{id:'a'.repeat(64)}}}};
  assert.deepEqual(faultArgs(state,'kill','login'),['kill','--signal','KILL','a'.repeat(64)]);
  assert.throws(()=>faultArgs(state,'kill','mysql'));assert.throws(()=>faultArgs(state,'rm','login'));
  assert.throws(()=>parseArgs(['--state','relative','--case','sso-commit','--output','relative']));
  let started=0,paused=0,killed=false;
  const result=await crashPlan({probe:async phase=>{if(phase==='arm')return{target:'login'};if(phase==='verify')throw new Error('secret-value');if(phase==='pause')paused++;return{};},
    running:async()=>!killed,kill:async()=>{killed=true;throw new Error('lost kill ACK');},start:async()=>{started++;killed=false;},
    waitHealthy:async()=>true,cleanup(){}},'login-accepted');
  assert.equal(started,1);assert.equal(paused,1);assert.equal(result.status,'FAIL');assert.equal(result.restarted,true);assert.equal(result.error,'phase5_operation_failed');
  return{status:'PASS',checks:9,dockerExecuted:false,mysqlExecuted:false};
}
async function main(){const args=parseArgs(process.argv.slice(2));const report=args.selfTest?await selfTest():await runProcessCrash(args);process.stdout.write(JSON.stringify(report)+'\n');if(report.status!=='PASS')process.exitCode=1;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write(JSON.stringify({status:'FAIL',error:'phase5_process_controller_failed'})+'\n');process.exitCode=1;});
