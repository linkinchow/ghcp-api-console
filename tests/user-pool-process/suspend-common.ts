import assert from 'node:assert/strict';
import { childEnvironment, optedIn } from './worker-common.js';
import type { PrewarmWorkerSnapshot } from '../../src/proxy/src/userPool/worker.js';

export const BASELINE = '356f8f5e33a21ccfe7cf8c5db07060ab1ac47846';
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function suspendGate(env: NodeJS.ProcessEnv, platform = process.platform): URL | undefined {
  if (env.MYSQL_POOL_SUSPEND_TEST !== '1') return undefined;
  assert.equal(platform, 'linux', 'Linux SIGSTOP/SIGCONT acceptance only; never emulate on Windows');
  const url = optedIn(env);
  assert.ok(url, 'MYSQL_POOL_PROCESS_TEST=1 required');
  return url;
}
export function suspendEnvironment(url: URL, database: string, origin: string, role: 'old' | 'successor'): NodeJS.ProcessEnv {
  return { ...childEnvironment(url, database, false, origin), MYSQL_POOL_SUSPEND_TEST: '1', SUSPEND_ROLE: role };
}
export async function bounded<T>(label: string, operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
export async function pollUntil<T>(label: string, predicate: () => Promise<T | undefined | false> | T | undefined | false,
  signal: AbortSignal, timeout = 12000): Promise<T> {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    signal.throwIfAborted();
    const value = await predicate();
    signal.throwIfAborted();
    if (value !== undefined && value !== false) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
export interface SuspendMessage {
  kind: 'boot' | 'claim' | 'standby' | 'checkpoint-held' | 'checkpoint-result' | 'resumed' | 'local-fenced' | 'callback' | 'status' | 'stopped' | 'fatal';
  pid: number;
  owner?: string;
  dbNow?: number;
  identity?: string;
  nonce?: string | null;
  taskId?: string | null;
  attempt?: string;
  generation?: number;
  accepted?: boolean;
  sameFence?: boolean;
  unchanged?: boolean;
  active?: boolean;
  snapshot?: PrewarmWorkerSnapshot;
  steps?: number;
  httpCalls?: number;
  updates?: number;
}
