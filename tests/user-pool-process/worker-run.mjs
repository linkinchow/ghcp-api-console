// Single entry point. No credentials in argv, no dotenv imports, no build/package edits.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const frozen = '2bc12b363e62923ca6c1db0185e42f9ed5c78bf9';
const modes = new Set(['--gate-check', '--typecheck', '--run']);
assert.ok(process.argv.length === 3 && modes.has(process.argv[2]),
  'Usage: node tests/user-pool-process/worker-run.mjs --gate-check|--typecheck|--run (no other arguments)');
const mode = process.argv[2];
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), frozen,
  'Harness is prepared only for its frozen commit');
execFileSync('git', ['diff', '--exit-code', frozen, '--', 'src/proxy', 'src/packages/shared'],
  { cwd: root, stdio: 'ignore' });
const require = createRequire(import.meta.url);
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22+ required');
if (mode === '--run') {
  // Dependency-free duplicate of worker-common's gate: reject BEFORE any loader,
  // test/worker spawn, production import, HTTP bind or database connection.
  assert.equal(process.env.MYSQL_POOL_PROCESS_TEST, '1', 'MYSQL_POOL_PROCESS_TEST=1 required');
  assert.equal(process.env.MYSQL_POOL_TEST_DISPOSABLE, '1', 'MYSQL_POOL_TEST_DISPOSABLE=1 required');
  assert.ok(process.env.MYSQL_TEST_URL, 'MYSQL_TEST_URL required');
  let url;
  try { url = new URL(process.env.MYSQL_TEST_URL); } catch { throw new Error('Invalid worker MySQL test URL'); }
  assert.equal(url.protocol, 'mysql:', 'MySQL scheme required');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Loopback MySQL only');
  assert.equal(url.username, 'root', 'Disposable MySQL root account required');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'Disposable database marker required');
  assert.equal(url.search, '', 'URL options are forbidden');
  assert.equal(url.hash, '', 'URL fragments are forbidden');
}
if (mode === '--typecheck') {
  const ts = require('typescript');
  const config = ts.readConfigFile(fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { noEmit: true });
  const files = readdirSync(directory).filter(file => /^worker.*\.ts$/.test(file)).map(file => `${directory}/${file}`);
  // Include the existing Express augmentation normally pulled in by the proxy project.
  files.push(fileURLToPath(new URL('../../src/proxy/src/auth/apiKey.ts', import.meta.url)));
  const program = ts.createProgram(files, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }));
    process.exitCode = 1;
  } else console.log('PASS: worker fixture TypeScript noEmit check (not process/MySQL acceptance)');
} else {
  const childEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  Object.assign(childEnv, {
    DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null', DOTENV_CONFIG_QUIET: 'true',
    // Parent never uses provider HTTP; worker origins are assigned by mock listen(0).
    SSO_BASE_URL: 'http://127.0.0.1:0', LOGIN_BASE_URL: 'http://127.0.0.1:0',
    COPILOT_API_BASE_URL: 'http://127.0.0.1:0', INTERNAL_API_TOKEN: 'worker-process-synthetic-internal',
    PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', NODE_ENV: 'test',
  });
  if (mode === '--run') {
    for (const key of ['MYSQL_POOL_PROCESS_TEST', 'MYSQL_POOL_TEST_DISPOSABLE', 'MYSQL_TEST_URL']) childEnv[key] = process.env[key];
  }
  const files = mode === '--gate-check' ? ['worker-gate.test.ts', 'worker-owner.test.ts'] : ['worker-owner.test.ts'];
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
    cwd: directory, env: childEnv, stdio: 'inherit', shell: false, timeout: 300000, killSignal: 'SIGKILL',
  });
  const interrupt = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  child.on('error', () => { console.error('Worker test runner could not start'); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    process.exitCode = signal ? 1 : code ?? 1;
  });
}
