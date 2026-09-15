import assert from 'node:assert/strict';

export const tokenA = 'synthetic-process-routes-token-a';
export const tokenB = 'synthetic-process-routes-token-b';
export const apiKey = 'synthetic-process-routes-api-key';
export const internalKey = 'synthetic-process-internal';
export const caller = `sha256:${'a'.repeat(64)}`;
export const otherCaller = `sha256:${'b'.repeat(64)}`;
export const model = 'gpt-process-routes';
export const createdAt = '2026-01-01T00:00:00.000Z';
export const deadlineMs = 8000;

// Ordinary discovery without the dedicated opt-in skips. Once opted in, every
// missing/unsafe destructive-fixture input is a hard refusal, never an engine pass.
export function engineEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MYSQL_POOL_PROCESS_ROUTES_TEST === undefined) return false;
  mysqlGate(env);
  return true;
}

// Pure validation: no application imports, dotenv, child processes, or network.
export function mysqlGate(env: NodeJS.ProcessEnv): URL {
  assert.equal(env.MYSQL_POOL_PROCESS_ROUTES_TEST, '1', 'REFUSED: MYSQL_POOL_PROCESS_ROUTES_TEST=1 is required');
  assert.equal(env.MYSQL_POOL_TEST_DISPOSABLE, '1', 'REFUSED: MYSQL_POOL_TEST_DISPOSABLE=1 is required');
  assert.ok(env.MYSQL_TEST_URL, 'REFUSED: explicit MYSQL_TEST_URL is required');
  const url = new URL(env.MYSQL_TEST_URL);
  assert.equal(url.protocol, 'mysql:');
  assert.equal(url.username, 'root', 'Only literal root credentials are accepted');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'MySQL must be loopback');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search + url.hash, '', 'URL options and fragments are forbidden');
  return url;
}

export function loopbackOrigin(raw: string): string {
  const url = new URL(raw);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && Number(url.port) > 0);
  assert.equal(url.pathname, '/');
  assert.equal(url.username + url.password + url.search + url.hash, '');
  return url.origin;
}

export async function bounded<T>(promise: Promise<T>, label: string, ms = deadlineMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = performance.now() + deadlineMs;
  while (true) {
    const remaining = end - performance.now();
    assert.ok(remaining > 0, `Barrier: ${label}`);
    if (await bounded(Promise.resolve().then(check), label, remaining)) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, end - performance.now()))));
  }
}
