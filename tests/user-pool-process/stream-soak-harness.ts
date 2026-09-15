import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { apiKey, baseline, bounded, caller, model, origin, osKeys } from './replicas-safety.js';
import { cleanupSeconds, gate, options, Ring, SseReader, type Options } from './stream-soak-safety.js';
import { streamMock } from './stream-soak-mock.js';

type AbortSource = 'child-log' | 'child-log-budget' | 'child-error' | 'child-exit' | 'sampler' | 'deadline' | 'external' | 'workload' | 'cleanup';
const abortSources: AbortSource[] = ['child-log', 'child-log-budget', 'child-error', 'child-exit', 'sampler', 'deadline', 'external', 'workload', 'cleanup'];
const safeEvents = new Set(['upstream-stream-failed', 'upstream-fetch-failed', 'upstream-http-error', 'diagnostic-persistence-failed',
  'write-failed', 'request-finish-failed', 'wake-failed', 'reconcile-failed', 'ownership-lost', 'refresh-failed-stale', 'identity-init', 'identity-init-release']);
interface AbortEvidence { source: AbortSource; elapsedMs: number; pid?: number; level?: 'ERROR' | 'WARN'; event?: string; location?: string; }
// Never retain raw messages/fields. First cause is immutable even when cancellation
// cascades through delay, sampler, clients and teardown. Rings contain <=16 entries.
export class FirstAbortTrace {
  private readonly ring = new Ring<AbortEvidence>(16);
  private first?: AbortEvidence;
  record(source: AbortSource, details: { pid?: number; level?: string; event?: string; error?: unknown; elapsedMs?: number } = {}) {
    assert.ok(abortSources.includes(source));
    const evidence: AbortEvidence = { source, elapsedMs: Math.max(0, Math.round(details.elapsedMs ?? 0)) };
    if (Number.isSafeInteger(details.pid) && details.pid! > 0) evidence.pid = details.pid;
    if (details.level === 'ERROR' || details.level === 'WARN') evidence.level = details.level;
    if (details.event !== undefined) evidence.event = safeEvents.has(details.event) ? details.event : 'unrecognized-event';
    if (details.error instanceof Error) evidence.location = /stream-soak-[\w.-]+:\d+:\d+/.exec(details.error.stack ?? '')?.[0] ?? 'fixture';
    this.first ??= evidence; this.ring.add(evidence);
    return evidence;
  }
  snapshot() { return { first: this.first ? { ...this.first } : undefined, recent: this.ring.snapshot() }; }
}
export function logTokens(text: string): Array<{ level: 'ERROR' | 'WARN'; event: string }> {
  const tokens: Array<{ level: 'ERROR' | 'WARN'; event: string }> = [];
  for (const match of text.matchAll(/\] (ERROR|WARN) (?:([a-z][a-z0-9-]{0,63}):)?/g)) {
    tokens.push({ level: match[1] as 'ERROR' | 'WARN', event: safeEvents.has(match[2]) ? match[2] : 'unrecognized-event' });
    if (tokens.length === 16) break;
  }
  return tokens;
}
interface CancelMetadata { pid: number; requestId: string; armed: boolean; upstreamAborted: boolean; downstreamClosed: boolean; }
export class ExpectedCancelLogs {
  private active = new Map<string, { pid: number; abortIssued: boolean; metadata: boolean; paired: boolean }>();
  private wires = new Map<number, number>();
  count = 0;
  arm(pid: number, requestId: string) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.match(requestId, /^stream-soak-[0-4]-[1-9][0-9]*-cancel$/);
    assert.ok(this.active.size < 5 && !this.active.has(requestId), 'Bounded unique cancel intent');
    this.active.set(requestId, { pid, abortIssued: false, metadata: false, paired: false });
  }
  beginAbort(pid: number, requestId: string) {
    const entry = this.active.get(requestId); assert.ok(entry && entry.pid === pid && !entry.abortIssued); entry.abortIssued = true;
  }
  metadata(value: CancelMetadata) {
    const entry = this.active.get(value.requestId); assert.ok(entry, 'Unregistered cancellation event');
    assert.equal(entry.pid, value.pid); assert.equal(entry.abortIssued, true, 'Parent has not issued cancellation'); assert.equal(value.armed, true); assert.equal(value.upstreamAborted, true); assert.equal(value.downstreamClosed, true);
    assert.equal(entry.metadata, false, 'Duplicate expected cancel event'); entry.metadata = true; this.pair(value.pid);
  }
  wire(pid: number) {
    const count = (this.wires.get(pid) ?? 0) + 1; assert.ok(count <= 5, 'Bounded unpaired stream log'); this.wires.set(pid, count); this.pair(pid);
  }
  private pair(pid: number) {
    const entry = [...this.active.values()].find(value => value.pid === pid && value.metadata && !value.paired);
    if (entry && (this.wires.get(pid) ?? 0) > 0) { entry.paired = true; this.wires.set(pid, this.wires.get(pid)! - 1); }
  }
  matched(pid: number, requestId: string) { const entry = this.active.get(requestId); return entry?.pid === pid && entry.metadata && entry.paired; }
  finish(pid: number, requestId: string) { assert.equal(this.matched(pid, requestId), true); this.active.delete(requestId); this.count++; }
  unpaired(pid: number) { return this.wires.get(pid) ?? 0; }
  assertDrained() { assert.equal(this.active.size, 0); assert.ok([...this.wires.values()].every(value => value === 0), 'Unpaired stream log'); }
}
interface Replica { child: ChildProcess; pid: number; instance: string; proxy: string; control: string; logBytes: number; }
interface ChildState {
  pid: number; instance: string; owner?: string; acquisitions: number; unexpected: number;
  memory: { rss: number; heapUsed: number; external: number }; cpu: { user: number; system: number };
  resource: Record<string, number>; connections: number[]; pool: { total: number; free: number; queue: number };
  scheduler: { state: string; scope: string };
}
interface Lease extends RowDataPacket { lease_id: string; member_identity: string; expires_at: number; last_success_at: number | null; phase: string; }
export interface Report {
  schema: 1; scope: string; baseline: string; status: 'running' | 'passed' | 'failed'; stage: string; config: Options;
  parentPid: number; database?: string; startedAt: string; elapsedSeconds: number;
  counts: { sent: number; full: number; canceled: number; recovered: number; unexpected: number; samples: number; cycles: number; bytes: number; };
  limits: Record<string, number>; peaks: Record<string, number>; recent: unknown[]; first?: unknown; last?: unknown;
  processes: Array<{ pid: number; instance: string; proxy: string; control: string; logBytes: number; exitCode: number | null; signal: NodeJS.Signals | null }>;
  expectedCancelEvents?: number; mock?: unknown; abortTrace?: ReturnType<FirstAbortTrace['snapshot']>; failure?: { name: string; location: string; source?: AbortSource; pid?: number; event?: string }; cleanup: { childrenDead: boolean; databaseDropped: boolean; complete: boolean };
}
export async function runSoak(config: Options, checkpoint: (report: Report) => Promise<void> = async () => {}, external?: AbortSignal): Promise<Report> {
  const supplied = gate(process.env);
  // Validate programmatic callers as strictly as the CLI, before timers/imports/sockets.
  options(['--duration-seconds', String(config.duration), '--stream-seconds', String(config.stream), '--replicas', String(config.replicas),
    '--concurrency', String(config.concurrency), '--checkpoint-seconds', String(config.checkpoint)]);
  const started = performance.now(); const end = started + config.duration * 1000;
  const abort = new AbortController(); const signal = external ? AbortSignal.any([abort.signal, external]) : abort.signal;
  const trace = new FirstAbortTrace(); const expectedCancel = new ExpectedCancelLogs();
  function stop(source: AbortSource, details: Parameters<FirstAbortTrace['record']>[1] = {}) {
    const evidence = trace.record(source, { ...details, elapsedMs: performance.now() - started });
    abort.abort(new Error(`Soak stop: ${evidence.source}`));
  }
  const externalAbort = () => stop('external');
  if (external?.aborted) externalAbort(); else external?.addEventListener('abort', externalAbort, { once: true });
  const timer = setTimeout(() => stop('deadline'), config.duration * 1000);
  const replicas: Replica[] = []; const children: ChildProcess[] = []; const pending = new Set<Promise<unknown>>();
  const recent = new Ring<unknown>(120); const key = randomBytes(32).toString('hex');
  const sequences = Array(config.concurrency).fill(0) as number[];
  let admin: Connection | undefined; let mock: Awaited<ReturnType<typeof streamMock>> | undefined;
  let created = false; let closing = false; let failed = false; let sampling = true; let sampler: Promise<void> | undefined;
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  const db = new URL(supplied); db.pathname = `/${database}`;
  const adminUrl = new URL(supplied); adminUrl.pathname = '/';
  const report: Report = { schema: 1, scope: 'Synthetic loopback SSE resource correctness; real customer longstream capacity UNMEASURED', baseline,
    status: 'running', stage: 'setup', config, parentPid: process.pid, startedAt: new Date().toISOString(), elapsedSeconds: 0,
    counts: { sent: 0, full: 0, canceled: 0, recovered: 0, unexpected: 0, samples: 0, cycles: 0, bytes: 0 },
    limits: { durationSeconds: config.duration, cleanupSeconds, clientConcurrency: config.concurrency, queuedClients: 0,
      mysqlConnections: 4 * config.replicas + 1, childPoolQueue: 8, retainedSamples: 120, retainedLogScanBytes: 4096, retainedAbortEvents: 16, childLogByteCeiling: 2 * 1024 * 1024 },
    peaks: {}, recent: [], processes: [], cleanup: { childrenDead: false, databaseDropped: false, complete: false } };
  function live() { assert.equal(closing, false); signal.throwIfAborted(); }
  function track<T>(promise: Promise<T>): Promise<T> { pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; }
  function peak(key: string, value: number) { report.peaks[key] = Math.max(report.peaks[key] ?? 0, value); }
  async function delay(ms: number) {
    live(); await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(wait); signal.removeEventListener('abort', cancel); reject(new Error('Soak aborted')); };
      const wait = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async function until(check: () => Promise<boolean>, label: string, ms = 6000) {
    const deadline = Math.min(end, performance.now() + ms);
    while (performance.now() < deadline) { live(); if (await check()) return; await delay(100); }
    throw new Error(`Barrier ${label}`);
  }
  async function sql<T extends RowDataPacket = RowDataPacket>(query: string, values: unknown[] = []): Promise<T[]> {
    live(); const [rows] = await admin!.query<T[]>({ sql: query, values, timeout: 3000 }); return rows;
  }
  async function control<T = Record<string, unknown>>(replica: Replica, command: string, body?: unknown): Promise<T> {
    live(); return track((async () => {
      const response = await fetch(`${replica.control}/${command}`, { method: command === 'state' ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
      const text = await response.text(); assert.ok(text.length < 16384); assert.equal(response.status, 200, 'Control response'); return JSON.parse(text) as T;
    })());
  }
  async function lease(lane: number): Promise<Lease> {
    const rows = await sql<Lease>(`SELECT lease_id,member_identity,expires_at,last_success_at,phase FROM \`${database}\`.user_pool_leases WHERE caller_id=?`, [caller(lane + 1)]);
    assert.equal(rows.length, 1); return rows[0];
  }
  async function holds(lane?: number): Promise<number> {
    const inference = lane === undefined ? `\`${database}\`.user_pool_holds` :
      `\`${database}\`.user_pool_holds h JOIN \`${database}\`.user_pool_leases l ON l.lease_id=h.lease_id WHERE l.caller_id=?`;
    const catalog = `\`${database}\`.user_pool_catalog_holds${lane === undefined ? '' : ' WHERE caller_id=?'}`;
    const [row] = await sql(`SELECT (SELECT COUNT(*) FROM ${inference}) + (SELECT COUNT(*) FROM ${catalog}) AS count`,
      lane === undefined ? [] : [caller(lane + 1), caller(lane + 1)]);
    return Number(row.count);
  }
  async function emit() {
    report.elapsedSeconds = (performance.now() - started) / 1000; report.recent = recent.snapshot(); report.mock = mock?.snapshot();
    report.abortTrace = trace.snapshot(); report.expectedCancelEvents = expectedCancel.count;
    report.processes = replicas.map(r => ({ pid: r.pid, instance: r.instance, proxy: r.proxy, control: r.control, logBytes: r.logBytes,
      exitCode: r.child.exitCode, signal: r.child.signalCode }));
    await checkpoint(structuredClone(report));
  }
  async function sample() {
    live();
    const states = await Promise.all(replicas.map(r => control<ChildState>(r, 'state')));
    const [connections] = await sql('SELECT COUNT(*) AS count FROM information_schema.PROCESSLIST WHERE DB=?', [database]);
    const [sizes] = await sql(`SELECT (SELECT COUNT(*) FROM \`${database}\`.user_pool_accounts) AS accounts,
      (SELECT COUNT(*) FROM \`${database}\`.user_pool_leases) AS leases,
      (SELECT COUNT(*) FROM \`${database}\`.user_pool_events) AS events,
      (SELECT COUNT(*) FROM \`${database}\`.proxy_request_stats) AS stats`);
    const [owner] = await sql(`SELECT owner, (owner IS NOT NULL AND owner_until>(TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',UTC_TIMESTAMP(3)) DIV 1000)) AS valid
      FROM \`${database}\`.user_pool_settings WHERE id=1`);
    assert.equal(Number(owner.valid), 1, 'DB-valid owner'); assert.equal(states.filter(state => state.owner === owner.owner).length, 1);
    assert.ok(Number(connections.count) <= 4 * config.replicas); assert.ok(Number(sizes.accounts) <= 20);
    assert.ok(Number(sizes.leases) <= config.concurrency); assert.ok(Number(sizes.stats) <= 2000 + config.concurrency);
    assert.ok(Number(sizes.events) <= 20000, 'Finite SQL event size ceiling');
    const held = await holds(); assert.ok(held <= config.concurrency);
    for (const state of states) {
      assert.equal(state.unexpected, 0); assert.ok(state.scheduler); assert.ok(state.pool.total <= 4); assert.ok(state.pool.queue <= 8);
      assert.ok(state.memory.rss < 768 * 1024 * 1024, 'Child RSS finite test ceiling');
      peak(`rss.${state.pid}`, state.memory.rss); peak(`heap.${state.pid}`, state.memory.heapUsed); peak(`poolQueue.${state.pid}`, state.pool.queue);
      peak(`httpConnections.${state.pid}`, state.connections.reduce((a, b) => a + b, 0));
    }
    for (const r of replicas) { assert.equal(r.child.exitCode, null); assert.equal(r.child.signalCode, null); assert.ok(r.logBytes <= report.limits.childLogByteCeiling); }
    const upstream = mock!.snapshot(); assert.equal(upstream.unexpected + upstream.provisioningFailures, 0);
    peak('mysqlConnections', Number(connections.count)); peak('holds', held); peak('events', Number(sizes.events)); peak('stats', Number(sizes.stats));
    const memory = process.memoryUsage(); assert.ok(memory.rss < 768 * 1024 * 1024, 'Harness RSS finite test ceiling'); peak('parentRss', memory.rss);
    const value = { elapsedSeconds: (performance.now() - started) / 1000, parent: { memory, cpu: process.cpuUsage() }, children: states,
      db: { connections: Number(connections.count), holds: held, ...sizes }, mock: upstream, pendingClients: pending.size };
    report.counts.samples++; report.first ??= value; report.last = value; recent.add(value); await emit();
  }
  async function request(lane: number, replica: Replica, kind: 'full' | 'cancel' | 'recover') {
    live(); const local = new AbortController(); const seq = ++sequences[lane]; const begin = performance.now();
    const prior = seq > 1 ? await lease(lane) : undefined;
    report.counts.sent++;
    const work = (async () => {
      const response = await fetch(`${replica.proxy}/v1/messages`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'X-User-Identity': caller(lane + 1), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 8, stream: true, messages: [{ role: 'user', content: `stream-soak-${lane}-${seq}-${kind}` }] }),
        signal: AbortSignal.any([signal, local.signal, AbortSignal.timeout((config.stream + 12) * 1000)]) });
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/); assert.ok(response.body);
      const reader = response.body.getReader(); const parser = new SseReader(); let before: Lease | undefined;
      try {
        for (;;) {
          const result = await reader.read(); if (result.done) break; parser.add(result.value);
          if (!before && parser.deltas) {
            before = await lease(lane); assert.ok(await holds(lane) >= 1, 'Actual SQL slot while streaming');
            if (prior) assert.deepEqual(before, prior, 'Headers/partial stream cannot renew the preceding lease');
            else { assert.equal(before.phase, 'provisional'); assert.equal(before.last_success_at, null); }
          }
          if (kind === 'cancel' && parser.deltas >= 3 && performance.now() - begin >= 2000) {
            assert.ok(before); assert.equal(parser.terminal, false);
            const requestId = `stream-soak-${lane}-${seq}-cancel`;
            expectedCancel.arm(replica.pid, requestId);
            const armed = await control(replica, 'expect-cancel', { requestId }); assert.equal(armed.armed, true); assert.equal(armed.pid, replica.pid);
            expectedCancel.beginAbort(replica.pid, requestId); local.abort(); await reader.cancel().catch(() => {});
            await until(async () => await holds(lane) === 0 && !mock!.activeLane(lane) && expectedCancel.matched(replica.pid, requestId), 'cancel slot/log/native abort drain');
            assert.deepEqual(await lease(lane), before, 'Partial cancellation must not renew expiry, success time, phase or lease');
            expectedCancel.finish(replica.pid, requestId);
            report.counts.canceled++; report.counts.bytes += parser.bytes; return;
          }
        }
        assert.notEqual(kind, 'cancel', 'Cancellation did not happen'); parser.finish(); assert.ok(before);
        if (kind === 'full') assert.ok(performance.now() - begin >= config.stream * 1000, 'Real longstream elapsed');
        await until(async () => await holds(lane) === 0 && (await lease(lane)).phase === 'active', 'success slot drain');
        const after = await lease(lane); assert.equal(after.lease_id, before.lease_id); assert.equal(after.member_identity, before.member_identity);
        assert.ok(Number(after.last_success_at) > Number(before.last_success_at ?? 0), 'Valid completion renews lease');
        report.counts[kind === 'full' ? 'full' : 'recovered']++; report.counts.bytes += parser.bytes;
      } finally { reader.releaseLock(); }
    })();
    return track(work);
  }
  try {
    const { createConnection } = await import('mysql2/promise'); live();
    admin = await createConnection({ uri: adminUrl.toString(), connectTimeout: 3000 }); live();
    await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`, timeout: 5000 }); created = true;
    report.database = database; await emit();
    mock = await streamMock(config, async task => { assert.ok(replicas[0]); await control(replicas[0], 'oauth-callback', { identity: task.identity, nonce: task.oauthAttemptId }); });
    for (let i = 0; i < config.replicas; i++) {
      live(); const env: NodeJS.ProcessEnv = Object.fromEntries(osKeys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
      Object.assign(env, { MYSQL_POOL_STREAM_SOAK_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1', MYSQL_TEST_URL: db.toString(),
        STREAM_SOAK_CHILD: '1', STREAM_SOAK_REPLICAS: String(config.replicas), STREAM_SOAK_STREAM: String(config.stream),
        STREAM_SOAK_LIFETIME: String(Math.max(60, Math.ceil((end - performance.now()) / 1000) + 20)), STREAM_SOAK_MOCK_ORIGIN: mock.origin,
        STREAM_SOAK_CONTROL_KEY: key, TSX_TSCONFIG_PATH: fileURLToPath(new URL('./stream-soak-tsconfig.json', import.meta.url)) });
      const child = fork(fileURLToPath(new URL('./stream-soak-child.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], env,
        cwd: fileURLToPath(new URL('../../', import.meta.url)), silent: true }); children.push(child);
      let bytes = 0; let replica: Replica | undefined;
      child.on('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'stream-failure') return;
        try {
          const evidence = message as unknown as CancelMetadata;
          assert.equal(evidence.pid, child.pid); expectedCancel.metadata(evidence);
        } catch {
          report.counts.unexpected++; stop('child-log', { pid: child.pid, level: 'ERROR', event: 'upstream-stream-failed' });
        }
      });
      // Bounded log line scan. Only the exact stream-failure token can await paired
      // request-scoped IPC; every other ERROR/WARN still stops immediately.
      for (const stream of [child.stdout, child.stderr]) {
        let scan = ''; let countedPartial = false;
        const handle = (token: { level: 'ERROR' | 'WARN'; event: string }) => {
          if (token.level === 'ERROR' && token.event === 'upstream-stream-failed') {
            try {
              expectedCancel.wire(child.pid!);
              if (expectedCancel.unpaired(child.pid!)) {
                const timeout = setTimeout(() => {
                  if (expectedCancel.unpaired(child.pid!)) { report.counts.unexpected++; stop('child-log', { pid: child.pid, ...token }); }
                }, 1000); timeout.unref();
              }
            } catch { report.counts.unexpected++; stop('child-log', { pid: child.pid, ...token }); }
          } else { report.counts.unexpected++; stop('child-log', { pid: child.pid, ...token }); }
        };
        stream?.on('data', chunk => {
          bytes += chunk.length; if (replica) replica.logBytes = bytes;
          scan += String(chunk);
          for (;;) {
            const end = scan.indexOf('\n'); if (end < 0) break;
            const line = scan.slice(0, end); scan = scan.slice(end + 1);
            if (!countedPartial) for (const token of logTokens(line)) handle(token);
            countedPartial = false;
          }
          if (scan.length > 4096) {
            if (!countedPartial) for (const token of logTokens(scan)) handle(token);
            countedPartial = true; scan = scan.slice(-64);
          }
          if (bytes > report.limits.childLogByteCeiling) { report.counts.unexpected++; stop('child-log-budget', { pid: child.pid }); }
        });
      }
      child.on('error', () => { report.counts.unexpected++; stop('child-error', { pid: child.pid }); });
      child.once('exit', () => { if (!closing) { report.counts.unexpected++; stop('child-exit', { pid: child.pid }); } });
      const info = await bounded(new Promise<Omit<Replica, 'child' | 'logBytes'>>((resolve, reject) => {
        child.once('error', reject); child.once('exit', () => reject(new Error('Child startup exit')));
        child.once('message', message => {
          try { assert.ok(message && typeof message === 'object' && 'type' in message && message.type === 'ready');
            const info = message as unknown as Omit<Replica, 'child' | 'logBytes'>;
            assert.equal(info.pid, child.pid); assert.notEqual(info.pid, process.pid); assert.match(info.instance, /^[a-f0-9-]{36}$/);
            origin(info.proxy); origin(info.control); resolve(info);
          } catch { reject(new Error('Child startup protocol')); }
        });
      }), 'child startup', Math.min(20000, Math.max(1, end - performance.now())));
      replica = { ...info, child, logBytes: bytes }; replicas.push(replica); mock.allowPid(info.pid);
    }
    for (const key of ['pid', 'instance', 'proxy', 'control'] as const) assert.equal(new Set(replicas.map(r => r[key])).size, config.replicas);
    for (const replica of replicas) {
      const response = await fetch(`${replica.proxy}/v1/models`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      assert.equal(response.status, 401); await response.text();
    }
    assert.equal(mock.snapshot().forwarded, 0); await Promise.all(replicas.map(r => control(r, 'start')));
    await until(async () => Number((await sql(`SELECT COUNT(*) AS count FROM \`${database}\`.user_pool_accounts WHERE state='ready' AND verified_at IS NOT NULL`))[0].count) >= config.concurrency, 'warm inventory', 25000);
    report.stage = 'resource-and-stream-workload'; await sample();
    sampler = (async () => {
      while (sampling && !signal.aborted) {
        await delay(config.checkpoint * 1000); if (sampling && !signal.aborted) await sample();
      }
    })().catch(error => { if (sampling) { report.counts.unexpected++; stop('sampler', { error }); } });
    // A real successful SSE through every child proves PIDs are independent proxy
    // processes, not several ports in one process. Same caller also exercises affinity.
    for (const replica of replicas) await request(0, replica, 'recover');
    let cycle = 0;
    while (performance.now() + (config.stream + 3) * 1000 < end) {
      const cancelLane = cycle % config.concurrency;
      await Promise.all(Array.from({ length: config.concurrency }, async (_, lane) => {
        const replica = replicas[(lane + cycle) % replicas.length];
        if (lane === cancelLane) {
          await request(lane, replica, 'cancel');
          await until(async () => !mock!.activeLane(lane), 'upstream cancellation');
          await request(lane, replicas[(lane + cycle + 1) % replicas.length], 'recover');
        } else await request(lane, replica, 'full');
      }));
      report.counts.cycles = ++cycle;
      await until(async () => await holds() === 0 && mock!.snapshot().active === 0, 'all SQL and upstream slots drain');
      assert.equal(mock.snapshot().attempts, report.counts.sent, 'Exactly one upstream attempt per submitted request; no retries');
    }
    assert.ok(report.counts.cycles >= 1 && report.counts.full >= 1 && report.counts.canceled >= 1, 'At least one full/cancel/recovery cycle must execute');
    // No truncated last stream: final partial-cycle remainder is explicit idle observation,
    // and still checks for delayed replay/resource drift until the declared budget ends.
    report.stage = 'final-idle-observation';
    while (performance.now() + 1000 < end) await delay(Math.min(500, end - performance.now() - 750));
    sampling = false;
    await sample();
    assert.equal(await holds(), 0); const final = mock.snapshot();
    assert.equal(final.active, 0); assert.equal(final.attempts, report.counts.sent);
    assert.equal(final.completed, report.counts.full + report.counts.recovered); assert.equal(final.canceled, report.counts.canceled);
    assert.equal(final.unexpected + final.provisioningFailures, 0); assert.equal(Object.keys(final.perPid).length, config.replicas);
    assert.equal(report.counts.unexpected, 0); expectedCancel.assertDrained(); assert.equal(expectedCancel.count, report.counts.canceled);
  } catch (error) {
    failed = true; report.counts.unexpected++;
    stop('workload', { error });
    const first = trace.snapshot().first!;
    report.failure = { name: error instanceof Error ? error.name : 'UnknownError',
      location: first.location ?? 'fixture', source: first.source, pid: first.pid, event: first.event };
  }
  finally {
    sampling = false; closing = true; clearTimeout(timer); abort.abort(); external?.removeEventListener('abort', externalAbort);
    const cleanupTimer = setTimeout(() => {
      // Owned handles only. A late forced exit is failure, never a successful result.
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      admin?.destroy();
    }, (cleanupSeconds - 5) * 1000);
    const errors: unknown[] = [];
    try {
      await Promise.all(children.map(async child => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
            try { if (child.connected) child.send({ type: 'shutdown' }, () => {}); await bounded(exited, 'graceful child shutdown', 7000); }
            catch { child.kill('SIGKILL'); await bounded(exited, 'forced child shutdown', 3000); }
          }
          assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
        } catch (error) { errors.push(error); }
      }));
      try { await mock?.close(); } catch (error) { errors.push(error); }
      try { await bounded(Promise.allSettled([...pending, ...(sampler ? [sampler] : [])]), 'client and sampler drain', 3000); } catch (error) { errors.push(error); }
      report.cleanup.childrenDead = children.every(child => child.exitCode !== null || child.signalCode !== null);
      if (created && report.cleanup.childrenDead) {
        try { await admin!.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 }); report.cleanup.databaseDropped = true; }
        catch (error) { errors.push(error); }
      } else if (created) errors.push(new Error('Owned child alive; retain database'));
      try { if (admin) await bounded(admin.end(), 'admin close', 3000); } catch (error) { admin?.destroy(); errors.push(error); }
    } finally { clearTimeout(cleanupTimer); }
    report.cleanup.complete = errors.length === 0 && report.cleanup.childrenDead && (!created || report.cleanup.databaseDropped);
    if (errors.length) { failed = true; report.counts.unexpected += errors.length; }
    if (report.counts.unexpected !== 0) failed = true;
    report.status = failed ? 'failed' : 'passed'; await emit();
  }
  if (failed) throw new Error(`Stream soak failed in ${report.stage}; inspect bounded checkpoint, cleanup and counters (raw product errors intentionally suppressed)`);
  return report;
}
