import assert from 'node:assert/strict';
import test from 'node:test';
import { initLoginFixture, loginRequest } from '../../src/login/src/db/enterpriseFixture.js';
import { boundedInteger, createClient, HARD_LIMIT_MS, MAX_REQUESTS, safeFailure, pauseAfterFailure, recordFailure, writePrivateDiagnostic, assertMigratedPoolProjection } from './fullstack.js';
import { createSyntheticAuthorizer } from './login-test-entry.js';

process.env.INTERNAL_API_TOKEN='phase5-local-unit-internal';
const profile=initLoginFixture();

test('buildApp injected queue owns task submission and settings wake; default singleton remains unchanged',async t=>{
  const [{buildApp},{LoginQueue,loginQueue},{loginRuntimeSettings}]=await Promise.all([
    import('../../src/login/src/server.js'),import('../../src/login/src/tasks/queue.js'),import('../../src/login/src/db/runtimeSettingsRepo.js')]);
  const originalEnqueue=loginQueue.enqueue,originalWake=loginQueue.onRuntimeSettingsUpdated;
  let enqueues=0,wakes=0;
  const queue=new LoginQueue({getConcurrency:()=>0,readAuthorizationAttempt:async binding=>({binding,status:'active'})});
  const actual=queue.enqueue.bind(queue);
  queue.enqueue=async request=>{enqueues++;return actual(request);};
  queue.onRuntimeSettingsUpdated=()=>{wakes++;};
  const server=buildApp(queue).listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const headers={'x-internal-token':process.env.INTERNAL_API_TOKEN!,'content-type':'application/json'};
  let r=await fetch(`${origin}/api/tasks`,{method:'POST',headers,body:JSON.stringify(loginRequest(profile))});assert.equal(r.status,202);await r.body?.cancel();assert.equal(enqueues,1);
  r=await fetch(`${origin}/api/settings/runtime`,{method:'PATCH',headers,body:JSON.stringify({expectedVersion:loginRuntimeSettings.getSnapshot().version,changes:{concurrency:2}})});assert.equal(r.status,200);await r.body?.cancel();assert.equal(wakes,1);
  r=await fetch(`${origin}/api/settings/runtime`,{method:'PATCH',headers,body:JSON.stringify({expectedVersion:1,changes:{concurrency:3}})});assert.equal(r.status,409);await r.body?.cancel();assert.equal(wakes,1);
  assert.equal(loginQueue.enqueue,originalEnqueue);assert.equal(loginQueue.onRuntimeSettingsUpdated,originalWake);
});

test('synthetic authorizer sends only full tuple to fixed local provider and preserves AbortSignal',async t=>{
  const state={credentials:{fixtureToken:'fixture-secret'}},p={id:profile.id,revision:1,sso:{loginUrl:profile.sso.loginUrl,githubApiBaseUrl:profile.sso.githubApiBaseUrl}};
  const authorize=createSyntheticAuthorizer({state,registry:{profiles:[p]}} as never);
  const payload={...loginRequest(profile),profile,taskId:'synthetic-task'};
  const fetchMock=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(input,'http://provider:8000/fixture/authorize');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    const body=JSON.parse(String(init?.body));assert.equal(body.binding.accountIncarnation,payload.accountIncarnation);assert.equal(body.binding.oauthAttemptId,payload.oauthAttemptId);
    assert.equal(body.binding.expectedGhLogin,payload.expectedGhLogin);assert.equal(body.taskId,undefined);assert.equal(body.profile,undefined);
    return Response.json({token:`phase5_${'a'.repeat(32)}`});
  });
  assert.equal(await authorize({},payload,{},new AbortController().signal),`phase5_${'a'.repeat(32)}`);assert.equal(fetchMock.mock.callCount(),1);
  const controller=new AbortController();controller.abort();await assert.rejects(authorize({},payload,{},controller.signal));assert.equal(fetchMock.mock.callCount(),1);
  await assert.rejects(authorize({}, {...payload,enterpriseRevision:2},{},new AbortController().signal));assert.equal(fetchMock.mock.callCount(),1);
});

test('fullstack bounds reject duration above ten minutes, arbitrary origins, and enforce total request cap',async t=>{
  assert.equal(HARD_LIMIT_MS,600_000);assert.throws(()=>boundedInteger(600_001,1,HARD_LIMIT_MS,'duration'));
  const client=createClient({state:{origins:{proxy:'http://proxy-lb:3000',proxyReplicas:[]},credentials:{internalApiToken:'synthetic',fixtureToken:'synthetic'}}} as never,30_000);
  const mocked=t.mock.method(globalThis,'fetch',async()=>Response.json({}));
  await assert.rejects(client.call('https://api.github.com','/user'));await assert.rejects(client.call('http://proxy-lb:3000','//api.github.com/user'));assert.equal(mocked.mock.callCount(),0);
  for(let i=0;i<MAX_REQUESTS;i++)await client.call('http://proxy-lb:3000','/healthz');
  await assert.rejects(client.call('http://proxy-lb:3000','/healthz'),/cap_exceeded/);assert.equal(mocked.mock.callCount(),MAX_REQUESTS);
});

test('migrated singleton cap projects exactly to legacy profile while all non-cap configuration stays equal',()=>{
  const registry={legacyEnterpriseId:'legacy',profiles:[{id:'legacy',maxAccounts:6},{id:'second',maxAccounts:6}]};
  const runtime={enabled:true,maxAccounts:12,idleTarget:0,leaseSeconds:120,accountDomain:'pool-a.invalid',pollMs:1000,warmupModel:'phase5-synthetic'};
  const original={...runtime,maxAccounts:6};
  assert.doesNotThrow(()=>assertMigratedPoolProjection(original,runtime,registry));
  assert.throws(()=>assertMigratedPoolProjection({...original,maxAccounts:12},runtime,registry),/original_legacy_cap_changed/);
  assert.throws(()=>assertMigratedPoolProjection(original,{...runtime,maxAccounts:6},registry),/runtime_global_cap_changed/);
  assert.throws(()=>assertMigratedPoolProjection({...original,leaseSeconds:60},runtime,registry),/config_invariants_changed/);
  assert.throws(()=>assertMigratedPoolProjection({...original,accountDomain:'wrong.invalid'},runtime,registry),/config_invariants_changed/);
  assert.throws(()=>assertMigratedPoolProjection({...original,extraInvariant:true},runtime,registry),/config_invariants_changed/);
});

test('failure public metadata excludes string secrets and exposes only numeric assertion operands',()=>{
  const error=Object.assign(new Error('synthetic-password-secret'),{code:'ERR_ASSERTION',operator:'strictEqual',actual:3,expected:2});
  assert.deepEqual(safeFailure(error),{code:'assertion_failed',operator:'strictEqual',actual:3,expected:2});
  const secret=Object.assign(new Error('secret'),{code:'PASSWORD_SECRET',operator:'secret',actual:'token-secret',expected:{password:'secret'}});
  assert.deepEqual(safeFailure(secret),{code:'fixture_operation_failed'});
});

test('failure pause uses independent signal and at most one fresh CAS retry, without cancellation',async t=>{
  const fixture={state:{origins:{proxy:'http://proxy-lb:3000',proxyReplicas:[]},credentials:{internalApiToken:'synthetic',fixtureToken:'synthetic'}}} as never;
  const calls:Array<{method:string;body:any;signal:AbortSignal|null|undefined}>=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(input,'http://proxy-lb:3000/api/management/pool/settings');
    const method=init?.method??'GET';calls.push({method,body:init?.body?JSON.parse(String(init.body)):undefined,signal:init?.signal});
    if(calls.length===1)return Response.json({version:1,paused:0,idle_target:2});
    if(calls.length===2)return Response.json({}, {status:409});
    if(calls.length===3)return Response.json({version:2,paused:0,idle_target:2});
    return Response.json({version:3,paused:1,idle_target:0});
  });
  assert.deepEqual(await pauseAfterFailure(fixture),{paused:true,requests:4});
  assert.deepEqual(calls.map(c=>c.method),['GET','PATCH','GET','PATCH']);
  assert.deepEqual(calls[1].body,{expectedVersion:1,changes:{paused:1,idle_target:0}});assert.equal(calls[3].body.expectedVersion,2);assert.ok(calls.every(c=>c.signal));
});

test('private diagnosis precedes redacted public failure; diagnostic storage errors never prevent pause',async()=>{
  const fixture={state:{runId:'unit',origins:{proxy:'http://proxy-lb:3000',proxyReplicas:[]},credentials:{internalApiToken:'synthetic',fixtureToken:'synthetic'}}} as never;
  const c=createClient(fixture,1000),error=Object.assign(new Error('synthetic-private-secret'),{code:'ERR_ASSERTION',operator:'strictEqual',actual:'private-token',expected:2});
  const order:string[]=[];let privateValue:any;
  const result=await recordFailure(c,'/results/failure.json','unit',error,{
    diagnose:async()=>{order.push('diagnose');return {tasks:[{status:'uncertain'}]};},
    write:async(_path,value)=>{order.push('write');privateValue=value;return '/results/private/secret.json';},
    pause:async()=>{order.push('pause');return {paused:true,requests:2};},
  });
  assert.deepEqual(order,['diagnose','write','pause']);assert.match(privateValue.error,/synthetic-private-secret/);assert.match(privateValue.stack,/synthetic-private-secret/);
  assert.equal(JSON.stringify(result).includes('secret'),false);assert.equal(JSON.stringify(result).includes('private-token'),false);assert.equal(result.privateDiagnosticWritten,true);assert.equal(error.message,'synthetic-private-secret');
  let paused=false;
  const failedWrite=await recordFailure(c,'/results/failure.json','unit',error,{diagnose:async()=>{throw new Error('snapshot secret');},write:async()=>{throw new Error('disk secret');},pause:async()=>{paused=true;return {paused:false,requests:2};}});
  assert.equal(paused,true);assert.equal(failedWrite.privateDiagnosticWritten,false);assert.equal(failedWrite.code,'assertion_failed');
  await assert.rejects(writePrivateDiagnostic('/outside/failure.json',{}),/output_rejected/);
});
