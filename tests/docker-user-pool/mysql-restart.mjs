// Service VM only: fixed labelled disposable MySQL container, volume preserved.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PROJECT, urls, check, health, pool, mock, connectDatabase, request, status, auth,
  inferOptions, successful, hash, sleep } from './mysql-smoke.mjs';

const execute = promisify(execFile), container = PROJECT + '-mysql-1';
check(process.env.POOL_MYSQL_RESTART_CONFIRM === PROJECT, 'explicit_restart_confirmation_required');
const report = { kind: 'mysql_restart_beyond_owner_ttl', passed: false, failClosedStatuses: [],
  runtime: { node: process.version, undici: process.versions.undici ?? null, platform: process.platform },
  signals: [] };
const reportPath = '/opt/ghcp-test/results/matrix-restart-report.json';
const prefix = 'restart-' + randomUUID(), caller = 'sha256:' + hash(prefix);
const interrupted = new AbortController(), streamController = new AbortController();
let stopped = false, db, stream, mysqlId;
const failure = label => Object.assign(new Error(label), { fixtureCheck: true });
const errorInfo = error => error ? { name: error.name, code: error.code,
  causeCode: error.cause?.code, ...(error.fixtureCheck ? { check: error.message } : {}) } : null;
function streamSnapshot() {
  if (!stream) return;
  const { text, ...state } = stream.state;
  return { ...state, receivedChars: text.length, terminalSeen: text.includes('message_stop') };
}
function writeReport() {
  report.stream = streamSnapshot();
  // Synchronous persistence keeps a stuck fetch reader from suppressing evidence.
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
const onSignal = signal => {
  const reason = failure('fixture_interrupted_' + signal.toLowerCase());
  report.signals.push({ signal, at: Date.now() });
  report.passed = false;
  report.failure = reason.message;
  process.exitCode = 1;
  interrupted.abort(reason);
};
const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);
const watchdog = setTimeout(() => interrupted.abort(failure('fixture_wall_timeout')), 180000);
// Allows the bounded stop/inspect/start restoration to finish after the normal
// deadline. Last resort only: never report a timed-out harness as a passing run.
const hardExit = () => {
  report.passed = false;
  report.failure ??= 'fixture_hard_timeout';
  report.hardTimeout = true;
  report.mysqlMayStillBeStopped = stopped;
  try { writeReport(); } catch { console.error('FAIL fixture_report_write'); }
  console.error(JSON.stringify(report));
  process.exit(1);
};
const hardTimer = setTimeout(hardExit, 360000);
hardTimer.unref();

// Cleanup cannot use bounded(): interruption is already set on this path. The
// losing operation remains handled, but we never await it without a deadline.
async function cleanupWait(start, timeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(start).then(() => ({ settled: true }), error => ({ settled: true, error: errorInfo(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Bound observer SQL as well as HTTP; dispose a connection returned after cancellation.
function bounded(start, label, timeout = 12000, cancel = () => {}, late = () => {}) {
  interrupted.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); interrupted.signal.removeEventListener('abort', abort); };
    const fail = error => {
      if (settled) return;
      settled = true; cleanup();
      try { cancel(); } catch { /* Already closed. */ }
      reject(error);
    };
    const abort = () => fail(interrupted.signal.reason);
    const timer = setTimeout(() => fail(failure(label)), timeout);
    interrupted.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(start).then(value => {
      if (settled) { try { late(value); } catch { /* Best-effort late disposal. */ } return; }
      settled = true; cleanup(); resolve(value);
    }, error => { if (!settled) { settled = true; cleanup(); reject(error); } });
  });
}
const wait = ms => bounded(() => sleep(ms), 'fixture_wait_timeout', ms + 1000);
const http = (service, path, options = {}) => request(service, path, { ...options, signal: interrupted.signal });
async function connect() {
  db = await bounded(() => connectDatabase(), 'observer_connect_timeout', 10000, undefined, late => late.destroy());
}
async function query(sql, values = []) {
  const connection = db;
  check(connection, 'observer_connection_missing');
  return bounded(() => connection.query(sql, values), 'observer_query_timeout', 5000, () => connection.destroy());
}
async function poll(label, read, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    interrupted.signal.throwIfAborted();
    const value = await read();
    if (predicate(value)) return value;
    await wait(100);
  } while (Date.now() < end);
  throw failure(label + '_timeout');
}
async function docker(args) {
  // Do not race an in-flight stop/start against interruption: restoration must run
  // AFTER it settles, not while Docker might still be stopping the container.
  return (await execute('docker', args, { timeout: 45000, maxBuffer: 1024 * 1024 })).stdout;
}
async function validate() {
  const [value] = JSON.parse(await docker(['inspect', container]));
  check(value.Config.Labels['com.docker.compose.project'] === PROJECT
    && value.Config.Labels['com.docker.compose.service'] === 'mysql'
    && (!mysqlId || value.Id === mysqlId), 'wrong_mysql_container');
  return value;
}
async function leaseState() {
  const [[row]] = await query(`SELECT l.member_identity,l.lease_id,l.phase,l.expires_at,l.last_success_at,
    (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id=l.lease_id) holds
    FROM user_pool_leases l WHERE l.caller_id=?`, [caller]);
  return row;
}
async function holds() {
  const [[row]] = await query(`SELECT (SELECT COUNT(*) FROM user_pool_holds) n,
    (SELECT COUNT(*) FROM user_pool_catalog_holds) c`);
  return { holds: Number(row.n), catalogHolds: Number(row.c) };
}
async function ownerState() {
  const [[row]] = await query(`SELECT owner,owner_until,
    (TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000) now_ms
    FROM user_pool_settings WHERE id=1`);
  return row;
}
async function ready() {
  return poll('mysql_restart_recovery', async () => {
    try { await bounded(() => health(), 'fixture_health_timeout'); return true; }
    catch { interrupted.signal.throwIfAborted(); return false; }
  }, Boolean, 100000);
}

function readHeldStream(id) {
  const state = { status: null, text: '', messageStart: false, settled: false, readFailed: false,
    chunks: 0, receivedBytes: 0, startedAt: Date.now(), firstChunkAt: null, lastChunkAt: null,
    eof: false, cleanupFallback: false, signal: { aborted: false } };
  const timeoutSignal = AbortSignal.timeout(60000);
  const signal = AbortSignal.any([interrupted.signal, streamController.signal, timeoutSignal]);
  const onAbort = () => {
    state.signal = { aborted: true, at: Date.now(), reason: errorInfo(signal.reason),
      source: interrupted.signal.aborted ? 'fixture' : streamController.signal.aborted ? 'cleanup' : 'stream_timeout' };
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let reader;
  const options = inferOptions(caller, '/v1/messages', `POOL_TEST:${JSON.stringify({ id, streamMode: 'hold' })}`, true);
  const done = (async () => {
    const decoder = new TextDecoder();
    try {
      const response = await fetch(urls.proxy2 + '/v1/messages', {
        ...options, headers: { ...options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(options.body), redirect: 'error', signal,
      });
      state.status = response.status;
      check(state.status === 200 && response.headers.get('content-type')?.includes('text/event-stream')
        && response.body, 'held_stream_not_sse');
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { state.eof = true; break; }
        state.chunks++;
        state.receivedBytes += value.byteLength;
        state.lastChunkAt = Date.now();
        state.firstChunkAt ??= state.lastChunkAt;
        state.text += decoder.decode(value, { stream: true });
        check(state.text.length < 4 * 1024 * 1024, 'held_stream_size_bound');
        if (!state.messageStart) {
          // Only complete data frames count; headers and heartbeat comments do not.
          state.messageStart = state.text.split(/\r?\n\r?\n/).slice(0, -1).some(frame => {
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trim()).join('\n');
            try { return JSON.parse(data).type === 'message_start'; } catch { return false; }
          });
        }
      }
    } catch (error) {
      state.readFailed = true;
      state.readError = errorInfo(error);
      if (error?.fixtureCheck) state.failure = error.message;
    } finally {
      state.text += decoder.decode();
      try { reader?.releaseLock(); } catch (error) { state.releaseError = errorInfo(error); }
      signal.removeEventListener('abort', onAbort);
      state.settled = true;
      state.settledAt = Date.now();
    }
    return state;
  })();
  // Exposed only to this harness: reader.cancel() is a bounded cleanup fallback
  // for runtimes where aborting fetch leaves a pending body read unresolved.
  return { state, done, get reader() { return reader; } };
}

try {
  await bounded(() => health(), 'fixture_health_timeout');
  const before = await bounded(() => pool('proxy2', true), 'fixture_pool_timeout');
  check(before.settings.paused === 1 && before.counts.ready_idle >= 8, 'paused_ready_fixture_required');
  mysqlId = (await validate()).Id;
  await connect();
  successful(await http('proxy', '/v1/messages', inferOptions(caller, '/v1/messages',
    `POOL_TEST:${JSON.stringify({ id: prefix + '-baseline' })}`)), '/v1/messages', false);
  // HTTP completion precedes the asynchronous SQL renewal. Snapshot only its
  // committed active lease after the baseline request's hold has been removed.
  const lease = await poll('baseline_active_drained', leaseState,
    row => row?.phase === 'active' && row.last_success_at !== null && Number(row.holds) === 0);
  const owner = await ownerState();
  check(owner.owner && Number(owner.owner_until) > Number(owner.now_ms), 'live_scheduler_owner_missing');
  check(Number(lease.expires_at) - Number(owner.now_ms) > 180000, 'baseline_lease_ttl_too_short');
  const initial = JSON.parse(await docker(['inspect', PROJECT + '-proxy-1', PROJECT + '-proxy2-1']));
  const held = prefix + '-held';
  const reading = readHeldStream(held);
  stream = reading;
  await poll('live_held_sse', async () => {
    check(!reading.state.failure, reading.state.failure ?? 'held_stream_failure');
    check(!reading.state.settled, 'held_stream_ended_before_mysql_stop');
    const row = await leaseState();
    const seen = (await bounded(() => mock(), 'fixture_mock_timeout')).inference.filter(record => record.marker === held);
    check(seen.length <= 1, 'held_stream_replayed_before_stop');
    return reading.state.messageStart && Number(row?.holds) === 1 && seen.length === 1
      && seen[0].identity === lease.member_identity && seen[0].stream === true
      && seen[0].status === 200 && seen[0].outcome === 'pending';
  }, Boolean, 10000);
  check(!reading.state.settled && !reading.state.text.includes('message_stop'), 'held_stream_not_live_at_stop');
  db.destroy(); db = undefined;
  interrupted.signal.throwIfAborted();
  const started = Date.now();
  stopped = true;
  await docker(['stop', '-t', '2', container]);
  const stoppedAt = Date.now();
  interrupted.signal.throwIfAborted();
  for (const service of ['proxy', 'proxy2']) {
    const result = await http(service, '/v1/messages', {
      ...inferOptions('sha256:' + hash(prefix + service), '/v1/messages',
        `POOL_TEST:${JSON.stringify({ id: prefix + '-denied-' + service })}`), timeout: 12000,
    });
    report.failClosedStatuses.push({ service, status: result.status });
    // A raw driver error yielding 500 is an API mapping defect, not success.
    status(result, 503, result.status === 500 ? 'db_down_raw_storage_error' : 'db_down_fail_closed');
  }
  await wait(Math.max(0, 35000 - (Date.now() - stoppedAt)));
  await docker(['start', container]);
  stopped = false;
  report.unavailableMs = Date.now() - stoppedAt;
  await ready();
  await connect();
  const after = await bounded(() => pool('proxy2', true), 'fixture_pool_timeout');
  check(JSON.stringify(before.settings) === JSON.stringify(after.settings), 'restart_reseeded_settings');
  // Inspect SQL and the mock independently BEFORE waiting for client transport.
  // A stuck bridge/reader must not hide whether the proxy cancelled upstream and
  // preserved the lease. Persist each observation even if the next one hangs.
  report.afterRecovery = { at: Date.now(), streamBeforeAwait: streamSnapshot() };
  report.afterRecovery.holds = await holds();
  writeReport();
  const retained = await leaseState();
  report.afterRecovery.lease = retained;
  writeReport();
  report.afterRecovery.mock = (await bounded(() => mock(), 'fixture_mock_timeout')).inference
    .filter(record => record.marker === held)
    .map(({ marker, identity, status, stream, outcome, startedAt, endedAt }) =>
      ({ marker, identity, status, stream, outcome, startedAt, endedAt }));
  writeReport();
  const response = await bounded(() => stream.done, 'held_stream_drain_timeout', 65000);
  check(!response.failure, response.failure ?? 'held_stream_failure');
  check(response.messageStart && !response.text.includes('message_stop'), 'held_stream_falsely_completed');
  check(!response.cleanupFallback && !response.signal.aborted, 'held_stream_required_client_cancellation');
  check(response.readFailed && !response.eof, 'held_stream_transport_did_not_abort');
  check(retained && retained.phase === lease.phase && retained.lease_id === lease.lease_id
    && retained.member_identity === lease.member_identity && retained.expires_at === lease.expires_at
    && retained.last_success_at === lease.last_success_at, 'restart_or_failed_stream_changed_lease');
  await poll('fresh_live_owner', ownerState, row => row.owner && row.owner !== owner.owner
    && Number(row.owner_until) > Number(row.now_ms), 20000);
  const procAfter = JSON.parse(await docker(['inspect', PROJECT + '-proxy-1', PROJECT + '-proxy2-1']));
  check(procAfter.every((value, i) => value.Id === initial[i].Id
    && value.State.StartedAt === initial[i].State.StartedAt
    && value.RestartCount === initial[i].RestartCount), 'proxy_restarted_to_recover');
  for (const service of ['proxy', 'proxy2']) successful(await http(service, '/v1/messages', inferOptions(caller,
    '/v1/messages', `POOL_TEST:${JSON.stringify({ id: prefix + '-after-' + service })}`)), '/v1/messages', false);
  const drained = await poll('final_holds_drained', holds, value => value.holds === 0 && value.catalogHolds === 0, 20000);
  const seen = (await bounded(() => mock(), 'fixture_mock_timeout')).inference.filter(record => record.marker?.startsWith(prefix));
  check(!seen.some(record => record.marker.includes('-denied-')), 'db_down_request_forwarded');
  check(new Set(seen.map(record => record.marker)).size === seen.length, 'restart_inference_replay');
  check(seen.length === 4 && seen.some(record => record.marker === held), 'restart_upstream_markers_missing');
  status(await http('proxy2', `/api/user-pool/leases/${lease.lease_id}/release`,
    { method: 'POST', headers: auth, body: { confirm: true } }), 200, 'release_restart_lease');
  report.passed = true;
  report.wallMs = Date.now() - started;
  report.failClosed = report.failClosedStatuses.length;
  report.proxyRestarts = 0;
  report.ownerChanged = true;
  Object.assign(report, drained);
  report.upstreamMarkers = seen.length;
} catch (error) {
  report.passed = false;
  report.failure = error?.fixtureCheck ? error.message : 'fixture_or_transport_failure';
  report.error = errorInfo(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  report.cleanup = { startedAt: Date.now(), streamBeforeCancel: streamSnapshot() };
  // Reader cancellation is diagnostic cleanup, never evidence that the proxy
  // itself interrupted the stream. Persist failure before attempting it.
  if (stream && !stream.state.settled) {
    stream.state.cleanupFallback = true;
    report.passed = false;
    report.failure ??= 'held_stream_required_cleanup';
    process.exitCode = 1;
  }
  try { writeReport(); } catch { report.reportWriteFailed = true; report.passed = false; process.exitCode = 1; }
  streamController.abort(failure('fixture_stream_cleanup'));
  db?.destroy();
  if (stopped) {
    try {
      await validate();
      await docker(['start', container]);
      stopped = false;
      report.mysqlRestored = true;
    } catch {
      report.mysqlRestored = false;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  // Keep signal handlers installed through restoration; a second signal must not
  // turn a disposable outage into a permanently stopped fixture.
  if (stream) {
    report.cleanup.abortDrain = await cleanupWait(() => stream.done, 1500);
    if (!report.cleanup.abortDrain.settled) {
      stream.state.cleanupFallback = true;
      report.passed = false;
      report.failure ??= 'held_stream_cleanup_timeout';
      process.exitCode = 1;
      report.cleanup.readerExposed = Boolean(stream.reader);
      report.cleanup.readerCancel = await cleanupWait(() => stream.reader?.cancel(failure('fixture_reader_cleanup')), 1500);
      report.cleanup.cancelDrain = await cleanupWait(() => stream.done, 1500);
    }
  }
  report.cleanup.finishedAt = Date.now();
  try { writeReport(); } catch { report.reportWriteFailed = true; report.passed = false; process.exitCode = 1; }
  console.log(JSON.stringify(report));
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  clearTimeout(hardTimer);
  // Normally the process exits naturally. Lingering runtime/socket handles get
  // a final non-passing report and exit instead of hanging the fixture forever.
  setTimeout(hardExit, 5000).unref();
}
