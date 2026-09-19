import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initEnterpriseSqlite } from '../../src/packages/shared/src/enterpriseStorage.js';
import { sha256 } from '../default-enterprise/sqlite.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnterpriseCommandV3,safeEnterpriseToolError } from './commands.js';
import { legacyProfileV2,parseEnterpriseManifestV3,type EnterpriseManifestV3 } from './manifest.js';
import { registryV3,poolOptionsV3 } from './fixtures.js';
test('CLI init/verify/inspect pairs exact registries without secrets or source hashes in output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'enterprise-v3-cli-'));try {
    const manifest:EnterpriseManifestV3={manifestVersion:3,sourceSchemaVersion:2,registry:registryV3(),attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true},
      services:[{component:'proxy',driver:'sqlite',layout:'pool',target:join(root,'proxy.db'),init:poolOptionsV3()},
        {component:'sso',driver:'sqlite',layout:'sso',target:join(root,'sso.db')},{component:'login',driver:'sqlite',layout:'login',target:join(root,'login.db')}]};
    // init's explicit options do not accept user-provided layout; it comes from the service descriptor.
    delete manifest.services[0].init!.layout;
    const canonical=parseEnterpriseManifestV3(manifest);assert.deepEqual(parseEnterpriseManifestV3(canonical),canonical);
    const initialized=await runEnterpriseCommandV3('init',canonical);assert.equal(initialized.ready,true);assert.equal(initialized.pairedRegistry,true);
    const before=manifest.services.map(service=>readFileSync((service as {target:string}).target));
    assert.equal((await runEnterpriseCommandV3('verify',manifest)).ready,true);
    assert.equal((await runEnterpriseCommandV3('inspect',manifest)).components.every(item=>item.state==='complete'),true);
    for(const [i,service] of manifest.services.entries())assert.deepEqual(readFileSync((service as {target:string}).target),before[i]);
    assert.ok(!JSON.stringify(initialized).includes('sha256'));assert.ok(!JSON.stringify(initialized).includes('SESSION'));
    await assert.rejects(runEnterpriseCommandV3('init',manifest),/output_exists/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('CLI protected preflight plan round-trips through apply and paired verify without regeneration',async()=>{
  const root=mkdtempSync(join(tmpdir(),'enterprise-v3-plan-'));try {
    const registry=registryV3();
    const manifest:EnterpriseManifestV3={manifestVersion:3,sourceSchemaVersion:2,registry,attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true},
      services:(['proxy','sso','login'] as const).map(component=>{
        const db=new Database(':memory:');try {
          const layout=component==='proxy'?'direct':component;initEnterpriseSqlite(db,component,legacyProfileV2(registry),{layout});
          const source=join(root,`${component}.old.db`),bytes=db.serialize();writeFileSync(source,bytes);
          return {component,driver:'sqlite' as const,layout,source,target:join(root,`${component}.new.db`),backup:{reference:`synthetic-${component}`,sha256:sha256(bytes)}};
        }finally{db.close();}
      })};
    const planOut=join(root,'protected-plan.json');assert.equal((await runEnterpriseCommandV3('preflight',manifest,{planOut})).ready,false);
    const protectedBytes=readFileSync(planOut),plan=JSON.parse(protectedBytes.toString());
    assert.deepEqual(plan.services[0].accountIncarnations,[]);assert.deepEqual(plan.services[1].userIncarnations,[]);
    assert.equal((await runEnterpriseCommandV3('apply',plan)).ready,true);assert.equal((await runEnterpriseCommandV3('verify',plan)).ready,true);
    assert.deepEqual(readFileSync(planOut),protectedBytes);
    await assert.rejects(runEnterpriseCommandV3('preflight',plan,{planOut}),/EEXIST/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('inspection accepts registration manifests and initialization rejects implicit MySQL options before connection', async () => {
  const root=mkdtempSync(join(tmpdir(),'enterprise-v3-command-guards-'));
  try {
    const previousRegistry=registryV3(false), registry=registryV3();registry.registryRevision=2;
    const manifest={manifestVersion:3,sourceSchemaVersion:2,registry,previousRegistry,attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true},
      services:[{component:'proxy',driver:'sqlite',layout:'direct',target:join(root,'p.db')},{component:'sso',driver:'sqlite',layout:'sso',target:join(root,'s.db')},{component:'login',driver:'sqlite',layout:'login',target:join(root,'l.db')}]};
    const result=await runEnterpriseCommandV3('inspect',manifest);assert.equal(result.ready,false);assert.ok(result.components.every(row=>row.state==='absent'));
    const mysql={component:'proxy',driver:'mysql',layout:'direct',location:{host:'127.0.0.1',port:3306,database:'synthetic_test',connectionEnv:'ENTERPRISE_MYSQL_SYNTHETIC'}};
    const {previousRegistry:_previous,...initial}=manifest;
    await assert.rejects(runEnterpriseCommandV3('init',{...initial,services:[mysql,...manifest.services.slice(1)]},{env:{}}),/mysql_explicit_init_options_required/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('strict manifests reject raw secret fields, reused paths, unconfirmed writers and missing plan output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'enterprise-v3-invalid-'));try {
    const value={manifestVersion:3,sourceSchemaVersion:2,registry:registryV3(),attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true},
      services:[{component:'proxy',driver:'sqlite',layout:'direct',target:join(root,'p.db')},{component:'sso',driver:'sqlite',layout:'sso',target:join(root,'s.db')},{component:'login',driver:'sqlite',layout:'login',target:join(root,'l.db')}]};
    assert.equal(parseEnterpriseManifestV3(value).services.length,3);
    await assert.rejects(runEnterpriseCommandV3('preflight',value),/protected_plan/);
    const raw=structuredClone(value);Object.assign(raw.registry.profiles[0].sso,{privateKey:'DO-NOT-PRINT-SECRET'});assert.throws(()=>parseEnterpriseManifestV3(raw));
    const repeated=structuredClone(value);repeated.services[1].target=repeated.services[0].target;assert.throws(()=>parseEnterpriseManifestV3(repeated),/path_reused/);
    const running=structuredClone(value);running.attestations.writersStopped=false;assert.throws(()=>parseEnterpriseManifestV3(running),/attestation/);
    assert.ok(!safeEnterpriseToolError(new Error('mysql://user:DO-NOT-PRINT-SECRET@host')).includes('DO-NOT-PRINT-SECRET'));
  }finally{rmSync(root,{recursive:true,force:true});}
});
