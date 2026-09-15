import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
// Register the live acceptance as an explicit skip in the sanitized offline run.
import './suspend-owner.test.js';
import { childEnvironment, siblingUrl, validateMysqlUrl } from './worker-common.js';
import { BASELINE, suspendEnvironment, suspendGate } from './suspend-common.js';

const marker = 'mysql://root:synthetic-only@127.0.0.1:3306/ghcp_pool_test_marker';
const env = { MYSQL_POOL_SUSPEND_TEST: '1', MYSQL_POOL_PROCESS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1', MYSQL_TEST_URL: marker };
test('suspend gate requires explicit Linux opt-ins; no socket or loader side effects', () => {
  assert.equal(suspendGate({}, 'linux'), undefined);
  assert.equal(suspendGate({ MYSQL_TEST_URL: marker }, 'linux'), undefined);
  assert.ok(suspendGate(env, 'linux'));
  for (const platform of ['win32', 'darwin', 'freebsd'] as const) assert.throws(() => suspendGate(env, platform));
  for (const key of ['MYSQL_POOL_PROCESS_TEST', 'MYSQL_POOL_TEST_DISPOSABLE', 'MYSQL_TEST_URL'] as const) {
    assert.throws(() => suspendGate({ ...env, [key]: undefined }, 'linux'));
  }
  for (const raw of ['mysql://root@remote.example/ghcp_pool_test_a', 'mysql://user@127.0.0.1/ghcp_pool_test_a',
    'mysql://root@127.0.0.1/production', 'mysql://root@127.0.0.1/ghcp_pool_test_a?ssl=false',
    'mysql://root@127.0.0.1/ghcp_pool_test_a#fragment', 'https://root@127.0.0.1/ghcp_pool_test_a', 'invalid']) {
    assert.throws(() => suspendGate({ ...env, MYSQL_TEST_URL: raw }, 'linux'));
  }
});
test('suspend uses existing isolation and random fixed-prefix sibling validation unchanged', () => {
  const selected = validateMysqlUrl(marker);
  const first = siblingUrl(selected), second = siblingUrl(selected);
  assert.notEqual(first.database, second.database); assert.match(first.database, /^ghcp_pool_test_[a-f0-9]{32}$/);
  assert.equal(first.admin.pathname, '/'); assert.equal(selected.pathname, '/ghcp_pool_test_marker');
  const origin = 'http://127.0.0.1:49152';
  const child = suspendEnvironment(first.url, first.database, origin, 'old');
  for (const key of ['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'MYSQL_URL_REAL', 'GH_TOKEN', 'GITHUB_TOKEN', 'API_KEY']) assert.equal(child[key], undefined);
  assert.deepEqual(child, { ...childEnvironment(first.url, first.database, false, origin), MYSQL_POOL_SUSPEND_TEST: '1', SUSPEND_ROLE: 'old' });
  assert.throws(() => suspendEnvironment(selected, first.database, origin, 'old'));
});
test('launcher refuses before baseline/loader/network and never prints URL credentials', () => {
  const launcher = fileURLToPath(new URL('./suspend-run.mjs', import.meta.url));
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  for (const addition of [{}, { ...env, MYSQL_TEST_URL: 'mysql://root:DO_NOT_PRINT_SYNTHETIC@remote.example/ghcp_pool_test_a' }]) {
    const result = spawnSync(process.execPath, [launcher, '--run'], { env: { ...clean, ...addition }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.signal, null);
    assert.match(result.stderr, /REFUSED:/); assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_SYNTHETIC|SOURCE BASELINE|TAP version/);
  }
});
test('baseline attests v5 and frozen-v4 worker launcher is byte-for-byte unchanged', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), BASELINE);
  execFileSync('git', ['diff', '--exit-code', BASELINE, '--', 'tests/user-pool-process/worker-run.mjs'], { cwd: root, stdio: 'ignore' });
});
