// v5-only entry point; the existing frozen-v4 worker-run.mjs stays untouched.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = '356f8f5e33a21ccfe7cf8c5db07060ab1ac47846';
const mode = process.argv[2];
function gate() {
  assert.equal(process.env.MYSQL_POOL_SUSPEND_TEST, '1', 'MYSQL_POOL_SUSPEND_TEST=1 required');
  assert.equal(process.platform, 'linux', 'Linux SIGSTOP/SIGCONT required; Windows unsupported');
  assert.equal(process.env.MYSQL_POOL_PROCESS_TEST, '1', 'MYSQL_POOL_PROCESS_TEST=1 required');
  assert.equal(process.env.MYSQL_POOL_TEST_DISPOSABLE, '1', 'MYSQL_POOL_TEST_DISPOSABLE=1 required');
  assert.ok(process.env.MYSQL_TEST_URL, 'MYSQL_TEST_URL required');
  let url;
  try { url = new URL(process.env.MYSQL_TEST_URL); } catch { throw new Error('Invalid suspend test URL'); }
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Loopback only');
  assert.equal(url.username, 'root');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search, ''); assert.equal(url.hash, '');
}
try {
  assert.ok(process.argv.length === 3 && ['--gate-check', '--typecheck', '--run'].includes(mode),
    'Usage: node tests/user-pool-process/suspend-run.mjs --gate-check|--typecheck|--run');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22+ required');
  if (mode === '--run') gate(); // BEFORE git, loaders, imports, binds or connections.
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), baseline,
    'Suspend harness requires exact v5 HEAD 356f8f5');
  execFileSync('git', ['diff', '--exit-code', baseline, '--', 'src/proxy', 'src/packages/shared',
    'tests/user-pool-process/worker-common.ts', 'tests/user-pool-process/worker-mock.ts', 'tsconfig.base.json'],
  { cwd: root, stdio: 'ignore' });
  console.log(`SOURCE BASELINE ${baseline}; production + reused helpers unchanged`);
  if (mode === '--typecheck') {
    const require = createRequire(import.meta.url);
    const ts = require('typescript');
    const config = ts.readConfigFile(fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)), ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { noEmit: true });
    const files = readdirSync(directory).filter(file => /^suspend-.*\.ts$/.test(file)).map(file => `${directory}/${file}`);
    files.push(fileURLToPath(new URL('../../src/proxy/src/auth/apiKey.ts', import.meta.url)));
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(files, parsed.options))];
    if (diagnostics.length) {
      process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
      }));
      process.exitCode = 1;
    } else console.log('PASS: suspend TypeScript noEmit (not POSIX/MySQL acceptance)');
  } else {
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null', DOTENV_CONFIG_QUIET: 'true',
      SSO_BASE_URL: 'http://127.0.0.1:0', LOGIN_BASE_URL: 'http://127.0.0.1:0', COPILOT_API_BASE_URL: 'http://127.0.0.1:0',
      INTERNAL_API_TOKEN: 'worker-process-synthetic-internal', PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', NODE_ENV: 'test' });
    if (mode === '--run') for (const key of ['MYSQL_POOL_SUSPEND_TEST', 'MYSQL_POOL_PROCESS_TEST', 'MYSQL_POOL_TEST_DISPOSABLE', 'MYSQL_TEST_URL']) env[key] = process.env[key];
    // Run node:test files directly so this ChildProcess IS the fixture parent.
    // A nested `node --test` coordinator could swallow SIGTERM before cleanup.
    const file = mode === '--run' ? 'suspend-owner.test.ts' : 'suspend-gate.test.ts';
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      cwd: directory, env, shell: false, stdio: 'inherit',
    });
    let escalation;
    const interrupt = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM'); // Parent fixture continues suspended children BEFORE termination.
      escalation ??= setTimeout(() => child.kill('SIGKILL'), 30000);
    };
    const watchdog = setTimeout(interrupt, 160000);
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    const done = () => {
      clearTimeout(watchdog); clearTimeout(escalation);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    };
    child.on('error', () => { done(); console.error('Suspend runner could not start'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { done(); process.exitCode = signal ? 1 : code ?? 1; });
  }
} catch {
  // Assertion errors can include the invalid URL. Deliberately print no error object.
  console.error('REFUSED: suspend runner requires exact v5 source, Node 22+, valid mode; --run additionally requires Linux and all disposable loopback opt-ins.');
  process.exitCode = 1;
}
