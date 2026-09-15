import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// Exercise the actual fixture function without importing its eager fixed-port
// listeners / Docker-only modes. This covers forwarding over real HTTP sockets,
// not bridge routing or container wiring; no new mounted helper is required.
const file = new URL('./mysql-bridge.mjs', import.meta.url);
const source = await readFile(file, 'utf8');
const begin = source.indexOf('function forward('), end = source.indexOf('\nfunction listen(', begin);
assert.ok(begin >= 0 && end > begin, 'fixture forward function extraction boundary changed');
const forward = runInNewContext(`(${source.slice(begin, end)})`, {
  http,
  json() { assert.fail('unexpected pre-header forwarding failure'); },
}, { filename: file.pathname });
const start = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const stop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function exercise(t, finishUpstream) {
  let upstreamResponse;
  const upstream = http.createServer((_req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(start);
  });
  const bridge = http.createServer((req, res) => forward(req, res, '127.0.0.1', upstream.address().port));
  t.after(async () => {
    await Promise.all([bridge, upstream].map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });
  for (const server of [upstream, bridge]) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  return new Promise((resolve, reject) => {
    const observed = { text: '', aborted: false, ended: false, errors: [] };
    let finishedAt;
    const client = http.get({ host: '127.0.0.1', port: bridge.address().port, path: '/stream', agent: false }, response => {
      observed.status = response.statusCode;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        observed.text += chunk;
        // Break / end only once the client has actually received the SSE start.
        if (!finishedAt && observed.text.includes(start)) {
          finishedAt = Date.now();
          finishUpstream(upstreamResponse);
        }
      });
      response.on('aborted', () => { observed.aborted = true; });
      response.on('error', error => { observed.errors.push(error.code); });
      response.on('end', () => { observed.ended = true; });
      response.on('close', () => {
        clearTimeout(timer);
        resolve({ ...observed, complete: response.complete, destroyed: response.destroyed,
          afterUpstreamMs: finishedAt ? Date.now() - finishedAt : null });
      });
    });
    client.on('error', error => { clearTimeout(timer); reject(error); });
    const timer = setTimeout(() => {
      reject(new Error('downstream did not settle promptly after upstream completion/failure'));
      client.destroy();
    }, 1500);
    t.after(() => { clearTimeout(timer); client.destroy(); });
  });
}

test('forward aborts the downstream after upstream destroys a partial SSE body', { timeout: 5000 }, async t => {
  const result = await exercise(t, res => res.destroy());
  assert.equal(result.status, 200);
  assert.equal(result.text, start);
  assert.equal(result.aborted, true, 'truncation must reach the downstream socket');
  assert.equal(result.destroyed, true);
  assert.equal(result.complete, false);
  assert.equal(result.ended, false, 'truncation must not be converted to clean EOF');
  assert.ok(result.errors.length > 0, 'client must observe a body transport failure');
  assert.ok(result.afterUpstreamMs !== null && result.afterUpstreamMs < 1500);
  assert.equal(result.text.includes('message_stop'), false);
});

test('forward preserves the full SSE body and clean EOF', { timeout: 5000 }, async t => {
  const result = await exercise(t, res => res.end(stop));
  assert.equal(result.status, 200);
  assert.equal(result.text, start + stop);
  assert.equal(result.aborted, false);
  assert.equal(result.ended, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.errors, []);
});
