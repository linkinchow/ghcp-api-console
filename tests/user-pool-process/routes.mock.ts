import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bounded, createdAt, internalKey, model, tokenA, tokenB } from './routes.safety.js';

type Call = { pid: number; path: string; kind: string; token: string; partial: boolean; cancelled: boolean; released: boolean; res: ServerResponse };
export async function mockServer() {
  const calls: Call[] = [];
  const failures: string[] = [];
  const allowedPids = new Set<number>();
  let holdModels = false;
  let holdWarmup = false;
  const reply = (res: ServerResponse, value: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const success = () => ({ id: 'synthetic-process-result', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'OK' }] });
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.socket.remoteAddress, '127.0.0.1');
      const pid = Number(req.headers['x-process-routes-pid']); assert.ok(allowedPids.has(pid), 'Only the two fixture PIDs may call upstream');
      const path = req.url!;
      if (req.method === 'GET' && /^\/api\/users\/[a-z]+\.[a-z]+[0-9]{2}$/.test(path)) {
        assert.equal(req.headers['x-internal-token'], internalKey);
        const member = decodeURIComponent(path.slice('/api/users/'.length));
        reply(res, { ssoUser: member, email: `${member}@process-routes.test`, role: 'user', createdAt,
          emuStatus: 'active', ghLogin: 'synthetic-gh-process', ghScimId: 'synthetic-scim', copilotSeatStatus: 'assigned' }); return;
      }
      assert.ok(['/models', '/v1/messages'].includes(path));
      assert.equal(req.method, path === '/models' ? 'GET' : 'POST');
      const token = String(req.headers.authorization);
      assert.ok([`Bearer ${tokenA}`, `Bearer ${tokenB}`].includes(token));
      let text = '';
      for await (const chunk of req) { text += String(chunk); assert.ok(Buffer.byteLength(text) < 16384); }
      const kind = path === '/models' ? 'catalog' : String(JSON.parse(text).messages?.[0]?.content);
      if (path === '/v1/messages') assert.equal(JSON.parse(text).model, model);
      assert.ok(['catalog', 'Reply OK', 'mixed', 'old-success', 'old-unauthorized', 'replacement', 'must-not-admit'].includes(kind));
      const call: Call = { pid, path, kind, token, partial: false, cancelled: false, released: false, res };
      calls.push(call);
      res.once('close', () => { if (!res.writableFinished) call.cancelled = true; });
      if (kind === 'catalog') {
        if (!holdModels) { call.released = true; reply(res, { data: [{ id: model, capabilities: { endpoints: ['/v1/messages'] } }] }); }
        else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"data":['); call.partial = true; }
      } else if (kind === 'replacement' || kind === 'must-not-admit' || kind === 'Reply OK' && !holdWarmup) {
        call.released = true; reply(res, success());
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      if (!res.headersSent) reply(res, { error: 'Fixture rejected unexpected traffic' }, 500); else res.destroy();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.listen(0, '127.0.0.1');
  await bounded(once(server, 'listening'), 'mock listen');
  const release = (kind: string) => {
    for (const call of calls.filter(call => call.kind === kind && !call.released)) {
      assert.equal(call.cancelled || call.res.destroyed, false, `Upstream ${kind} from PID ${call.pid} closed before its release barrier`);
      call.released = true;
      if (kind === 'catalog') call.res.end(`${JSON.stringify({ id: model, capabilities: { endpoints: ['/v1/messages'] } })}]}`);
      else reply(call.res, kind === 'old-unauthorized' ? { error: { message: 'synthetic unauthorized' } } : success(), kind === 'old-unauthorized' ? 401 : 200);
    }
  };
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, failures, release,
    allowPid: (pid: number) => { assert.ok(Number.isSafeInteger(pid) && pid > 0); allowedPids.add(pid); },
    holdCatalog: () => { holdModels = true; }, holdWarmup: () => { holdWarmup = true; },
    close: async () => { for (const call of calls) call.res.destroy(); server.closeAllConnections();
      await bounded(new Promise<void>(resolve => server.close(() => resolve())), 'mock close'); },
  };
}
