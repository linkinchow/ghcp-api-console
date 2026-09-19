import assert from 'node:assert/strict';
import {fixture as metadataFixture,type Row} from '../default-enterprise/mysql.fixture.js';
import {registryV3,poolOptionsV3} from '../multi-enterprise/fixtures.js';
import {getExpectedEnterpriseMysqlV3,enterpriseMysqlCreateTriggerV3} from '../../src/packages/shared/src/enterpriseMysqlSchemaV3.js';
import {getExpectedEnterpriseMysqlV4} from '../../src/packages/shared/src/enterpriseMysqlSchemaV4.js';
import {enterpriseMysqlRegistryHashV3} from '../../src/packages/shared/src/enterpriseMysqlV3.js';
import {enterpriseProfileIdentityHashV4} from '../../src/packages/shared/src/enterpriseRuntimeV4.js';
import {mysqlCreateTable,type MysqlConnection} from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import {enterpriseMysqlStageSchemaV4} from './mysql.js';
/** Deterministic SQL/metadata simulation only. No mysql2 runtime import or sockets. */
export function mysqlFixtureV4(layout:'direct'|'pool'='pool',version:0|3|4=3,registry=registryV3()){
  const base=metadataFixture(layout,0),data=base.data,statements:string[]=[],mutations:string[]=[];let dead=false,txn:Record<string,Row[]>|undefined;
  let fail:(s:string)=>boolean=()=>false,lose:(s:string)=>boolean=()=>false;
  if(version){const e=version===3?getExpectedEnterpriseMysqlV3(layout):getExpectedEnterpriseMysqlV4(layout);Object.assign(base.schema,structuredClone(e.schema));Object.assign(base.triggers,structuredClone(e.triggers));for(const name of Object.keys(e.schema))data[name]=[];
    data.schema_migrations=['2026-08-27-proxy-mysql-initial','2026-08-27-proxy-token-binary-collation',...(layout==='pool'?['2026-09-12-user-pool-mysql-v1']:[])].map(id=>({id,applied_at:'2026-09-18 00:00:00.000'}));
    data.enterprise_profiles=registry.profiles.map(p=>({id:p.id,slug:p.slug,revision:p.revision,profile_json:JSON.stringify(p),max_accounts:p.maxAccounts}));
    data.enterprise_registry=[{singleton:1,legacy_enterprise_id:registry.legacyEnterpriseId,registry_revision:registry.registryRevision,registry_sha256:enterpriseMysqlRegistryHashV3(registry)}];
    data.enterprise_schema=[{singleton:1,component:'proxy',schema_version:version,contract_version:2,capability:version===3?'enterprise-isolation-legacy-pool':'enterprise-multi-pool',layout,registry_sha256:enterpriseMysqlRegistryHashV3(registry),migration_id:`enterprise-schema${version}-contract2`,state:'complete'}];
    if(layout==='pool')data.user_pool_settings=[{id:1,...poolOptionsV3().pool.settings,account_domain:registry.profiles.find(p=>p.id===registry.legacyEnterpriseId)!.accountDomain,config_fingerprint:'a'.repeat(64)}];
    if(version===4)data.enterprise_pool_policy=registry.profiles.map(p=>({enterprise_id:p.id,state:'draft',policy_version:1,identity_sha256:enterpriseProfileIdentityHashV4(p),validation_kind:null,validation_evidence_json:null,validated_at:null,updated_at:1}));
  }
  function historyEnterprise(table:string,row:Row):string|null { const a=data.proxy_accounts.find(a=>a.identity===row.identity);if(!a)return null;
    const created=Date.parse(a.created_at+'Z'),at=table==='proxy_request_stats'?Date.parse(row.requested_at+'Z'):Number(row.at);
    return Number.isFinite(created)&&Number.isFinite(at)&&at>=created?a.enterprise_id:null;
  }
  async function exec(sql:string,v:any[]):Promise<any>{
    if(sql.startsWith('SET SESSION')||sql.includes('GET_LOCK')||sql.includes('RELEASE_LOCK')||sql.startsWith('SELECT DATABASE()')||sql.includes('information_schema')||sql.startsWith('SELECT HEX'))return base.connection.query(sql,v);
    if(sql.startsWith('SELECT SUM(max_accounts)'))return[[{n:data.enterprise_profiles.reduce((n,p)=>n+Number(p.max_accounts),0)}]];
    if(sql.startsWith('SELECT s.next_ordinal,p.identity,p.ordinal,a.sso_user FROM user_pool_settings s LEFT JOIN user_pool_accounts'))return[data.user_pool_settings.filter(s=>Number(s.id)===1).flatMap(s=>data.user_pool_accounts.length?data.user_pool_accounts.map(p=>({next_ordinal:s.next_ordinal,identity:p.identity,ordinal:p.ordinal,sso_user:data.proxy_accounts.find(a=>a.identity===p.identity)?.sso_user??null})).sort((a,b)=>Number(a.ordinal)-Number(b.ordinal)).slice(0,10001):[{next_ordinal:s.next_ordinal,identity:null,ordinal:null,sso_user:null}])];
    if(sql.startsWith('SELECT p.*,e.max_accounts'))return[data.enterprise_pool_policy.map(p=>({...p,max_accounts:data.enterprise_profiles.find(e=>e.id===p.enterprise_id)!.max_accounts}))];
    if(sql.startsWith('SELECT COUNT(*)')){
      const table=sql.match(/FROM (\w+)/)![1];
      if(sql.includes('LEFT JOIN')){
        if(sql.includes('CAST(h.enterprise_id'))return[[{n:data[table].filter(h=>historyEnterprise(table,h)!==h.enterprise_id).length}]];
        if(sql.includes('BINARY a.enterprise_id <>'))return[[{n:data.user_pool_accounts.filter(p=>data.proxy_accounts.find(a=>a.identity===p.identity)?.enterprise_id!==v[0]).length}]];
        const m=sql.match(/FROM (\w+) a LEFT JOIN (\w+) b ON a\.(\w+)=b\.(\w+)/);assert(m,sql);return[[{n:data[m[1]].filter(a=>(a[m[3]]!==null || !sql.includes('IS NOT NULL')) && !data[m[2]].some(b=>b[m[4]]===a[m[3]])).length}]];
      }
      if(sql.includes("WHERE status='active'"))return[[{n:data[table].filter(r=>r.status==='active').length}]];
      if(sql.includes('copilot_oauth_attempt_id IS NOT NULL'))return[[{n:data.proxy_accounts.filter(a=>a.copilot_oauth_attempt_id!=null||!['valid','expired','missing','failed'].includes(a.copilot_oauth_status)).length}]];
      if(sql.includes("WHERE p.state='provisioning'"))return[[{n:data.user_pool_accounts.filter(p=>p.state==='provisioning'||/ambiguous|unconfirmed|stalled|sso_name_conflict|oauth_task_invalid/.test(p.last_error??'')).length}]];
      if(sql.includes('WHERE enterprise_id IS NOT NULL'))return[[{n:data[table].filter(r=>r.enterprise_id!==null).length}]];
      assert(!sql.includes('WHERE'),sql);return[[{n:data[table].length}]];
    }
    if(sql.includes('AS server_now'))return[data.user_pool_settings.map(s=>({...s,server_now:Date.now()}))];
    if(sql.startsWith('SELECT ')){const m=sql.match(/^SELECT (.+) FROM (\w+)/)!;assert(m,sql);let rows=structuredClone(data[m[2]]);assert(rows,sql);if(sql.includes('WHERE id=?'))rows=rows.filter(r=>r.id===v[0]);if(sql.includes('ORDER BY BINARY')){const k=sql.match(/ORDER BY BINARY (\w+)/)![1];rows.sort((a,b)=>String(a[k]).localeCompare(String(b[k])));}if(m[1]!=='*')rows=rows.map(r=>Object.fromEntries(m[1].split(',').map(k=>[k,r[k]])));return[rows];}
    if(sql==='START TRANSACTION'){txn=structuredClone(data);return[{}];}if(sql==='COMMIT'){txn=undefined;return[{}];}if(sql==='ROLLBACK'){if(txn){for(const n of Object.keys(data))delete data[n];Object.assign(data,txn);txn=undefined;}return[{}];}
    if(sql.startsWith('CREATE TABLE')){const n=sql.match(/CREATE TABLE `(\w+)`/)![1],s=getExpectedEnterpriseMysqlV4(layout).schema;assert.equal(sql,mysqlCreateTable(n,s));assert(!base.schema[n]);base.schema[n]=structuredClone(s[n]);data[n]=[];}
    else if(sql.startsWith('DROP TABLE')){assert.equal(sql,'DROP TABLE enterprise_schema');delete base.schema.enterprise_schema;delete data.enterprise_schema;}
    else if(sql.startsWith('DROP TRIGGER'))delete base.triggers[sql.match(/DROP TRIGGER (\w+)/)![1]];
    else if(sql.startsWith('CREATE TRIGGER')){const n=sql.match(/CREATE TRIGGER (\w+)/)![1],t=getExpectedEnterpriseMysqlV4(layout).triggers[n];assert.equal(sql,enterpriseMysqlCreateTriggerV3(n,t));(base.triggers as Record<string,unknown>)[n]=structuredClone(t);}
    else if(sql.startsWith('ALTER TABLE')){const n=sql.match(/ALTER TABLE (\w+)/)![1],step=Number(data.enterprise_upgrade_v4[0].step);base.schema[n]=structuredClone(enterpriseMysqlStageSchemaV4(layout,step)[n]);for(const r of data[n])r.enterprise_id=null;}
    else if(sql.startsWith('INSERT INTO enterprise_upgrade_v4'))data.enterprise_upgrade_v4.push({singleton:1,migration_id:v[0],database_name:v[1],manifest_sha256:v[2],backup_reference:v[3],backup_sha256:v[4],registry_sha256:v[5],source_sha256:v[6],layout:v[7],state:'applying',step:0,checkpoint_state:'after',evidence_json:v[8],migrated_at:v[9]});
    else if(sql.startsWith('INSERT INTO enterprise_pool_policy'))data.enterprise_pool_policy.push({enterprise_id:v[0],state:v[1],policy_version:1,identity_sha256:v[2],validation_kind:v[3],validation_evidence_json:null,validated_at:v[4],updated_at:v[5]});
    else if(sql.startsWith('INSERT INTO enterprise_profiles'))data.enterprise_profiles.push({id:v[0],slug:v[1],revision:v[2],profile_json:v[3],max_accounts:v[4]});
    else if(sql.startsWith('INSERT INTO enterprise_registry'))data.enterprise_registry.push({singleton:1,legacy_enterprise_id:v[0],registry_revision:v[1],registry_sha256:v[2]});
    else if(sql.startsWith('INSERT INTO enterprise_schema'))data.enterprise_schema.push({singleton:1,component:'proxy',schema_version:4,contract_version:2,capability:'enterprise-multi-pool',layout:v[0],registry_sha256:v[1],migration_id:v[2],state:'complete'});
    else if(sql.startsWith('INSERT INTO schema_migrations'))data.schema_migrations.push({id:v[0],applied_at:'2026-09-18 00:00:00.000'});
    else if(sql.startsWith('INSERT INTO user_pool_settings'))data.user_pool_settings.push(Object.fromEntries(['id','version','idle_target','lease_seconds','paused','next_ordinal','account_domain','config_fingerprint','owner','owner_until'].map((k,i)=>[k,[1,...v][i]])));
    else if(/^UPDATE (proxy_request_stats|user_pool_events) h JOIN/.test(sql)){const table=sql.match(/^UPDATE (\w+)/)![1];for(const r of data[table])r.enterprise_id=historyEnterprise(table,r);}
    else if(sql.startsWith('UPDATE enterprise_upgrade_v4 SET step=')){data.enterprise_upgrade_v4[0].step=v[0];data.enterprise_upgrade_v4[0].checkpoint_state='before';}
    else if(sql.startsWith("UPDATE enterprise_upgrade_v4 SET checkpoint_state='unknown'"))data.enterprise_upgrade_v4[0].checkpoint_state='unknown';
    else if(sql.startsWith("UPDATE enterprise_upgrade_v4 SET checkpoint_state='after'")){data.enterprise_upgrade_v4[0].checkpoint_state='after';data.enterprise_upgrade_v4[0].state=v[0];}
    else if(sql.startsWith('UPDATE enterprise_registry SET')){const r=data.enterprise_registry[0];if(r.registry_revision!==v[2]||r.registry_sha256!==v[3])return[{affectedRows:0}];r.registry_revision=v[0];r.registry_sha256=v[1];}
    else if(sql.startsWith('UPDATE enterprise_schema SET')){const r=data.enterprise_schema[0];if(r.registry_sha256!==v[1])return[{affectedRows:0}];r.registry_sha256=v[0];}
    else assert.fail(`Unhandled synthetic SQL ${sql}`);return[{affectedRows:1}];
  }
  const connection={async query(sql:string,v:any[]=[]){statements.push(sql);if(dead||fail(sql))throw new Error('synthetic driver failure');if(!sql.startsWith('SELECT')&&!sql.startsWith('SET SESSION'))mutations.push(sql);const r=await exec(sql,v);if(lose(sql))throw new Error('lost acknowledgment');return r;},destroy(){dead=true;}} as unknown as MysqlConnection;
  return{connection,data,statements,mutations,base,failWhen(fn:typeof fail){fail=fn;},loseWhen(fn:typeof lose){lose=fn;},reconnect(){dead=false;fail=()=>false;lose=()=>false;base.reconnect();},get destroyed(){return dead;}};
}
