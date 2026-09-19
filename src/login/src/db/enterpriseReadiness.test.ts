import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import {parseEnterpriseReadinessV1,parseEnterpriseRegistryV3} from '@ghcp/shared';
import {initEnterpriseSqliteV3} from '@ghcp/shared/enterpriseStorageV3';
import {enterpriseRegistryHashV3} from '@ghcp/shared/enterpriseRuntimeV3';
import {enterpriseProfileIdentityHashV4} from '@ghcp/shared/enterpriseRuntimeV4';
import {loginRegistryFixture} from './enterpriseFixture.js';

process.env.NODE_ENV='test';process.env.INTERNAL_API_TOKEN='phase4-login-synthetic-auth';
const directory=mkdtempSync(join(tmpdir(),'phase4-login-readiness-'));
process.env.DOTENV_CONFIG_PATH=join(directory,'missing.env');
process.env.DB_PATH=join(directory,'login.sqlite');process.env.ENTERPRISE_REGISTRY_FILE=join(directory,'registry.json');
process.env.LOG_DIR=join(directory,'logs');process.env.AUTH_DEBUG_ARTIFACT_DIR=join(directory,'artifacts');
const input=loginRegistryFixture();input.profiles.find(p=>p.id!==input.legacyEnterpriseId)!.login.provider='azure';
const registry=parseEnterpriseRegistryV3(input),legacy=registry.profiles.find(p=>p.id===registry.legacyEnterpriseId)!,azure=registry.profiles.find(p=>p.id!==registry.legacyEnterpriseId)!;
writeFileSync(process.env.ENTERPRISE_REGISTRY_FILE,JSON.stringify(registry));
const {config}=await import('../config.js');
const {getDb,getValidatedEnterpriseRegistry}=await import('./connection.js');
const {createEnterpriseReadinessRouter,loginReadiness}=await import('../routes/enterpriseReadiness.js');
const {requireInternalToken}=await import('../auth/internalAuth.js');

test('Login phase4 readonly initialized readiness contract', {timeout:15000}, async t=>{
  const nativeFetch=globalThis.fetch;let outbound=0;
  globalThis.fetch=async()=>{outbound++;throw new Error('no external request allowed');};
  const app=express();app.use('/internal',requireInternalToken,createEnterpriseReadinessRouter());
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,auth={'x-internal-token':config.internalApiToken};
  const probe=(id:string,extra='',headers:Record<string,string>=auth)=>nativeFetch(`${base}/internal/profiles/${id}/readiness${extra}`,{headers});
  const noSidecars=(path:string)=>{for(const suffix of ['-wal','-shm','-journal'])assert.equal(existsSync(path+suffix),false);};
  try{
    await t.test('missing and invalid database probes never initialize or enable WAL',async()=>{
      assert.equal(existsSync(config.dbPath),false);assert.throws(getValidatedEnterpriseRegistry,/storage_not_ready/);
      assert.equal((await probe(legacy.id)).status,503);assert.equal(existsSync(config.dbPath),false);noSidecars(config.dbPath);
      const invalid=new Database(config.dbPath);invalid.exec('CREATE TABLE unknown_legacy(value TEXT)');invalid.close();const bytes=readFileSync(config.dbPath);
      assert.throws(getDb,/partial_or_unknown_schema/);assert.equal((await probe(legacy.id)).status,503);assert.deepEqual(readFileSync(config.dbPath),bytes);noSidecars(config.dbPath);
      rmSync(config.dbPath);const fixture=new Database(config.dbPath);try{initEnterpriseSqliteV3(fixture,'login',registry);}finally{fixture.close();}
      const initializedBytes=readFileSync(config.dbPath);assert.equal((await probe(legacy.id)).status,503,'valid file alone is not initialized runtime');assert.deepEqual(readFileSync(config.dbPath),initializedBytes);noSidecars(config.dbPath);
    });
    await t.test('profile provider, identity hash and safe DTO are local configuration only',()=>{
      const ready=parseEnterpriseReadinessV1(loginReadiness(registry,legacy.id)),blocked=parseEnterpriseReadinessV1(loginReadiness(registry,azure.id));
      assert.equal(ready.ready,true);assert.deepEqual(ready.blockers,[]);assert.equal(blocked.ready,false);assert.deepEqual(blocked.blockers,['pool_provider_unsupported']);
      for(const [profile,value]of [[legacy,ready],[azure,blocked]] as const){
        assert.equal(value.enterpriseId,profile.id);assert.equal(value.enterpriseRevision,profile.revision);assert.equal(value.profileIdentitySha256,enterpriseProfileIdentityHashV4(profile));
        assert.equal(value.registryRevision,registry.registryRevision);assert.equal(value.registrySha256,enterpriseRegistryHashV3(registry));assert.equal(value.legacyEnterpriseId,legacy.id);
        assert.equal(value.schemaVersion,3);assert.equal(value.contractVersion,2);assert.equal(value.capability,'enterprise-isolation-legacy-pool');
        const text=JSON.stringify(value);assert(!text.includes('TEST_KEY'));assert(!text.includes('signingKeyRef'));assert(!text.includes('allowedLoginUrls'));
      }
      const changed=structuredClone(registry);changed.profiles.find(p=>p.id===legacy.id)!.maxAccounts=1;assert.equal(loginReadiness(changed,legacy.id).profileIdentitySha256,ready.profileIdentitySha256);
      changed.registryRevision++;const advanced=loginReadiness(changed,legacy.id);assert.equal(advanced.profileIdentitySha256,ready.profileIdentitySha256);assert.notEqual(advanced.registrySha256,ready.registrySha256);
      assert.throws(()=>loginReadiness(registry,randomUUID()),/enterprise_not_found/);assert.equal(outbound,0);
    });
    await t.test('runtime readiness rejects marker drift without scanning task history',async()=>{
      const db=getDb();
      db.prepare('UPDATE enterprise_schema SET registry_sha256=? WHERE singleton=1').run('0'.repeat(64));
      assert.equal((await probe(legacy.id)).status,503);
      db.prepare('UPDATE enterprise_schema SET registry_sha256=? WHERE singleton=1').run(enterpriseRegistryHashV3(registry));
      assert.equal((await probe(legacy.id)).status,200);
    });
    await t.test('initialized authenticated HTTP scopes reject mismatches and never recover tasks or mutate storage',async()=>{
      const db=getDb(),before=db.serialize();
      assert.equal((await probe(legacy.id,'',{})).status,401);assert.equal((await probe(legacy.id,'',{'x-internal-token':'wrong'})).status,401);
      assert.equal((await probe(azure.id,'',{...auth,'x-enterprise-id':legacy.id})).status,400);
      assert.equal((await probe(azure.id,'',{...auth,'x-enterprise-revision':'2'})).status,400);
      assert.equal((await probe(azure.id,`?enterpriseId=${legacy.id}`)).status,400);assert.equal((await probe(randomUUID())).status,404);
      for(const profile of [legacy,azure]){
        const response=await probe(profile.id,'',{...auth,'x-enterprise-id':profile.id,'x-enterprise-revision':String(profile.revision)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
        const body=parseEnterpriseReadinessV1(await response.json());assert.equal(body.enterpriseId,profile.id);assert.equal(body.ready,profile.id===legacy.id);assert.equal(body.registrySha256,enterpriseRegistryHashV3(registry));
      }
      assert.deepEqual(db.serialize(),before);assert.equal((db.prepare('SELECT COUNT(*) n FROM login_tasks').get() as {n:number}).n,0);
      assert.equal(outbound,0);assert.equal(existsSync(config.logDir),false);assert.equal(existsSync(config.auth.debugArtifactsDir),false);
      db.close();const closedBytes=readFileSync(config.dbPath);assert.equal((await probe(legacy.id)).status,503);assert.deepEqual(readFileSync(config.dbPath),closedBytes);noSidecars(config.dbPath);
    });
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));globalThis.fetch=nativeFetch;
    try{getValidatedEnterpriseRegistry();getDb().close();}catch{/* already closed or deliberately unavailable */}
    rmSync(directory,{recursive:true,force:true});
  }
});
