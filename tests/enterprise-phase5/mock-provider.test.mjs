import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, loadFixtureConfig, MODEL_ID } from './mock-provider.mjs';
const A='a0000000-0000-4000-8000-000000000001',B='b0000000-0000-4000-8000-000000000002';
const fixtureToken='synthetic-fixture-secret-only';
function config() {
  const profiles=[A,B].map((id,i)=>({id,revision:1,slug:`phase5-${i?'b':'a'}`,shortcode:i?'p5bb':'p5aa',accountDomain:`pool-${i?'b':'a'}.invalid`,
    routes:{proxyInternalUrl:'http://proxy-lb:3000',ssoInternalUrl:'http://sso:7001',loginInternalUrl:'http://login:7003',ssoPublicUrl:'http://sso:7001'},
    sso:{githubApiBaseUrl:`http://provider:8000/github/${id}`,scimBaseUrl:`http://provider:8000/scim/v2/enterprises/phase5-${i?'b':'a'}`,loginUrl:`http://sso:7001${i?`/profiles/${id}`:''}/login`},
    login:{allowedLoginUrls:[`http://sso:7001${i?`/profiles/${id}`:''}/login`]}}));
  return {state:{fixtureVersion:1,syntheticOnly:true,runId:'unit',project:'ghcp-enterprise-phase5-unit',legacyEnterpriseId:A,enterpriseIds:[A,B],
    origins:{provider:'http://provider:8000',sso:'http://sso:7001',login:'http://login:7003',proxy:'http://proxy-lb:3000',console:'http://console:7004',proxyReplicas:['http://proxy-1:3000','http://proxy-2:3000']},
    credentials:{fixtureToken,apiKey:'synthetic-inference-api-key',internalApiToken:'synthetic-internal-secret-only',enterprises:Object.fromEntries([A,B].map(id=>[id,{scimToken:`synthetic-scim-${id}`,githubPat:`synthetic-pat-${id}`,defaultPassword:`synthetic-pass-${id}`}]))}},
    registry:{version:3,legacyEnterpriseId:A,profiles}};
}
async function fixture(t) {
  const cfg=config(),server=createMockProvider(cfg);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(path,token=fixtureToken,body,method=body===undefined?'GET':'POST',signal) {
    return fetch(`${origin}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
  }
  const profile=id=>cfg.registry.profiles.find(p=>p.id===id),secret=id=>cfg.state.credentials.enterprises[id];
  async function provision(id,name='shared.name00') {
    const p=profile(id),s=secret(id);
    let r=await request(`/scim/v2/enterprises/${p.slug}/Users`,s.scimToken,{userName:name,active:true});assert.equal(r.status,201);const user=await r.json();
    r=await request(`/github/${id}/enterprises/${p.slug}/copilot/billing/selected_users`,s.githubPat,{selected_usernames:[user.githubLogin]});assert.equal(r.status,200);
    const binding={enterpriseId:id,enterpriseRevision:1,identity:name,accountIncarnation:randomUUID(),oauthAttemptId:randomUUID(),expectedGhLogin:user.githubLogin};
    const authorization={binding,ssoUser:name,ssoPassword:s.defaultPassword};
    r=await request('/fixture/authorize',fixtureToken,authorization);assert.equal(r.status,200);const {token}=await r.json();return {user,token,authorization};
  }
  const snapshot=async()=> (await (await request('/fixture/snapshot')).json()).enterprises;
  return {request,profile,secret,provision,snapshot,cfg};
}

test('CLI guard rejects missing marker, nonfixture URL and mismatched scope before listen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'phase5-provider-unit-'));
  try {
    const cfg=config();cfg.state.registryFile=join(dir,'registry.json');writeFileSync(cfg.state.registryFile,JSON.stringify(cfg.registry));
    const file=join(dir,'state.json');writeFileSync(file,JSON.stringify(cfg.state));
    assert.throws(()=>loadFixtureConfig(file,{}),/synthetic_guard/);
    assert.equal(loadFixtureConfig(file,{PHASE5_SYNTHETIC_ONLY:'1'}).state.syntheticOnly,true);
    cfg.state.origins.provider='https://api.github.com';writeFileSync(file,JSON.stringify(cfg.state));
    assert.throws(()=>loadFixtureConfig(file,{PHASE5_SYNTHETIC_ONLY:'1'}),/origin_invalid/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('SCIM, PAT, seat, subject and token namespaces reject cross-enterprise credentials',async t=>{
  const f=await fixture(t),a=await f.provision(A),b=await f.provision(B);
  assert.notEqual(a.token,b.token);
  assert.equal((await f.request('/scim/v2/enterprises/phase5-a/Users',f.secret(B).scimToken)).status,401);
  assert.equal((await f.request(`/github/${A}/enterprises/phase5-b/copilot/billing/seats`,f.secret(A).githubPat)).status,404);
  assert.equal((await f.request(`/github/${A}/user`,b.token)).status,401);
  const r=await f.request(`/github/${A}/user`,a.token);assert.deepEqual(await r.json(),{login:a.user.githubLogin,id:1,type:'User'});
  const snapshots=await f.snapshot();assert.equal(snapshots[0].counts['verify-user'],1);assert.equal(snapshots[1].counts['verify-user'],undefined);
  assert.equal(JSON.stringify(snapshots).includes(a.token),false);assert.equal(JSON.stringify(snapshots).includes(f.secret(A).defaultPassword),false);
});
test('authorization requires complete immutable tuple, known seated subject and matching password',async t=>{
  const f=await fixture(t),a=await f.provision(A);
  assert.equal((await f.request('/fixture/authorize','wrong-token',a.authorization)).status,401);
  assert.equal((await f.request('/fixture/authorize',fixtureToken,{...a.authorization,ssoPassword:'wrong'})).status,403);
  for (const mutation of [{accountIncarnation:undefined},{enterpriseRevision:2},{expectedGhLogin:'someone_else'},{expectedGithubUserId:'2'}]) {
    const r=await f.request('/fixture/authorize',fixtureToken,{...a.authorization,binding:{...a.authorization.binding,...mutation}});assert.ok(r.status>=400);
  }
  const changed={...a.authorization,binding:{...a.authorization.binding,accountIncarnation:randomUUID()}};
  assert.equal((await f.request('/fixture/authorize',fixtureToken,changed)).status,409);
  assert.equal((await (await f.request('/fixture/authorize',fixtureToken,a.authorization)).json()).token,a.token);
  assert.equal((await f.request('/fixture/authorize',fixtureToken,{...a.authorization,binding:{...a.authorization.binding,enterpriseId:B}})).status,403);
});
test('model catalog, JSON and SSE are token-scoped and count one request marker per upstream attempt',async t=>{
  const f=await fixture(t),a=await f.provision(A),b=await f.provision(B);
  assert.equal((await f.request('/models','invalid')).status,401);
  assert.equal((await (await f.request('/models',a.token)).json()).data[0].id,MODEL_ID);
  for (const path of ['/v1/messages','/chat/completions','/responses']) {
    for (const stream of [false,true]) {
      const r=await f.request(path,a.token,{model:MODEL_ID,messages:[{role:'user',content:'phase5-request:normal'}],max_tokens:8,stream});assert.equal(r.status,200);assert.match(await r.text(),/synthetic/);
    }
  }
  assert.equal((await (await f.request('/v1/messages/count_tokens',b.token,{model:MODEL_ID})).json()).input_tokens,8);
  let s=await f.snapshot();assert.equal(s[0].markers['phase5-request:normal'].inference,6);assert.equal(s[1].counts.inference,1);
  await f.request('/fixture/control',fixtureToken,{enterpriseId:A,channel:'inference',mode:'429',count:1});
  const r=await f.request('/chat/completions',a.token,{model:MODEL_ID,messages:[{role:'user',content:'phase5-request:throttled'}]});assert.equal(r.status,429);
  s=await f.snapshot();assert.equal(s[0].markers['phase5-request:throttled'].inference,1);
  assert.equal((await f.request('/chat/completions',b.token,{model:MODEL_ID})).status,200);
});
test('bounded lost ACK commits only mock operation, delay aborts before token issuance, unknown is finite',async t=>{
  const f=await fixture(t),a=await f.provision(A);
  assert.equal((await f.request('/fixture/control',fixtureToken,{enterpriseId:A,channel:'authorize',mode:'delay',delayMs:600001})).status,400);
  await f.request('/fixture/control',fixtureToken,{enterpriseId:A,channel:'scim-create',mode:'lost-ack'});
  await assert.rejects(f.request('/scim/v2/enterprises/phase5-a/Users',f.secret(A).scimToken,{userName:'lost.ack00',active:true}));
  const list=await (await f.request('/scim/v2/enterprises/phase5-a/Users',f.secret(A).scimToken)).json();assert.equal(list.totalResults,2);
  await f.request('/fixture/control',fixtureToken,{enterpriseId:A,channel:'authorize',mode:'delay',delayMs:1000});
  await assert.rejects(f.request('/fixture/authorize',fixtureToken,{...a.authorization,binding:{...a.authorization.binding,oauthAttemptId:randomUUID()}},'POST',AbortSignal.timeout(40)));
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal((await f.snapshot())[0].issuedTokens,1);
  await f.request('/fixture/control',fixtureToken,{enterpriseId:A,channel:'inference',mode:'terminal-unknown',delayMs:10});
  assert.equal((await f.request('/chat/completions',a.token,{model:MODEL_ID})).status,503);
  assert.equal((await f.request('/chat/completions',a.token,{model:MODEL_ID})).status,200);
});
