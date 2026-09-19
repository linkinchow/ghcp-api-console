import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnterpriseRegistryV3, parseAuthorizationBinding, resolveEnterpriseScope, canonicalEnterpriseIdentityRegistryV3,
  canonicalEnterpriseRegistryV3, type EnterpriseProfileV3 } from './enterpriseV3.js';
import { readEnterpriseRegistryFile, readEnterpriseSecret, enterpriseRegistryHashV3 } from './enterpriseRuntimeV3.js';
import { JsonHttpClient } from './httpClient.js';

const aid='11111111-2222-4333-8444-555555555555', bid='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function profile(id: string, legacy: boolean): EnterpriseProfileV3 {
  const path=legacy?'':`/profiles/${id}`;
  return {id,slug:legacy?'enterprise-a':'enterprise-b',shortcode:legacy?'enaa':'enbb',accountDomain:'pool.invalid',revision:1,maxAccounts:10,
    routes:{proxyInternalUrl:'http://127.0.0.1:18171',ssoInternalUrl:'http://127.0.0.1:18172',loginInternalUrl:'http://127.0.0.1:18173',ssoPublicUrl:'http://127.0.0.1:18172'},
    sso:{entityId:`http://127.0.0.1:18172${path}/metadata`,ssoUrl:`http://127.0.0.1:18172${path}/sso`,loginUrl:`http://127.0.0.1:18172${path}/login`,logoutUrl:`http://127.0.0.1:18172${path}/logout`,
      spEntityId:`urn:synthetic:${id}`,spAcsUrl:`http://127.0.0.1:18174/acs/${id}`,scimBaseUrl:`http://127.0.0.1:18174/scim/${id}`,githubApiBaseUrl:'http://127.0.0.1:18174',
      emailDomain:'users.invalid',userPrefix:'user',signingCertRef:{env:`CERT_${legacy?'A':'B'}`},signingKeyRef:{env:`KEY_${legacy?'A':'B'}`},sessionSecretRef:{env:`SESSION_${legacy?'A':'B'}`}},
    login:{provider:'custom',allowedLoginUrls:[`http://127.0.0.1:18172${path}/login`],selectors:{}}};
}
const registry=()=>({version:3 as const,registryRevision:1,legacyEnterpriseId:aid,profiles:[profile(aid,true),profile(bid,false)]});

test('registry preserves UUID identity and resolves legacy without relying on array order',()=>{
  const a=parseEnterpriseRegistryV3(registry()),b=parseEnterpriseRegistryV3({...registry(),profiles:registry().profiles.reverse()});
  assert.equal(canonicalEnterpriseRegistryV3(a),canonicalEnterpriseRegistryV3(b));
  assert.equal(resolveEnterpriseScope(b).enterpriseId,aid);
  assert.equal(resolveEnterpriseScope(b,bid).profile.slug,'enterprise-b');
  assert.throws(()=>resolveEnterpriseScope(a,'default'));
  assert.throws(()=>resolveEnterpriseScope(a,'12345678-1234-4234-8234-123456789012'),/enterprise_not_found/);
});
test('duplicate identities slugs shortcodes and wrong route ownership reject',()=>{
  for(const key of ['id','slug','shortcode'] as const){const r=registry();(r.profiles[1] as unknown as Record<string,unknown>)[key]=r.profiles[0][key];assert.throws(()=>parseEnterpriseRegistryV3(r));}
  const r=registry();r.profiles[1].sso.loginUrl=r.profiles[0].sso.loginUrl;r.profiles[1].login.allowedLoginUrls=[r.profiles[0].sso.loginUrl];
  assert.throws(()=>parseEnterpriseRegistryV3(r),/collision|mismatch/);
});
test('registry rejects inline secrets extra keys ambiguous routes and capacity overflow',()=>{
  const r=registry();assert.throws(()=>parseEnterpriseRegistryV3({...r,token:'secret'}));
  assert.throws(()=>parseEnterpriseRegistryV3({...r,profiles:[{...r.profiles[0],sso:{...r.profiles[0].sso,signingKeyRef:{value:'secret'}}},r.profiles[1]]}));
  r.profiles[1].maxAccounts=10000;assert.throws(()=>parseEnterpriseRegistryV3(r),/capacity/);
  const bad=registry();bad.profiles[1].sso.spAcsUrl='https://user:secret@example.invalid';assert.throws(()=>parseEnterpriseRegistryV3(bad));
});
test('identity digest excludes capacity but binds routes profile and registry revisions',()=>{
  const a=registry(),b=registry();b.profiles[0].maxAccounts=20;
  assert.equal(canonicalEnterpriseIdentityRegistryV3(a),canonicalEnterpriseIdentityRegistryV3(b));
  assert.equal(enterpriseRegistryHashV3(a),enterpriseRegistryHashV3(b));
  assert.notEqual(canonicalEnterpriseRegistryV3(a),canonicalEnterpriseRegistryV3(b));
  b.registryRevision=2;assert.notEqual(enterpriseRegistryHashV3(a),enterpriseRegistryHashV3(b));
});
test('binding validation requires explicit scope incarnation attempt and expected subject',()=>{
  const binding={enterpriseId:aid,enterpriseRevision:1,identity:'alice',accountIncarnation:bid,oauthAttemptId:'12345678-1234-4234-8234-123456789012',expectedGhLogin:'alice_enaa'};
  assert.deepEqual(parseAuthorizationBinding(binding),binding);
  assert.throws(()=>parseAuthorizationBinding({...binding,accountIncarnation:undefined}));
  assert.throws(()=>parseAuthorizationBinding({...binding,expectedGithubUserId:'0'}));
  assert.throws(()=>parseAuthorizationBinding({...binding,expectedGhLogin:'alice/other'}));
  assert.throws(()=>parseAuthorizationBinding({...binding,token:'secret'}));
});
test('runtime reads only configured secret references and errors do not leak source content',()=>{
  const dir=mkdtempSync(join(tmpdir(),'enterprise-registry-v3-'));
  try{
    const file=join(dir,'registry.json');writeFileSync(file,JSON.stringify(registry()));
    const loaded=readEnterpriseRegistryFile(file);assert.equal(Object.isFrozen(loaded.profiles[0].sso),true);
    assert.equal(readEnterpriseSecret({env:'SYNTH_SECRET'},{SYNTH_SECRET:'synthetic-value'}),'synthetic-value');
    assert.throws(()=>readEnterpriseSecret({env:'MISSING'},{}),/unavailable/);
    assert.throws(()=>readEnterpriseSecret(undefined,{}),/unconfigured/);
    writeFileSync(file,'{"secret":"DO_NOT_PRINT"');
    try{readEnterpriseRegistryFile(file);assert.fail();}catch(e){assert.doesNotMatch(String(e),/DO_NOT_PRINT/);}
    assert.match(readFileSync(file,'utf8'),/DO_NOT_PRINT/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('HTTP client composes cancellation and caller-selected redirect policy',async t=>{
  const controller=new AbortController();let signal:AbortSignal|undefined,redirect:RequestInit['redirect'];
  t.mock.method(globalThis,'fetch',async (_input:unknown,init?:RequestInit)=>{signal=init?.signal??undefined;redirect=init?.redirect;return new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}});});
  const client=new JsonHttpClient({baseUrl:'http://127.0.0.1:18174'});
  assert.deepEqual(await client.request('/fixture',{signal:controller.signal,redirect:'error'}),{ok:true});
  assert.equal(redirect,'error');assert.equal(signal?.aborted,false);controller.abort();assert.equal(signal?.aborted,true);
});
