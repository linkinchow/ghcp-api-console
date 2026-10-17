// Runs inside a shipped image (argv[2]: baseline or candidate) against the image's own node_modules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireImage = createRequire('/app/src/proxy/package.json');
const expected = process.argv[2];
assert.ok(['baseline', 'candidate'].includes(expected));
const versions = Object.fromEntries(['multer', 'proxy-addr', 'brace-expansion'].map((name) => [
  name,
  JSON.parse(readFileSync(`/app/node_modules/${name}/package.json`, 'utf8')).version,
]));
assert.deepEqual(versions, expected === 'candidate'
  ? { multer: '2.4.0', 'proxy-addr': '2.0.8', 'brace-expansion': '1.1.21' }
  : { multer: '2.3.0', 'proxy-addr': '2.0.7', 'brace-expansion': '1.1.18' });
const expand = requireImage('brace-expansion');
assert.deepEqual(expand('fixture-{a,b}-{1..2}'), ['fixture-a-1', 'fixture-a-2', 'fixture-b-1', 'fixture-b-2']);
const proxyAddress = requireImage('proxy-addr');
// X-Forwarded-For is honoured only when the direct peer is a trusted (loopback) proxy.
assert.equal(
  proxyAddress(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.12' } },
    proxyAddress.compile('loopback'),
  ),
  '192.0.2.12',
);
assert.equal(
  proxyAddress(
    { socket: { remoteAddress: '192.0.2.10' }, headers: { 'x-forwarded-for': '192.0.2.12' } },
    proxyAddress.compile('loopback'),
  ),
  '192.0.2.10',
);
const express = requireImage('express');
const multer = requireImage('multer');
const app = express();
app.post(
  '/upload',
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 } }).single('file'),
  (req, res) => res.json({ content: req.file?.buffer.toString('utf8') }),
);
app.use((error, req, res, next) => res.status(400).json({ code: error.code ?? 'INVALID_MULTIPART' }));
const server = app.listen(0, '127.0.0.1');
try {
  await new Promise((resolve) => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/upload`;

  const valid = new FormData();
  valid.append('file', new Blob(['synthetic']), 'fixture.txt');
  const accepted = await fetch(endpoint, { method: 'POST', body: valid, signal: AbortSignal.timeout(3000) });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).content, 'synthetic');

  const large = new FormData();
  large.append('file', new Blob(['x'.repeat(32)]), 'fixture.txt');
  const rejected = await fetch(endpoint, { method: 'POST', body: large, signal: AbortSignal.timeout(3000) });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'LIMIT_FILE_SIZE');

  const malformed = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data' },
    body: 'synthetic-invalid-boundary',
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(malformed.status, 400);
  await malformed.body?.cancel();

  console.log(JSON.stringify({
    phase: expected,
    pass: true,
    versions,
    braceExpansion: true,
    proxyAddressTrustedAndUntrusted: true,
    multipartValidMalformedAndSizeLimit: true,
    scope: 'Image-owned dependencies, network-none container, synthetic loopback HTTP fixture;'
      + ' not an application upload route or security exploit test',
  }));
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
