import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { type AuthorizationBinding, type EnterpriseProfileV3 } from '@ghcp/shared';
import { initEnterpriseSqliteV4, validateEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { fixtureProfile, fixtureRegistry, fixtureOptions, fixtureReadinessEvidence } from '../test/enterpriseFixtures.js';
import { readPoolConfig } from '../userPool/config.js';
import { SqliteStorage } from './sqliteStorage.js';
import { completeVerifiedAuthorization, verifyGithubSubject } from '../accounts/authorization.js';

export function twoProfiles(options?:ReturnType<typeof readPoolConfig>) {
  const legacy=fixtureProfile(options),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const other:EnterpriseProfileV3={...legacy,id,slug:'second-enterprise',shortcode:'next',maxAccounts:20,
    sso:{...legacy.sso,entityId:'urn:other',ssoUrl:`http://localhost:7001/profiles/${id}/sso`,loginUrl:`http://localhost:7001/profiles/${id}/login`,logoutUrl:`http://localhost:7001/profiles/${id}/logout`,githubApiBaseUrl:'https://second-api.example.test'},
    login:{...legacy.login,allowedLoginUrls:[`http://localhost:7001/profiles/${id}/login`]}};
  return {legacy,other,registry:fixtureRegistry(options,[other,legacy])};
}
async function fixture(pool=false) {
  const options=pool?readPoolConfig({ACCOUNT_ROUTING_MODE:'caller-lease',POOL_ACCOUNT_EMAIL_DOMAIN:'accounts.example.test',POOL_WARMUP_MODEL:'mock',READY_IDLE_TARGET:'2',POOL_MAX_ACCOUNTS:'10'}):undefined;
  const profiles=twoProfiles(options),db=new Database(':memory:');db.pragma('foreign_keys=ON');
  initEnterpriseSqliteV4(db,'proxy',profiles.registry,fixtureOptions(options));
  const storage=new SqliteStorage(':memory:',100,profiles.registry,db);await storage.initialize();
  return {...profiles,db,storage,options};
}
async function begin(f:Awaited<ReturnType<typeof fixture>>,enterpriseId=f.legacy.id,identity='same') {
  const account=await f.storage.createAccount({enterpriseId,identity,ssoUser:'alice',ghLogin:'alice_octo'});
  const binding:AuthorizationBinding={enterpriseId,enterpriseRevision:1,identity,accountIncarnation:account.accountIncarnation,oauthAttemptId:randomUUID(),expectedGhLogin:account.ghLogin!};
  await f.storage.beginAuthorizationAttempt(binding);return binding;
}
const subject={login:'alice_octo',id:'123'};
const goodFetch=(async()=>Response.json(subject)) as typeof fetch;

test('scoped lookup/list/delete-by-sso/import/collision and initialization claims cannot adopt another enterprise',async t=>{
  const f=await fixture();t.after(()=>f.storage.close());
  const a=await f.storage.createAccount({identity:'a',ssoUser:'alice',ghLogin:'alice_octo'});
  await f.storage.createAccount({enterpriseId:f.other.id,identity:'b',ssoUser:'alice',ghLogin:'alice_next'});
  assert.equal(await f.storage.getAccount('a',f.other.id),undefined);
  assert.equal(await f.storage.getAccount('b'),undefined);
  assert.deepEqual((await f.storage.listAccounts()).items.map(x=>x.identity),['a']);
  assert.deepEqual((await f.storage.listAccounts({enterpriseId:f.other.id,q:'alice'})).items.map(x=>x.identity),['b']);
  assert.equal(await f.storage.deleteAccount('a',f.other.id),undefined);
  await assert.rejects(f.storage.createAccount({enterpriseId:f.other.id,identity:'a',ssoUser:'steal'}),/identity_enterprise_collision/);
  const absentInOther = await f.storage.getCopilotOauthTokenImportFence('not-created',f.other.id);
  await assert.rejects(f.storage.importCopilotOauthToken({enterpriseId:f.other.id,identity:'a',ssoUser:'steal',copilotOauthToken:'secret',expectedAccount:absentInOther}),/identity_enterprise_collision/);
  assert.equal((await f.storage.getAccount('a'))?.accountIncarnation,a.accountIncarnation);
  assert.equal(await f.storage.claimIdentityInitialization('pending','claim-a',30,f.legacy.id),true);
  f.db.prepare("UPDATE proxy_identity_initializations SET lease_expires_at='2000-01-01' WHERE identity='pending'").run();
  assert.equal(await f.storage.claimIdentityInitialization('pending','claim-b',30,f.other.id),false);
  assert.equal(await f.storage.releaseIdentityInitialization('pending','claim-a',f.other.id),false);
  await assert.rejects(f.storage.claimIdentityInitialization('a','claim-b',30,f.other.id),/identity_enterprise_collision/);
  const deleted=await f.storage.deleteAccountsBySsoUser('ALICE',f.other.id);
  assert.equal(deleted.deletedAccounts,1);assert.ok(await f.storage.getAccount('a'));
});

test('incarnation ABA and immutable attempt ledger reject stale task and unsafe legacy nonce callbacks',async t=>{
  const f=await fixture();t.after(()=>f.storage.close());const old=await begin(f);
  await f.storage.deleteAccount(old.identity);const next=await begin(f);
  assert.notEqual(next.accountIncarnation,old.accountIncarnation);
  await assert.rejects(f.storage.completeAuthorizationAttempt(old,'late-token',subject),/stale_authorization_binding/);
  await assert.rejects(f.storage.beginAuthorizationAttempt({...next,oauthAttemptId:old.oauthAttemptId}),/stale_authorization_binding/);
  await assert.rejects(f.storage.saveCopilotOauthToken(next.identity,next.oauthAttemptId,'unsafe',subject.login),/authorization_binding_required/);
  await assert.rejects(f.storage.failCopilotOauthAuthorization(next.identity,next.oauthAttemptId),/authorization_binding_required/);
  assert.throws(()=>f.db.prepare('UPDATE proxy_accounts SET account_incarnation=? WHERE identity=?').run(randomUUID(),next.identity),/binding_immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM proxy_authorization_attempts WHERE oauth_attempt_id=?').run(old.oauthAttemptId),/evidence_required/);
});

test('success performs pinned /user subject verification and identical lost ACK retry has no network or raw-token evidence',async t=>{
  const f=await fixture();t.after(()=>f.storage.close());const b=await begin(f,f.other.id);
  let calls=0;const fetcher=(async(url,init)=>{calls++;assert.equal(url,'https://second-api.example.test/user');assert.equal(init?.redirect,'error');assert.equal(init?.headers && (init.headers as Record<string,string>).Authorization,'Bearer synthetic-secret');return Response.json(subject);}) as typeof fetch;
  assert.equal((await completeVerifiedAuthorization(f.storage,b,'synthetic-secret',{profile:f.other,fetch:fetcher})).outcome,'applied');
  assert.equal((await completeVerifiedAuthorization(f.storage,b,'synthetic-secret',{profile:f.other,fetch:fetcher})).outcome,'already-succeeded');assert.equal(calls,1);
  await assert.rejects(completeVerifiedAuthorization(f.storage,b,'different-token',{profile:f.other,fetch:fetcher}),/outcome_conflict/);
  const evidence=f.db.prepare('SELECT * FROM proxy_authorization_attempts').all();assert.ok(!JSON.stringify(evidence).includes('synthetic-secret'));
  assert.equal((await f.storage.getAccount(b.identity,f.other.id))?.ghLogin,'alice_octo');
});

test('wrong login, optional numeric GitHub ID, oversized body and redirect fail closed before token mutation',async t=>{
  const f=await fixture();t.after(()=>f.storage.close());const base=await begin(f);
  const b={...base,oauthAttemptId:randomUUID(),expectedGithubUserId:'123'};await f.storage.beginAuthorizationAttempt(b);
  for (const wrong of [{login:'mallory_octo',id:123},{login:'alice_octo',id:456}]) {
    await assert.rejects(completeVerifiedAuthorization(f.storage,b,'token',{profile:f.legacy,fetch:(async()=>Response.json(wrong)) as typeof fetch}),/subject_mismatch/);
  }
  assert.equal((await f.storage.getAccount(b.identity))?.copilotOauthToken,undefined);
  await assert.rejects(verifyGithubSubject(f.legacy,'token',(async()=>new Response('x'.repeat(65537))) as typeof fetch),/subject_invalid/);
  await assert.rejects(verifyGithubSubject(f.legacy,'token',(async()=>new Response(null,{status:302,headers:{location:'https://attacker.test'}})) as typeof fetch),/subject_unavailable/);
});

test('cancel and replacement attempt win CAS while /user verification is outstanding; failure consumes nonce',async t=>{
  for (const action of ['cancel','replace','fail'] as const) {
    const f=await fixture();t.after(()=>f.storage.close());const b=await begin(f);let finish!:()=>void;let started!:()=>void;
    const entered=new Promise<void>(r=>started=r),deferred=new Promise<void>(r=>finish=r);
    const pending=completeVerifiedAuthorization(f.storage,b,'late',{profile:f.legacy,fetch:(async()=>{started();await deferred;return Response.json(subject);}) as typeof fetch});
    await entered;
    if (action==='replace') await f.storage.beginAuthorizationAttempt({...b,oauthAttemptId:randomUUID()});
    else await f.storage.endAuthorizationAttempt(b,action==='cancel'?'cancelled':'failed',action==='fail'?'login_failed':undefined);
    finish();await assert.rejects(pending,/stale_authorization_binding|outcome_conflict/);
    assert.equal((await f.storage.getAccount(b.identity))?.copilotOauthToken,undefined);
    if (action!=='replace') assert.equal((await f.storage.getAccount(b.identity))?.copilotOauthAttemptId,undefined);
  }
});

test('bounded verifier aborts an uncooperative mocked fetch or response body without changing production timeouts',async()=>{
  const profile=fixtureProfile();
  for (const fetcher of [(async()=>new Promise<Response>(()=>{})) as typeof fetch,(async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{})}))) as typeof fetch]) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('test_deadline')),10);
    try {await assert.rejects(verifyGithubSubject(profile,'token',fetcher,controller.signal),/github_subject_/);} finally {clearTimeout(timer);}
  }
});

test('multi-enterprise pool requires explicit activation and keeps cap policy CAS and global ordinal', async t => {
  const f = await fixture(true); t.after(() => f.storage.close()); const pool = f.storage.userPool(f.options!);
  assert.equal(pool.reserve(), undefined);
  for (const profile of [f.legacy, f.other]) {
    const current = pool.enterprisePolicy(profile.id)!;
    const validated = pool.updateEnterprisePolicy(profile.id, current.policyVersion, { type: 'validate', evidence: { ...fixtureReadinessEvidence(f.registry, profile.id), checkedAt: pool.now() } });
    pool.updateEnterprisePolicy(profile.id, validated.policyVersion, { type: 'activate', evidence: { ...fixtureReadinessEvidence(f.registry, profile.id), checkedAt: pool.now() } });
  }
  pool.updateSettings(pool.settings().version, { paused: 0 });
  const first = pool.reserve()!;
  assert.equal(first.enterprise_id, f.other.id);
  assert.equal(first.ordinal, 0);
  assert.equal(pool.settings().max_accounts, 30);
  const old = pool.enterprisePolicy(f.legacy.id)!;
  assert.equal(pool.updateEnterprisePolicy(f.legacy.id, old.policyVersion, { type: 'cap', maxAccounts: 15 }).maxAccounts, 15);
  assert.equal((f.db.prepare('SELECT max_accounts FROM enterprise_profiles WHERE id=?').get(f.other.id) as { max_accounts: number }).max_accounts, 20);
  assert.throws(() => pool.updateSettings(pool.settings().version, { max_accounts: 9990 }), /invalid_pool_settings/);
  assert.throws(() => pool.updateEnterprisePolicy(f.legacy.id, old.policyVersion, { type: 'cap', maxAccounts: 3 }), /policy_version_conflict/);
  assert.equal(validateEnterpriseSqliteV4(f.db, 'proxy', f.registry).legacyEnterpriseId, f.legacy.id);
});
