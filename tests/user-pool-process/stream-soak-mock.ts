import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMock, type Task } from './replicas-mock.js';
import { bounded, model, token } from './replicas-safety.js';
import { frame, type Options } from './stream-soak-safety.js';

export async function streamMock(config: Options, complete: (task: Task) => Promise<void>) {
  // Reuse the real replica fixture's guarded provisioning/callback protocol read-only.
  // Its finite ledger sees ONLY provisioning/models/warmup, not repeated business SSE.
  const provisioning = await startMock(complete);
  const pids = new Set<number>();
  const lastSequence = Array(config.concurrency).fill(0) as number[];
  const active = new Map<string, { res: ServerResponse; timer: ReturnType<typeof setInterval> }>();
  const perPid = new Map<number, number>();
  const counters = { attempts: 0, completed: 0, canceled: 0, unexpected: 0, forwarded: 0, peakActive: 0, bytes: 0 };
  let closed = false;
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(closed, false); assert.equal(req.socket.remoteAddress, '127.0.0.1');
      const pid = Number(req.headers['x-replicas-pid']); assert.ok(pids.has(pid));
      let text = '';
      for await (const chunk of req) { text += String(chunk); assert.ok(Buffer.byteLength(text) < 16384); }
      const body = text ? JSON.parse(text) : {};
      if (req.url !== '/v1/messages' || body.messages?.[0]?.content === 'Reply OK') {
        assert.ok(++counters.forwarded <= 1000, 'Provisioning wire traffic ceiling');
        assert.ok(req.url?.startsWith('/') && !req.url.startsWith('//'));
        const headers = new Headers();
        for (const key of ['authorization', 'x-internal-token', 'x-replicas-pid', 'content-type']) {
          if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key]);
        }
        const reply = await fetch(`${provisioning.origin}${req.url}`, { method: req.method, headers,
          body: text || undefined, redirect: 'error', signal: AbortSignal.timeout(12000) });
        const response = await reply.text(); assert.ok(response.length < 16384);
        res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' }).end(response); return;
      }
      assert.equal(req.method, 'POST'); assert.equal(body.model, model); assert.equal(body.stream, true); assert.equal(body.max_tokens, 8);
      const match = /^stream-soak-(\d+)-(\d+)-(full|cancel|recover)$/.exec(body.messages?.[0]?.content); assert.ok(match);
      const lane = Number(match[1]); const seq = Number(match[2]); const kind = match[3];
      assert.ok(lane >= 0 && lane < config.concurrency);
      assert.equal(seq, lastSequence[lane] + 1, 'No duplicate, retry, replay or skipped mock request');
      assert.equal(active.has(String(lane)), false, 'One outstanding request per lane');
      const identity = provisioning.tasks.find(task => req.headers.authorization === `Bearer ${token(task.identity)}`)?.identity;
      assert.ok(identity, 'Only nonce-provisioned synthetic tokens');
      lastSequence[lane] = seq; counters.attempts++; perPid.set(pid, (perPid.get(pid) ?? 0) + 1);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const write = (data: Record<string, unknown>) => {
        const wire = frame(data); counters.bytes += Buffer.byteLength(wire);
        assert.ok(res.writableLength < 16384, 'Bounded mock socket buffer');
        res.write(wire);
      };
      write({ type: 'message_start', message: { id: 'synthetic-stream', role: 'assistant', type: 'message', model,
        content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
      write({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      write({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tick-0' } });
      const start = performance.now(); let ticks = 0; let terminal = false;
      const duration = kind === 'recover' ? 1000 : config.stream * 1000;
      const timer = setInterval(() => {
        try {
          if (res.destroyed) return;
          if (performance.now() - start < duration) {
            write({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `tick-${++ticks}` } });
          } else {
            write({ type: 'content_block_stop', index: 0 });
            write({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: ticks + 1 } });
            write({ type: 'message_stop' }); terminal = true; counters.completed++; res.end(); clearInterval(timer);
          }
        } catch { counters.unexpected++; clearInterval(timer); res.destroy(); }
      }, 1000);
      active.set(String(lane), { res, timer }); counters.peakActive = Math.max(counters.peakActive, active.size);
      assert.ok(active.size <= config.concurrency);
      res.once('close', () => {
        clearInterval(timer); active.delete(String(lane));
        if (!terminal) { if (kind !== 'cancel' && !closed) counters.unexpected++; counters.canceled++; }
      });
    })().catch(() => {
      counters.unexpected++;
      if (!res.headersSent) res.writeHead(500).end('Synthetic fixture rejected traffic'); else res.destroy();
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 5000;
  try { server.listen(0, '127.0.0.1'); await bounded(once(server, 'listening'), 'stream mock listen'); }
  catch (error) { await provisioning.close(); throw error; }
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    allowPid(pid: number) { provisioning.allowPid(pid); pids.add(pid); },
    activeLane(lane: number) { return active.has(String(lane)); },
    snapshot() { return { ...counters, active: active.size, perPid: Object.fromEntries(perPid), provisioningCalls: provisioning.calls.length,
      provisioningFailures: provisioning.failures.length, users: provisioning.tasks.length }; },
    async close() {
      closed = true;
      for (const value of active.values()) { clearInterval(value.timer); value.res.destroy(); }
      server.closeAllConnections(); await bounded(new Promise<void>(resolve => server.close(() => resolve())), 'stream mock close', 3000);
      await provisioning.close();
    },
  };
}
