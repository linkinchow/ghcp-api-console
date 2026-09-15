// Dependency-free entry gate runs before even git/loader/test process creation.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = '356f8f5e33a21ccfe7cf8c5db07060ab1ac47846';
const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ['--offline', '--typecheck', '--run'].includes(mode),
  'Usage: node tests/user-pool-process/login-network-run.mjs --offline|--typecheck|--run');
if (mode === '--run') {
  assert.equal(process.env.MYSQL_POOL_LOGIN_NETWORK_TEST, '1', 'REFUSED: MYSQL_POOL_LOGIN_NETWORK_TEST=1 required');
  assert.equal(process.env.MYSQL_POOL_TEST_DISPOSABLE, '1', 'REFUSED: MYSQL_POOL_TEST_DISPOSABLE=1 required');
  assert.ok(process.env.MYSQL_TEST_URL, 'REFUSED: MYSQL_TEST_URL required');
  let url;
  try { url = new URL(process.env.MYSQL_TEST_URL); } catch { throw new Error('Invalid MySQL test URL'); }
  assert.equal(url.protocol, 'mysql:'); assert.equal(url.username, 'root');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Loopback MySQL only');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/); assert.equal(url.search + url.hash, '');
}
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22+ required');
const gitOptions = { cwd: root, encoding: 'utf8', timeout: 10000 };
// Descendant test-only integration commits are OK; executed production must equal v5.
execFileSync('git', ['merge-base', '--is-ancestor', baseline, 'HEAD'], gitOptions);
execFileSync('git', ['diff', '--exit-code', baseline, '--', 'src/proxy', 'src/packages/shared',
  'tests/user-pool-process/worker-common.ts', 'tests/user-pool-process/worker-mock.ts'], { ...gitOptions, stdio: 'ignore' });
if (mode === '--typecheck') {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const config = ts.readConfigFile(fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { noEmit: true });
  const files = readdirSync(directory).filter(file => /^login-network-.*\.ts$/.test(file)).map(file => `${directory}/${file}`);
  files.push(fileURLToPath(new URL('../../src/proxy/src/auth/apiKey.ts', import.meta.url)));
  const program = ts.createProgram(files, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
    })); process.exitCode = 1;
  } else console.log('PASS: Login network noEmit typecheck (not MySQL/network acceptance)');
} else {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null', DOTENV_CONFIG_QUIET: 'true',
    SSO_BASE_URL: 'http://127.0.0.1:0', LOGIN_BASE_URL: 'http://127.0.0.1:0', COPILOT_API_BASE_URL: 'http://127.0.0.1:0',
    INTERNAL_API_TOKEN: 'worker-process-synthetic-internal', PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', NODE_ENV: 'test' });
  if (mode === '--run') {
    for (const key of ['MYSQL_POOL_LOGIN_NETWORK_TEST', 'MYSQL_POOL_TEST_DISPOSABLE', 'MYSQL_TEST_URL']) env[key] = process.env[key];
  }
  // Acceptance runs node:test directly: no intermediary coordinator can swallow
  // SIGTERM or die before the fixture parent runs its own cleanup.
  const args = mode === '--run'
    ? ['--import', 'tsx', 'login-network-mysql.test.ts']
    : ['--import', 'tsx', '--test', '--test-concurrency=1', 'login-network-offline.test.mjs', 'login-network-mysql.test.ts'];
  const child = spawn(process.execPath, args, { cwd: directory, env, stdio: 'inherit', shell: false });
  let interrupted = false;
  let escalation;
  let exited = false;
  const force = () => { if (!exited) child.kill('SIGKILL'); };
  const interrupt = () => {
    if (exited || interrupted) return;
    interrupted = true;
    // On Linux the directly launched fixture handles SIGTERM and cleans its DB.
    // Windows cannot guarantee POSIX signal cleanup; real acceptance is Linux-only.
    child.kill('SIGTERM');
    escalation = setTimeout(force, 30000);
  };
  // Reserve the final 30 seconds WITHIN the original 410-second outer limit.
  const deadline = setTimeout(interrupt, mode === '--run' ? 380000 : 15000);
  const hardDeadline = setTimeout(force, mode === '--run' ? 410000 : 45000);
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const clear = () => {
    clearTimeout(deadline); clearTimeout(hardDeadline); clearTimeout(escalation);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  };
  child.on('error', () => {
    console.error('Login network runner failed; details suppressed'); process.exitCode = 1;
    if (!child.pid) { exited = true; clear(); }
  });
  child.on('exit', (code, signal) => {
    exited = true; clear();
    process.exitCode = interrupted || signal ? 1 : code ?? 1;
  });
}
