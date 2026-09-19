import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Connection } from 'mysql2/promise';

export const SCHEMAS = ['app', 'v2', 'v3', 'v4', 'runtime', 'chain', 'fault_v2', 'fault_v3', 'fault_v4', 'compat_direct', 'compat_pool']
  .map(name => `ghcp_enterprise_test_phase5_${name}`).concat('ghcp_pool_test_phase5');
export type State = {
  fixtureVersion: number; syntheticOnly: boolean; runId: string; project: string; root: string;
  registryFile: string; legacyEnterpriseId: string;
  paths: Record<string, string>; hostPaths: Record<string, string>;
  database: { host: string; port: number; hostAddress: string; hostPort: number; restoreHostPort?: number;
    name: string; username: string; password: string; rootPassword: string; schemas: string[] };
  ownership: { containers: Record<string, { id: string; name: string }> };
  [key: string]: unknown;
};
export function insist(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`phase5_${code}`);
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(?:phase5_|enterprise_|mysql_|sqlite_|manifest_)[a-z0-9_]{1,110}$/.test(message)
    ? message : 'phase5_operation_failed_details_suppressed';
}
export function sha256(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
export function hashFile(file: string): string {
  const stat = lstatSync(file); insist(stat.isFile() && !stat.isSymbolicLink(), 'regular_artifact_required');
  return sha256(readFileSync(file));
}
export function noSymlinkPath(file: string): void {
  for (let cursor = resolve(file);; cursor = dirname(cursor)) {
    try { insist(!lstatSync(cursor).isSymbolicLink(), 'symlink_path_refused'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (cursor === dirname(cursor)) return;
  }
}
export function writePrivate(file: string, value: unknown): void {
  noSymlinkPath(file);
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function args(argv = process.argv.slice(2)): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    insist(/^--[a-z][a-z-]*$/.test(argv[i]) && !!argv[i + 1] && !argv[i + 1].startsWith('--'), 'explicit_named_arguments_required');
    insist(!Object.hasOwn(result, argv[i].slice(2)), 'duplicate_argument'); result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
export function inside(root: string, file: string): string {
  insist(isAbsolute(root) && isAbsolute(file), 'absolute_owned_path_required');
  const child = relative(resolve(root), resolve(file));
  insist(child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'path_outside_owned_root');
  return resolve(file);
}
/** Pure checks run before imports of any driver, schema, configured runtime or migration tool. */
export function validateDbGate(state: State, inspected: any, env: NodeJS.ProcessEnv, service = 'mysql'): void {
  insist(env.PHASE5_SYNTHETIC_ONLY === '1' && env.PHASE5_DB_ALLOW_DDL === '1', 'explicit_synthetic_ddl_gate_required');
  insist(state.fixtureVersion === 1 && state.syntheticOnly === true && /^[a-z0-9]{6,24}$/.test(state.runId), 'invalid_fixture');
  insist(state.project === `ghcp-enterprise-phase5-${state.runId}` && state.root === `/opt/ghcp-test/phase5-${state.runId}`, 'run_root_mismatch');
  insist(['mysql', 'mysql-restore'].includes(service), 'mysql_service_not_allowed');
  const owner = state.ownership?.containers?.[service];
  insist(owner && /^[a-f0-9]{64}$/.test(owner.id) && owner.name === `${state.project}-${service}-1`, 'new_container_ownership_required');
  const labels = inspected?.Config?.Labels;
  insist(inspected?.Id === owner.id && inspected?.Name === '/' + owner.name && labels?.['com.docker.compose.project'] === state.project
    && labels?.['com.docker.compose.service'] === service && labels?.['io.ghcp.phase5.run-id'] === state.runId
    && labels?.['io.ghcp.phase5.synthetic'] === 'true', 'container_identity_mismatch');
  insist(inspected.State?.Running === true, 'owned_mysql_not_running');
  const port = service === 'mysql' ? state.database.hostPort : state.database.restoreHostPort;
  insist(Number.isInteger(port) && port! > 1024 && port! < 65536 && state.database.hostAddress === '127.0.0.1', 'numeric_loopback_required');
  const bindings = inspected.NetworkSettings?.Ports?.['3306/tcp'];
  insist(Array.isArray(bindings) && bindings.length === 1 && bindings[0].HostIp === '127.0.0.1'
    && bindings[0].HostPort === String(port), 'container_loopback_binding_mismatch');
  insist(state.database.schemas?.length === SCHEMAS.length && new Set(state.database.schemas).size === SCHEMAS.length
    && state.database.schemas.every(name => SCHEMAS.includes(name)), 'schema_allowlist_mismatch');
  insist(['init', 'migration'].includes(state.mode as string)
    && state.database.name === `ghcp_enterprise_test_phase5_${state.mode === 'migration' ? 'chain' : 'app'}` && state.database.username === 'phase5'
    && typeof state.database.rootPassword === 'string' && state.database.rootPassword.length >= 24
    && typeof state.database.password === 'string' && state.database.password.length >= 24, 'synthetic_database_credentials_required');
  if (service === 'mysql-restore') insist(owner.id !== state.ownership.containers.mysql?.id
    && state.database.restoreHostPort !== state.database.hostPort, 'restore_requires_distinct_instance');
}
export async function loadDbGate(statePath: string, inspectPath: string, service = 'mysql'): Promise<State> {
  insist(isAbsolute(statePath) && isAbsolute(inspectPath), 'explicit_state_and_inspect_required');
  for (const file of [statePath, inspectPath]) insist(!lstatSync(file).isSymbolicLink() && lstatSync(file).isFile(), 'regular_gate_file_required');
  insist(Date.now() - lstatSync(inspectPath).mtimeMs < 300_000, 'fresh_container_inspect_required');
  // Shared loader incorporates separately recorded, immutable ownership manifests.
  // It has no DB/runtime imports; both gates finish before a driver can be loaded.
  const safety = await import(new URL('./safety.mjs', import.meta.url).href);
  const state = safety.loadState(statePath) as State;
  safety.noSymlinkPath(inspectPath);
  const inspectRoots = [state.hostPaths.results, '/results'];
  insist(inspectRoots.some(root => { try { inside(root, inspectPath); return true; } catch { return false; } }), 'inspect_outside_run_results');
  const inspected = JSON.parse(readFileSync(inspectPath, 'utf8'));
  if (Array.isArray(inspected)) insist(inspected.length === 1, 'inspect_cardinality');
  validateDbGate(state, Array.isArray(inspected) ? inspected[0] : inspected, process.env, service);
  safety.assertOwnedContainer(state, Array.isArray(inspected) ? inspected[0] : inspected, service);
  const permittedRoots = [state.hostPaths?.fixture, '/fixture'].filter(Boolean);
  insist(permittedRoots.some(root => { try { inside(root, realpathSync(statePath)); return true; } catch { return false; } }), 'state_outside_fixture');
  return state;
}
export function resultPath(state: State, file: string): string {
  insist(typeof file === 'string' && [state.hostPaths.results, '/results'].some(root => {
    try { inside(root, file); return true; } catch { return false; }
  }), 'output_outside_run_results');
  noSymlinkPath(file);
  try { lstatSync(file); insist(false, 'output_already_exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return file;
}
export function databaseUrl(state: State, schema: string, service = 'mysql'): string {
  insist(SCHEMAS.includes(schema) && state.database.schemas.includes(schema), 'schema_not_owned');
  const port = service === 'mysql' ? state.database.hostPort : state.database.restoreHostPort;
  return `mysql://root:${encodeURIComponent(state.database.rootPassword)}@127.0.0.1:${port}/${schema}`;
}
export function validatePeer(c: Connection): void {
  const transport = (c as any).connection;
  if (transport.config?.socketPath || !['127.0.0.1', '::ffff:127.0.0.1'].includes(transport.stream?.remoteAddress)) {
    c.destroy(); insist(false, 'numeric_loopback_peer_required');
  }
}
export async function connect(state: State, schema: string, service = 'mysql'): Promise<Connection> {
  const { createConnection } = await import('mysql2/promise');
  const c = await createConnection({ uri: databaseUrl(state, schema, service), timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4', connectTimeout: 5000, multipleStatements: false });
  try {
    validatePeer(c);
    const [rows] = await c.query<any[]>('SELECT DATABASE() AS db,VERSION() AS version,CURRENT_USER() AS principal');
    insist(rows[0]?.db === schema && /^8\.4\./.test(rows[0]?.version) && rows[0]?.principal?.startsWith('root@'), 'owned_mysql84_root_required');
    await c.query('SET SESSION lock_wait_timeout=5,innodb_lock_wait_timeout=5');
    return c;
  } catch (error) { c.destroy(); throw error; }
}
export async function assertEmpty(c: Connection): Promise<void> {
  for (const [table, column] of [['TABLES', 'TABLE_SCHEMA'], ['TRIGGERS', 'TRIGGER_SCHEMA'], ['ROUTINES', 'ROUTINE_SCHEMA'], ['EVENTS', 'EVENT_SCHEMA']]) {
    const [rows] = await c.query<any[]>(`SELECT COUNT(*) AS n FROM information_schema.${table} WHERE ${column}=DATABASE()`);
    insist(Number(rows[0].n) === 0, 'nonempty_schema_refused_no_cleanup');
  }
}
