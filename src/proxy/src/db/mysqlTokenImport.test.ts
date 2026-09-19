import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { MysqlStorage } from './mysqlStorage.js';
import { IMPORT_FENCE_SQL } from './copilotOauthTokenImportFence.js';
import { fixtureRegistry, TEST_ENTERPRISE } from '../test/enterpriseFixtures.js';

interface Account {
  enterprise_id: string; account_incarnation: string; identity: string; sso_user: string; gh_login: string | null;
  copilot_oauth_token: string | null; copilot_oauth_status: string; copilot_oauth_attempt_id: string | null;
  created_at: string; updated_at: string; copilot_oauth_updated_at: string | null;
}
interface Attempt { enterprise_id: string; identity: string; account_incarnation: string; oauth_attempt_id: string; status: string }
const normalize = (sql: string) => sql.replace(/\s+/g,' ').trim();

/** Driver-boundary SQL/rollback fixture, not a simulation of MySQL isolation. */
class Fixture {
  account?: Account;
  attempts: Attempt[] = [];
  calls: string[] = [];
  rollbacks=0;
  beforeWrite?:()=>void;
  private inTransaction=false;
  private locked=false;
  private before?: {account?:Account;attempts:Attempt[]};
  private connection = {
    beginTransaction: async()=>{assert.equal(this.inTransaction,false);this.before=structuredClone({account:this.account,attempts:this.attempts});this.inTransaction=true;},
    commit: async()=>{this.inTransaction=false;this.locked=false;},
    rollback: async()=>{this.rollbacks++;this.account=this.before!.account;this.attempts=this.before!.attempts;this.inTransaction=false;this.locked=false;},
    release:()=>{},destroy:()=>{},
    execute:async(sql:string,args:unknown[]=[])=>this.execute(sql,args),
  } as unknown as PoolConnection;
  storage=new MysqlStorage({getConnection:async()=>this.connection} as unknown as Pool,100,fixtureRegistry());
  constructor() {Reflect.set(this.storage,'registry',fixtureRegistry());}
  seed(identity='alice') {
    this.account={enterprise_id:TEST_ENTERPRISE.id,identity,account_incarnation:randomUUID(),sso_user:identity,gh_login:'alice_octo',
      copilot_oauth_token:'original',copilot_oauth_status:'valid',copilot_oauth_attempt_id:null,
      created_at:'2026-09-19 00:00:00.000',updated_at:'2026-09-19 00:00:00.000',copilot_oauth_updated_at:null};
  }
  begin() {
    assert.ok(this.account);
    const attempt={enterprise_id:this.account.enterprise_id,identity:this.account.identity,account_incarnation:this.account.account_incarnation,
      oauth_attempt_id:randomUUID(),status:'active'};
    this.attempts.push(attempt);this.account.copilot_oauth_attempt_id=attempt.oauth_attempt_id;return attempt;
  }
  snapshot(){return structuredClone({account:this.account,attempts:this.attempts});}
  private execute(raw:string,args:unknown[]) {
    const sql=normalize(raw);this.calls.push(sql);
    assert.equal((sql.match(/\?/g)??[]).length,args.length);
    const rows=(value:unknown[])=>[structuredClone(value),[]];
    const affected=(affectedRows:number)=>[{affectedRows},[]];
    if(sql===normalize(IMPORT_FENCE_SQL)) {
      const [enterprise,identity,target]=args;assert.equal(identity,target);
      return rows([{enterprise_id:this.account?.enterprise_id??null,account_incarnation:this.account?.account_incarnation??null,
        copilot_oauth_attempt_id:this.account?.copilot_oauth_attempt_id??null,
        authorization_attempts:this.attempts.filter(a=>a.enterprise_id===enterprise&&a.identity===identity).length}]);
    }
    assert.ok(this.inTransaction,'all commit-path SQL uses a transaction');
    if(sql.startsWith('INSERT INTO proxy_accounts')) {
      assert.ok(sql.endsWith('ON DUPLICATE KEY UPDATE identity=identity'),'reservation must not overwrite another incarnation');
      if(!this.account) {
        const [enterprise,incarnation,identity,ssoUser,ghLogin,created,updated]=args;
        this.account={enterprise_id:String(enterprise),account_incarnation:String(incarnation),identity:String(identity),sso_user:String(ssoUser),
          gh_login:ghLogin as string|null,copilot_oauth_token:null,copilot_oauth_status:'missing',copilot_oauth_attempt_id:null,
          created_at:String(created),updated_at:String(updated),copilot_oauth_updated_at:null};
      }
      return affected(1);
    }
    if(sql==='SELECT * FROM proxy_accounts WHERE identity=? FOR UPDATE') {this.locked=true;return rows(this.account?[this.account]:[]);}
    assert.ok(this.locked,'account lock precedes ledger reads and credential mutation');
    if(sql==='SELECT oauth_attempt_id FROM proxy_authorization_attempts WHERE enterprise_id=? AND identity=? FOR UPDATE') {
      return rows(this.attempts.filter(a=>a.enterprise_id===args[0]&&a.identity===args[1]).map(a=>({oauth_attempt_id:a.oauth_attempt_id})));
    }
    if(sql===normalize(`UPDATE proxy_accounts SET gh_login=COALESCE(?,gh_login),copilot_oauth_token=?,copilot_oauth_status='valid',copilot_oauth_updated_at=?,copilot_oauth_attempt_id=NULL,updated_at=?
        WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id <=> ?`)) {
      this.beforeWrite?.();
      const [login,token,tokenAt,updated,enterprise,identity,incarnation,nonce]=args,a=this.account;
      if(!a||a.enterprise_id!==enterprise||a.identity!==identity||a.account_incarnation!==incarnation||a.copilot_oauth_attempt_id!==nonce)return affected(0);
      a.gh_login=login as string??a.gh_login;a.copilot_oauth_token=String(token);a.copilot_oauth_status='valid';
      a.copilot_oauth_updated_at=String(tokenAt);a.updated_at=String(updated);a.copilot_oauth_attempt_id=null;return affected(1);
    }
    if(sql==="UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='token_imported',updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND oauth_attempt_id=? AND status='active'") {
      const [,enterprise,identity,incarnation,nonce]=args;let changed=0;
      for(const a of this.attempts)if(a.enterprise_id===enterprise&&a.identity===identity&&a.account_incarnation===incarnation&&a.oauth_attempt_id===nonce&&a.status==='active'){a.status='cancelled';changed++;}
      return affected(changed);
    }
    if(sql==='SELECT * FROM proxy_accounts WHERE enterprise_id=? AND identity=?') {
      assert.equal(this.account?.enterprise_id,args[0]);assert.equal(this.account?.identity,args[1]);return rows([this.account]);
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  }
}
const input={identity:'alice',ssoUser:'alice',ghLogin:'alice_octo',copilotOauthToken:'replacement'};

test('MySQL import CAS rejects delete/recreate, lost absence and fresh authorization including completed nonce ABA',async()=>{
  for(const scenario of ['deleted','recreated','absent-created','fresh-attempt','finished-attempt','observed-attempt-finished'] as const) {
    const f=new Fixture();if(scenario!=='absent-created')f.seed();
    if(scenario==='observed-attempt-finished')f.begin();
    const expectedAccount=await f.storage.getCopilotOauthTokenImportFence('alice');
    if(scenario==='deleted')f.account=undefined;
    if(scenario==='recreated'||scenario==='absent-created')f.seed();
    if(scenario==='fresh-attempt'||scenario==='finished-attempt')f.begin();
    if(scenario==='finished-attempt'||scenario==='observed-attempt-finished'){f.attempts.at(-1)!.status='cancelled';f.account!.copilot_oauth_attempt_id=null;}
    const before=f.snapshot();
    await assert.rejects(f.storage.importCopilotOauthToken({...input,expectedAccount}),/stale_token_import/,scenario);
    assert.deepEqual(f.snapshot(),before);assert.equal(f.rollbacks,1);
    assert.ok(!f.calls.some(sql=>sql.startsWith('UPDATE ')),'stale fence fails before credentials or ledger writes');
  }
});

test('MySQL import creates from absence and overwrites only the observed live incarnation/attempt',async()=>{
  for(const present of [false,true]) {
    const f=new Fixture();if(present){f.seed();f.begin();}
    const expectedAccount=await f.storage.getCopilotOauthTokenImportFence('alice');
    const saved=await f.storage.importCopilotOauthToken({...input,expectedAccount});
    assert.equal(saved.copilotOauthToken,'replacement');assert.equal(saved.copilotOauthAttemptId,undefined);
    if(present){assert.equal(saved.accountIncarnation,expectedAccount.accountIncarnation);assert.equal(f.attempts[0]?.status,'cancelled');}
    assert.equal(f.rollbacks,0);
  }
});

test('MySQL import CAS affected-row failure rolls back and cannot consume the attempt',async()=>{
  const f=new Fixture();f.seed();f.begin();const expectedAccount=await f.storage.getCopilotOauthTokenImportFence('alice'),before=f.snapshot();
  f.beforeWrite=()=>{f.account!.copilot_oauth_attempt_id=randomUUID();};
  await assert.rejects(f.storage.importCopilotOauthToken({...input,expectedAccount}),/stale_token_import/);
  assert.deepEqual(f.snapshot(),before);assert.equal(f.rollbacks,1);
});
