import assert from 'node:assert/strict';

export const baseline = '356f8f5e33a21ccfe7cf8c5db07060ab1ac47846';
export const apiKey = 'synthetic-replicas-api-key';
export const internalKey = 'synthetic-replicas-internal';
export const model = 'gpt-replicas-synthetic';
export const domain = 'replicas.synthetic.test';
export const createdAt = '2026-01-01T00:00:00.000Z';
export const password = 'synthetic-replicas-password';
export const token = (identity: string) => `synthetic-replicas-token-${identity}`;
export const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
export const osKeys = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path'];
export function gate(env: NodeJS.ProcessEnv): URL {
  assert.equal(env.MYSQL_POOL_REPLICAS_TEST, '1', 'REFUSED: MYSQL_POOL_REPLICAS_TEST=1 required');
  assert.equal(env.MYSQL_POOL_TEST_DISPOSABLE, '1', 'REFUSED: MYSQL_POOL_TEST_DISPOSABLE=1 required');
  assert.ok(env.MYSQL_TEST_URL, 'REFUSED: MYSQL_TEST_URL required');
  let url: URL;
  try { url = new URL(env.MYSQL_TEST_URL); } catch { throw new Error('REFUSED: invalid MySQL URL'); }
  assert.equal(url.protocol, 'mysql:', 'REFUSED: MySQL scheme');
  assert.equal(url.username, 'root', 'REFUSED: literal root account required');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'REFUSED: loopback MySQL only');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'REFUSED: disposable database marker');
  assert.equal(url.search + url.hash, '', 'REFUSED: URL options forbidden');
  return url;
}
export function enabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MYSQL_POOL_REPLICAS_TEST === undefined) return false;
  gate(env); return true;
}
export function origin(raw: string): string {
  const url = new URL(raw);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0); assert.equal(url.pathname, '/');
  assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.equal(raw, url.origin); return url.origin;
}
export function replicaCount(raw: string): 3 | 5 {
  assert.ok(raw === '3' || raw === '5', 'REFUSED: only 3 or 5 replicas');
  return Number(raw) as 3 | 5;
}
export async function bounded<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function until(check: () => Promise<boolean>, label: string, ms = 30000, signal?: AbortSignal): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    signal?.throwIfAborted();
    if (await bounded(check(), label, Math.max(1, end - performance.now()))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Barrier: ${label}`);
}
