import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolConfig } from '../../src/proxy/src/userPool/config.js';

export const FROZEN_COMMIT = '2bc12b363e62923ca6c1db0185e42f9ed5c78bf9';
export const INTERNAL_TOKEN = 'worker-process-synthetic-internal';
export const OAUTH_TOKEN = 'worker-process-synthetic-oauth';
export const PASSWORD = 'worker-process-synthetic-password';
export const CREATED_AT = '2026-01-01T00:00:00.000Z';
export const options: PoolConfig = {
  enabled: true, accountDomain: 'worker.synthetic.test', idleTarget: 1, maxAccounts: 1,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 250, prewarmConcurrency: 1,
  loginMaxPending: 1, retryAfterSeconds: 1, warmupModel: 'worker-synthetic-model', requestTimeoutMs: 15000,
};

/** Only an explicit root/loopback disposable marker is accepted. Never print the URL. */
export function validateMysqlUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid worker MySQL test URL'); }
  assert.equal(url.protocol, 'mysql:', 'MySQL scheme required');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Loopback MySQL only');
  assert.equal(url.username, 'root', 'Disposable MySQL root account required');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'Disposable database marker required');
  assert.equal(url.search, '', 'URL options are forbidden');
  assert.equal(url.hash, '', 'URL fragments are forbidden');
  return url;
}

export function optedIn(env: NodeJS.ProcessEnv): URL | undefined {
  if (env.MYSQL_POOL_PROCESS_TEST !== '1') return undefined;
  assert.equal(env.MYSQL_POOL_TEST_DISPOSABLE, '1', 'MYSQL_POOL_TEST_DISPOSABLE=1 required');
  assert.ok(env.MYSQL_TEST_URL, 'MYSQL_TEST_URL required');
  return validateMysqlUrl(env.MYSQL_TEST_URL);
}

export function siblingUrl(marker: URL): { database: string; url: URL; admin: URL } {
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(marker);
  url.pathname = `/${database}`;
  const admin = new URL(marker);
  admin.pathname = '/';
  return { database, url, admin };
}

/** Origins are assigned by listen(0), never inherited from the invoking shell. */
export function validateMockOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid worker mock origin'); }
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0 && Number(url.port) <= 65535);
  assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.equal(url.pathname, '/');
  assert.equal(raw, url.origin, 'Origin only, with explicit dynamically allocated port');
  return url.origin;
}

/** No environment files, inherited provider credentials, NODE_OPTIONS or network proxies. */
export function childEnvironment(url: URL, database: string, holdCheckpoint: boolean, mockOrigin: string): NodeJS.ProcessEnv {
  validateMysqlUrl(url.toString());
  assert.match(database, /^ghcp_pool_test_[a-f0-9]{32}$/);
  assert.equal(url.pathname, `/${database}`);
  validateMockOrigin(mockOrigin);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, MYSQL_POOL_PROCESS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
    MYSQL_TEST_URL: url.toString(), WORKER_TEST_DATABASE: database,
    WORKER_HOLD_CHECKPOINT: holdCheckpoint ? '1' : '0', WORKER_MOCK_ORIGIN: mockOrigin,
    DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null',
    DOTENV_CONFIG_QUIET: 'true', STORAGE_DRIVER: 'mysql', MYSQL_URL: url.toString(),
    MYSQL_SSL_MODE: 'disabled', INTERNAL_API_TOKEN: INTERNAL_TOKEN,
    SSO_BASE_URL: mockOrigin, LOGIN_BASE_URL: mockOrigin, COPILOT_API_BASE_URL: mockOrigin,
    PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', NODE_ENV: 'test' };
}

export interface WorkerMessage {
  kind: 'boot' | 'claim' | 'standby' | 'started' | 'checkpoint-held' | 'observation-finished' | 'status' | 'stopped' | 'fatal';
  pid: number;
  owner?: string;
  dbNow?: number;
  active?: boolean;
  identity?: string;
  nonce?: string | null;
  taskId?: string | null;
  attempt?: string;
  generation?: number;
}
