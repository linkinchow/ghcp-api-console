import assert from 'node:assert/strict';
import { readPoolConfig } from '../../src/proxy/src/userPool/config.js';
import { childEnvironment, validateMysqlUrl, validateMockOrigin } from './worker-common.js';
export { CREATED_AT, INTERNAL_TOKEN, OAUTH_TOKEN, PASSWORD, siblingUrl, validateMockOrigin } from './worker-common.js';

export const SUITE_MS = 360000;
export const CLEANUP_MS = 30000;
export const CHILD_MS = SUITE_MS + CLEANUP_MS + 10000;
// Read the real production default, never a fixture-shortened HTTP timeout.
export const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'worker.synthetic.test', POOL_WARMUP_MODEL: 'worker-synthetic-model',
  READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '2', PREWARM_CONCURRENCY: '1',
  POOL_LOGIN_MAX_PENDING: '1', PREWARM_POLL_SECONDS: '1' });
assert.equal(options.requestTimeoutMs, 120000, 'Review runtime budget if the production default changes');

export function gate(env: NodeJS.ProcessEnv): URL {
  assert.equal(env.MYSQL_POOL_LOGIN_NETWORK_TEST, '1', 'REFUSED: MYSQL_POOL_LOGIN_NETWORK_TEST=1 required');
  assert.equal(env.MYSQL_POOL_TEST_DISPOSABLE, '1', 'REFUSED: MYSQL_POOL_TEST_DISPOSABLE=1 required');
  assert.ok(env.MYSQL_TEST_URL, 'REFUSED: MYSQL_TEST_URL required');
  return validateMysqlUrl(env.MYSQL_TEST_URL);
}
export function enabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MYSQL_POOL_LOGIN_NETWORK_TEST === undefined) return false;
  gate(env); return true;
}
export function childEnv(url: URL, database: string, upstream: string, login: string): NodeJS.ProcessEnv {
  validateMockOrigin(login);
  return { ...childEnvironment(url, database, false, upstream), MYSQL_POOL_LOGIN_NETWORK_TEST: '1',
    LOGIN_BASE_URL: login, LOGIN_NETWORK_UPSTREAM: upstream };
}
export function childGate(): URL {
  const url = gate(process.env);
  assert.equal(process.argv.length, 2, 'No child arguments');
  assert.ok(process.send, 'IPC parent required');
  assert.match(process.env.WORKER_TEST_DATABASE ?? '', /^ghcp_pool_test_[a-f0-9]{32}$/);
  assert.equal(url.pathname, `/${process.env.WORKER_TEST_DATABASE}`);
  assert.equal(process.env.DOTENV_CONFIG_PATH, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(process.env.NODE_OPTIONS, undefined);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'DOTENV_CONFIG_OVERRIDE']) assert.equal(process.env[key], undefined);
  assert.equal(process.env.POOL_REQUEST_TIMEOUT_SECONDS, undefined, 'No HTTP timeout override');
  return url;
}
export interface Task {
  id: string; identity: string; ssoUser: string; ghLogin: string; oauthAttemptId: string;
  ssoType: 'custom'; status: 'running' | 'success'; createdAt: string;
}
export interface Proof {
  kind: string; pid: number; id?: string; task?: Task; tasks?: Task[]; origin?: string;
  method?: string; path?: string; at?: number; elapsedMs?: number; headersSent?: boolean;
  identity?: string; generation?: number; reason?: string; snapshot?: Record<string, unknown>;
}
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function bounded<T>(operation: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function until<T>(check: () => T | false | undefined | Promise<T | false | undefined>,
  label: string, signal: AbortSignal, ms = 12000, intervalMs = 100): Promise<T> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    signal.throwIfAborted();
    const value = await bounded(Promise.resolve().then(check), label, Math.max(1, Math.min(10000, end - performance.now())));
    signal.throwIfAborted();
    if (value !== false && value !== undefined) return value;
    await pause(intervalMs);
  }
  throw new Error(`Barrier: ${label}`);
}
