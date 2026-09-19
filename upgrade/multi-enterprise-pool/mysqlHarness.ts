import type {Connection,ConnectionOptions} from 'mysql2/promise';
export type EnterpriseMysqlTestGate={enabled:false}|{enabled:true;host:'127.0.0.1'|'::1';port:number;database:string;user:string;password:string};
const deny=(code:string):never=>{throw new Error(code);};
/** Gate before driver/schema imports. Only these three dedicated variables are ever inspected. */
export function readEnterpriseMysqlTestGate(env:NodeJS.ProcessEnv=process.env):EnterpriseMysqlTestGate{
  const value=env.GHCP_ENTERPRISE_MYSQL_TEST_URL,allow=env.GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL,schema=env.GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA;
  if(value===undefined && allow===undefined && schema===undefined)return{enabled:false};
  if(allow!=='1'||!value||!schema||!/^ghcp_enterprise_test_[a-z0-9_]{1,40}$/.test(schema))return deny('mysql_test_explicit_empty_schema_and_ddl_gate_required');
  let url:URL;try{url=new URL(value);}catch{return deny('mysql_test_invalid_url');}
  // Reject URL normalization tricks, hostnames, alternate numerical IP spellings, socket query parameters and fragments.
  if(!/^mysql:\/\/[^/?#]+\/(?:ghcp_enterprise_test_[a-z0-9_]{1,40})$/.test(value)||url.protocol!=='mysql:'||url.search||url.hash
    ||!['127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!==`/${schema}`||!url.username)return deny('mysql_test_literal_loopback_url_required');
  const authority=value.slice('mysql://'.length).split('/')[0].split('@').at(-1)!;
  if(!/^(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/.test(authority))return deny('mysql_test_literal_loopback_url_required');
  const port=Number(url.port||3306);if(!Number.isInteger(port)||port<1||port>65535)return deny('mysql_test_invalid_port');
  let user:string,password:string;try{user=decodeURIComponent(url.username);password=decodeURIComponent(url.password);}catch{return deny('mysql_test_invalid_credentials');}
  if(!user||/[\x00-\x1f\x7f]/.test(user+password))return deny('mysql_test_invalid_credentials');
  return{enabled:true,host:url.hostname==='[::1]'?'::1':'127.0.0.1',port,database:schema,user,password};
}
export function validateEnterpriseMysqlTestPeer(c:Connection):void{
  const transport=(c as unknown as {connection:{config?:{socketPath?:string};stream?:{remoteAddress?:string}}}).connection;
  if(transport.config?.socketPath||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(transport.stream?.remoteAddress??'')){c.destroy();deny('mysql_test_literal_loopback_peer_required');}
}
export interface EnterpriseMysqlTestHarness {connection:Connection;openConnection():Promise<Connection>;database:string}
/** Preprovided empty schema only. No server/schema provisioning; cleanup only acknowledged objects created by this invocation. */
export async function withEnterpriseMysqlTestSchema<T>(gate:EnterpriseMysqlTestGate,run:(h:EnterpriseMysqlTestHarness)=>Promise<T>):Promise<T>{
  if(!gate.enabled)return deny('mysql_test_gate_disabled');
  // Revalidate a caller-constructed gate instead of trusting the type annotation.
  readEnterpriseMysqlTestGate({GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL:'1',GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA:gate.database,
    GHCP_ENTERPRISE_MYSQL_TEST_URL:`mysql://${encodeURIComponent(gate.user)}:${encodeURIComponent(gate.password)}@${gate.host==='::1'?'[::1]':gate.host}:${gate.port}/${gate.database}`});
  const database=gate.database;
  const {createConnection}=await import('mysql2/promise');
  const [{getExpectedEnterpriseMysqlV4},{getExpectedEnterpriseMysqlV3},{enterpriseMysqlSchema}]=await Promise.all([
    import('../../src/packages/shared/src/enterpriseMysqlSchemaV4.js'),import('../../src/packages/shared/src/enterpriseMysqlSchemaV3.js'),import('../../src/packages/shared/src/enterpriseMysql.js')]);
  const schemas=[enterpriseMysqlSchema('pool'),getExpectedEnterpriseMysqlV3('pool').schema,getExpectedEnterpriseMysqlV4('pool').schema];
  const knownTables=new Set(schemas.flatMap(s=>Object.keys(s))),knownTriggers=new Set([...Object.keys(getExpectedEnterpriseMysqlV3('pool').triggers),...Object.keys(getExpectedEnterpriseMysqlV4('pool').triggers)]);
  const createdTables=new Set<string>(),createdTriggers=new Set<string>(),connections:Connection[]=[],rawQueries=new Map<Connection,Connection['query']>();
  let approvedEmpty=false;
  const config:ConnectionOptions={host:gate.host,port:gate.port,user:gate.user,password:gate.password,database:gate.database,timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,charset:'utf8mb4',connectTimeout:5000,multipleStatements:false};
  async function openRaw():Promise<Connection>{const c=await createConnection(config);try{validateEnterpriseMysqlTestPeer(c);const[r]=await c.query<any[]>('SELECT DATABASE() AS name,VERSION() AS version');if(r.length!==1||r[0].name!==database||!/^8\./.test(r[0].version))deny('mysql_test_dedicated_mysql8_required');connections.push(c);rawQueries.set(c,c.query.bind(c));return c;}catch(e){c.destroy();throw e;}}
  function tracked(c:Connection):Connection{const raw=rawQueries.get(c)!,prepared=c.execute.bind(c);return new Proxy(c,{get(target,key){
    if(key==='query'||key==='execute')return async (...args:unknown[])=>{const sql=typeof args[0]==='string'?args[0]:(args[0] as {sql?:unknown})?.sql;
      if(typeof sql!=='string'||/\b(?:CREATE|DROP|ALTER)\s+(?:DATABASE|SCHEMA)\b/i.test(sql)||/\bUSE\s+/i.test(sql))return deny('mysql_test_schema_provisioning_forbidden');
      const table=sql.match(/^CREATE TABLE\s+`?([a-zA-Z0-9_]+)`?\s*\(/i)?.[1],trigger=sql.match(/^CREATE TRIGGER\s+`?([a-zA-Z0-9_]+)`?\s/i)?.[1];
      if(table&&!knownTables.has(table)||trigger&&!knownTriggers.has(trigger))return deny('mysql_test_unknown_object');
      const result=await Reflect.apply(key==='execute'?prepared:raw,c,args);
      if(table)createdTables.add(table);if(trigger)createdTriggers.add(trigger);
      const dropTable=sql.match(/^DROP TABLE\s+`?([a-zA-Z0-9_]+)`?\s*$/i)?.[1],dropTrigger=sql.match(/^DROP TRIGGER\s+`?([a-zA-Z0-9_]+)`?\s*$/i)?.[1];
      if(dropTable)createdTables.delete(dropTable);if(dropTrigger)createdTriggers.delete(dropTrigger);return result;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});}
  let result:T|undefined,primaryError:unknown;
  try{
    const raw=await openRaw();
    for(const [table,column]of [['TABLES','TABLE_SCHEMA'],['TRIGGERS','TRIGGER_SCHEMA'],['ROUTINES','ROUTINE_SCHEMA'],['EVENTS','EVENT_SCHEMA']] as const){const [rows]=await raw.query<any[]>(`SELECT COUNT(*) AS n FROM information_schema.${table} WHERE ${column}=DATABASE()`);if(Number(rows[0]?.n)!==0)deny('mysql_test_schema_not_empty_no_cleanup');}
    approvedEmpty=true;result=await run({connection:tracked(raw),database:gate.database,openConnection:async()=>tracked(await openRaw())});
  }catch(e){primaryError=e;}
  finally{
    // End transactions first. A rejected initial nonempty schema causes zero cleanup statements.
    for(const c of connections){if(approvedEmpty)try{await rawQueries.get(c)!('ROLLBACK');}catch{/* connection may have been destroyed */}try{await c.end();}catch{c.destroy();}}
    if(approvedEmpty && (createdTables.size||createdTriggers.size)){
      let cleanup:Connection|undefined;
      try{cleanup=await createConnection(config);validateEnterpriseMysqlTestPeer(cleanup);
        const [db]=await cleanup.query<any[]>('SELECT DATABASE() AS name');if(db[0]?.name!==gate.database)deny('mysql_test_cleanup_schema_mismatch');
        const [tables]=await cleanup.query<any[]>('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
        const [triggers]=await cleanup.query<any[]>('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
        if(tables.some(r=>r.TABLE_TYPE!=='BASE TABLE'||!createdTables.has(r.TABLE_NAME))||triggers.some(r=>!createdTriggers.has(r.TRIGGER_NAME)))deny('mysql_test_cleanup_unknown_objects_left_for_manual_inspection');
        await cleanup.query('SET SESSION lock_wait_timeout=5,innodb_lock_wait_timeout=5');
        for(const row of triggers)await cleanup.query(`DROP TRIGGER \`${row.TRIGGER_NAME}\``);
        const [foreign]=await cleanup.query<any[]>('SELECT TABLE_NAME,REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
        const pending=new Set<string>(tables.map(r=>r.TABLE_NAME));while(pending.size){const name=[...pending].find(n=>!foreign.some(f=>f.REFERENCED_TABLE_NAME===n && f.TABLE_NAME!==n && pending.has(f.TABLE_NAME)));if(!name)deny('mysql_test_cleanup_fk_cycle');await cleanup.query(`DROP TABLE \`${name}\``);pending.delete(name!);}
      }catch(e){primaryError??=e;}finally{if(cleanup)try{await cleanup.end();}catch{cleanup.destroy();}}
    }
  }
  if(primaryError)throw primaryError;return result as T;
}
