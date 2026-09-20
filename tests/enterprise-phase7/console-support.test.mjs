import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE, IDS, ORIGINS, allowedBrowserRequest, bounded, deferred, exactRequest, flags, safeError, trustedPath, validateFixture, writeExclusive } from './console-support.mjs';
import { qualifyDocker } from './console-run.mjs';

function fixture() {
  const runId = '20260920c', root = `/opt/ghcp-test/phase5-${runId}`;
  const state = { fixtureVersion: 1, syntheticOnly: true, mode: 'init', runId, root, project: `ghcp-enterprise-phase5-${runId}`, origins: structuredClone(ORIGINS), enterpriseIds: [...IDS], legacyEnterpriseId: IDS[0],
    registryFile: '/fixture/registry.json', paths: { state: '/fixture/state.json', results: '/results' }, pool: { paused: 1, idle_target: 0, next_ordinal: 0 },
    source: { head: BASELINE, bundleSha256: 'a'.repeat(64), dirty: true }, credentials: { consoleUsername: 'phase5-admin', consolePassword: 'synthetic-console-password-only', defaultPassword: 'synthetic-default-password-only', fixtureToken: 'synthetic-fixture-token-only' }, images: { login: `ghcp-phase5-login:${runId}` } };
  const registry = { version: 3, legacyEnterpriseId: IDS[0], profiles: IDS.map((id, i) => ({ id, slug: `phase5-${i ? 'b' : 'a'}`, maxAccounts: 6,
    routes: { proxyInternalUrl: ORIGINS.proxy, ssoInternalUrl: ORIGINS.sso, loginInternalUrl: ORIGINS.login, ssoPublicUrl: ORIGINS.sso },
    sso: { entityId: ORIGINS.sso + '/metadata', ssoUrl: ORIGINS.sso + '/sso', loginUrl: ORIGINS.sso + '/login', logoutUrl: ORIGINS.sso + '/logout', spEntityId: ORIGINS.provider + '/sp', spAcsUrl: ORIGINS.provider + '/acs', scimBaseUrl: ORIGINS.provider + '/scim', githubApiBaseUrl: ORIGINS.provider + '/github' } })) };
  return { state, registry, username: `phase7c-${runId}` };
}

test('exact fresh synthetic fixture accepts dirty bundle provenance', () => {
  const f = fixture(); assert.equal(validateFixture(f.state, f.registry).username, f.username);
});

test('fixture rejects unsafe origin, provider route, identity, pool, credential and source drift', () => {
  for (const mutate of [
    f => { f.state.syntheticOnly = false; }, f => { f.state.mode = 'migration'; }, f => { f.state.runId = '../live'; },
    f => { f.state.root = '/srv/live'; }, f => { f.state.origins.console = 'https://customer.invalid'; },
    f => { f.state.origins.extra = 'https://extra.invalid'; }, f => { f.state.origins.proxyReplicas[0] = 'http://127.0.0.1:3000'; },
    f => { f.state.enterpriseIds.reverse(); }, f => { f.state.pool.paused = 0; }, f => { f.state.pool.idle_target = 1; },
    f => { f.state.pool.next_ordinal = 1; }, f => { f.state.source.head = 'b'.repeat(40); }, f => { f.state.source.bundleSha256 = ''; },
    f => { f.state.credentials.consolePassword = 'weak'; }, f => { f.registry.profiles[0].maxAccounts = 7; },
    f => { f.registry.profiles[1].routes.loginInternalUrl = 'http://unowned:7003'; },
    f => { f.registry.profiles[1].sso.githubApiBaseUrl = 'https://api.github.com'; }, f => { f.registry.profiles[0].sso.loginUrl = 'https://live.invalid'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => validateFixture(f.state, f.registry), /phase7_console_/); }
});

test('browser allowlist permits only bounded synthetic cap/settings/user writes', () => {
  const f = fixture(), p = `/api/console/proxy/profiles/${IDS[0]}/pool-policy`, u = `/api/console/sso/profiles/${IDS[0]}/users`;
  const allow = (path, method, body) => allowedBrowserRequest(f.state, f.username, new URL(path, ORIGINS.console), method, body);
  assert.equal(allow(p, 'GET'), true); assert.equal(allow(p, 'PATCH', { expectedVersion: 1, maxAccounts: 5001 }), true);
  assert.equal(allow('/api/console/proxy/management/pool/settings', 'PATCH', { expectedVersion: 1, changes: { paused: 1, idle_target: 0, lease_seconds: 121 } }), true);
  assert.equal(allow(u, 'POST', { ssoUser: f.username, password: f.state.credentials.defaultPassword, email: 'new@phase7.invalid', role: 'user' }), true);
  assert.equal(allow(`${u}/${f.username}`, 'PATCH', { email: 'edit@phase7.invalid', role: 'user', expectedUserIncarnation: IDS[0] }), true);
  assert.equal(allow(`${u}/batch`, 'POST', { operation: 'delete_sso', ssoUsers: [f.username], expectedIncarnations: { [f.username]: IDS[0] } }), true);
});

test('browser allowlist rejects unsafe writes, token routes, unpause and credential forwarding', () => {
  const f = fixture(), p = `/api/console/proxy/profiles/${IDS[0]}/pool-policy`, u = `/api/console/sso/profiles/${IDS[0]}/users`;
  for (const [path, method, body] of [
    ['https://github.com/login', 'GET'], [ORIGINS.provider + '/fixture/snapshot', 'GET'],
    [`${p}/activate`, 'POST', { expectedVersion: 1, confirm: true }], [`${p}/validate`, 'POST', { expectedVersion: 1 }],
    [p, 'PATCH', { expectedVersion: 1, maxAccounts: 10001 }], [p, 'PATCH', { expectedVersion: 1, maxAccounts: 5, weight: 1 }],
    [p + '?enterpriseId=' + IDS[1], 'PATCH', { expectedVersion: 1, maxAccounts: 5 }],
    ['/api/console/setup', 'POST', { username: 'x', password: 'x' }], ['/api/console/proxy/accounts/x', 'DELETE', {}],
    ['/api/console/proxy/management/pool/settings', 'PATCH', { expectedVersion: 1, changes: { paused: 0, idle_target: 0, lease_seconds: 121 } }],
    ['/api/console/proxy/management/pool/settings', 'PATCH', { expectedVersion: 1, changes: { paused: 1, idle_target: 1, lease_seconds: 121 } }],
    [u, 'POST', { ssoUser: 'another-user', password: f.state.credentials.defaultPassword, email: 'new@phase7.invalid', role: 'user' }],
    [`${u}/batch`, 'POST', { operation: 'sync_emu', ssoUsers: [f.username], expectedIncarnations: { [f.username]: IDS[0] } }],
    [`${u}/${f.username}`, 'PATCH', { email: 'edit@phase7.invalid', role: 'admin', expectedUserIncarnation: IDS[0] }],
    [`${u}/${f.username}`, 'PATCH', { email: 'edit@phase7.invalid', role: 'user' }],
  ]) assert.equal(allowedBrowserRequest(f.state, f.username, new URL(path, ORIGINS.console), method, body), false);
});

test('barrier matching is exact method origin path query and captured body', () => {
  const request = { url: () => ORIGINS.console + '/api/x', method: () => 'PATCH', postDataJSON: () => ({ expectedVersion: 1, maxAccounts: 7 }) };
  assert.equal(exactRequest(request, ORIGINS.console, 'PATCH', '/api/x', { expectedVersion: 1, maxAccounts: 7 }), true);
  for (const [origin, method, path, body] of [[ORIGINS.sso, 'PATCH', '/api/x'], [ORIGINS.console, 'GET', '/api/x'], [ORIGINS.console, 'PATCH', '/api'], [ORIGINS.console, 'PATCH', '/api/x', { expectedVersion: 2, maxAccounts: 7 }]]) assert.equal(exactRequest(request, origin, method, path, body), false);
  assert.equal(exactRequest({ ...request, url: () => request.url() + '?q=1' }, ORIGINS.console, 'PATCH', '/api/x'), false);
});

test('exclusive output and path traversal rejection use no network or fixture credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'phase7-console-pure-'));
  try { const out = join(root, 'result.json'); assert.equal(trustedPath(out, root), out); writeExclusive(out, '{}'); assert.equal(readFileSync(out, 'utf8'), '{}'); assert.throws(() => writeExclusive(out, 'overwrite')); assert.throws(() => trustedPath(join(root, '..', 'escape.json'), root), /path_boundary/); } finally { rmSync(root, { recursive: true }); }
});

test('CLI rejects missing, duplicate, unknown flags and redacts arbitrary errors', () => {
  assert.deepEqual(flags(['--state', '/fixture/state.json', '--output', '/results/c.json']), { stateFile: '/fixture/state.json', output: '/results/c.json' });
  for (const args of [[], ['--state', 'x'], ['--state', 'x', '--output', 'y', '--output', 'z'], ['--state', 'x', '--output', 'y', '--unsafe', '1']]) assert.throws(() => flags(args), /phase7_console_flags/);
  assert.equal(safeError(new Error('mysql://root:credential@internal')), 'phase7_console_failed_details_suppressed');
  assert.equal(safeError(new Error('phase7_console_deadline')), 'phase7_console_deadline');
});

test('barrier waits resolve and time out without starting browser or API', async () => {
  const d = deferred(); d.resolve('ready'); assert.equal(await bounded(d.promise, 100, 'unused'), 'ready');
  await assert.rejects(bounded(new Promise(() => {}), 5, 'expected_timeout'), /phase7_console_expected_timeout/);
});

function dockerFixture() {
  const { state } = fixture(), labels = { 'com.docker.compose.project': state.project, 'io.ghcp.phase5.run-id': state.runId, 'io.ghcp.phase5.synthetic': 'true' };
  const network = { Id: 'n'.repeat(64), Name: state.project + '_isolated', Internal: true, Labels: labels };
  const services = ['proxy-lb', 'sso', 'login', 'console', 'provider', 'proxy-1', 'proxy-2', 'proxy-3'];
  state.ownership = { containers: Object.fromEntries(services.map((service, index) => [service, { id: (index + 1).toString(16).repeat(64), name: `${state.project}-${service}-1` }])) };
  const containers = services.map(service => ({ Id: state.ownership.containers[service].id, Name: `/${state.ownership.containers[service].name}`, Config: { Labels: { ...labels, 'com.docker.compose.service': service } }, State: { Running: true, Health: { Status: 'healthy' } }, NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } } }));
  return { state, network, containers, image: { Id: 'sha256:' + 'a'.repeat(64), RepoTags: [state.images.login] } };
}

test('launcher pure ownership gate requires internal-only healthy owned services and exact image', () => {
  const f = dockerFixture(); assert.deepEqual(qualifyDocker(f.state, f.containers, f.network, f.image), { network: f.network.Id, image: f.image.Id });
  for (const mutate of [f => { f.network.Internal = false; }, f => { f.containers[0].Config.Labels['io.ghcp.phase5.synthetic'] = 'false'; }, f => { f.containers[1].State.Running = false; }, f => { f.containers[2].NetworkSettings.Networks.public = {}; }, f => { f.containers[3].State.Health.Status = 'unhealthy'; }, f => { f.image.RepoTags = ['other']; }, f => { f.state.ownership.containers = {}; }, f => { f.containers[0].Id = 'f'.repeat(64); }, f => { f.containers[1].Name = '/copied-labels-wrong-name'; }, f => { f.state.ownership.containers.sso.id = 'e'.repeat(64); }]) { const g = dockerFixture(); mutate(g); assert.throws(() => qualifyDocker(g.state, g.containers, g.network, g.image), /phase7_console_/); }
});
