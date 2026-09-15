import assert from 'node:assert/strict';
import test from 'node:test';
import { childEnvironment, optedIn, siblingUrl, validateMockOrigin, validateMysqlUrl } from './worker-common.js';

test('worker MySQL gate requires three explicit opt-ins without opening sockets', () => {
  assert.equal(optedIn({}), undefined);
  assert.equal(optedIn({ MYSQL_TEST_URL: 'not-a-url', MYSQL_POOL_TEST_DISPOSABLE: '1' }), undefined);
  assert.throws(() => optedIn({ MYSQL_POOL_PROCESS_TEST: '1' }));
  assert.throws(() => optedIn({ MYSQL_POOL_PROCESS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1' }));
  const marker = 'mysql://root:synthetic-only@127.0.0.1:3306/ghcp_pool_test_marker';
  assert.ok(optedIn({ MYSQL_POOL_PROCESS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1', MYSQL_TEST_URL: marker }));
  for (const bad of ['mysql://root@remote.example/ghcp_pool_test_a',
    'mysql://app@127.0.0.1/ghcp_pool_test_a', 'mysql://root@127.0.0.1/production',
    'mysql://root@127.0.0.1/ghcp_pool_test_a?ssl=false', 'mysql://root@127.0.0.1/ghcp_pool_test_a#x',
    'https://root@127.0.0.1/ghcp_pool_test_a', 'mysql://root@127.0.0.1/ghcp_pool_test_a/extra', 'invalid']) {
    assert.throws(() => validateMysqlUrl(bad));
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.ok(validateMysqlUrl(`mysql://root@${host}/ghcp_pool_test_marker`));
  }
});

test('random sibling and dynamic loopback origin are validated before child spawn', () => {
  const marker = validateMysqlUrl('mysql://root:synthetic-only@127.0.0.1/ghcp_pool_test_marker');
  const first = siblingUrl(marker), second = siblingUrl(marker);
  assert.notEqual(first.database, second.database);
  assert.match(first.database, /^ghcp_pool_test_[a-f0-9]{32}$/);
  assert.equal(marker.pathname, '/ghcp_pool_test_marker');
  assert.equal(first.url.pathname, `/${first.database}`);
  assert.equal(first.admin.pathname, '/');
  const mockOrigin = 'http://127.0.0.1:49152'; // Validation only; no socket binds in this test.
  assert.equal(validateMockOrigin(mockOrigin), mockOrigin);
  for (const bad of ['http://remote.example:49152', 'https://127.0.0.1:49152',
    'http://127.0.0.1:0', 'http://127.0.0.1:49152/path', 'http://user@127.0.0.1:49152']) {
    assert.throws(() => validateMockOrigin(bad));
  }
  assert.throws(() => childEnvironment(marker, first.database, true, mockOrigin));
  const env = childEnvironment(first.url, first.database, true, mockOrigin);
  for (const key of ['NODE_OPTIONS', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    assert.equal(env[key], undefined, `${key} must not be inherited`);
  }
  assert.equal(env.MYSQL_TEST_URL, first.url.toString());
  assert.equal(env.DOTENV_CONFIG_PATH, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(env.SSO_BASE_URL, mockOrigin);
  assert.equal(env.LOGIN_BASE_URL, mockOrigin);
  assert.equal(env.COPILOT_API_BASE_URL, mockOrigin);
  assert.equal(env.WORKER_HOLD_CHECKPOINT, '1');
});
