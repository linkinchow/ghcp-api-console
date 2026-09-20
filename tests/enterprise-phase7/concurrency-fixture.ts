import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { EnterpriseMysqlTestHarness } from '../../upgrade/multi-enterprise-pool/mysqlHarness.js';
import type { EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';

/** No driver or service imports until caller has entered the dedicated-schema gate. */
export async function registry(count: number, cap: number): Promise<EnterpriseRegistryV3> {
  assert.ok(Number.isInteger(count) && count >= 2 && count <= 100 && count * cap <= 10000);
  const {parseEnterpriseRegistryV3}=await import('../../src/packages/shared/src/enterpriseV3.js');
  const ids=Array.from({length:count},(_,i)=>`${(i+1).toString(16).padStart(8,'0')}-7777-4777-8777-777777777777`);
  return parseEnterpriseRegistryV3({version:3,registryRevision:1,legacyEnterpriseId:ids[0],profiles:ids.map((id,i)=>{
    const slug=`phase7-${i}`,root='http://127.0.0.1:19071',base=`${root}${i?`/profiles/${id}`:''}`;
    return{id,slug,shortcode:`t${i.toString(36).padStart(3,'0')}`,revision:1,maxAccounts:cap,accountDomain:`${slug}.invalid`,
      routes:{proxyInternalUrl:'http://127.0.0.1:19070',ssoInternalUrl:root,loginInternalUrl:'http://127.0.0.1:19073',ssoPublicUrl:root},
      sso:{entityId:`${base}/metadata`,ssoUrl:`${base}/sso`,loginUrl:`${base}/login`,logoutUrl:`${base}/logout`,
        spEntityId:`https://${slug}.invalid/sp`,spAcsUrl:`https://${slug}.invalid/acs`,scimBaseUrl:`https://${slug}.invalid/scim`,githubApiBaseUrl:`https://${slug}.invalid/github`,
        emailDomain:`${slug}.invalid`,userPrefix:'synthetic',signingCertRef:{env:`TEST_${i}_CERT`},signingKeyRef:{env:`TEST_${i}_KEY`},sessionSecretRef:{env:`TEST_${i}_SESSION`}},
      login:{provider:'custom',allowedLoginUrls:[`${base}/login`],selectors:{user:'#user',password:'#password'}}};
  })});
}
export async function stores(h: EnterpriseMysqlTestHarness, reg: EnterpriseRegistryV3, idleTarget=0) {
  const [{MysqlPoolStore},{normalizePoolConfig},{initEnterpriseMysqlV4}]=await Promise.all([
    import('../../src/proxy/src/userPool/mysqlStore.js'),import('../../src/proxy/src/userPool/config.js'),
    import('../../src/packages/shared/src/enterpriseMysqlV4.js')]);
  const options=normalizePoolConfig({enabled:true,accountDomain:reg.profiles[0].accountDomain,idleTarget,maxAccounts:reg.profiles.reduce((n,p)=>n+p.maxAccounts,0),
    leaseSeconds:600,provisionalSeconds:30,pollMs:1000,retryAfterSeconds:1,warmupModel:'synthetic-no-http',requestTimeoutMs:30000});
  const {idleTarget:_i,maxAccounts:_m,leaseSeconds:_l,enabled:_e,callerDomain:_d,...invariants}=options;
  const fingerprint=createHash('sha256').update(JSON.stringify(Object.entries(invariants).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  await initEnterpriseMysqlV4(h.connection,'proxy',reg,{layout:'pool',pool:{fingerprint,settings:{version:1,idle_target:idleTarget,lease_seconds:600,paused:1,next_ordinal:0,account_domain:reg.profiles[0].accountDomain,owner:null,owner_until:0}}});
  const open=async()=>{const c=await h.openConnection();await c.query('SET SESSION lock_wait_timeout=5,innodb_lock_wait_timeout=5');return c;};
  const pool={
    async query(...args:unknown[]){const c=await open();try{return await Reflect.apply(c.query,c,args);}finally{await c.end();}},
    async execute(...args:unknown[]){const c=await open();try{return await Reflect.apply(c.execute,c,args);}finally{await c.end();}},
    async getConnection(){const c=await open();let released=false;return new Proxy(c,{get(target,key){if(key==='release')return()=>{if(!released){released=true;void c.end().catch(()=>c.destroy());}};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}}) as unknown as PoolConnection;},
  } as unknown as Pool;
  const first=new MysqlPoolStore(pool,options,reg),second=new MysqlPoolStore(pool,options,reg);
  await Promise.all([first.initialize(),second.initialize()]);
  async function active(ids=reg.profiles.map(p=>p.id)){
    const [{enterpriseProfileIdentityHashV4},{enterpriseRegistryHashV3}]=await Promise.all([
      import('../../src/packages/shared/src/enterpriseRuntimeV4.js'),import('../../src/packages/shared/src/enterpriseRuntimeV3.js')]);
    for(const id of ids){const p=reg.profiles.find(r=>r.id===id)!;const now=await first.now();
      const binding={enterpriseId:p.id,enterpriseRevision:p.revision,profileIdentitySha256:enterpriseProfileIdentityHashV4(p),registryRevision:reg.registryRevision,registrySha256:enterpriseRegistryHashV3(reg),legacyEnterpriseId:reg.legacyEnterpriseId};
      const probe={...binding,probeVersion:1,schemaVersion:3,contractVersion:2,capability:'enterprise-isolation-legacy-pool',ready:true,blockers:[]};
      const evidence={...binding,version:1,checkedAt:now,sso:{...probe,component:'sso'},login:{...probe,component:'login'}};
      await h.connection.query(`UPDATE enterprise_pool_policy SET state='active',policy_version=1,validation_kind='local_service_readiness_v1',validation_evidence_json=?,validated_at=?,updated_at=? WHERE enterprise_id=?`,[JSON.stringify(evidence),now,now,id]);
    }
  }
  async function settings(changes: Record<string,number>){const prior=await first.settings();return first.updateSettings(prior.version,changes);}
  async function cap(id:string,value:number){const prior=(await first.enterprisePolicy(id))!;return first.updateEnterprisePolicy(id,prior.policyVersion,{type:'cap',maxAccounts:value});}
  async function drain(id:string){const prior=(await first.enterprisePolicy(id))!;return first.updateEnterprisePolicy(id,prior.policyVersion,{type:'drain'});}
  return{first,second,pool,options,active,settings,cap,drain,MysqlPoolStore};
}
/** Barrier keeps the real transaction and server locks; never replaces a SQL result.
 * Both reach and release are bounded, and cleanup always unblocks intercepted calls. */
export function sqlBarrier(pool: Pool, matches: (sql:string)=>boolean) {
  let reached!:()=>void,release!:()=>void,used=false;
  const entered=new Promise<void>(done=>{reached=done;}),resume=new Promise<void>(done=>{release=done;});
  const intercepted={...pool,async getConnection(){const c=await pool.getConnection();return new Proxy(c,{get(target,key){
    if(key==='query'||key==='execute')return async(...args:unknown[])=>{const result=await Reflect.apply(target[key],target,args);
      if(!used&&typeof args[0]==='string'&&matches(args[0])){used=true;reached();await bounded(resume,5000);}
      return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});}} as Pool;
  return{pool:intercepted,entered:()=>bounded(entered,5000),release};
}
export async function bounded<T>(promise:Promise<T>,ms=10000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('phase7_bounded_wait_exceeded')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
