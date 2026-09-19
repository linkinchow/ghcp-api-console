import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import Database from 'better-sqlite3';
import {parseEnterpriseRegistryV3,parseEnterpriseValidationEvidenceV1,type EnterpriseProfileV3,type LoginTaskDto,type SsoUserDto} from '@ghcp/shared';
import {initEnterpriseSqliteV4} from '@ghcp/shared/enterpriseStorageV4';
import {fixtureProfile,fixtureReadinessEvidence,TEST_ENTERPRISE} from '../test/enterpriseFixtures.js';
import {readPoolConfig} from './config.js';
import {accountName} from './names.js';
import {UserPoolStore} from './store.js';
import {PrewarmWorker} from './worker.js';
import {realProvisioner} from './provisioner.js';
import {config} from '../config.js';
import {getStorage,closeStorage} from '../db/connection.js';
import {getUserPool,stopUserPool} from './runtime.js';
import {buildApp} from '../server.js';

const B='22222222-2222-4222-8222-222222222222';
const model='synthetic-phase4-model';
const caller=(n:number)=>`sha256:${n.toString(16).padStart(64,'0')}`;
const tickTurn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('two active enterprise runtime: score selects B, isolated prewarm and nonlegacy compatible inference', {timeout:30000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'enterprise-phase4-runtime-'));
  const savedEnv={...process.env},savedConfig={...config},nativeFetch=globalThis.fetch;
  const options=readPoolConfig({ACCOUNT_ROUTING_MODE:'caller-lease',POOL_ACCOUNT_EMAIL_DOMAIN:'alpha.accounts.test',POOL_WARMUP_MODEL:model,
    READY_IDLE_TARGET:'2',POOL_MAX_ACCOUNTS:'9',PREWARM_CONCURRENCY:'2',POOL_LOGIN_MAX_PENDING:'2',PREWARM_POLL_SECONDS:'1'});
  const a:EnterpriseProfileV3={...fixtureProfile(options),maxAccounts:9,routes:{...TEST_ENTERPRISE.routes,ssoInternalUrl:'http://sso-alpha.synthetic.invalid',loginInternalUrl:'http://login-alpha.synthetic.invalid'}};
  const publicRoot='http://sso-beta.synthetic.invalid';
  const b:EnterpriseProfileV3={...fixtureProfile(options),id:B,slug:'synthetic-beta',shortcode:'beta',accountDomain:'beta.accounts.test',revision:2,maxAccounts:1,
    routes:{...TEST_ENTERPRISE.routes,ssoInternalUrl:'http://sso-beta.synthetic.invalid',loginInternalUrl:'http://login-beta.synthetic.invalid',ssoPublicUrl:publicRoot},
    sso:{...fixtureProfile(options).sso,entityId:`${publicRoot}/profiles/${B}/metadata`,ssoUrl:`${publicRoot}/profiles/${B}/sso`,loginUrl:`${publicRoot}/profiles/${B}/login`,logoutUrl:`${publicRoot}/profiles/${B}/logout`,emailDomain:'beta.users.test'},
    login:{provider:'custom',allowedLoginUrls:[`${publicRoot}/profiles/${B}/login`],selectors:{}}};
  const registry=parseEnterpriseRegistryV3({version:3,registryRevision:7,legacyEnterpriseId:a.id,profiles:[a,b]});
  const registryPath=join(directory,'registry.json'),dbPath=join(directory,'proxy.sqlite');writeFileSync(registryPath,JSON.stringify(registry));
  const initialized=new Database(dbPath);
  try{
    initEnterpriseSqliteV4(initialized,'proxy',registry,{layout:'pool',pool:{settings:{version:1,idle_target:2,lease_seconds:600,paused:1,next_ordinal:0,account_domain:a.accountDomain,owner:null,owner_until:0}}});
    const seed=new UserPoolStore(initialized,options,registry);
    for(const profile of registry.profiles){let policy=seed.enterprisePolicy(profile.id)!;const evidence={...fixtureReadinessEvidence(registry,profile.id),checkedAt:seed.now()};
      policy=seed.updateEnterprisePolicy(profile.id,policy.policyVersion,{type:'validate',evidence});seed.updateEnterprisePolicy(profile.id,policy.policyVersion,{type:'activate',evidence});}
    const now=Date.now(),stamp=new Date(now).toISOString();
    initialized.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(a.id,randomUUID(),accountName(0),accountName(0),stamp,stamp);
    initialized.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,updated_at) VALUES(?,0,'provisioning','new',?,?)`).run(accountName(0),randomUUID(),now);
    initialized.prepare('UPDATE user_pool_settings SET next_ordinal=1,paused=0 WHERE id=1').run();
  }finally{initialized.close();}
  Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:join(directory,'missing.env'),ENTERPRISE_REGISTRY_FILE:registryPath,DB_PATH:dbPath,
    ACCOUNT_ROUTING_MODE:'caller-lease',STORAGE_DRIVER:'sqlite',POOL_ACCOUNT_EMAIL_DOMAIN:a.accountDomain,POOL_WARMUP_MODEL:model,
    READY_IDLE_TARGET:'2',POOL_MAX_ACCOUNTS:'9',PREWARM_CONCURRENCY:'2',POOL_LOGIN_MAX_PENDING:'2',PREWARM_POLL_SECONDS:'1',CALLER_LEASE_TTL_SECONDS:'600'});
  Object.assign(config,{dbPath,storageDriver:'sqlite',enterpriseShortcode:a.shortcode,ssoBaseUrl:a.routes.ssoInternalUrl,loginBaseUrl:a.routes.loginInternalUrl,
    apiKey:'phase4-synthetic-api-key',internalApiToken:'phase4-synthetic-internal',copilotApiBaseUrl:'http://model.synthetic.invalid',errorDiagnosticsEnabled:false});
  await stopUserPool();await closeStorage();
  const store=await getUserPool();assert.ok(store instanceof UserPoolStore);const storage=getStorage();
  const users=new Map<string,Map<string,SsoUserDto>>(registry.profiles.map(p=>[p.id,new Map()]));
  const tasks=new Map<string,Map<string,LoginTaskDto>>(registry.profiles.map(p=>[p.id,new Map()]));
  const tokenOwners=new Map<string,{enterpriseId:string;identity:string}>(),calls:{enterpriseId:string;method:string;path:string}[]=[],inferences:{enterpriseId:string;identity:string;token:string}[]=[],mockErrors:unknown[]=[];
  const readinessCalls=new Set<string>(),started=new Set<string>();let releaseStart!:()=>void;
  const bothStarted=new Promise<void>(resolve=>{releaseStart=resolve;});
  const json=(value:unknown,status=200)=>Response.json(value,{status});
  const transport:typeof fetch=async(input,init)=>{
    try{
      const url=new URL(String(input)),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;
      if(url.origin===config.copilotApiBaseUrl){
        const token=(new Headers(init?.headers).get('authorization')??'').replace(/^Bearer /,'');const owner=tokenOwners.get(token);assert.ok(owner,'every model request must carry a fixture-issued enterprise credential');
        if(url.pathname==='/models')return json({data:[{id:model,capabilities:{endpoints:['/v1/messages']}}]});
        assert.equal(url.pathname,'/v1/messages');assert.equal(body.model,model);assert.equal(body.stream,false);
        if(body.messages[0].content!=='Reply OK')inferences.push({...owner,token});
        return json({id:'synthetic-message',type:'message',role:'assistant',model,content:[{type:'text',text:'OK'}]});
      }
      const profile=registry.profiles.find(p=>url.origin===p.routes.ssoInternalUrl||url.origin===p.routes.loginInternalUrl);assert.ok(profile,`forbidden outbound origin ${url.origin}`);
      if(url.origin===profile.routes.ssoInternalUrl&&url.pathname===`/internal/profiles/${profile.id}/creation-capacity`){
        assert.equal(method,'GET');assert.equal(new Headers(init?.headers).get('x-enterprise-id'),profile.id);
        assert.equal(new Headers(init?.headers).get('x-enterprise-revision'),String(profile.revision));
        return json({enterpriseId:profile.id,enterpriseRevision:profile.revision,currentUsers:users.get(profile.id)!.size,maxUsers:null,availableSlots:null,canCreate:true});
      }
      const prefix=`/api/profiles/${profile.id}`;assert.ok(url.pathname.startsWith(prefix+'/'),'enterprise path must match trusted transport origin');
      assert.equal(new Headers(init?.headers).get('x-enterprise-id'),profile.id);assert.equal(new Headers(init?.headers).get('x-enterprise-revision'),String(profile.revision));
      assert.equal(new Headers(init?.headers).get('x-internal-token'),config.internalApiToken);assert.equal(init?.redirect,'error');assert.ok(init?.signal);
      const path=url.pathname.slice(prefix.length),localUsers=users.get(profile.id)!,localTasks=tasks.get(profile.id)!;calls.push({enterpriseId:profile.id,method,path});
      if(url.origin===profile.routes.ssoInternalUrl){
        if(path==='/users'&&method==='POST'){
          assert.equal(body.email,`${body.ssoUser}@${profile.accountDomain}`);assert.equal(body.role,'user');assert.equal(body.poolManaged,true);assert(!localUsers.has(body.ssoUser));
          const member=store.inventory(body.ssoUser)!;assert.equal(member.enterprise_id,profile.id);assert.equal(member.enterprise_revision,profile.revision);assert.equal(member.stage,'sso-creating');
          const stamp=new Date(store.now()).toISOString(),user:SsoUserDto={enterpriseId:profile.id,userIncarnation:randomUUID(),ssoUser:body.ssoUser,email:body.email,role:'user',emuStatus:'not_synced',copilotSeatStatus:'unassigned',createdAt:stamp,updatedAt:stamp};
          localUsers.set(user.ssoUser,user);started.add(profile.id);if(started.size===2)releaseStart();await bothStarted;return json(user,201);
        }
        if(path==='/users/batch'&&method==='POST'){
          assert.equal(body.operation,'sync_emu');assert.equal(body.createOnly,true);assert.equal(body.assignCopilotSeat,false);const user=localUsers.get(body.ssoUsers[0]);assert.ok(user);assert.equal(user.emuStatus,'not_synced');
          Object.assign(user,{emuStatus:'active',ghLogin:`${user.ssoUser.replaceAll('.','-')}_${profile.shortcode}`,ghScimId:`${profile.shortcode}-scim`});return json({rows:[{ssoUser:user.ssoUser,status:'success',user}]});
        }
        const match=/^\/users\/([^/]+)(?:\/(.+))?$/.exec(path);assert.ok(match);const id=decodeURIComponent(match[1]),action=match[2],user=localUsers.get(id);
        if(method==='GET'&&!action)return user?json(user):json({},404);
        assert.ok(user);if(method==='POST'&&action==='copilot-seat'){assert.equal(user.copilotSeatStatus,'unassigned');user.copilotSeatStatus='assigned';return json(user);}
        if(method==='POST'&&action==='login-credentials'){assert.deepEqual(body,{expectedCreatedAt:user.createdAt,expectedEmail:user.email});return json({user,passwordForLogin:`synthetic-password-${profile.shortcode}`});}
      }else{
        if(path==='/tasks'&&method==='POST'){
          const user=localUsers.get(body.identity);assert.ok(user);assert.equal(body.ssoPassword,`synthetic-password-${profile.shortcode}`);assert.equal(body.enterpriseId,profile.id);assert.equal(body.enterpriseRevision,profile.revision);
          const account=await storage.getAccount(body.identity,profile.id);assert.ok(account);assert.equal(body.accountIncarnation,account.accountIncarnation);assert.equal(body.expectedGhLogin,user.ghLogin);
          const attempt=await storage.getAuthorizationAttempt(profile.id,body.identity,body.oauthAttemptId);assert.ok(attempt);assert.equal(attempt.status,'active');
          assert.deepEqual(attempt.binding,{enterpriseId:profile.id,enterpriseRevision:profile.revision,identity:body.identity,accountIncarnation:account.accountIncarnation,oauthAttemptId:body.oauthAttemptId,expectedGhLogin:user.ghLogin});
          const token=`synthetic-token-${profile.shortcode}-${body.identity}`;tokenOwners.set(token,{enterpriseId:profile.id,identity:body.identity});
          const result=await storage.completeAuthorizationAttempt(attempt.binding,token,{login:user.ghLogin!,id:profile.id===a.id?'101':'202'});assert.equal(result.outcome,'applied');
          const task:LoginTaskDto={id:randomUUID(),enterpriseId:profile.id,enterpriseRevision:profile.revision,accountIncarnation:account.accountIncarnation,expectedGhLogin:user.ghLogin,identity:body.identity,ssoUser:body.ssoUser,ghLogin:user.ghLogin,oauthAttemptId:body.oauthAttemptId,ssoType:'custom',status:'success',attempts:1,createdAt:new Date(store.now()).toISOString()};
          assert(![...localTasks.values()].some(t=>t.oauthAttemptId===task.oauthAttemptId),'no nonce replay');localTasks.set(task.id,task);return json(task,202);
        }
        if(path.startsWith('/tasks/')&&method==='GET'){const task=localTasks.get(path.slice('/tasks/'.length));assert.ok(task,'cannot read another enterprise task');return json(task);}
      }
      assert.fail(`unexpected synthetic request ${method} ${url.href}`);
    }catch(error){mockErrors.push(error);throw error;}
  };
  globalThis.fetch=transport;
  const worker=new PrewarmWorker(store,realProvisioner(store,options,{fetch:transport,enterpriseProfile:id=>{const p=registry.profiles.find(p=>p.id===id);assert.ok(p);return p;},
    verifyReadiness:async(profile,signal)=>{signal.throwIfAborted();const evidence=parseEnterpriseValidationEvidenceV1(fixtureReadinessEvidence(registry,profile.id));assert.equal(evidence.enterpriseRevision,profile.revision);readinessCalls.add(profile.id);}}),options.pollMs,2);
  let server:ReturnType<ReturnType<typeof buildApp>['listen']>|undefined;
  try{
    await t.test('A1/B0 with caps9/1 reserves B and concurrently prewarms isolated enterprise routes/domains',async()=>{
      assert.equal(store.counts().total,1);assert.equal(store.inventory(accountName(0))!.enterprise_id,a.id);
      for(let i=0;i<30&&store.counts().ready_idle<2;i++){await worker.tick();await tickTurn();assert.deepEqual(mockErrors,[]);}
      assert.equal(store.counts().total,2);assert.equal(store.counts().ready_idle,2);const beta=store.inventory(accountName(1))!;assert.equal(beta.enterprise_id,b.id);assert.equal(beta.enterprise_revision,2);
      assert.deepEqual([...started].sort(),[a.id,b.id].sort());assert.deepEqual([...readinessCalls].sort(),[a.id,b.id].sort());
      for(const profile of registry.profiles){assert.equal(users.get(profile.id)!.size,1);assert.equal(tasks.get(profile.id)!.size,1);const user=[...users.get(profile.id)!.values()][0];assert.equal(user.email,`${user.ssoUser}@${profile.accountDomain}`);assert.equal(user.copilotSeatStatus,'assigned');}
      assert.equal(await storage.getAccount(beta.identity,a.id),undefined);assert.equal((await storage.getAccount(beta.identity,b.id))!.copilotOauthStatus,'valid');
    });
    await t.test('global idle already sufficient does not create extra inventory for ratio balancing',async()=>{
      const before=JSON.stringify(store.accounts()),posts=calls.filter(c=>c.method==='POST').length;
      for(let i=0;i<5;i++)await worker.tick();assert.equal(store.counts().total,2);assert.equal(JSON.stringify(store.accounts()),before);assert.equal(calls.filter(c=>c.method==='POST').length,posts);
    });
    await t.test('readiness eligibility fails closed and owner handoff rechecks previously cached profiles',async()=>{
      const before=store.counts().total,probes:string[]=[];let betaReady=false;
      const eligibility=realProvisioner(store,options,{fetch:transport,enterpriseProfile:id=>registry.profiles.find(p=>p.id===id)!,verifyReadiness:async(profile,signal)=>{signal.throwIfAborted();probes.push(profile.id);if(profile.id===b.id&&!betaReady)throw new Error('synthetic-local-readiness-blocker');}});
      assert.ok(eligibility.eligibleEnterprises);const signal=new AbortController().signal;
      assert.deepEqual(await eligibility.eligibleEnterprises(signal,'owner-one'),[a.id]);
      betaReady=true;assert.deepEqual([...(await eligibility.eligibleEnterprises(signal,'owner-one'))].sort(),[a.id,b.id].sort());
      assert.equal(probes.filter(id=>id===a.id).length,1,'ready profile is cached only inside the same tenure');
      assert.deepEqual([...(await eligibility.eligibleEnterprises(signal,'owner-two'))].sort(),[a.id,b.id].sort());
      assert.equal(probes.filter(id=>id===a.id).length,2,'new owner must revalidate both profiles');
      assert.equal(store.counts().total,before,'readiness discovery has no registration side effects');assert.deepEqual(mockErrors,[]);
    });
    await t.test('nonlegacy held enterprise flows through actual compatible HTTP credential lookup and durable request stats',async()=>{
      server=buildApp().listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const request=async(n:number)=>{const response=await nativeFetch(`${base}/v1/messages`,{method:'POST',headers:{authorization:`Bearer ${config.apiKey}`,'x-user-identity':caller(n),'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'synthetic-inference'}],max_tokens:8,stream:false})});assert.equal(response.status,200);assert.equal((await response.json() as {model:string}).model,model);};
      // Existing stable within-enterprise ordering is retained: score first chooses A, then B is the sole idle member.
      await request(1);await request(2);assert.equal(inferences.length,2);assert.equal(inferences[0].enterpriseId,a.id);assert.equal(inferences[1].enterpriseId,b.id);
      const leases=store.leases(),betaLease=leases.find(l=>l.caller_id===caller(2))!;assert.equal(betaLease.member_identity,accountName(1));
      const held=store.acquire(caller(2));assert.equal(held.enterprise_id,b.id);assert.equal(held.enterprise_revision,b.revision);store.finish(held,false);
      await request(2);assert.equal(inferences[2].token,inferences[1].token);assert.equal(store.counts().total,2);assert.equal(store.leases().length,2);
      const stats=await storage.listRequestStats(undefined,100,b.id);assert.equal(stats.length,2);assert(stats.every(stat=>stat.enterpriseId===b.id&&stat.identity===accountName(1)));
      assert.equal((await storage.listRequestStats(undefined,100,a.id)).length,1);assert.deepEqual(mockErrors,[]);
    });
  }finally{
    releaseStart();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
    await worker.stop();await stopUserPool();await closeStorage();globalThis.fetch=nativeFetch;Object.assign(config,savedConfig);
    for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,savedEnv);rmSync(directory,{recursive:true,force:true});
  }
});
