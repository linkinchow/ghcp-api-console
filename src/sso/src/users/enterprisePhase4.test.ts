import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import { parseEnterpriseReadinessV1, resolveEnterpriseScope, type SecretReference } from '@ghcp/shared';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { initSsoRegistryFixture, SECOND_FIXTURE_ID } from '../db/enterpriseFixture.js';

// The dedicated test process owns these synthetic variables before service imports.
process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_TOKEN = 'phase4-sso-test-auth';
process.env.SSO_DEFAULT_USER_PASSWORD = 'phase4-synthetic-default-password';
process.env.SCIM_TOKEN = 'phase4-synthetic-scim-secret';
process.env.GITHUB_COPILOT_SEAT_PAT = 'phase4-synthetic-seat-secret';
process.env.LOG_LEVEL = 'error';
const registry = initSsoRegistryFixture(true);
const a = resolveEnterpriseScope(registry), b = resolveEnterpriseScope(registry, SECOND_FIXTURE_ID);
const { config } = await import('../config.js');
const { getDb, getValidatedEnterpriseRegistry } = await import('../db/connection.js');
const { createEnterpriseReadinessRouter, ssoReadiness } = await import('../routes/enterpriseReadiness.js');
const { requireInternalToken } = await import('../auth/internalAuth.js');
const { requireEnterpriseRequest } = await import('../enterprise.js');
const { createUsersApiRouter } = await import('../routes/usersApi.js');
const repo = await import('../db/usersRepo.js');
const { hashPassword } = await import('../auth/password.js');

test('SSO phase4 readiness and stale-incarnation safety', { timeout: 30000 }, async t => {
  const secretDir = mkdtempSync(join(tmpdir(), 'phase4-sso-material-'));
  const certPath = join(secretDir, 'synthetic.crt'), keyPath = join(secretDir, 'synthetic.key');
  // Self-signed, synthetic, local-only material; no external CA or network request.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '2', '-subj', '/CN=phase4-readiness.synthetic.invalid'], { stdio: 'ignore' });
  const cert = readFileSync(certPath, 'utf8'), key = readFileSync(keyPath, 'utf8');
  const secrets: Record<string, string> = {
    TEST_SSO_SIGNING_CERT: cert, TEST_SSO_SIGNING_KEY: key,
    TEST_SSO_SESSION_SECRET: 'phase4-synthetic-session-secret-over-thirty-two-chars',
    TEST_SSO_SCIM_TOKEN: 'phase4-synthetic-scim-secret', TEST_SSO_SEAT_PAT: 'phase4-synthetic-seat-secret',
    SSO_DEFAULT_USER_PASSWORD: 'phase4-synthetic-default-password',
  };
  Object.assign(process.env, secrets);
  const readSecret = (ref: SecretReference | undefined): string => {
    assert.ok(ref && 'env' in ref && Object.hasOwn(secrets, ref.env), 'only synthetic named references may be read');
    return secrets[ref.env];
  };
  const nativeFetch = globalThis.fetch; let outboundCalls = 0;
  globalThis.fetch = async () => { outboundCalls++; throw new Error('forbidden outbound phase4 test request'); };
  const app = express(); app.use(express.json());
  app.use('/internal', requireInternalToken, createEnterpriseReadinessRouter());
  for (const scope of [a,b]) app.use(`/api/profiles/${scope.enterpriseId}`, requireInternalToken, requireEnterpriseRequest(scope), createUsersApiRouter(scope));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { 'x-internal-token': config.internalApiToken };
  const probe = (id: string, extra = '', headers: Record<string,string> = auth) => nativeFetch(`${base}/internal/profiles/${id}/readiness${extra}`, { headers });
  const noSidecars = (path: string) => { for (const suffix of ['-wal','-shm','-journal']) assert.equal(existsSync(path + suffix), false); };
  try {
    await t.test('uninitialized and invalid storage probes do not open, seed, recover or switch WAL', async () => {
      const originalPath = config.dbPath, originalBytes = readFileSync(originalPath);
      assert.throws(getValidatedEnterpriseRegistry, /storage_not_ready/);
      const missing = join(secretDir, 'missing.sqlite'); config.dbPath = missing;
      try { const response = await probe(a.enterpriseId); assert.equal(response.status,503); assert.equal(existsSync(missing),false); noSidecars(missing); }
      finally { config.dbPath = originalPath; }
      const invalid = join(secretDir, 'invalid.sqlite'), db = new Database(invalid); db.exec('CREATE TABLE foreign_schema(value TEXT)'); db.close();
      const invalidBytes = readFileSync(invalid); config.dbPath = invalid;
      try {
        assert.throws(getDb, /partial_or_unknown_schema/);
        assert.equal((await probe(a.enterpriseId)).status,503);
        assert.deepEqual(readFileSync(invalid),invalidBytes); noSidecars(invalid);
      } finally { config.dbPath = originalPath; }
      assert.deepEqual(readFileSync(originalPath),originalBytes); noSidecars(originalPath);
    });
    await t.test('local material checks return safe blockers and exact profile/registry hashes', () => {
      for (const scope of [a,b]) {
        const ready = parseEnterpriseReadinessV1(ssoReadiness(registry,scope.enterpriseId,readSecret));
        assert.equal(ready.ready,true); assert.deepEqual(ready.blockers,[]);
        assert.equal(ready.profileIdentitySha256,enterpriseProfileIdentityHashV4(scope.profile));
        assert.equal(ready.registrySha256,enterpriseRegistryHashV3(registry));
        assert.equal(ready.schemaVersion,3); assert.equal(ready.contractVersion,2);
        const serialized = JSON.stringify(ready); for (const value of Object.values(secrets)) assert(!serialized.includes(value));
        assert(!serialized.includes('signingKeyRef')); assert(!serialized.includes('TEST_SSO_'));
      }
      const bad = ssoReadiness(registry,a.enterpriseId,() => { throw new Error('SECRET_DRIVER_ERROR_MUST_NOT_ESCAPE'); });
      assert.equal(bad.ready,false); assert.deepEqual(bad.blockers,['saml_signing_material_unavailable','saml_session_secret_unavailable','scim_secret_unavailable','seat_secret_unavailable','pool_password_unavailable']);
      assert(!JSON.stringify(bad).includes('SECRET_DRIVER_ERROR'));
      const azure = structuredClone(registry); azure.profiles.find(p=>p.id===b.enterpriseId)!.login.provider='azure';
      assert.deepEqual(ssoReadiness(azure,b.enterpriseId,readSecret).blockers,['pool_provider_unsupported']);
      assert.notEqual(ssoReadiness(registry,a.enterpriseId,readSecret).profileIdentitySha256,ssoReadiness(registry,b.enterpriseId,readSecret).profileIdentitySha256);
    });
    await t.test('initialized HTTP probes enforce auth/path scope and remain database-read-only', async () => {
      const db=getDb(), before=db.serialize();
      assert.equal((await probe(a.enterpriseId,'',{})).status,401);
      assert.equal((await probe(a.enterpriseId,'',{'x-internal-token':'wrong'})).status,401);
      for(const headers of [{...auth,'x-enterprise-id':a.enterpriseId},{...auth,'x-enterprise-revision':'2'}])assert.equal((await probe(b.enterpriseId,'',headers)).status,400);
      assert.equal((await probe(b.enterpriseId,`?enterpriseId=${a.enterpriseId}`)).status,400);
      assert.equal((await probe(randomUUID())).status,404);
      for(const scope of [a,b]){
        const response=await probe(scope.enterpriseId,'',{...auth,'x-enterprise-id':scope.enterpriseId,'x-enterprise-revision':'1'});
        assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
        const body=parseEnterpriseReadinessV1(await response.json());assert.equal(body.ready,true);assert.equal(body.enterpriseId,scope.enterpriseId);
        assert.equal(body.profileIdentitySha256,enterpriseProfileIdentityHashV4(scope.profile));assert.equal(body.registrySha256,enterpriseRegistryHashV3(registry));
      }
      assert.deepEqual(db.serialize(),before);assert.equal(outboundCalls,0);
    });
    const create=(name:string,scope:typeof a)=>repo.createUser({ssoUser:name,...hashPassword('synthetic-user-password'),email:`${name}@${scope.profile.sso.emailDomain}`},scope);
    await t.test('stale patch cannot mutate a recreated or same-name other-enterprise user', async () => {
      const old=create('stale-patch',a),other=create('stale-patch',b);repo.deleteUser(old.ssoUser,old.userIncarnation,undefined,a);const replacement=create(old.ssoUser,a);
      const patch=(id:string)=>nativeFetch(`${base}/api/profiles/${a.enterpriseId}/users/stale-patch`,{method:'PATCH',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({expectedUserIncarnation:id,email:'wrong@example.test',role:'admin'})});
      for(const stale of [old.userIncarnation,other.userIncarnation]){const response=await patch(stale);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'user_incarnation_conflict');}
      assert.deepEqual(repo.getUser(old.ssoUser,a),replacement);assert.deepEqual(repo.getUser(old.ssoUser,b),other);assert.equal(outboundCalls,0);
      const accepted=await nativeFetch(`${base}/api/profiles/${a.enterpriseId}/users/stale-patch`,{method:'PATCH',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({expectedUserIncarnation:replacement.userIncarnation,email:'safe@example.test'})});
      assert.equal(accepted.status,200);assert.equal(repo.getUser(old.ssoUser,a)!.userIncarnation,replacement.userIncarnation);assert.equal(repo.getUser(old.ssoUser,b)!.email,other.email);
    });
    await t.test('batch stale/missing incarnation maps reject before any external mutation', async () => {
      const old=create('stale-batch',a);repo.deleteUser(old.ssoUser,old.userIncarnation,undefined,a);const replacement=create(old.ssoUser,a);
      const batch=(expectedIncarnations:unknown)=>nativeFetch(`${base}/api/profiles/${a.enterpriseId}/users/batch`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({operation:'sync_emu',ssoUsers:[old.ssoUser],createOnly:true,expectedIncarnations})});
      for(const invalid of [{},{[old.ssoUser]:''},{[old.ssoUser]:'not-a-uuid'}])assert.equal((await batch(invalid)).status,400);
      const response=await batch({[old.ssoUser]:old.userIncarnation});assert.equal(response.status,200);const body=await response.json();assert.equal(body.rows.length,1);assert.equal(body.rows[0].status,'failed');assert.match(body.rows[0].detail,/recreated/);
      assert.deepEqual(repo.getUser(old.ssoUser,a),replacement);assert.equal(outboundCalls,0);assert.equal((getDb().prepare('SELECT operation_fence FROM sso_users WHERE enterprise_id=? AND sso_user=?').get(a.enterpriseId,old.ssoUser) as {operation_fence:string|null}).operation_fence,null);
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
    globalThis.fetch=nativeFetch;rmSync(secretDir,{recursive:true,force:true});
  }
});
