import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
const { loginWithDeviceFlow } = await import('./deviceFlow.js');
const { enterpriseDeviceFlowClient } = await import('./enterpriseAuth.js');
const { findLoginEnterprise, readyLoginEnterprise, setLoginEnterprisesForTesting } = await import('../enterprises.js');
const fixture = await import('../testing/enterpriseFixture.js');

setLoginEnterprisesForTesting(fixture.loginFixtureRegistry());

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: unknown;
}

/** Runs the flow against a fake GitHub that answers in order; returns the token and what was sent. */
async function runFlow(enterpriseId: string, verificationUri: string) {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const responses = [
    jsonResponse({
      device_code: 'device-code',
      user_code: 'user-code',
      verification_uri: verificationUri,
      expires_in: 900,
      interval: 1,
    }),
    jsonResponse({ error: 'authorization_pending' }),
    jsonResponse({ access_token: 'oauth-token', token_type: 'bearer', scope: 'read:user' }),
  ];
  let now = 0;
  let authorizedCode: string | undefined;
  let openedPage: string | undefined;
  const warnings: Array<{ message: string; fields: unknown }> = [];
  const logger = {
    info: () => undefined,
    warn: (_step: string, message: string, fields?: unknown) => { warnings.push({ message, fields }); },
  };
  const enterprise = readyLoginEnterprise(findLoginEnterprise(enterpriseId)!);
  const authorize = async (device: { user_code: string; verification_uri: string }) => {
    authorizedCode = device.user_code;
    openedPage = device.verification_uri;
  };
  const token = await loginWithDeviceFlow(
    { name: 'test', authorize },
    logger,
    enterpriseDeviceFlowClient(enterprise),
    {
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: init?.headers });
        return responses.shift()!;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    },
  );
  return { token, requests, sleeps, authorizedCode, openedPage, warnings };
}

test('a github.com enterprise uses the OpenCode headers, its own client ID and github.com endpoints', async () => {
  const run = await runFlow('default', 'https://github.com/login/device');
  assert.equal(run.token, 'oauth-token');
  assert.equal(run.authorizedCode, 'user-code');
  assert.deepEqual(run.sleeps, [4_000, 4_000]);
  assert.deepEqual(run.requests.map((request) => request.url), [
    'https://github.com/login/device/code',
    'https://github.com/login/oauth/access_token',
    'https://github.com/login/oauth/access_token',
  ]);
  assert.deepEqual(run.requests[0]!.body, { client_id: fixture.DEFAULT_CLIENT_ID, scope: 'read:user' });
  assert.deepEqual(run.requests[0]!.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'opencode/1.0.0',
  });
  assert.deepEqual(run.requests[1]!.body, {
    client_id: fixture.DEFAULT_CLIENT_ID,
    device_code: 'device-code',
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
});

test('a GHE.com enterprise uses its own host and client ID', async () => {
  const run = await runFlow(fixture.GHE_ENTERPRISE_ID, 'https://contoso.ghe.com/login/device');
  assert.equal(run.token, 'oauth-token');
  assert.deepEqual(run.requests.map((request) => request.url), [
    'https://contoso.ghe.com/login/device/code',
    'https://contoso.ghe.com/login/oauth/access_token',
    'https://contoso.ghe.com/login/oauth/access_token',
  ]);
  assert.deepEqual(run.requests.map((request) => request.body.client_id), Array(3).fill(fixture.GHE_CLIENT_ID));
});

test('the browser always opens the enterprise verification page; another answer is only logged', async () => {
  const same = await runFlow('default', 'https://github.com/login/device/');
  assert.equal(same.openedPage, 'https://github.com/login/device/');
  assert.deepEqual(same.warnings, []);
  for (const [enterpriseId, page] of [
    ['default', 'https://contoso.ghe.com/login/device'],
    [fixture.GHE_ENTERPRISE_ID, 'https://github.com/login/device'],
    [fixture.GHE_ENTERPRISE_ID, 'https://contoso.ghe.com.evil.test/login/device'],
    ['default', 'https://github.com/login/device/../../evil'],
  ] as const) {
    const run = await runFlow(enterpriseId, `${page}?user_code=secret-looking`);
    const origin = enterpriseId === 'default' ? 'https://github.com' : 'https://contoso.ghe.com';
    const expected = `${origin}/login/device`;
    assert.equal(run.token, 'oauth-token', page);
    assert.equal(run.openedPage, expected, page);
    assert.equal(run.warnings.length, 1, page);
    assert.equal(JSON.stringify(run.warnings).includes('secret-looking'), false, 'The log keeps origin and path only');
  }
});

test('an enterprise with blockers cannot run a device flow', () => {
  const unready = findLoginEnterprise(fixture.UNREADY_ENTERPRISE_ID)!;
  assert.deepEqual(unready.blockers, ['enterprise_field_missing:github.slug']);
  assert.equal(unready.endpoints, undefined);
  assert.throws(() => readyLoginEnterprise(unready), { code: 'enterprise_not_ready' });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
