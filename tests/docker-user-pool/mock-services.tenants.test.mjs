// node --test tests/docker-user-pool/mock-services.tenants.test.mjs
// Runs mock-services.mjs as a local child process on a loopback port (no Docker) and checks host-dispatched GHE.com
// tenants (design §9.5) next to the unchanged single-tenant behaviour.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MOCK = fileURLToPath(new URL('./mock-services.mjs', import.meta.url));
const INTERNAL = 'tenant-test-internal';
const TENANT = {
  host: 'contoso.ghe.com', slug: 'contoso', enterpriseId: 'contoso-eu', port: 8002,
  scimToken: 'tenant-test-contoso-scim',
  seatPat: 'tenant-test-contoso-seat',
  ssoPassword: 'tenant-test-contoso-password',
  idpSsoUrl: 'http://sso:7001/enterprises/contoso-eu/sso',
};
const DEFAULT = {
  scimToken: 'tenant-test-default-scim',
  seatPat: 'tenant-test-default-seat',
  ssoPassword: 'tenant-test-default-sso',
};
const children = [];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startMock(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [MOCK], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), INTERNAL_API_TOKEN: INTERNAL,
      SCIM_TOKEN: DEFAULT.scimToken, SEAT_PAT: DEFAULT.seatPat, SSO_DEFAULT_USER_PASSWORD: DEFAULT.ssoPassword,
      PROXY_BASE_URL: 'http://proxy:3000', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('LOCAL_POOL_MOCK_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`mock exited ${code}`)));
  });
  return port;
}

/** HTTP with an explicit Host header (fetch does not allow overriding it). */
function call(port, { host = 'mock:8002', method = 'GET', path, headers = {}, body, form }) {
  const payload = form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: {
      host, ...headers,
      ...(payload === undefined ? {} : {
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'content-length': Buffer.byteLength(payload),
      }),
    } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const internal = { 'x-internal-token': INTERNAL };
let tenantPort;
let legacyPort;
let singleGhePort;

before(async () => {
  tenantPort = await startMock({ MOCK_GHE_TENANTS: JSON.stringify([TENANT]) });
  legacyPort = await startMock({});
  singleGhePort = await startMock({ MOCK_GHE_HOST: 'fixture.ghe.com' });
});

after(() => {
  for (const child of children) child.kill('SIGKILL');
});

test('single-tenant mode is unchanged: suffixed logins, unscoped tasks need ssoType, legacy state shape', async () => {
  const created = await call(legacyPort, { method: 'POST', path: '/scim/v2/enterprises/local-test/Users',
    headers: bearer(DEFAULT.scimToken), body: { userName: 'legacy-user', active: true } });
  assert.equal(created.status, 201);
  assert.equal(created.json.githubLogin, 'legacy-user_test');
  assert.equal(created.json.githubId, undefined, 'SCIM resources keep their r4 shape');
  const contosoPath = await call(legacyPort, { host: 'api.contoso.ghe.com', path: '/scim/v2/enterprises/contoso/Users',
    headers: bearer(TENANT.scimToken) });
  assert.equal(contosoPath.status, 404, 'no tenant without MOCK_GHE_TENANTS');
  const task = await call(legacyPort, { method: 'POST', path: '/api/tasks', headers: internal, body: {
    identity: 'legacy-user', ssoUser: 'legacy-user', ghLogin: 'legacy-user_test', oauthAttemptId: 'a1',
    ssoPassword: 'x' } });
  assert.equal(task.status, 400, 'unscoped tasks still require ssoType=custom');
  const readiness = await call(legacyPort, { path: '/internal/enterprises', headers: internal });
  assert.equal(readiness.status, 404);
  const state = await call(legacyPort, { path: '/test/state', headers: internal });
  assert.deepEqual(Object.keys(state.json).sort(), ['concurrency', 'counters', 'fixture', 'inference', 'loginQueue',
    'nextControl', 'otherInference', 'seats', 'tasks', 'users']);
  assert.equal(state.json.counters.scimCreates, 1);
});

test('GHE.com tenant answers only on its own hosts with its own credentials', async () => {
  const scim = '/scim/v2/enterprises/contoso/Users';
  const longName = 'contoso-member-with-a-rather-long-pool-name-0001';
  const wrongToken = await call(tenantPort, { host: 'api.contoso.ghe.com', method: 'POST', path: scim,
    headers: bearer(DEFAULT.scimToken), body: { userName: longName } });
  assert.equal(wrongToken.status, 401, 'default SCIM token is rejected by the GHE.com tenant');
  const wrongHost = await call(tenantPort, { method: 'POST', path: scim, headers: bearer(TENANT.scimToken),
    body: { userName: longName } });
  assert.equal(wrongHost.status, 404, 'tenant paths are not served on the default host');
  const created = await call(tenantPort, { host: 'api.contoso.ghe.com:8002', method: 'POST', path: scim,
    headers: bearer(TENANT.scimToken), body: { userName: longName, active: true } });
  assert.equal(created.status, 201);
  assert.equal(created.json.githubLogin, longName.slice(0, 30));
  assert.ok(!created.json.githubLogin.includes('_'));
  const seat = await call(tenantPort, { host: 'api.contoso.ghe.com', method: 'POST',
    path: '/enterprises/contoso/copilot/billing/selected_users', headers: bearer(TENANT.seatPat),
    body: { selected_usernames: [created.json.githubLogin] } });
  assert.equal(seat.status, 201);
  const member = await call(tenantPort, { host: 'api.contoso.ghe.com',
    path: `/enterprises/contoso/members/${created.json.githubLogin}/copilot`, headers: bearer(TENANT.seatPat) });
  assert.equal(member.json.total_seats, 1);
  const defaultCreated = await call(tenantPort, { method: 'POST', path: '/scim/v2/enterprises/local-test/Users',
    headers: bearer(DEFAULT.scimToken), body: { userName: 'default-member', active: true } });
  assert.equal(defaultCreated.json.githubLogin, 'default-member_test');

  // Scoped fake Login: the provider comes from the enterprise, so ssoType may be omitted.
  const body = { identity: longName, ssoUser: longName, ghLogin: created.json.githubLogin, oauthAttemptId: 'attempt-1',
    ssoPassword: TENANT.ssoPassword };
  const tasks = '/api/enterprises/contoso-eu/tasks';
  const wrongPassword = await call(tenantPort, { method: 'POST', path: tasks, headers: internal,
    body: { ...body, ssoPassword: DEFAULT.ssoPassword } });
  assert.equal(wrongPassword.status, 401);
  const override = await call(tenantPort, { method: 'POST', path: tasks, headers: internal,
    body: { ...body, ssoUrl: 'http://evil.invalid/login' } });
  assert.equal(override.status, 400, 'a body may not override the SSO page');
  const crossTenant = await call(tenantPort, { method: 'POST', path: '/api/enterprises/default/tasks',
    headers: internal,
    body: { ...body, ssoPassword: DEFAULT.ssoPassword } });
  assert.equal(crossTenant.status, 409, 'the default tenant has no such SCIM user or seat');
  const accepted = await call(tenantPort, { method: 'POST', path: tasks, headers: internal, body });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.json.enterpriseId, 'contoso-eu');
  assert.equal(accepted.json.ssoType, 'custom');
  const byAttempt = await call(tenantPort, { path: `${tasks}/by-attempt/attempt-1`, headers: internal });
  assert.equal(byAttempt.json.id, accepted.json.id);
  const otherList = await call(tenantPort,
    { path: '/api/enterprises/default/tasks?page=1&pageSize=10', headers: internal });
  assert.equal(otherList.json.total, 0);
  const unknown = await call(tenantPort, { path: '/api/enterprises/nope-x/tasks', headers: internal });
  assert.equal(unknown.status, 404);

  const state = (await call(tenantPort, { path: '/test/state', headers: internal })).json;
  const tenant = state.tenants['contoso-eu'];
  assert.equal(tenant.counters.scimCreates, 1);
  assert.equal(tenant.counters.taskPosts, 1);
  assert.equal(tenant.users[0].githubId, 1001);
  assert.equal(state.counters.scimCreates, 1, 'default tenant counted separately');
  assert.equal(state.users[0].githubLogin, 'default-member_test');
});

test('device flow per tenant issues tokens valid only on that tenant (/user, models, inference)', async () => {
  const web = 'contoso.ghe.com:8002';
  const scim = '/scim/v2/enterprises/contoso/Users';
  const userName = 'device-user';
  await call(tenantPort, { host: 'api.contoso.ghe.com', method: 'POST', path: scim, headers: bearer(TENANT.scimToken),
    body: { userName, active: true } });
  const code = await call(tenantPort, { host: web, method: 'POST', path: '/login/device/code',
    body: { client_id: 'fixture-client', scope: 'read:user' } });
  assert.equal(code.status, 200);
  const initiate = await call(tenantPort,
    { host: web, path: '/enterprises/contoso/saml/initiate?return_to=%2Flogin%2Fdevice' });
  assert.equal(initiate.status, 302);
  const location = new URL(initiate.headers.location);
  assert.equal(location.origin + location.pathname, TENANT.idpSsoUrl);
  const request = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest'), 'base64')).toString('utf8');
  const requestId = /ID="([^"]+)"/.exec(request)[1];
  const issuer = 'http://contoso.ghe.com:8002/enterprises/contoso';
  const response = `<samlp:Response Destination="${issuer}/saml/consume" InResponseTo="${requestId}">`
    + `<saml:Audience>${issuer}</saml:Audience><saml:NameID>${userName}</saml:NameID><ds:Signature></ds:Signature>`
    + '</samlp:Response>';
  const consumed = await call(tenantPort, { host: web, method: 'POST', path: '/enterprises/contoso/saml/consume',
    form: { SAMLResponse: Buffer.from(response).toString('base64'), RelayState: '/login/device' } });
  assert.equal(consumed.status, 302);
  const cookie = consumed.headers['set-cookie'][0].split(';', 1)[0];
  await call(tenantPort, { host: web, method: 'POST', path: '/login/device', headers: { cookie },
    form: { user_code: code.json.user_code } });
  await call(tenantPort, { host: web, method: 'POST', path: '/login/oauth/authorize', headers: { cookie },
    form: { user_code: code.json.user_code } });
  const token = (await call(tenantPort, { host: web, method: 'POST', path: '/login/oauth/access_token',
    body: { client_id: 'fixture-client', device_code: code.json.device_code } })).json.access_token;
  assert.match(token, /^ghe-fixture-oauth-/);

  const user = await call(tenantPort, { host: 'api.contoso.ghe.com', path: '/user', headers: bearer(token) });
  assert.equal(user.status, 200);
  assert.equal(user.json.login, userName);
  assert.ok(Number.isInteger(user.json.id) && user.json.id >= 1001);
  const elsewhere = await call(tenantPort, { path: '/user', headers: bearer(token) });
  assert.equal(elsewhere.status, 401, 'a GHE.com token is not a github.com token');
  const copilot = 'copilot-api.contoso.ghe.com';
  const models = await call(tenantPort, { host: copilot, path: '/models', headers: bearer(token) });
  assert.equal(models.status, 200);
  const defaultModels = await call(tenantPort, { path: '/models', headers: bearer(token) });
  assert.equal(defaultModels.status, 401);
  const inference = await call(tenantPort, { host: 'copilot-api.contoso.ghe.com', method: 'POST', path: '/v1/messages',
    headers: bearer(token),
    body: { model: 'claude-opus-5.2', messages: [{ role: 'user', content: 'POOL_TEST:{"id":"t1"}' }] } });
  assert.equal(inference.status, 200);
  const state = (await call(tenantPort, { path: '/test/state', headers: internal })).json;
  assert.equal(state.tenants['contoso-eu'].inference.at(-1).marker, 't1');
  assert.ok(!state.inference.some((row) => row.marker === 't1'));
  assert.ok(state.audit.crossTenantTokensRejected >= 2);
});

test('single GHE.com host mode (ghe-e2e) is unchanged: default tenant is GHE-shaped on every host', async () => {
  const created = await call(singleGhePort, { host: 'api.fixture.ghe.com', method: 'POST',
    path: '/scim/v2/enterprises/local-test/Users', headers: bearer(DEFAULT.scimToken),
    body: { userName: 'ghe-single-user', active: true } });
  assert.equal(created.status, 201);
  assert.equal(created.json.githubLogin, 'ghe-single-user');
  const anyHost = await call(singleGhePort, { path: '/scim/v2/enterprises/local-test/Users',
    headers: bearer(DEFAULT.scimToken) });
  assert.equal(anyHost.json.totalResults, 1);
  const page = await call(singleGhePort, { host: 'fixture.ghe.com:8002', path: '/enterprises/local-test/sso' });
  assert.equal(page.status, 200);
  const evidence = await call(singleGhePort, { path: '/test/ghe', headers: internal });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.json.users[0].githubLogin, 'ghe-single-user');
  assert.ok(evidence.json.ghe.hosts['scim:api.fixture.ghe.com'] >= 1);
});

test('invalid tenant configuration is refused at startup', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [MOCK], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port),
      MOCK_GHE_TENANTS: JSON.stringify([{ ...TENANT, host: 'evil.example.com' }]) },
    stdio: 'ignore',
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
});
