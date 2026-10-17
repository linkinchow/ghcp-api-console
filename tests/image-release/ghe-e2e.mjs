// Drives and checks the GHE.com end-to-end run defined in ghe-compose.yaml.
// Prints one JSON line per check and a final summary; exits non-zero on the first failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const PROXY = 'http://proxy:3000';
const SSO = 'http://sso:7001';
const LOGIN = 'http://login:7003';
const MOCK = 'http://mock:8002';
const INTERNAL = { 'X-Internal-Token': 'ghe-fixture-internal-only' };
const GHE_BASE = 'http://fixture.ghe.com:8002';
const ENTERPRISE_ENTITY = `${GHE_BASE}/enterprises/local-test`;
const OPENCODE_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const PROVISION_TIMEOUT_MS = 8 * 60_000;
// Callers are identified by the gateway's hashed key: sha256:<64 hex>.
const CALLER = `sha256:${createHash('sha256').update('ghe-e2e-caller').digest('hex')}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, headers = INTERNAL) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json();
}

function pass(check, details = {}) {
  console.log(JSON.stringify({ check, pass: true, ...details }));
}

/** The pool provisions one account through SSO, SCIM, seat, Login (device flow) and warmup. */
async function waitForReadyAccount() {
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(`${PROXY}/api/user-pool`).catch((error) => ({ error: String(error) }));
    const ready = last.accounts?.find((account) => account.state === 'ready');
    if (ready) return ready;
    await sleep(3000);
  }
  const accounts = last?.accounts?.map(({ identity, state, stage, lastError }) => ({ identity, state, stage, lastError }));
  console.log(JSON.stringify({ check: 'pool_ready_account', pass: false, accounts, counts: last?.counts }));
  const tasks = await getJson(`${LOGIN}/api/tasks?limit=5`).catch(() => undefined);
  console.log(JSON.stringify({ diagnostics: 'login_tasks', tasks }));
  throw new Error('No pool account became ready');
}

function checkGheEvidence(evidence, account) {
  const { ghe, users, seats } = evidence;

  assert.ok(ghe.deviceCodeRequests.length >= 1, 'device code requested from the GHE.com host');
  assert.ok(ghe.deviceCodeRequests.every((request) => request.clientId === OPENCODE_CLIENT_ID), 'OpenCode OAuth client id');
  pass('device_flow_on_ghe_host', { requests: ghe.deviceCodeRequests.length });

  const accepted = ghe.samlResponses.filter((response) => response.accepted);
  assert.ok(accepted.length >= 1, `SAML response accepted: ${JSON.stringify(ghe.samlResponses)}`);
  assert.ok(accepted.every((response) => response.audience === ENTERPRISE_ENTITY), 'SAML audience is the GHE.com enterprise');
  assert.ok(accepted.some((response) => response.nameId === account.identity), 'SAML NameID is the pool account');
  pass('sso_saml_for_ghe_enterprise', { audience: ENTERPRISE_ENTITY, nameId: account.identity });

  const scimUser = users.find((user) => user.userName === account.identity);
  assert.ok(scimUser, 'SCIM user created');
  assert.ok(!scimUser.githubLogin.includes('_'), `GHE.com login has no shortcode suffix: ${scimUser.githubLogin}`);
  assert.ok(scimUser.githubLogin.length <= 30, 'GHE.com login is at most 30 characters');
  assert.ok(seats.includes(scimUser.githubLogin), 'Copilot seat assigned to the unsuffixed login');
  pass('scim_and_seat_without_suffix', { githubLogin: scimUser.githubLogin });

  assert.ok(ghe.authorizations.some((entry) => entry.authorized && entry.nameId === account.identity), 'device authorized by the account');
  assert.ok(ghe.tokensIssued.some((entry) => entry.nameId === account.identity), 'token issued after authorization');
  pass('device_code_entered_and_authorized');

  const hosts = Object.keys(ghe.hosts);
  for (const kind of ['scim', 'seats']) {
    assert.deepEqual(hosts.filter((key) => key.startsWith(`${kind}:`)), [`${kind}:api.fixture.ghe.com`], `${kind} host`);
  }
  assert.deepEqual(hosts.filter((key) => key.startsWith('copilot:')), ['copilot:copilot-api.fixture.ghe.com'], 'Copilot host');
  pass('ghe_api_hosts', { hosts: ghe.hosts });
  return scimUser;
}

async function checkServiceState(account, scimUser) {
  const ssoUser = await getJson(`${SSO}/api/users/${encodeURIComponent(account.identity)}`);
  assert.equal(ssoUser.ghLogin, scimUser.githubLogin, 'SSO stored the unsuffixed GH login');
  assert.equal(ssoUser.copilotSeatStatus, 'assigned');
  pass('sso_user_state', { ghLogin: ssoUser.ghLogin, seat: ssoUser.copilotSeatStatus });

  const tasks = await getJson(`${LOGIN}/api/tasks?limit=20`);
  const list = Array.isArray(tasks) ? tasks : tasks.items ?? [];
  const task = list.find((entry) => entry.identity === account.identity);
  assert.equal(task?.status, 'success', `Login task for ${account.identity}: ${JSON.stringify(task)}`);
  pass('login_task_success', { taskId: task.id });
}

async function checkInference(account) {
  const response = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ghe-fixture-api-only', 'X-User-Identity': CALLER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-2', max_tokens: 16, messages: [{ role: 'user', content: 'GHE end-to-end' }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `inference: ${response.status} ${text.slice(0, 300)}`);
  const evidence = await getJson(`${MOCK}/test/ghe`);
  const served = evidence.inference.filter((entry) => entry.path === '/v1/messages' && entry.outcome === 'complete');
  assert.ok(served.some((entry) => entry.identity === account.identity), 'served by the GHE-authorized account token');
  pass('caller_inference_via_ghe_copilot', { member: account.identity });
}

try {
  const account = await waitForReadyAccount();
  pass('pool_ready_account', { identity: account.identity, ghLogin: account.ghLogin });
  const scimUser = checkGheEvidence(await getJson(`${MOCK}/test/ghe`), account);
  await checkServiceState(account, scimUser);
  await checkInference(account);
  console.log(JSON.stringify({ result: 'ghe_end_to_end', pass: true, realExternalCalls: 0 }));
} catch (error) {
  console.log(JSON.stringify({ result: 'ghe_end_to_end', pass: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
