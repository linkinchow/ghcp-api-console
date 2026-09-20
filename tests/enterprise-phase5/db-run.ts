import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { args, databaseUrl, insist, loadDbGate, noSymlinkPath, resultPath, safeError, writePrivate } from './db-gate.js';
export const SUITES = {
  v2: ['upgrade/default-enterprise/mysql.integration.test.ts'],
  v3: ['upgrade/multi-enterprise/mysql.integration.test.ts'],
  v4: ['upgrade/multi-enterprise-pool/mysql.integration.test.ts'],
  names: ['upgrade/multi-enterprise-pool/nameCatalog.integration.test.ts'],
  concurrency: ['tests/enterprise-phase7/concurrency.integration.test.ts'],
  scale: ['tests/enterprise-phase7/scale.integration.test.ts'],
  phase4: ['src/proxy/src/userPool/mysqlPhase4.integration.test.ts'],
  storage: ['src/proxy/src/db/mysqlStorage.integration.test.ts'],
  pool: ['src/proxy/src/userPool/mysqlStore.integration.test.ts', 'src/proxy/src/userPool/mysqlRecovery.integration.test.ts',
    'src/proxy/src/userPool/mysqlAdmission.integration.test.ts', 'src/proxy/src/userPool/mysqlCallerIsolation.integration.test.ts',
    'src/proxy/src/userPool/mysqlLifecycle.integration.test.ts'],
} as const;
export const ROUTING_SUITE = ['src/proxy/src/routes/userPoolCatalogPressure.mysql.test.ts',
  'src/proxy/src/routes/userPoolCredentialRace.test.ts', 'src/proxy/src/userPool/inferenceTimeout.mysql.test.ts'] as const;
const RUNNABLE_SUITES = { ...SUITES, routing: ROUTING_SUITE };
/** Logs stay on the VM. Never publish/upload this private tree with sanitized results. */
function privateLogDirectory(output: string): string {
  const results = dirname(output);
  insist(basename(results) === 'results' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(basename(output)), 'private_log_results_root_required');
  const privateRoot = join(results, 'private'); noSymlinkPath(privateRoot);
  if (!existsSync(privateRoot)) mkdirSync(privateRoot, { mode: 0o700 });
  const stat = lstatSync(privateRoot);
  insist(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (process.getuid === undefined || stat.uid === process.getuid()), 'private_log_directory_permissions');
  const directory = join(privateRoot, basename(output));
  // Each invocation exclusively owns a fresh evidence directory, even after failed runs.
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}
function openPrivateLog(file: string): number {
  noSymlinkPath(file);
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) { closeSync(fd); insist(false, 'private_log_file_permissions'); }
  return fd;
}
/** Only the final TAP summary is read into the controller; raw evidence never enters its output. */
function tapSummary(fd: number): { tests: number | null; pass: number | null; fail: number | null; skipped: number | null } {
  const size = fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 64 * 1024));
  readSync(fd, bytes, 0, bytes.length, size - bytes.length);
  const text = bytes.toString('utf8');
  const count = (name: string) => { const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))]; return matches.length ? Number(matches.at(-1)![1]) : null; };
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
}
/** Deliberate filename allowlist: never root `npm test` or sqlite-to-mysql's existing-target integration suite. */
export async function runRealSuite(input = args()): Promise<void> {
  const state = await loadDbGate(input.state, input.inspect);
  resultPath(state, input.output);
  insist(Object.hasOwn(RUNNABLE_SUITES, input.suite), 'suite_not_allowlisted');
  const suite = input.suite as keyof typeof RUNNABLE_SUITES, root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME']) if (process.env[name]) env[name] = process.env[name];
  if (suite === 'v2') {
    env.ENTERPRISE_MYSQL_TEST = '1'; env.ENTERPRISE_MYSQL_TEST_ALLOW_DDL = '1';
    env.ENTERPRISE_MYSQL_TEST_URL = databaseUrl(state, 'ghcp_enterprise_test_phase5_v2');
  } else if (['v3','v4','phase4','names','concurrency','scale'].includes(suite)) {
    env.GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL = '1';
    env.GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA = `ghcp_enterprise_test_phase5_${['phase4','concurrency','scale'].includes(suite) ? 'runtime' : suite === 'names' ? 'v4' : suite}`;
    env.GHCP_ENTERPRISE_MYSQL_TEST_URL = databaseUrl(state, env.GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA);
    if (suite === 'names') env.GHCP_ENTERPRISE_NAME_CATALOG_TEST = '1';
  } else {
    env.MYSQL_POOL_TEST_DISPOSABLE = '1'; env.MYSQL_TEST_URL = databaseUrl(state, 'ghcp_pool_test_phase5');
  }
  const results = [], logs = privateLogDirectory(input.output);
  for (const [index, file] of RUNNABLE_SUITES[suite].entries()) {
    const stdout = openPrivateLog(join(logs, `${index + 1}-${basename(file)}.stdout.log`));
    let stderr: number | undefined;
    try {
      stderr = openPrivateLog(join(logs, `${index + 1}-${basename(file)}.stderr.log`));
      // Stream to private files from process start. Partial evidence survives timeout,
      // failed assertions, output overflow or an interrupted controller; never echo it.
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', file],
        { cwd: root, env, timeout: ['names','concurrency','scale'].includes(suite) ? 600_000 : 900_000, stdio: ['ignore', stdout, stderr] });
      const { tests, pass, fail, skipped } = tapSummary(stdout);
      const status = !result.error && result.status === 0 && tests !== null && tests > 0 && pass !== null && pass > 0 && fail === 0 && skipped === 0 ? 'PASS' : 'FAIL';
      results.push({ file, status, exitCode: result.status, tests, pass, fail, skipped, timedOut: result.error?.message?.includes('ETIMEDOUT') ?? false });
      if (status !== 'PASS') break;
    } finally { closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
  }
  const status = results.length === RUNNABLE_SUITES[suite].length && results.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL';
  writePrivate(input.output, { status, suite, syntheticOnly: true, runId: state.runId, results,
    gateBeforeImports: true, selectedFilesOnly: true, credentialsOrRawDriverErrorsIncluded: false,
    privateEvidence: { retainedOnVm: true, exportAllowed: false, directoryMode: '0700', fileMode: '0600' } });
  if (status !== 'PASS') process.exitCode = 1;
}
if (process.argv[1]?.endsWith('db-run.ts')) runRealSuite().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
