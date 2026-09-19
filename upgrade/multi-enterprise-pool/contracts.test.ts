import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registryV3,poolOptionsV3,A,B} from '../multi-enterprise/fixtures.js';
import {enterpriseRegistryHashV3} from '../../src/packages/shared/src/enterpriseRuntimeV3.js';
import {enterpriseProfileIdentityHashV4} from '../../src/packages/shared/src/enterpriseRuntimeV4.js';
import {parseEnterpriseReadinessV1,parseEnterpriseValidationEvidenceV1,parseEnterpriseValidationEvidenceJsonV1,parseEnterprisePoolPolicyRecord,enterprisePoolPolicyDto,type EnterpriseReadinessV1,type EnterpriseValidationEvidenceV1,type EnterprisePoolPolicyRecord} from '../../src/packages/shared/src/enterprisePoolV4.js';
import {parseEnterpriseManifestV4} from './manifest.js';
import {runEnterpriseCommandV4} from './commands.js';
const registry=registryV3(),profile=registry.profiles[0];
function probe(component:'sso'|'login'):EnterpriseReadinessV1{return{probeVersion:1,component,schemaVersion:3,contractVersion:2,capability:'enterprise-isolation-legacy-pool',enterpriseId:A,enterpriseRevision:1,profileIdentitySha256:enterpriseProfileIdentityHashV4(profile),registryRevision:1,registrySha256:enterpriseRegistryHashV3(registry),legacyEnterpriseId:A,ready:true,blockers:[]};}
function evidence():EnterpriseValidationEvidenceV1{return{version:1,enterpriseId:A,enterpriseRevision:1,profileIdentitySha256:enterpriseProfileIdentityHashV4(profile),registryRevision:1,registrySha256:enterpriseRegistryHashV3(registry),legacyEnterpriseId:A,checkedAt:100,sso:probe('sso'),login:probe('login')};}
function policy():EnterprisePoolPolicyRecord{return{enterpriseId:A,state:'active',policyVersion:1,maxAccounts:5,identitySha256:enterpriseProfileIdentityHashV4(profile),validationKind:'local_service_readiness_v1',validationEvidence:evidence(),validatedAt:100,updatedAt:101};}
test('strict safe readiness/evidence/record parsers bind both components and reject extensions/unknown versions',()=>{
  assert.deepEqual(parseEnterpriseReadinessV1(probe('sso')),probe('sso'));assert.deepEqual(parseEnterpriseValidationEvidenceV1(evidence()),evidence());assert.deepEqual(parseEnterprisePoolPolicyRecord(policy()),policy());
  for(const changes of [{component:'proxy'},{schemaVersion:4},{contractVersion:1},{capability:'other'},{enterpriseId:B},{enterpriseRevision:2},{profileIdentitySha256:'b'.repeat(64)},{registryRevision:2},{registrySha256:'b'.repeat(64)},{legacyEnterpriseId:B},{ready:false,blockers:['not_ready']},{secret:'no'}])assert.throws(()=>parseEnterpriseValidationEvidenceV1({...evidence(),sso:{...probe('sso'),...changes}}));
  for(const changes of [{version:2},{checkedAt:NaN},{checkedAt:-1},{extra:true}])assert.throws(()=>parseEnterpriseValidationEvidenceV1({...evidence(),...changes}));
  for(const changes of [{probeVersion:2},{blockers:['https://private.example/token']},{blockers:['secret\nvalue']},{ready:true,blockers:['not_ready']},{ready:false,blockers:[]},{ready:false,blockers:['blocked','blocked']}])assert.throws(()=>parseEnterpriseReadinessV1({...probe('sso'),...changes}));
  assert.throws(()=>parseEnterpriseValidationEvidenceJsonV1(' '.repeat(16385)));assert.throws(()=>parseEnterpriseValidationEvidenceJsonV1('{bad json'));
});
test('policy parser rejects inconsistent lifecycle and safe projection strips evidence/configuration',()=>{
  for(const changes of [{state:'unknown'},{policyVersion:0},{maxAccounts:10001},{identitySha256:'b'.repeat(64)},{validatedAt:99},{updatedAt:99},{state:'draft'},{validationKind:null},{validationKind:'migration_preserved_v3'}])assert.throws(()=>parseEnterprisePoolPolicyRecord({...policy(),...changes}));
  const p=enterprisePoolPolicyDto(profile,policy());assert.deepEqual(Object.keys(p).sort(),['enterpriseId','enterpriseRevision','slug','shortcode','state','policyVersion','maxAccounts','validationKind','validatedAt','updatedAt'].sort());
  assert(!JSON.stringify(p).includes('signingKeyRef'));assert(!JSON.stringify(p).includes('registrySha256'));assert(!JSON.stringify(p).includes('validationEvidence'));
});
test('manifest4 has no incarnation mapping or component schema coercion and init creates only Proxy4 plus peers3',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'phase4-manifest-'));try{
    const value={manifestVersion:4,sourceSchemaVersion:3,registry,services:[{component:'proxy',driver:'sqlite',layout:'pool',target:join(dir,'proxy.sqlite'),init:poolOptionsV3()},{component:'sso',driver:'sqlite',layout:'sso',target:join(dir,'sso.sqlite')},{component:'login',driver:'sqlite',layout:'login',target:join(dir,'login.sqlite')}],attestations:{writersStopped:true,externalOperationsDrained:true,backupVerified:true}};
    // Init layout is service-level, never duplicated inside the strict init object.
    delete (value.services[0].init as any).layout;
    const parsed=parseEnterpriseManifestV4(value);assert.equal(parsed.manifestVersion,4);
    for(const mutation of [{manifestVersion:3},{sourceSchemaVersion:2},{accountIncarnations:[]}])assert.throws(()=>parseEnterpriseManifestV4({...value,...mutation}));
    const changed=structuredClone(value);(changed.services[0] as any).accountIncarnations=[];assert.throws(()=>parseEnterpriseManifestV4(changed));
    const result=await runEnterpriseCommandV4('init',value,{env:{}});assert.equal(result.ready,true);assert.deepEqual(result.components.map(c=>c.schemaVersion),[4,3,3]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
