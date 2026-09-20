import assert from 'node:assert/strict';
import test from 'node:test';
import { HARD_LIMIT_MS, CASES, crashPlan, faultArgs, parseArgs, selfTest } from './process-crash.mjs';

test('host controller self-test never opens infrastructure and uses a sub-ten-minute hard window',async()=>{
  assert.equal((await selfTest()).status,'PASS');assert.ok(HARD_LIMIT_MS<=600000);assert.equal(HARD_LIMIT_MS,480000);
});
test('CLI refuses arbitrary service or executable selections',()=>{
  for(const args of [[],['--case','login'],['--state','relative','--case','proxy-owner','--output','relative'],['--state','/tmp/s','--case','mysql','--output','/tmp/o']])assert.throws(()=>parseArgs(args));
  const state={ownership:{containers:{'proxy-1':{id:'f'.repeat(64)},mysql:{id:'a'.repeat(64)}}}};
  assert.deepEqual(faultArgs(state,'start','proxy-1'),['start','f'.repeat(64)]);
  for(const service of ['mysql','provider','proxy-lb','old-proxy','f'.repeat(64)])assert.throws(()=>faultArgs(state,'kill',service));
});
for(const scenario of CASES)test(`actual-controller sequencing ${scenario}: exact target always restored and paused`,async()=>{
  const events=[],target=scenario==='login-accepted'?'login':scenario==='sso-commit'?'sso':'proxy-2';let running=true;
  const result=await crashPlan({
    async probe(phase){events.push(phase);return phase==='arm'?{target,owner:'proxy-2'}:{checks:{noReplay:true}};},
    async running(service){assert.equal(service,target);return running;},
    async kill(service){assert.equal(service,target);events.push(`kill-${service}`);running=false;},
    async start(service){assert.equal(service,target);events.push(`start-${service}`);running=true;},
    async waitHealthy(service){assert.equal(service,target);return running;},cleanup(){events.push('cleanup');},
  },scenario);
  assert.equal(result.status,'PASS');assert.equal(result.paused,true);assert.equal(result.restarted,true);
  assert.ok(events.indexOf(`kill-${target}`)>events.indexOf('arm'));
  assert.ok(events.lastIndexOf(`start-${target}`)>events.indexOf('cleanup'));
  if(scenario==='proxy-owner')assert.ok(events.indexOf('verify')<events.indexOf(`start-${target}`),'owner remains killed during survivor verification');
  else assert.ok(events.indexOf(`start-${target}`)<events.indexOf('verify'),'actual service restarts before restart verification');
});
test('verification failure preserves private detail and restores exact killed owner, no audit/pass',async()=>{
  const events=[];let running=true;
  const result=await crashPlan({async probe(phase){events.push(phase);if(phase==='arm')return{target:'proxy-1',owner:'proxy-1'};if(phase==='verify')throw new Error('mysql://private:secret@host');return{};},
    async running(){return running;},async kill(){running=false;},async start(service){events.push(service);running=true;},async waitHealthy(){return true;},cleanup(){},failure(e){assert.ok(e.message.includes('secret'));}},'proxy-owner');
  assert.equal(result.status,'FAIL');assert.equal(result.restarted,true);assert.equal(result.paused,true);assert.equal(result.error,'phase5_operation_failed');assert.equal(events.includes('audit'),false);assert.equal(events.filter(e=>e==='proxy-1').length,1);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('failed restart cannot yield PASS even if verification had passed',async()=>{
  let running=true,starts=0;
  const result=await crashPlan({async probe(phase){return phase==='arm'?{target:'proxy-3',owner:'proxy-3'}:{};},async running(){return running;},async kill(){running=false;},
    async start(){starts++;throw new Error('unavailable');},async waitHealthy(){return false;},cleanup(){}},'proxy-owner');
  assert.equal(result.status,'FAIL');assert.equal(result.restarted,false);assert.equal(result.paused,true);assert.equal(starts,1);
});
