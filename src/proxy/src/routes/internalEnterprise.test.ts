import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';

// Callback isolation (design §5.3, §5.7, §9.2): Login's callbacks only reach rows of the path's enterprise,
// only for the current attempt, and only with a token GitHub says belongs to the account's GitHub user.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(tmpdir(), `missing-internal-enterprise-${randomUUID()}`),
  STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', ACCOUNT_ROUTING_MODE: 'direct',
  INTERNAL_API_TOKEN: 'internal-enterprise-token', PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
});
const fixture = await import('../testing/enterpriseFixture.js');
const installed = fixture.installEnterpriseFixture();
const { buildApp } = await import('../server.js');
const repo = await import('../db/accountsRepo.js');
const { closeStorage } = await import('../db/connection.js');

const GHE = fixture.GHE_ENTERPRISE_ID;
const HEADERS = { 'X-Internal-Token': 'internal-enterprise-token', 'Content-Type': 'application/json' };

type SubjectReply = { login: string } | 'network' | 'unauthorized';
let subjectReply: SubjectReply = { login: 'ghe-user' };
const subjectCalls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return originalFetch(input, init);
  subjectCalls.push(`${url.origin}${url.pathname}`);
  if (subjectReply === 'network') throw new TypeError('fetch failed');
  if (subjectReply === 'unauthorized') return new Response('{}', { status: 401 });
  return Response.json({ login: subjectReply.login, id: 42 });
};

const server = buildApp().listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(async () => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  server.close();
  await closeStorage();
  installed.restore();
});

async function account(enterpriseId: typeof GHE, identity: string, ghLogin: string): Promise<string> {
  await repo.createAccount({ enterpriseId, identity, ssoUser: identity, ghLogin });
  const attemptId = randomUUID();
  assert.equal(await repo.beginCopilotOauthAuthorization(identity, attemptId), true);
  return attemptId;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await originalFetch(`${base}${path}`, {
    method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** `ghe-cross` belongs to the GHE.com enterprise; this path names `default`. */
const FOREIGN = '/internal/enterprises/default/accounts/ghe-cross';

function tokenPath(enterpriseId: string, identity: string): string {
  return `/internal/enterprises/${enterpriseId}/accounts/${identity}/copilot-oauth-token`;
}

/** Login's token callback for a GHE.com account. */
function saveToken(identity: string, oauthAttemptId: string) {
  return call('PUT', tokenPath(GHE, identity), { oauthAttemptId, copilotOauthToken: 't' });
}

test('a callback through another enterprise is not found and changes nothing', async () => {
  const attemptId = await account(GHE, 'ghe-cross', 'ghe-user');
  const before = await repo.getAccount('ghe-cross');
  const paths = [
    ['PUT', tokenPath(DEFAULT_ENTERPRISE_ID, 'ghe-cross'), { oauthAttemptId: attemptId, copilotOauthToken: 't' }],
    ['POST', `${FOREIGN}/mark-copilot-oauth-failed`, { oauthAttemptId: attemptId }],
    ['GET', `${FOREIGN}/login-task-protection?taskId=x`, undefined],
  ] as const;
  for (const [method, path, body] of paths) {
    const result = await call(method, path, body);
    assert.equal(result.status, 404, path);
    assert.equal(result.body.error.code, 'account_not_found');
  }
  const prepare = await call('POST', `${FOREIGN}/oauth-attempts/${randomUUID()}/prepare`, {
    ssoUser: 'ghe-cross', ghLogin: 'ghe-user', ssoType: 'custom', previousAttemptId: attemptId,
    credentialMode: 'override', ssoPassword: 'unused',
  });
  assert.equal(prepare.status, 404);
  assert.deepEqual(await repo.getAccount('ghe-cross'), before);
  assert.deepEqual(subjectCalls, [], 'a foreign callback never reaches GitHub');
});

test('an expired or mismatched attempt is refused before the subject check', async () => {
  const attemptId = await account(GHE, 'ghe-stale', 'ghe-user');
  const stale = await saveToken('ghe-stale', randomUUID());
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_oauth_attempt');
  await repo.failCopilotOauthAuthorization('ghe-stale', attemptId);
  const expired = await saveToken('ghe-stale', attemptId);
  assert.equal(expired.status, 409);
  assert.equal(subjectCalls.length, 0);
  assert.equal((await repo.getAccount('ghe-stale'))?.copilotOauthToken, undefined);
});

test('a token of another GitHub user fails the attempt with 409', async () => {
  subjectReply = { login: 'someone-else' };
  const attemptId = await account(GHE, 'ghe-mismatch', 'ghe-user');
  const result = await saveToken('ghe-mismatch', attemptId);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'authorization_subject_mismatch');
  assert.equal(JSON.stringify(result.body).includes('someone-else'), false, 'the other login is not revealed');
  const stored = await repo.getAccount('ghe-mismatch');
  assert.equal(stored?.copilotOauthStatus, 'failed');
  assert.equal(stored?.copilotOauthToken, undefined);
  assert.equal(subjectCalls.at(-1), `${fixture.GHE_ENDPOINTS.apiBaseUrl}/user`, 'the enterprise REST API is asked');
});

test('an unreachable GitHub answers 503 and keeps the attempt open for a retry', async () => {
  const attemptId = await account(GHE, 'ghe-network', 'ghe-user');
  for (const reply of ['network', 'unauthorized'] as const) {
    subjectReply = reply;
    const result = await saveToken('ghe-network', attemptId);
    assert.equal(result.status, 503, reply);
    assert.equal(result.body.error.code, 'authorization_subject_unavailable');
    assert.equal((await repo.getAccount('ghe-network'))?.copilotOauthStatus, 'refreshing');
  }
  subjectReply = { login: 'GHE-User' };
  const retried = await saveToken('ghe-network', attemptId);
  assert.equal(retried.status, 200, 'the login matches case-insensitively');
  assert.equal(retried.body.copilotOauthStatus, 'valid');
});

test('the default enterprise verifies with its own REST API', async () => {
  subjectReply = { login: 'octo-user_octo' };
  const attemptId = await account(DEFAULT_ENTERPRISE_ID, 'default-ok', 'octo-user_octo');
  const path = tokenPath(DEFAULT_ENTERPRISE_ID, 'default-ok');
  const result = await call('PUT', path, { oauthAttemptId: attemptId, copilotOauthToken: 'default-token' });
  assert.equal(result.status, 200);
  assert.notEqual(subjectCalls.at(-1), `${fixture.GHE_ENDPOINTS.apiBaseUrl}/user`);
  assert.equal((await repo.getAccount('default-ok'))?.copilotOauthToken, 'default-token');
});

test('SSO user lookups are scoped and unscoped internal paths are refused', async () => {
  await repo.createAccount({ enterpriseId: GHE, identity: 'same-name-ghe', ssoUser: 'same-name', ghLogin: 'a' });
  const sameName = { identity: 'same-name-default', ssoUser: 'same-name' };
  await repo.createAccount({ enterpriseId: DEFAULT_ENTERPRISE_ID, ...sameName });
  const removed = await call('DELETE', `/internal/enterprises/${GHE}/accounts/by-sso-user/same-name`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deletedAccounts, 1);
  assert.equal(await repo.getAccount('same-name-ghe'), undefined);
  assert.ok(await repo.getAccount('same-name-default'), 'the other enterprise keeps its same-named user');
  const membership = await call('GET', `/internal/enterprises/${GHE}/accounts/by-sso-user/same-name/pool-membership`);
  assert.deepEqual(membership.body, { managed: false });
  for (const path of ['/internal/accounts/default-ok/copilot-oauth-token', '/internal/accounts/by-sso-user/x']) {
    const unscoped = await call('PUT', path, {});
    assert.equal(unscoped.status, 400, path);
    assert.equal(unscoped.body.error.code, 'enterprise_scope_required');
  }
  assert.equal((await call('GET', '/internal/enterprises/unknown-co/accounts/x/login-task-protection')).status, 404);
});
