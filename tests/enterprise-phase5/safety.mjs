import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SERVICES = Object.freeze(['mysql', 'mysql-restore', 'provider', 'sso', 'login', 'proxy-1', 'proxy-2', 'proxy-3', 'proxy-lb', 'console', 'console-bridge']);
export const DATABASES = Object.freeze(['app','v2','v3','v4','runtime','chain','fault_v2','fault_v3','fault_v4','compat_direct','compat_pool'].map(s => `ghcp_enterprise_test_phase5_${s}`).concat('ghcp_pool_test_phase5'));
export function insist(value, code) { if (!value) throw new Error(`phase5_${code}`); }
export function absolutePath(value) {
  insist(typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/u.test(value), 'absolute_path_required');
  insist(resolve(value) === (process.platform === 'win32' ? value.replaceAll('/', sep) : value), 'canonical_path_required');
  return resolve(value);
}
export function within(root, file) {
  absolutePath(root); absolutePath(file);
  const rel = relative(root, file);
  insist(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'path_outside_root');
  return file;
}
export function noSymlinkPath(file) {
  absolutePath(file);
  for (let cursor = file;; cursor = dirname(cursor)) {
    if (existsSync(cursor)) insist(!lstatSync(cursor).isSymbolicLink(), 'symlink_refused');
    if (cursor === dirname(cursor)) break;
  }
  return file;
}
export function exclusiveWrite(file, content) {
  noSymlinkPath(file);
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
export function exclusiveJson(file, value) { exclusiveWrite(file, JSON.stringify(value, null, 2) + '\n'); }
export function validateState(state) {
  insist(state && state.fixtureVersion === 1 && state.syntheticOnly === true, 'synthetic_state_required');
  insist(/^[a-z0-9][a-z0-9-]{0,31}$/.test(state.runId), 'run_id');
  insist(state.project === `ghcp-enterprise-phase5-${state.runId}`, 'project');
  absolutePath(state.root);
  insist(basename(state.root) === `phase5-${state.runId}`, 'root_run_id');
  insist(['init','migration'].includes(state.mode), 'mode');
  insist(state.registryFile === '/fixture/registry.json', 'registry_path');
  insist(JSON.stringify(state.enterpriseIds) === JSON.stringify(['a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002']) && state.legacyEnterpriseId === state.enterpriseIds[0], 'enterprise_ids');
  const origins = {proxy:'http://proxy-lb:3000',sso:'http://sso:7001',login:'http://login:7003',console:'http://console:7004',provider:'http://provider:8000'};
  for (const [key, value] of Object.entries(origins)) insist(state.origins?.[key] === value, 'origin');
  insist(JSON.stringify(state.origins.proxyReplicas) === JSON.stringify([1,2,3].map(n => `http://proxy-${n}:3000`)), 'proxy_origins');
  const expectedPaths = {fixture:'/fixture',state:'/fixture/state.json',registry:'/fixture/registry.json',secrets:'/fixture/secrets',ssoDb:'/fixture/data/sso/sso.sqlite',loginDb:'/fixture/data/login/login.sqlite',adminsFile:'/fixture/data/console/admins.json',results:'/results',backups:'/backups',initManifest:'/fixture/init-v4.json'};
  for (const [key, value] of Object.entries(expectedPaths)) insist(state.paths?.[key] === value, 'container_path');
  for (const [key, leaf] of Object.entries({fixture:'fixture',results:'results',backups:'backups',source:'workspace'})) insist(state.hostPaths?.[key] === join(state.root,leaf), 'host_path');
  const db = state.database;
  insist(db && db.host === 'mysql' && db.port === 3306 && db.hostAddress === '127.0.0.1' && Number.isInteger(db.hostPort) && db.hostPort >= 1024 && db.hostPort <= 65535, 'db_route');
  insist(db.name === (state.mode === 'migration' ? 'ghcp_enterprise_test_phase5_chain' : DATABASES[0]) && db.username === 'phase5' && JSON.stringify(db.schemas) === JSON.stringify(DATABASES), 'db_allowlist');
  insist(Number.isInteger(db.restoreHostPort) && db.restoreHostPort >= 1024 && db.restoreHostPort <= 65535 && db.restoreHostPort !== db.hostPort, 'restore_port');
  insist(Number.isInteger(state.uiPort) && state.uiPort >= 1024 && state.uiPort <= 65535 && ![db.hostPort,db.restoreHostPort].includes(state.uiPort), 'ui_port');
  for (const name of ['internalApiToken','fixtureToken','defaultPassword','consolePassword','sessionSecret','mysqlRootPassword','mysqlPassword','apiKey']) insist(typeof state.credentials?.[name] === 'string' && /^[a-zA-Z0-9_-]{24,128}$/.test(state.credentials[name]), 'synthetic_credential_shape');
  insist(db.password === state.credentials.mysqlPassword && db.rootPassword === state.credentials.mysqlRootPassword, 'db_credential_binding');
  insist(/^[a-f0-9]{40}$/.test(state.source?.head) && /^[a-f0-9]{64}$/.test(state.source?.bundleSha256) && state.source.dirty === true, 'source_provenance');
  for (const key of ['tooling','proxy','sso','login','console','mysql','haproxy']) insist(typeof state.images?.[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,240}$/.test(state.images[key]), 'image_ref');
  for (const service of Object.keys(state.ownership?.containers ?? {})) {
    insist(SERVICES.includes(service), 'ownership_service');
    const own = state.ownership.containers[service];
    insist(own.name === `${state.project}-${service}-1` && /^[a-f0-9]{64}$/.test(own.id), 'ownership_id');
  }
  return state;
}
/** State is immutable; controller appends exclusive ownership files, never rewrites state. */
export function loadState(statePath) {
  statePath = absolutePath(statePath); noSymlinkPath(statePath);
  const state = validateState(JSON.parse(readFileSync(statePath, 'utf8')));
  const fixture = dirname(statePath);
  insist(basename(statePath) === 'state.json' && (fixture === '/fixture' || fixture === state.hostPaths.fixture), 'state_location');
  insist(realpathSync(fixture) === fixture, 'state_realpath');
  for (const leaf of ['ownership-mysql.json','ownership-restore.json','ownership-app.json']) {
    const file = join(fixture,leaf);
    if (!existsSync(file)) continue;
    noSymlinkPath(file);
    const owned = JSON.parse(readFileSync(file,'utf8'));
    insist(owned.runId === state.runId && owned.project === state.project && owned.root === state.root && owned.syntheticOnly === true, 'ownership_binding');
    for (const [service, identity] of Object.entries(owned.containers ?? {})) {
      insist(!state.ownership.containers[service], 'ownership_duplicate');
      state.ownership.containers[service] = identity;
    }
  }
  return validateState(state);
}
/** Takes a fresh `docker inspect` object, not a name supplied by a caller. */
export function assertOwnedContainer(state, inspection, service = 'mysql') {
  validateState(state);
  const row = Array.isArray(inspection) ? (insist(inspection.length === 1, 'inspect_cardinality'), inspection[0]) : inspection;
  const own = state.ownership.containers[service], labels = row?.Config?.Labels;
  insist(own && row.Id === own.id && row.Name === `/${own.name}`, 'container_identity');
  insist(labels?.['com.docker.compose.project'] === state.project && labels?.['com.docker.compose.service'] === service && labels?.['io.ghcp.phase5.run-id'] === state.runId && labels?.['io.ghcp.phase5.synthetic'] === 'true', 'container_labels');
  if (service === 'mysql' || service === 'mysql-restore') {
    const expectedPort = service === 'mysql' ? state.database.hostPort : state.database.restoreHostPort;
    const expectedVolume = service === 'mysql' ? 'mysql-data' : 'mysql-restore-data';
    const binding = row.HostConfig?.PortBindings?.['3306/tcp'];
    insist(Array.isArray(binding) && binding.length === 1 && binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === String(expectedPort), 'mysql_port_binding');
    const volume = row.Mounts?.filter(m => m.Destination === '/var/lib/mysql');
    insist(volume?.length === 1 && volume[0].Type === 'volume' && volume[0].Name === `${state.project}_${expectedVolume}`, 'mysql_owned_volume');
  }
  return row;
}
export function safeError(error) { return error instanceof Error && /^phase5_[a-z0-9_]+$/.test(error.message) ? error.message : 'phase5_operation_failed'; }
