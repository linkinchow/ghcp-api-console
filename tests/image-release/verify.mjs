import assert from 'node:assert/strict';

const HOSTS = ['proxy:3000', 'sso:7001', 'login:7003', 'console:7004'];
const PROXY = 'http://proxy:3000';
const SSO = 'http://sso:7001';
const LOGIN = 'http://login:7003';
const CONSOLE = 'http://console:7004';
const INTERNAL = { 'X-Internal-Token': 'release-fixture-internal' };
const OUTPUT_CONFIG_BETA = 'mid-conversation-output-config-2026-07-01';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForHealth(host) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://${host}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // Service still starting; retry below.
    }
    await sleep(500);
  }
  return false;
}

async function ensureSsoMember() {
  const existing = await fetch(`${SSO}/api/users/release-member`, { headers: INTERNAL });
  if (existing.status !== 404) {
    assert.equal(existing.status, 200);
    return;
  }
  const created = await postJson(
    `${SSO}/api/users`,
    { ssoUser: 'release-member', password: 'release-fixture-password-only', email: 'release-member@example.test' },
    INTERNAL,
  );
  assert.equal(created.status, 201, await created.text());
}

async function importOauthToken() {
  const response = await postJson(
    `${PROXY}/api/accounts/copilot-oauth-token/import`,
    { csvText: 'name,copilotOauthToken\nrelease-member,release-fixture-oauth\n' },
    INTERNAL,
  );
  assert.equal(response.status, 200);
  const imported = await response.json();
  assert.equal(imported.summary.success, 1);
  assert.equal(imported.summary.failed, 0);
}

function messageHeaders(optimized, withBeta) {
  const headers = {
    Authorization: 'Bearer release-fixture-api',
    'X-User-Identity': 'release-member',
    'X-Claude-Code-Optimized': String(optimized),
  };
  if (withBeta) {
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-beta'] = OUTPUT_CONFIG_BETA;
  }
  return headers;
}

async function verifyProtocol(messages) {
  for (const optimized of [true, false]) {
    for (const stream of [false, true]) {
      const response = await postJson(
        `${PROXY}/v1/messages`,
        { model: 'claude-opus-5-5', max_tokens: 128, messages, stream },
        messageHeaders(optimized, true),
      );
      assert.equal(response.status, 200);
      assert.match(await response.text(), stream ? /message_stop/ : /RELEASE_MOCK_OK/);
      console.log(JSON.stringify({ test: 'protocol', optimized, stream, pass: true }));
    }

    const missingBeta = await postJson(
      `${PROXY}/v1/messages`,
      { model: 'claude-opus-5.5', max_tokens: 128, messages },
      messageHeaders(optimized, false),
    );
    assert.equal(missingBeta.status, 400);
    assert.match(await missingBeta.text(), /messages.1.output_config/);
  }
}

async function verifyConsoleAssets() {
  const html = await (await fetch(`${CONSOLE}/`)).text();
  assert.match(html, /<div id="root">/);
  const asset = html.match(/src="([^"]+\.js)"/);
  assert.ok(asset);
  assert.equal((await fetch(CONSOLE + asset[1])).status, 200);
}

for (const host of HOSTS) {
  assert.ok(await waitForHealth(host), `${host} health`);
  console.log(JSON.stringify({ test: 'health', host, pass: true }));
}

assert.equal((await fetch(`${PROXY}/readyz`)).status, 200);
await ensureSsoMember();
await importOauthToken();

const messages = [
  { role: 'user', content: 'Synthetic question' },
  { role: 'system', content: [], output_config: { effort: 'high' } },
];
await verifyProtocol(messages);

const evidence = await (await fetch('http://mock:8002/evidence')).json();
assert.equal(evidence.requests.length, 6);
assert.ok(evidence.requests.every((request) => request.oauthMatches));
assert.deepEqual(evidence.requests[0].messages, messages);

assert.equal((await fetch(`${SSO}/metadata`)).status, 200);
assert.equal((await fetch(`${SSO}/api/users`, { headers: INTERNAL })).status, 200);
assert.equal((await fetch(`${LOGIN}/api/tasks`, { headers: INTERNAL })).status, 200);
assert.equal((await fetch(`${LOGIN}/api/tasks`)).status, 401);
await verifyConsoleAssets();
assert.equal((await fetch(`${CONSOLE}/api/console/me`)).status, 401);
console.log(JSON.stringify({ test: 'sso-metadata-login-auth-console-assets', pass: true }));
console.log(JSON.stringify({ phase: 'completed', protocolRequests: evidence.requests.length, realExternalCalls: 0 }));
