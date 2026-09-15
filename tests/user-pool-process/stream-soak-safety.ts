import assert from 'node:assert/strict';
import { gate as replicaGate, replicaCount } from './replicas-safety.js';

export const cleanupSeconds = 45;
export const maxDurationSeconds = 1800;
export interface Options { duration: number; stream: number; concurrency: number; replicas: 3 | 5; checkpoint: number; report?: string; }
export function integer(raw: string, min: number, max: number, name: string): number {
  assert.match(raw, /^[1-9][0-9]*$/, `REFUSED: invalid ${name}`);
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `REFUSED: ${name} range ${min}..${max}`);
  return value;
}
// Pure validation: run before git, file writes, sockets, timers, imports of product or forks.
export function options(args: string[]): Options {
  const supplied = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    assert.ok(['--duration-seconds', '--stream-seconds', '--concurrency', '--replicas', '--checkpoint-seconds', '--report'].includes(key), 'REFUSED: unknown option');
    assert.ok(!supplied.has(key) && args[i + 1] && !args[i + 1].startsWith('--'), 'REFUSED: duplicate/missing option');
    supplied.set(key, args[i + 1]);
  }
  const duration = integer(supplied.get('--duration-seconds') ?? '60', 60, maxDurationSeconds, 'duration');
  const stream = integer(supplied.get('--stream-seconds') ?? '30', 10, 60, 'stream');
  assert.ok(duration >= stream + 25, 'REFUSED: duration must include stream plus 25 seconds of setup/drain');
  const replicas = replicaCount(supplied.get('--replicas') ?? '3');
  const concurrency = integer(supplied.get('--concurrency') ?? '3', 2, 5, 'concurrency');
  assert.ok(concurrency <= replicas, 'REFUSED: concurrency cannot exceed replica count');
  const checkpoint = integer(supplied.get('--checkpoint-seconds') ?? '10', 5, 60, 'checkpoint');
  const report = supplied.get('--report');
  if (report) assert.ok(report.endsWith('.json') && report.length < 1024 && !report.includes('\0'), 'REFUSED: report must be a JSON path');
  return { duration, stream, concurrency, replicas, checkpoint, report };
}
export function gate(env: NodeJS.ProcessEnv): URL {
  assert.equal(env.MYSQL_POOL_STREAM_SOAK_TEST, '1', 'REFUSED: MYSQL_POOL_STREAM_SOAK_TEST=1 required');
  return replicaGate({ ...env, MYSQL_POOL_REPLICAS_TEST: '1' });
}
export function enabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MYSQL_POOL_STREAM_SOAK_TEST === undefined) return false;
  gate(env); return true;
}
export class Ring<T> {
  private values: T[] = [];
  constructor(readonly cap: number) { assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 120); }
  add(value: T): void { if (this.values.length === this.cap) this.values.shift(); this.values.push(value); }
  snapshot(): T[] { return [...this.values]; }
}
export function frame(value: Record<string, unknown>): string {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}
// Client stores at most one small partial event, never a stream or request history.
export class SseReader {
  private buffer = '';
  private decoder = new TextDecoder();
  bytes = 0; deltas = 0; terminal = false; starts = 0;
  add(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength; assert.ok(this.bytes <= 256 * 1024, 'Stream byte ceiling');
    this.buffer += this.decoder.decode(chunk, { stream: true });
    assert.ok(this.buffer.length <= 8192, 'SSE pending event ceiling');
    for (;;) {
      const end = this.buffer.indexOf('\n\n'); if (end < 0) break;
      const event = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      const text = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!text) continue;
      const value = JSON.parse(text); assert.ok(!value.error && value.type !== 'error', 'Unexpected SSE error');
      if (value.type === 'message_start') this.starts++;
      if (value.type === 'content_block_delta') this.deltas++;
      if (value.type === 'message_stop') { assert.equal(this.terminal, false); this.terminal = true; }
    }
  }
  finish(): void { assert.equal(this.buffer + this.decoder.decode(), ''); assert.equal(this.starts, 1); assert.ok(this.deltas >= 1); assert.equal(this.terminal, true); }
}
