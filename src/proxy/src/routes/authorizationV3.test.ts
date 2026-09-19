import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import Database from 'better-sqlite3';
import { INTERNAL_AUTH_HEADER,type AuthorizationBinding } from '@ghcp/shared';
import { initEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { fixtureProfile,fixtureRegistry } from '../test/enterpriseFixtures.js';

test('real HTTP router isolates profiles and validates all callback sources before mocked GitHub I/O',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'proxy-v3-http-')),path=join(dir,'proxy.sqlite'),registryPath=join(dir,'registry.json');
  const legacy=fixtureProfile(),otherId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const other={...legacy,id:otherId,slug:'other',shortcode:'other',sso:{...legacy.sso,ssoUrl:`http://localhost:7001/profiles/${otherId}/sso`,loginUrl:`http://localhost:7001/profiles/${otherId}/login`,logoutUrl:`http://localhost:7001/profiles/${otherId}/logout`},login:{...legacy.login,allowedLoginUrls:[`http://localhost:7001/profiles/${otherId}/login`]}};
  const registry=fixtureRegistry(undefined,[other,legacy]);writeFileSync(registryPath,JSON.stringify(registry));
  const db=new Database(path);db.pragma('foreign_keys=ON');initEnterpriseSqliteV4(db,'proxy',registry,{layout:'direct'});db.close();
  process.env.ENTERPRISE_REGISTRY_FILE=registryPath;process.env.DB_PATH=path;process.env.INTERNAL_API_TOKEN='synthetic-internal';process.env.ACCOUNT_ROUTING_MODE='direct';process.env.DOTENV_CONFIG_PATH=join(dir,'none.env');
  const {config}=await import('../config.js');config.dbPath=path;config.internalApiToken='synthetic-internal';
  const {initializeStorage,getStorage,closeStorage}=await import('../db/connection.js');await initializeStorage();const storage=getStorage();
  const {buildApp}=await import('../server.js');const server=buildApp().listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,originalFetch=globalThis.fetch;let githubCalls=0;
  globalThis.fetch=(async(input,init)=>{const url=new URL(String(input));if(url.hostname==='127.0.0.1')return originalFetch(input,init);githubCalls++;assert.equal(url.href,`${legacy.sso.githubApiBaseUrl}/user`);assert.equal(init?.redirect,'error');return Response.json({login:'alice_octo',id:42});}) as typeof fetch;
  t.after(async()=>{globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await closeStorage();rmSync(dir,{recursive:true,force:true});});
  const call=async(pathname:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{
    const response=await originalFetch(base+pathname,{method,headers:{[INTERNAL_AUTH_HEADER]:'synthetic-internal','content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  };
  const a=await storage.createAccount({identity:'alice',ssoUser:'same',ghLogin:'alice_octo'});
  const b=await storage.createAccount({enterpriseId:otherId,identity:'bob',ssoUser:'same',ghLogin:'bob_other'});
  assert.equal((await call(`/api/profiles/${otherId}/accounts/alice`)).status,404);
  assert.equal((await call('/api/accounts/bob')).status,404);
  const lookup=await call(`/api/profiles/${otherId}/accounts/bob`);assert.equal(lookup.status,200);assert.equal(lookup.body.enterpriseId,otherId);
  assert.equal((await call(`/api/profiles/${otherId}/accounts/alice`,'DELETE')).status,404);
  assert.equal((await call(`/internal/profiles/${otherId}/accounts/by-sso-user/same/pool-membership`)).body.contractVersion,2);
  assert.equal((await call(`/internal/profiles/${otherId}/accounts/by-sso-user/same/pool-membership?enterpriseId=${legacy.id}`)).status,400);
  assert.equal((await call('/internal/profiles/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/accounts/by-sso-user/same','DELETE')).status,404);
  const deleted=await call(`/internal/profiles/${otherId}/accounts/by-sso-user/same`,'DELETE');assert.equal(deleted.body.deletedAccounts,1);assert.equal(deleted.body.enterpriseId,otherId);assert.ok(await storage.getAccount('alice'));
  const binding:AuthorizationBinding={enterpriseId:legacy.id,enterpriseRevision:1,identity:'alice',accountIncarnation:a.accountIncarnation,oauthAttemptId:randomUUID(),expectedGhLogin:'alice_octo'};await storage.beginAuthorizationAttempt(binding);
  const route=`/internal/profiles/${legacy.id}/accounts/alice/authorization-attempts/${binding.oauthAttemptId}`;
  assert.deepEqual((await call(route)).body,{binding,status:'active'});
  for(const [suffix,body,headers] of [
    ['/success',{binding:{...binding,enterpriseId:otherId},copilotOauthToken:'token'},{}],
    ['/success?enterpriseId='+otherId,{binding,copilotOauthToken:'token'},{}],
    ['/success',{binding,copilotOauthToken:'token'},{'x-enterprise-id':otherId}],
    ['/success',{binding,copilotOauthToken:'token',ghLogin:'mallory'},{}],
    ['/success',{binding:{...binding,identity:'bob'},copilotOauthToken:'token'},{}],
  ] as const){assert.notEqual((await call(route+suffix,'POST',body,headers)).status,200);}
  assert.equal(githubCalls,0);
  assert.equal((await call('/internal/accounts/alice/copilot-oauth-token','PUT',{oauthAttemptId:binding.oauthAttemptId,copilotOauthToken:'token'})).status,426);
  const success=await call(route+'/success','POST',{binding,copilotOauthToken:'token'});assert.equal(success.status,200);assert.equal(success.body.outcome,'applied');assert.equal(githubCalls,1);
  assert.equal((await call(route+'/success','POST',{binding,copilotOauthToken:'token'})).body.outcome,'already-succeeded');assert.equal(githubCalls,1);
  assert.equal((await call(route+'/success','POST',{binding,copilotOauthToken:'conflict'})).status,409);
  assert.ok(!JSON.stringify((await call(route)).body).includes('fingerprint'));
  // A deleted attempt remains a readable terminal fact, not a write capability.
  const retired={...binding,oauthAttemptId:randomUUID()};await storage.beginAuthorizationAttempt(retired);
  const retiredRoute=`/internal/profiles/${legacy.id}/accounts/alice/authorization-attempts/${retired.oauthAttemptId}`;
  await storage.deleteAccount('alice');
  const readRetired=()=>call(`${retiredRoute}?accountIncarnation=${retired.accountIncarnation}&expectedGhLogin=${retired.expectedGhLogin}`);
  assert.deepEqual((await readRetired()).body,{binding:retired,status:'cancelled'});
  const recreated=await storage.createAccount({identity:'alice',ssoUser:'same',ghLogin:'alice_octo'});
  const fresh={...binding,accountIncarnation:recreated.accountIncarnation,oauthAttemptId:randomUUID()};await storage.beginAuthorizationAttempt(fresh);
  assert.deepEqual((await readRetired()).body,{binding:retired,status:'cancelled'});
  assert.equal((await call(`${retiredRoute}?accountIncarnation=${fresh.accountIncarnation}`)).status,400);
  assert.equal((await call(retiredRoute,'GET',undefined,{'x-account-incarnation':fresh.accountIncarnation})).status,400);
  assert.equal((await call(`${retiredRoute}?expectedGhLogin=mallory`)).status,400);
  assert.equal((await call(retiredRoute.replace(legacy.id,otherId))).status,404);
  assert.equal((await call(retiredRoute.replace('/accounts/alice/','/accounts/bob/'))).status,404);
  const callsBeforeStale=githubCalls;
  for (const suffix of ['success','failure','cancel']) {
    assert.equal((await call(`${retiredRoute}/${suffix}`,'POST',{binding:retired,...(suffix==='success'?{copilotOauthToken:'late-token'}:{})})).status,409);
  }
  assert.equal(githubCalls,callsBeforeStale);
  assert.equal((await storage.getAccount('alice'))?.copilotOauthToken,undefined);
  assert.equal((await storage.getAccount('alice'))?.copilotOauthAttemptId,fresh.oauthAttemptId);
  assert.equal((await storage.getAuthorizationAttempt(legacy.id,'alice',fresh.oauthAttemptId))?.status,'active');
  // New direct-mode failures know the pinned legacy scope even before an account
  // exists; historical unknowns must stay unknown and out of enterprise views.
  const {statIdentity}=await import('../userPool/runtime.js');
  const direct=statIdentity({locals:{}} as Parameters<typeof statIdentity>[0],'never-created');
  assert.deepEqual(direct,{identity:'never-created',enterpriseId:legacy.id});
  // Exercise the actual direct HTTP failure before createAccount, not just the helper.
  config.apiKey='synthetic-direct-key';let initializationCalls=0;
  globalThis.fetch=(async(input)=>{
    const url=new URL(String(input));
    if(url.hostname==='127.0.0.1')return originalFetch(input);
    initializationCalls++;assert.ok(url.pathname.endsWith('/users/ensure'));
    return Response.json({error:{code:'synthetic_initialization_failure',message:'Synthetic SSO unavailable'}},{status:503});
  }) as typeof fetch;
  const failedDirect=await call('/v1/models','GET',undefined,{'x-api-key':'synthetic-direct-key',[config.identityHeader]:'pre-account-http-failure'});
  assert.ok(failedDirect.status>=400);assert.equal(initializationCalls,1);
  assert.equal(await storage.getAccount('pre-account-http-failure'),undefined);
  const directFailure=(await storage.listRequestStats('pre-account-http-failure'))[0];
  assert.equal(directFailure?.enterpriseId,legacy.id);assert.equal(directFailure?.success,false);
  await storage.recordRequestStat({...direct,path:'/v1/messages',success:false,failureReason:'initialization_failed'});
  await storage.recordRequestStat({identity:'historical-unknown',path:'/v1/messages',success:false});
  assert.equal((await storage.listRequestStats('never-created'))[0]?.enterpriseId,legacy.id);
  assert.equal((await storage.pageRequestStats({enterpriseId:legacy.id,identity:'never-created'})).total,1);
  assert.equal((await storage.pageRequestStats({enterpriseId:otherId})).total,0);
  assert.equal((await storage.pageRequestStats({enterpriseId:legacy.id,identity:'historical-unknown'})).total,0);
  const inspectDb=new Database(path,{readonly:true});
  assert.equal((inspectDb.prepare('SELECT enterprise_id FROM proxy_request_stats WHERE identity=?').get('historical-unknown') as {enterprise_id:null}).enterprise_id,null);inspectDb.close();
  const capabilities=await call(`/internal/profiles/${otherId}/enterprise`);assert.equal(capabilities.status,200);assert.equal(capabilities.body.contractVersion,2);assert.equal(capabilities.body.id,otherId);assert.ok(!JSON.stringify(capabilities.body).includes('SecretRef'));assert.equal(capabilities.body.maxAccounts,undefined);
});
