import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyApiSignal, classifyDatabase, classifyLocal, counterChange, getDiagnostics, sample, validateConfig } from './monitor.mjs';

const NOW = 1800000000000;
const SECRET = 'synthetic-secret-do-not-emit';
const config = () => ({ schemaVersion: 1, endpoints: [{ instance: 'proxy-a',
  url: 'https://proxy-a.example.invalid/api/user-pool/diagnostics/local', tokenEnv: 'POOL_MONITOR_TOKEN' }] });
const local = (state = 'standby') => ({ enabled: true, scope: 'local_process', observedAt: NOW,
  localScheduler: { scope: 'local_process', state, observedAtUnixMs: NOW, localTenureAgeMs: null,
    lastSuccessfulRenewalAtUnixMs: null, lastSuccessfulRenewalAgeMs: null,
    claimAttempts: 4, ownershipAcquisitions: 1, ownershipLosses: 1, lastOwnershipLoss: null } });
const db = () => ({ schemaVersion: 1, source: 'writer', status: 'ok', observedAtUnixMs: NOW,
  queryDurationMs: 5, row: { rowCount: 1, dbNowUnixMs: NOW + 900000, ownerPresent: 1,
    ownerUntilUnixMs: NOW + 910000, paused: 0 } });
const reportOptions = extra => ({ env: { POOL_MONITOR_TOKEN: SECRET }, now: () => NOW,
  transport: async () => ({ status: 'ok', body: local() }), ...extra });

function fakeHttp({ status = 200, headers = { 'cache-control': 'no-store', 'content-type': 'application/json' },
  chunks = ['{}'], failure = false, hang = false } = {}) {
  let calls = 0, captured, responseDestroyed = false, requestDestroyed = false;
  const transport = { request(url, options, cb) {
    calls++; captured = { url: url.href, options };
    const request = new EventEmitter();
    request.destroy = () => { requestDestroyed = true; };
    request.end = () => queueMicrotask(() => {
      if (failure) { request.emit('error', new Error(SECRET)); return; }
      if (hang) return;
      const response = new EventEmitter(); response.statusCode = status; response.headers = headers;
      response.destroy = () => { responseDestroyed = true; };
      cb(response);
      if (responseDestroyed) return;
      for (const chunk of chunks) {
        response.emit('data', Buffer.from(chunk));
        if (responseDestroyed) return;
      }
      response.emit('end');
    });
    return request;
  } };
  return { transports: { 'https:': transport }, state: () => ({ calls, captured, responseDestroyed, requestDestroyed }) };
}

test('config uses bounded defaults and explicit per-instance endpoints', () => {
  const c = validateConfig(config()); assert.equal(c.timeoutMs, 3000); assert.equal(c.concurrency, 4);
  assert.equal(c.maxAgeMs, 15000); assert.equal(c.endpoints[0].instance, 'proxy-a');
});

test('config rejects arbitrary paths, URL auth, query, fragments, plaintext and unbounded work', () => {
  for (const url of ['https://a.invalid/api/user-pool', 'https://a.invalid/api/user-pool/diagnostics/local?x=1',
    'https://user:secret@a.invalid/api/user-pool/diagnostics/local', 'https://a.invalid/api/user-pool/diagnostics/local#x',
    'http://a.invalid/api/user-pool/diagnostics/local', 'file:///api/user-pool/diagnostics/local']) {
    const c = config(); c.endpoints[0].url = url; assert.throws(() => validateConfig(c), /invalid_input/);
  }
  for (const patch of [{ token: SECRET }, { concurrency: 5 }, { timeoutMs: 99999 }, { maxAgeMs: 1 },
    { endpoints: [] }, { endpoints: Array.from({ length: 33 }, () => config().endpoints[0]) }]) {
    assert.throws(() => validateConfig({ ...config(), ...patch }));
  }
});

test('config permits HTTP only with explicit exact loopback opt-in', () => {
  const c = config(); c.endpoints[0].url = 'http://127.0.0.1:3000/api/user-pool/diagnostics/local';
  assert.throws(() => validateConfig(c)); c.endpoints[0].allowLoopbackHttp = true;
  assert.equal(validateConfig(c).endpoints[0].allowLoopbackHttp, true);
  c.endpoints[0].url = 'http://127.0.0.2/api/user-pool/diagnostics/local'; assert.throws(() => validateConfig(c));
});

test('config rejects duplicate instance or endpoint and invalid epoch', () => {
  const c = config(); c.endpoints.push({ ...c.endpoints[0] }); assert.throws(() => validateConfig(c));
  c.endpoints[1].instance = 'proxy-b'; assert.throws(() => validateConfig(c));
  c.endpoints.pop(); c.endpoints[0].processStartUnixMs = -1; assert.throws(() => validateConfig(c));
});

test('standby and null snapshots describe only the local process', () => {
  assert.equal(classifyLocal(local(), NOW, 15000).state, 'standby');
  const b = local(); b.localScheduler = null;
  assert.equal(classifyLocal(b, NOW, 15000).state, 'not_started');
  assert.equal(classifyLocal(local('owner'), NOW, 15000).state, 'owner');
});

test('local freshness checks outer and scheduler observations, not renewal age', () => {
  const b = local(); b.observedAt = NOW - 15001;
  assert.equal(classifyLocal(b, NOW, 15000).status, 'stale_or_clock_skew');
  b.observedAt = NOW; b.localScheduler.observedAtUnixMs = NOW + 1;
  assert.equal(classifyLocal(b, NOW, 15000).status, 'stale_or_clock_skew');
  b.localScheduler.observedAtUnixMs = NOW; b.localScheduler.lastSuccessfulRenewalAgeMs = 999999;
  assert.equal(classifyLocal(b, NOW, 15000).status, 'ok');
});

test('local response validation rejects missing counters, NaN, unknown state and unsafe reasons', () => {
  for (const mutation of [b => delete b.localScheduler.claimAttempts,
    b => { b.localScheduler.state = SECRET; }, b => { b.localScheduler.localTenureAgeMs = NaN; },
    b => { b.localScheduler.lastOwnershipLoss = { reason: SECRET, atUnixMs: NOW }; }]) {
    const b = local(); mutation(b); assert.deepEqual(classifyLocal(b, NOW, 15000), { status: 'invalid_response' });
  }
});

test('local output projects only safe fields, including allowlisted loss subclass', () => {
  const b = local(); b.password = SECRET; b.localScheduler.owner = SECRET;
  b.localScheduler.lastOwnershipLoss = { reason: 'storage_unavailable', storageFailure: 'deadline', atUnixMs: NOW, rawError: SECRET };
  const result = classifyLocal(b, NOW, 15000);
  assert.equal(result.lastOwnershipLoss.storageFailure, 'deadline');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('DB clock alone decides the fence, even when DB and sampler clocks differ', () => {
  const input = db(); assert.equal(classifyDatabase(input, NOW, 15000).ownerAtObservation, 'present');
  input.row.ownerUntilUnixMs = input.row.dbNowUnixMs - 45000;
  const r = classifyDatabase(input, NOW, 15000);
  assert.equal(r.ownerAtObservation, 'absent'); assert.equal(r.leaseExpiredForMs, 45000);
});

test('deadline equality means expired; zero owner_until has no invented absence duration', () => {
  const input = db(); input.row.ownerUntilUnixMs = input.row.dbNowUnixMs;
  assert.equal(classifyDatabase(input, NOW, 15000).ownerAtObservation, 'absent');
  input.row.ownerUntilUnixMs = 0; input.row.ownerPresent = 0;
  const r = classifyDatabase(input, NOW, 15000); assert.equal(r.ownerAtObservation, 'absent');
  assert.equal(r.leaseExpiredForMs, null);
});

test('unknown, stale, replica, invalid row and SQL-unreachable are never owner absence', () => {
  const cases = [null, { ...db(), source: 'replica' }, { ...db(), observedAtUnixMs: NOW - 15001 },
    { ...db(), observedAtUnixMs: NOW + 1 }, { ...db(), row: { ...db().row, rowCount: 0 } },
    { ...db(), row: { ...db().row, ownerUntilUnixMs: '1' } }, { ...db(), queryDurationMs: 60000 },
    { ...db(), status: 'sql_unreachable', error: SECRET }, { ...db(), status: 'query_failed' }];
  for (const input of cases) {
    const r = classifyDatabase(input, NOW, 15000); assert.equal(r.ownerAtObservation, 'unknown');
    assert.equal(r.leaseExpiredForMs, null); assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
  assert.equal(classifyDatabase({ ...db(), status: 'sql_unreachable' }, NOW, 15000).status, 'sql_unreachable');
});

test('owner-less future deadline is inconsistent, not assumed healthy or absent', () => {
  const input = db(); input.row.ownerPresent = 0;
  assert.equal(classifyDatabase(input, NOW, 15000).reason, 'inconsistent_row');
});

test('paused is a separate operational flag, not an inference about ownership', () => {
  const input = db(); input.row.paused = 1;
  const r = classifyDatabase(input, NOW, 15000); assert.equal(r.paused, true); assert.equal(r.ownerAtObservation, 'present');
});

test('local counter delta requires same externally supplied process start epoch', () => {
  const previous = { ...classifyLocal(local(), NOW, 15000), observedAtUnixMs: NOW - 5000, processStartUnixMs: NOW - 60000 };
  const current = { ...previous, observedAtUnixMs: NOW, counters: { claimAttempts: 6, ownershipAcquisitions: 2, ownershipLosses: 2 } };
  assert.deepEqual(counterChange(current, previous, NOW, 15000), {
    counterContinuity: 'continuous', counterDeltas: { claimAttempts: 2, ownershipAcquisitions: 1, ownershipLosses: 1 } });
  delete current.processStartUnixMs;
  assert.equal(counterChange(current, previous, NOW, 15000).counterContinuity, 'unknown');
});

test('counter regression and changed epoch reset deltas; monotone values cannot hide restart', () => {
  const previous = { ...classifyLocal(local(), NOW, 15000), observedAtUnixMs: NOW - 5000, processStartUnixMs: NOW - 60000 };
  let current = { ...previous, observedAtUnixMs: NOW, counters: { ...previous.counters, ownershipLosses: 0 } };
  assert.deepEqual(counterChange(current, previous, NOW, 15000), { counterContinuity: 'reset', counterDeltas: null });
  current = { ...previous, observedAtUnixMs: NOW, processStartUnixMs: NOW - 1000 };
  assert.equal(counterChange(current, previous, NOW, 15000).counterContinuity, 'reset');
});

test('counter gaps, stale, equal timestamps and malformed history do not produce rates', () => {
  const current = { ...classifyLocal(local(), NOW, 15000), processStartUnixMs: NOW - 60000 };
  for (const prior of [null, { ...current }, { ...current, observedAtUnixMs: NOW - 20000 },
    { ...current, observedAtUnixMs: NOW - 1000, status: 'unreachable' },
    { ...current, observedAtUnixMs: NOW - 1000, counters: { ownershipLosses: SECRET } }]) {
    assert.deepEqual(counterChange(current, prior, NOW, 15000), { counterContinuity: 'unknown', counterDeltas: null });
  }
});

test('API error signal classification uses exact status/code pairs', () => {
  for (const [status, code, expected] of [[503, 'pool_storage_unavailable', 'storage_unavailable'],
    [503, 'pool_owner_unavailable', 'sqlite_owner_guard'], [503, 'member_unavailable', 'member_unavailable'],
    [429, 'pool_exhausted', 'stock_exhausted'], [429, 'member_cooling', 'cooling'],
    [503, 'pool_exhausted', 'other'], [500, SECRET, 'other'], [429, 'upstream_error', 'other']]) {
    assert.equal(classifyApiSignal(status, code), expected);
  }
});

test('HTTP uses only authenticated GET with no-store, strict TLS and no proxy agent', async () => {
  const fake = fakeHttp({ chunks: [JSON.stringify(local())] });
  const r = await getDiagnostics(config().endpoints[0].url, SECRET, 3000, fake.transports);
  assert.equal(r.status, 'ok'); const s = fake.state(); assert.equal(s.calls, 1);
  assert.equal(s.captured.options.method, 'GET'); assert.equal(s.captured.options.headers['X-Internal-Token'], SECRET);
  assert.equal(s.captured.options.headers['Cache-Control'], 'no-store'); assert.equal(s.captured.options.rejectUnauthorized, true);
  assert.equal(s.captured.options.agent, false); assert.equal(s.requestDestroyed, true);
});

test('redirect and authentication error bodies are neither followed nor emitted', async () => {
  for (const [status, expected] of [[302, 'redirect_rejected'], [401, 'auth_failed'], [403, 'auth_failed'],
    [409, 'pool_disabled'], [503, 'http_error']]) {
    const fake = fakeHttp({ status, headers: { location: 'https://elsewhere.invalid' }, chunks: [SECRET] });
    const r = await getDiagnostics(config().endpoints[0].url, SECRET, 3000, fake.transports);
    assert.equal(r.status, expected); assert.equal(fake.state().calls, 1); assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
});

test('HTTP rejects missing no-store, malformed JSON, oversize and encoded bodies', async () => {
  for (const [options, expected] of [[{ headers: { 'content-type': 'application/json' } }, 'no_store_missing'],
    [{ chunks: [SECRET] }, 'invalid_response'], [{ chunks: ['x'.repeat(32769)] }, 'response_too_large'],
    [{ headers: { 'cache-control': 'no-store', 'content-type': 'text/html' } }, 'invalid_response'],
    [{ headers: { 'cache-control': 'no-store', 'content-type': 'application/json', 'content-encoding': 'gzip' } }, 'invalid_response']]) {
    const fake = fakeHttp(options);
    assert.deepEqual(await getDiagnostics(config().endpoints[0].url, SECRET, 3000, fake.transports), { status: expected });
  }
});

test('total HTTP deadline aborts hung request without real time or network', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeHttp({ hang: true });
  const pending = getDiagnostics(config().endpoints[0].url, SECRET, 3000, fake.transports);
  t.mock.timers.tick(3000);
  assert.deepEqual(await pending, { status: 'timeout' }); assert.equal(fake.state().requestDestroyed, true);
});

test('connection errors are sanitized with no retry', async () => {
  const fake = fakeHttp({ failure: true });
  assert.deepEqual(await getDiagnostics(config().endpoints[0].url, SECRET, 3000, fake.transports), { status: 'unreachable' });
  assert.equal(fake.state().calls, 1);
});

test('missing token and debug tracing fail closed without any HTTP calls', async () => {
  let calls = 0; const transport = async () => { calls++; throw new Error(SECRET); };
  const r = await sample(config(), reportOptions({ env: {}, transport }));
  assert.equal(r.instances[0].status, 'credential_unavailable'); assert.equal(calls, 0);
  await assert.rejects(() => sample(config(), reportOptions({ env: { NODE_DEBUG: 'http', POOL_MONITOR_TOKEN: SECRET }, transport })), /invalid_input/);
  assert.equal(calls, 0);
});

test('per-instance standby and unreachable never create global owner absence', async () => {
  for (const transport of [async () => ({ status: 'ok', body: local() }), async () => { throw new Error(SECRET); }]) {
    const r = await sample(config(), reportOptions({ transport })); assert.equal(r.database.ownerAtObservation, 'unknown');
    assert.equal(r.collectionComplete, false); assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
});

test('sampler emits safe structured report, never URL, env key, raw fields or token', async () => {
  const b = local(); b.token = SECRET; const d = db(); d.rawError = SECRET;
  const r = await sample(config(), reportOptions({ databaseObservation: d, transport: async () => ({ status: 'ok', body: b }) }));
  assert.equal(r.collectionComplete, true); const text = JSON.stringify(r);
  for (const forbidden of [SECRET, 'example.invalid', 'POOL_MONITOR_TOKEN', 'rawError']) assert.equal(text.includes(forbidden), false);
});

test('sampler concurrency stays bounded and every allowlisted instance is represented', async () => {
  const c = config(); c.concurrency = 2;
  c.endpoints = Array.from({ length: 7 }, (_, i) => ({ ...c.endpoints[0], instance: `proxy-${i}`,
    url: `https://proxy-${i}.example.invalid/api/user-pool/diagnostics/local` }));
  let active = 0, max = 0, calls = 0;
  const r = await sample(c, reportOptions({ transport: async () => {
    active++; calls++; max = Math.max(max, active); await Promise.resolve(); active--; return { status: 'ok', body: local() };
  } }));
  assert.equal(max, 2); assert.equal(calls, 7); assert.equal(r.instances.length, 7);
});

test('batch publication revalidates freshness instead of hiding early stale samples', async () => {
  const clocks = [NOW, NOW + 16000];
  const r = await sample(config(), reportOptions({ now: () => clocks.shift() ?? NOW + 16000, databaseObservation: db() }));
  assert.equal(r.instances[0].status, 'stale_or_clock_skew'); assert.equal(r.database.ownerAtObservation, 'unknown');
});

test('previous report supplies same-instance counter baseline only', async () => {
  const c = config(); c.endpoints[0].processStartUnixMs = NOW - 60000;
  const previous = { schemaVersion: 1, instances: [{ instance: 'proxy-a', processStartUnixMs: NOW - 60000,
    ...classifyLocal(local(), NOW, 15000), observedAtUnixMs: NOW - 5000 }] };
  const r = await sample(c, reportOptions({ previous }));
  assert.equal(r.instances[0].counterContinuity, 'continuous'); assert.equal(r.instances[0].counterDeltas.ownershipLosses, 0);
});

const cli = args => spawnSync(process.execPath, [fileURLToPath(new URL('./monitor.mjs', import.meta.url)), ...args], {
  encoding: 'utf8', timeout: 5000, env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
});

test('CLI invalid invocation emits only fixed safe JSON and exit 1', () => {
  const r = cli([]); assert.equal(r.status, 1); assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), { schemaVersion: 1, status: 'invalid_input_or_configuration' });
});

test('CLI without injected credentials never requests example endpoints and exits 2 with unknown ownership', () => {
  const r = cli([fileURLToPath(new URL('./config.example.json', import.meta.url))]);
  assert.equal(r.status, 2); assert.equal(r.stderr, ''); const report = JSON.parse(r.stdout);
  assert.equal(report.database.ownerAtObservation, 'unknown'); assert.equal(report.instances.length, 2);
  assert.ok(report.instances.every(x => x.status === 'credential_unavailable'));
  for (const term of ['POOL_MONITOR_TOKEN', 'example.invalid']) assert.equal(r.stdout.includes(term), false);
});
