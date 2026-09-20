import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const BASELINE = '9cbdae111f524a552ee607df4900e5c96189b16d';
export const SOFT_LIMIT_MS = 90_000;
export const HARD_LIMIT_MS = 150_000;
export const ORIGINS = Object.freeze({ proxy: 'http://proxy-lb:3000', sso: 'http://sso:7001', login: 'http://login:7003', console: 'http://console:7004', provider: 'http://provider:8000', proxyReplicas: ['http://proxy-1:3000', 'http://proxy-2:3000', 'http://proxy-3:3000'] });
export const IDS = ['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function insist(value, code) { if (!value) throw new Error(`phase7_console_${code}`); }
export function safeError(error) { return error instanceof Error && /^phase7_console_[a-z0-9_]+$/.test(error.message) ? error.message : 'phase7_console_failed_details_suppressed'; }
export function flags(args) {
  const values = {};
  while (args.length) { const key = args.shift(), value = args.shift(); insist(['--state', '--output'].includes(key) && !Object.hasOwn(values, key) && value && !value.startsWith('--'), 'flags'); values[key] = value; }
  insist(values['--state'] && values['--output'], 'flags');
  return { stateFile: values['--state'], output: values['--output'] };
}
export function trustedPath(value, root) {
  insist(typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/u.test(value), 'absolute_path');
  const rel = relative(root, value); insist(rel && !rel.startsWith('..') && !isAbsolute(rel), 'path_boundary');
  for (let path = value;; path = dirname(path)) { if (existsSync(path)) insist(!lstatSync(path).isSymbolicLink(), 'symlink'); if (path === dirname(path)) break; }
  return value;
}
export function writeExclusive(path, bytes) { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } }
export function validateFixture(state, registry) {
  insist(state.fixtureVersion === 1 && state.syntheticOnly === true && state.mode === 'init', 'synthetic_state');
  insist(/^[a-z0-9][a-z0-9-]{0,31}$/.test(state.runId) && state.project === `ghcp-enterprise-phase5-${state.runId}` && state.root === `/opt/ghcp-test/phase5-${state.runId}`, 'fixture_identity');
  insist(Object.keys(state.origins ?? {}).length === Object.keys(ORIGINS).length && Object.entries(ORIGINS).every(([k, v]) => JSON.stringify(state.origins[k]) === JSON.stringify(v)), 'fixed_origins');
  insist(JSON.stringify(state.enterpriseIds) === JSON.stringify(IDS) && state.legacyEnterpriseId === IDS[0], 'enterprise_ids');
  insist(state.registryFile === '/fixture/registry.json' && state.paths?.state === '/fixture/state.json' && state.paths?.results === '/results', 'fixture_paths');
  insist(state.pool?.paused === 1 && state.pool?.idle_target === 0 && state.pool?.next_ordinal === 0, 'paused_fixture');
  insist(state.source?.head === BASELINE && /^[a-f0-9]{64}$/.test(state.source?.bundleSha256), 'source_baseline');
  const c = state.credentials;
  insist(c?.consoleUsername === 'phase5-admin' && ['consolePassword', 'fixtureToken', 'defaultPassword'].every(k => typeof c[k] === 'string' && c[k].length >= 24), 'private_credentials');
  insist(registry.version === 3 && registry.legacyEnterpriseId === IDS[0] && registry.profiles?.length === 2, 'registry');
  for (const [i, p] of registry.profiles.entries()) {
    insist(p.id === IDS[i] && p.slug === `phase5-${i === 0 ? 'a' : 'b'}` && p.maxAccounts === 6, 'fresh_registry');
    insist(p.routes?.proxyInternalUrl === ORIGINS.proxy && p.routes?.ssoInternalUrl === ORIGINS.sso && p.routes?.loginInternalUrl === ORIGINS.login && p.routes?.ssoPublicUrl === ORIGINS.sso, 'registry_internal_routes');
    for (const value of [p.sso?.entityId, p.sso?.ssoUrl, p.sso?.loginUrl, p.sso?.logoutUrl]) insist(new URL(value).origin === ORIGINS.sso, 'registry_sso_routes');
    for (const value of [p.sso?.spEntityId, p.sso?.spAcsUrl, p.sso?.scimBaseUrl, p.sso?.githubApiBaseUrl]) insist(new URL(value).origin === ORIGINS.provider, 'registry_provider_routes');
  }
  return { state, registry, username: `phase7c-${state.runId}` };
}
export function loadFixture(stateFile, output) {
  insist(process.env.PHASE5_SYNTHETIC_ONLY === '1' && process.env.PHASE7_CONSOLE_WRITES === '1', 'explicit_write_opt_in');
  insist(stateFile === '/fixture/state.json', 'state_path'); trustedPath(stateFile, '/fixture');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  insist(state.registryFile === '/fixture/registry.json', 'registry_path'); trustedPath(state.registryFile, '/fixture');
  const result = validateFixture(state, JSON.parse(readFileSync(state.registryFile, 'utf8')));
  trustedPath(output, '/results'); insist(output.endsWith('.json') && !existsSync(output), 'fresh_output');
  if (process.platform !== 'win32') insist((lstatSync(stateFile).mode & 0o077) === 0, 'private_state_permissions');
  return result;
}
export function exactRequest(request, origin, method, path, body) {
  const url = new URL(request.url());
  return url.origin === origin && url.pathname === path && url.search === '' && request.method() === method && (body === undefined || JSON.stringify(request.postDataJSON()) === JSON.stringify(body));
}
const keys = (object, expected) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => expected.includes(k));
// This is narrower than state.origins: browsers only need Console. No generic
// business route, legacy fallback, activation, inference, SCIM or token API.
export function allowedBrowserRequest(state, username, url, method, body) {
  if (url.origin !== state.origins.console || url.username || url.password || url.hash) return false;
  if (method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/favicon.ico' || /^\/assets\/[\w.-]+$/.test(url.pathname)) return true;
    if (['/api/console/setup', '/api/console/me', '/api/console/proxy/management/enterprises', '/api/console/proxy/management/pool/summary', '/api/console/proxy/management/pool/settings'].includes(url.pathname)) return !url.search;
    return IDS.some(id => [`/api/console/proxy/profiles/${id}/pool-policy`, `/api/console/proxy/profiles/${id}/accounts`, `/api/console/sso/profiles/${id}/users`, `/api/console/sso/profiles/${id}/users/capacity`, `/api/console/login-service/profiles/${id}/tasks`].includes(url.pathname));
  }
  if (url.search) return false;
  if (method === 'POST' && url.pathname === '/api/console/login') return keys(body, ['username', 'password']) && body.username === state.credentials.consoleUsername && body.password === state.credentials.consolePassword;
  if (method === 'POST' && url.pathname === '/api/console/logout') return body == null;
  if (method === 'PATCH' && url.pathname === '/api/console/proxy/management/pool/settings') return keys(body, ['expectedVersion', 'changes']) && Number.isSafeInteger(body.expectedVersion) && body.expectedVersion > 0 && keys(body.changes, ['idle_target', 'lease_seconds', 'paused']) && body.changes.idle_target === 0 && body.changes.paused === 1 && Number.isSafeInteger(body.changes.lease_seconds) && body.changes.lease_seconds >= 60 && body.changes.lease_seconds <= 2592000;
  for (const id of IDS) {
    if (method === 'PATCH' && url.pathname === `/api/console/proxy/profiles/${id}/pool-policy`) return keys(body, ['expectedVersion', 'maxAccounts']) && Number.isSafeInteger(body.expectedVersion) && body.expectedVersion > 0 && Number.isSafeInteger(body.maxAccounts) && body.maxAccounts >= 1 && body.maxAccounts <= 10000;
    const users = `/api/console/sso/profiles/${id}/users`;
    if (method === 'POST' && url.pathname === users) return keys(body, ['ssoUser', 'password', 'email', 'role']) && body.ssoUser === username && body.password === state.credentials.defaultPassword && typeof body.email === 'string' && /^[a-z0-9-]+@phase7\.invalid$/.test(body.email) && body.role === 'user';
    if (method === 'PATCH' && url.pathname === `${users}/${username}`) return keys(body, ['email', 'role', 'expectedUserIncarnation']) && /^[a-z0-9-]+@phase7\.invalid$/.test(body.email) && body.role === 'user' && UUID.test(body.expectedUserIncarnation);
    if (method === 'POST' && url.pathname === `${users}/batch`) return keys(body, ['operation', 'ssoUsers', 'expectedIncarnations']) && body.operation === 'delete_sso' && JSON.stringify(body.ssoUsers) === JSON.stringify([username]) && keys(body.expectedIncarnations, [username]) && UUID.test(body.expectedIncarnations[username]);
  }
  return false;
}
export function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
export async function bounded(promise, ms, code) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`phase7_console_${code}`)), ms); })]); } finally { clearTimeout(timer); } }
