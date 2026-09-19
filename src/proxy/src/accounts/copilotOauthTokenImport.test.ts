import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { configureProxyFixture, TEST_ENTERPRISE } from '../test/enterpriseFixtures.js';
import { importCopilotOauthTokens } from './copilotOauthTokenImport.js';

// Single configured lifetime also works with the production startup-pinned registry.
process.env.ACCOUNT_ROUTING_MODE = 'direct';
process.env.STORAGE_DRIVER = 'sqlite';
const dbPath = configureProxyFixture();

test('rejects the whole CSV before importing when the header is invalid', async () => {
  const result = await importCopilotOauthTokens('name,wrongHeader\nalice,candidate-token\n');

  assert.deepEqual(result.summary, { total: 1, success: 0, failed: 1 });
  assert.equal(result.rows[0]?.line, 1);
  assert.match(result.rows[0]?.detail ?? '', /name,copilotOauthToken/);
});

test('CSV captures before every external await and never overwrites a recreated/deleted identity or competing authorization', async t => {
  const { config } = await import('../config.js');
  config.dbPath = dbPath; config.storageDriver = 'sqlite';
  config.copilotApiBaseUrl = 'https://copilot.example.test';
  const { initializeStorage, getStorage } = await import('../db/connection.js');
  await initializeStorage(); const storage = getStorage();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const gate of ['sso','subject','models'] as const) {
    for (const change of ['delete','recreate','fresh-attempt','finished-attempt','absent-created'] as const) {
      const name = `${gate}-${change}`;
      if (change !== 'absent-created') await storage.createAccount({identity:name,ssoUser:name,ghLogin:'alice_octo'});
      let entered!:()=>void, release!:()=>void;
      const pendingIo = new Promise<void>(resolve => {release=resolve;});
      const started = new Promise<void>(resolve => {entered=resolve;});
      globalThis.fetch = (async input => {
        const url = new URL(String(input));
        const stage = url.pathname.endsWith('/models') ? 'models' : url.pathname === '/user' ? 'subject' : 'sso';
        assert.ok(['localhost','api.github.example.test','copilot.example.test'].includes(url.hostname),'all provider requests are mocked');
        if (stage === gate) {entered(); await pendingIo;}
        return Response.json(stage === 'sso' ? {ssoUser:name,ghLogin:'alice_octo'} : stage === 'subject' ? {login:'alice_octo',id:101} : {data:[]});
      }) as typeof fetch;
      const pending = importCopilotOauthTokens(`name,copilotOauthToken\n${name},late-csv-token\n`);
      await started;
      if (change === 'delete' || change === 'recreate') await storage.deleteAccount(name);
      if (change === 'recreate' || change === 'absent-created') await storage.createAccount({identity:name,ssoUser:name,ghLogin:'alice_octo'});
      let freshAttempt: string | undefined;
      if (change === 'fresh-attempt' || change === 'finished-attempt') {
        const account = (await storage.getAccount(name))!;
        const binding = {enterpriseId:TEST_ENTERPRISE.id,enterpriseRevision:1,identity:name,accountIncarnation:account.accountIncarnation,
          oauthAttemptId:randomUUID(),expectedGhLogin:'alice_octo'};
        freshAttempt = binding.oauthAttemptId;
        await storage.beginAuthorizationAttempt(binding);
        if (change === 'finished-attempt') await storage.endAuthorizationAttempt(binding,'cancelled');
      }
      const before = await storage.getAccount(name);
      release();
      const result = await pending;
      assert.deepEqual(result.summary,{total:1,success:0,failed:1},`${gate}/${change}`);
      assert.equal(result.rows[0]?.detail,'stale_token_import');
      assert.deepEqual(await storage.getAccount(name),before,'CAS failure has no credential/account side effects');
      if (freshAttempt) assert.equal((await storage.getAuthorizationAttempt(TEST_ENTERPRISE.id,name,freshAttempt))?.status,
        change === 'finished-attempt' ? 'cancelled' : 'active','import must not cancel the fresh attempt');
    }
  }
});

test('CSV intentional same-incarnation overwrite consumes only the observed attempt and absence can create once', async t => {
  const { getStorage } = await import('../db/connection.js'); const storage = getStorage();
  const originalFetch = globalThis.fetch; t.after(() => {globalThis.fetch=originalFetch;});
  globalThis.fetch = (async input => {
    const url=new URL(String(input));
    if (url.pathname === '/user') return Response.json({login:'alice_octo',id:101});
    if (url.pathname.endsWith('/models')) return Response.json({data:[]});
    return Response.json({ssoUser:decodeURIComponent(url.pathname.split('/').at(-1)!),ghLogin:'alice_octo'});
  }) as typeof fetch;
  const name='intentional-overwrite';
  const account=await storage.createAccount({identity:name,ssoUser:name,ghLogin:'alice_octo'});
  const binding={enterpriseId:TEST_ENTERPRISE.id,enterpriseRevision:1,identity:name,accountIncarnation:account.accountIncarnation,
    oauthAttemptId:randomUUID(),expectedGhLogin:'alice_octo'};
  await storage.beginAuthorizationAttempt(binding);
  const result=await importCopilotOauthTokens(`name,copilotOauthToken\n${name},replacement-token\nnew-import,new-token\n`);
  assert.deepEqual(result.summary,{total:2,success:2,failed:0});
  assert.equal((await storage.getAccount(name))?.accountIncarnation,account.accountIncarnation);
  assert.equal((await storage.getAccount(name))?.copilotOauthToken,'replacement-token');
  assert.equal((await storage.getAuthorizationAttempt(TEST_ENTERPRISE.id,name,binding.oauthAttemptId))?.status,'cancelled');
  assert.equal((await storage.getAccount('new-import'))?.copilotOauthToken,'new-token');
});
