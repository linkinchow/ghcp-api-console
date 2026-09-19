import { configureProxyFixture, completeFixtureAttempt, failFixtureAttempt } from '../test/enterpriseFixtures.js';
import assert from 'node:assert/strict';
import test from 'node:test';

test('only invalidates the credential and authorization attempt that are still current', async t => {
  configureProxyFixture(t);
  const {
    createAccount,
    beginCopilotOauthAuthorization,

    getAccount,
    invalidateCopilotOauthToken,

  } = await import('./accountsRepo.js');

  const {getStorage}=await import('./connection.js');
  await createAccount({ identity: 'alice', ssoUser: 'alice', ghLogin: 'alice_octo' });
  assert.equal(await beginCopilotOauthAuthorization('alice', '11111111-1111-4111-8111-111111111111'), true);
  await completeFixtureAttempt(getStorage(),'alice', '11111111-1111-4111-8111-111111111111', 'new-token', 'alice_octo');

  assert.equal(await invalidateCopilotOauthToken('alice', 'stale-token', 'expired'), false);
  assert.deepEqual(
    pickAuth(await getAccount('alice')),
    { token: 'new-token', status: 'valid' },
  );
  assert.equal(await failFixtureAttempt(getStorage(),'alice', 'stale-attempt'), false);
  assert.equal((await getAccount('alice'))?.copilotOauthStatus, 'valid');

  await beginCopilotOauthAuthorization('alice', '22222222-2222-4222-8222-222222222222');
  assert.equal(await invalidateCopilotOauthToken('alice', 'new-token', 'expired'), false);
  assert.equal((await getAccount('alice'))?.copilotOauthStatus, 'refreshing');
  assert.equal(await failFixtureAttempt(getStorage(),'alice', '22222222-2222-4222-8222-222222222222'), true);
  assert.equal((await getAccount('alice'))?.copilotOauthStatus, 'failed');

  await beginCopilotOauthAuthorization('alice', '33333333-3333-4333-8333-333333333333');
  assert.equal(await completeFixtureAttempt(getStorage(),'alice', '22222222-2222-4222-8222-222222222222', 'stale-token', 'alice_octo'), undefined);
  await completeFixtureAttempt(getStorage(),'alice', '33333333-3333-4333-8333-333333333333', 'new-token', 'alice_octo');
  assert.equal(await invalidateCopilotOauthToken('alice', 'new-token', 'expired'), true);
  assert.deepEqual(
    pickAuth(await getAccount('alice')),
    { token: undefined, status: 'expired' },
  );
});

function pickAuth(account: { copilotOauthToken?: string; copilotOauthStatus: string } | undefined): {
  token: string | undefined;
  status: string | undefined;
} {
  return {
    token: account?.copilotOauthToken,
    status: account?.copilotOauthStatus,
  };
}
