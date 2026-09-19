import test from 'node:test';
import assert from 'node:assert/strict';
import {readEnterpriseMysqlTestGate,withEnterpriseMysqlTestSchema,validateEnterpriseMysqlTestPeer} from './mysqlHarness.js';

test('disabled dedicated MySQL gate reads only explicit names and makes no driver/connection call',async()=>{
  const reads:string[]=[],env=new Proxy({}, {get(_t,key){reads.push(String(key));if(!String(key).startsWith('GHCP_ENTERPRISE_MYSQL_TEST_'))throw new Error('ambient environment access');return undefined;}});
  const gate=readEnterpriseMysqlTestGate(env);assert.deepEqual(gate,{enabled:false});assert.equal(reads.length,3);
  await assert.rejects(withEnterpriseMysqlTestSchema(gate,async()=>assert.fail('must never run')),/gate_disabled/);
});
test('explicit test gate rejects partial opt-in, production names, hostname and URL tricks before driver import',()=>{
  const base={GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL:'1',GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA:'ghcp_enterprise_test_dedicated',GHCP_ENTERPRISE_MYSQL_TEST_URL:'mysql://test:synthetic@127.0.0.1:3306/ghcp_enterprise_test_dedicated'};
  for(const change of [{GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL:'true'},{GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA:'production'},
    ...['mysql://test:x@localhost/ghcp_enterprise_test_dedicated','mysql://test:x@127.1/ghcp_enterprise_test_dedicated','mysql://test:x@2130706433/ghcp_enterprise_test_dedicated',
      'mysql://test:x@127.0.0.1/ghcp_enterprise_test_dedicated?socketPath=x','mysql://test:x@127.0.0.1/ghcp_enterprise_test_dedicated#fragment',
      'mysql://test:x@127.0.0.1/other','mysql://test:x@10.0.0.1/ghcp_enterprise_test_dedicated','mysql://test:x@127.0.0.1/%67hcp_enterprise_test_dedicated'].map(url=>({GHCP_ENTERPRISE_MYSQL_TEST_URL:url}))])assert.throws(()=>readEnterpriseMysqlTestGate({...base,...change}));
  const gate=readEnterpriseMysqlTestGate(base);assert.equal(gate.enabled,true);assert.equal(readEnterpriseMysqlTestGate({...base,GHCP_ENTERPRISE_MYSQL_TEST_URL:'mysql://test:x@[::1]:3306/ghcp_enterprise_test_dedicated'}).enabled,true);
});
test('peer validation denies socket paths and non-loopback peers without trusting URL alone',()=>{
  for(const remoteAddress of ['10.0.0.1','127.0.0.2',undefined]){let destroyed=false;assert.throws(()=>validateEnterpriseMysqlTestPeer({connection:{stream:{remoteAddress}},destroy(){destroyed=true;}} as any));assert.equal(destroyed,true);}
  assert.throws(()=>validateEnterpriseMysqlTestPeer({connection:{config:{socketPath:'/tmp/mysql.sock'},stream:{remoteAddress:'127.0.0.1'}},destroy(){}} as any));
  for(const remoteAddress of ['127.0.0.1','::1','::ffff:127.0.0.1'])validateEnterpriseMysqlTestPeer({connection:{stream:{remoteAddress}},destroy(){assert.fail();}} as any);
});
