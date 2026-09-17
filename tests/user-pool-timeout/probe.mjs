// Run only inside run.py's fresh internal Docker project; zero external targets.
// --self-check performs pure fixture assertions, NOT HTTP/SQL/runtime testing.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const INTERNAL = 'timeout-fixture-internal-only';
const API_KEY = 'timeout-fixture-api-only';
const MODEL = 'claude-opus-5-2';
const origins = { old: 'http://proxy:3000', new: 'http://new:3000', mock: 'http://mock:8002', sso: 'http://sso:7001' };
const cases = [
  { id: 'new350', service: 'new', delayMs: 350000, expect: 'complete', seconds: 350 },
  { id: 'new600', service: 'new', delayMs: 700000, expect: 'timeout', seconds: 600 },
  { id: 'old120', service: 'old', delayMs: 700000, expect: 'timeout', seconds: 120 },
  { id: 'cancel5', service: 'new', delayMs: 700000, expect: 'cancel', seconds: 5 },
].map(item => ({ ...item, caller: `sha256:${createHash('sha256').update(`timeout-fixture-${item.id}`).digest('hex')}` }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, label) => { if (!value) throw Object.assign(new Error(label), { fixture: true }); };
const pass = (name, evidence = {}) => console.log(JSON.stringify({ case: name, status: 'PASS', ...evidence }));
const now = () => performance.now();

function bodyFor(item, warm = false) {
  return { model: MODEL, stream: !warm, max_tokens: 16, messages: [{ role: 'user',
    content: `Reply OK. POOL_TEST:${JSON.stringify({ id: warm ? `bind-${item.id}` : item.id, ...(warm ? {} : { delayMs: item.delayMs }) })}` }] };
}

function httpOnce(service, path, { method = 'GET', body, headers = {}, cancelMs, limitMs = 10000 } = {}) {
  check(Object.hasOwn(origins, service) && path.startsWith('/') && !path.startsWith('//'), 'target_not_fixture');
  return new Promise(resolve => {
    const started = now();
    let status = null, firstByteMs = null, text = '', bytes = 0, clientCancelled = false, settled = false;
    let abortTimer, limitTimer;
    const request = http.request(origins[service] + path, { method, headers: { ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
    const finish = (transport, code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(abortTimer); clearTimeout(limitTimer);
      let data;
      try { data = JSON.parse(text); } catch { /* SSE / aborted response */ }
      resolve({ status, firstByteMs, elapsedSeconds: (now() - started) / 1000, text, bytes,
        transport, code, clientCancelled, data, terminal: /event: message_stop\r?\n/.test(text) });
    };
    request.once('response', response => {
      status = response.statusCode;
      response.on('data', chunk => {
        firstByteMs ??= now() - started;
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { finish('body_limit'); request.destroy(); return; }
        text += chunk.toString('utf8');
      });
      response.once('end', () => finish('end'));
      response.once('aborted', () => finish('aborted'));
      response.once('error', error => finish('error', error.code ?? 'response_error'));
      response.once('close', () => { if (!response.complete) finish('aborted'); });
    });
    request.once('error', error => finish(clientCancelled ? 'client_cancel' : 'error', error.code ?? 'request_error'));
    if (cancelMs) abortTimer = setTimeout(() => {
      clientCancelled = true; request.destroy(); finish('client_cancel');
    }, cancelMs);
    limitTimer = setTimeout(() => { finish('client_watchdog'); request.destroy(); }, limitMs);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function json(service, path, { method = 'GET', body, status = 200 } = {}) {
  const result = await httpOnce(service, path, { method, body, headers: { 'X-Internal-Token': INTERNAL } });
  check(result.transport === 'end' && result.status === status && result.data, `api_${service}_${status}_failed`);
  return result.data;
}
const pool = (service = 'old') => json(service, '/api/user-pool');
const mock = () => json('mock', '/test/state');
async function settings(changes) {
  const before = await json('old', '/api/user-pool/summary');
  return json('old', '/api/user-pool/settings', { method: 'PATCH', body: { expectedVersion: before.settings.version, changes } });
}
async function poll(label, read, predicate, seconds = 15) {
  const end = now() + seconds * 1000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(250);
  } while (now() < end);
  check(false, label);
}
function verifyOutcome(item, result) {
  check(result.status === 200 && result.firstByteMs !== null && result.firstByteMs < 5000, `${item.id}_initial_sse_missing`);
  check(!result.text.includes('event: error'), `${item.id}_in_band_error`);
  if (item.expect === 'complete') {
    check(result.transport === 'end' && result.terminal && !result.clientCancelled, `${item.id}_terminal_missing`);
    check(result.elapsedSeconds >= 348 && result.elapsedSeconds <= 365, `${item.id}_duration`);
    check(result.text.includes(MODEL), `${item.id}_canonical_model`);
  } else if (item.expect === 'timeout') {
    check(['aborted', 'error'].includes(result.transport) && !result.terminal && !result.clientCancelled, `${item.id}_not_server_abort`);
    check(result.elapsedSeconds >= item.seconds - 3 && result.elapsedSeconds <= item.seconds + 12, `${item.id}_deadline_not_observed`);
  } else {
    check(result.clientCancelled && !result.terminal && result.elapsedSeconds >= 4.5 && result.elapsedSeconds <= 8, 'cancel_not_client_initiated');
  }
}

function selfCheck() {
  assert.equal(cases.length, 4);
  assert.equal(new Set(cases.map(item => item.caller)).size, 4);
  assert.equal(cases.filter(item => item.service === 'old').length, 1);
  const sample = { status: 200, firstByteMs: 20, text: MODEL, transport: 'aborted', terminal: false,
    clientCancelled: false, elapsedSeconds: 600 };
  verifyOutcome(cases[1], sample);
  for (const mutation of [{ elapsedSeconds: 120 }, { elapsedSeconds: 300 }, { transport: 'end' },
    { transport: 'client_watchdog' }, { terminal: true }, { clientCancelled: true }]) {
    assert.throws(() => verifyOutcome(cases[1], { ...sample, ...mutation }));
  }
  verifyOutcome(cases[0], { ...sample, elapsedSeconds: 350, transport: 'end', terminal: true });
  assert.equal(bodyFor(cases[0]).stream, true);
  assert.equal(bodyFor(cases[0], true).stream, false);
  pass('probe_self_check', { runtimeExecuted: false, checks: ['four_distinct_callers', 'reject_120_300_early_cutoff',
    'reject_clean_eof_without_terminal', 'reject_client_watchdog_as_timeout', '350_terminal_success_contract'] });
}

async function main() {
  check(process.env.TIMEOUT_FIXTURE_EXECUTE === '1', 'execution_guard_required');
  check(/^[a-f0-9]{64}$/.test(process.env.BASELINE_FINGERPRINT ?? ''), 'old_fingerprint_required');
  const require = createRequire('/app/package.json');
  const mysql = require('mysql2/promise');
  const db = await mysql.createConnection({ host: 'mysql', port: 3306, user: 'pool_fixture',
    password: 'timeout-fixture-db-only', database: 'ghcp_pool_timeout_test', connectTimeout: 5000,
    timezone: 'Z', supportBigNumbers: true, bigNumberStrings: false, multipleStatements: false });
  const query = async sql => (await db.query({ sql, timeout: 8000 }))[0];
  const state = async () => {
    const [meta] = await query(`SELECT DATABASE() db, config_fingerprint, paused,
      (TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000) now_ms
      FROM user_pool_settings WHERE id=1`);
    check(meta?.db === 'ghcp_pool_timeout_test' && meta.config_fingerprint === process.env.BASELINE_FINGERPRINT,
      'shared_database_or_fingerprint_changed');
    const leases = await query(`SELECT l.caller_id,l.lease_id,l.member_identity,l.last_success_at,l.expires_at lease_expires_at,
      h.request_id,h.deadline_at,h.expires_at hold_expires_at,h.generation
      FROM user_pool_leases l LEFT JOIN user_pool_holds h ON h.lease_id=l.lease_id ORDER BY l.caller_id`);
    const [{ orphans }] = await query(`SELECT COUNT(*) orphans FROM user_pool_holds h
      LEFT JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE l.lease_id IS NULL`);
    check(Number(orphans) === 0, 'orphan_holds');
    return { ...meta, leases };
  };
  const evidence = [];
  let watchdog;
  try {
    watchdog = setTimeout(() => { console.log(JSON.stringify({ case: 'probe_watchdog', status: 'FAIL' })); process.exit(1); }, 710000);
    for (const service of ['old', 'new']) {
      const ready = await json(service, '/readyz');
      check(ready.storage === 'mysql', 'proxy_not_mysql');
    }
    check((await json('sso', '/healthz')).status !== 'error', 'real_sso_not_healthy');
    const initial = await pool();
    const empty = await mock();
    check(initial.counts.total === 0 && empty.fixture && empty.users.length === 0 && empty.tasks.length === 0 && empty.inference.length === 0,
      'fresh_pool_and_mock_required');
    check((await state()).leases.length === 0, 'fresh_sql_leases_required');
    pass('old_and_new_same_database_unchanged_fingerprint', { fingerprint: process.env.BASELINE_FINGERPRINT });
    // A 60s lease deliberately expires while the 600s SQL holds remain live.
    // Old scheduler and old API must not reclaim those in-flight members.
    await settings({ paused: 0, idle_target: 4, max_accounts: 4, lease_seconds: 60 });
    await poll('prewarm_four_timed_out', () => pool(), value => value.counts.ready_idle === 4 && value.counts.provisioning === 0, 80);
    await settings({ paused: 1, idle_target: 0 });
    const warmed = await mock();
    check(warmed.counters.scimCreates === 4 && warmed.counters.taskPosts === 4 && warmed.counters.callbacksSucceeded === 4
      && warmed.counters.callbacksFailed === 0 && warmed.seats.length === 4, 'real_sso_mock_provisioning_not_exactly_four');
    for (const item of cases) {
      const bind = await httpOnce(item.service, '/v1/messages', { method: 'POST', body: bodyFor(item, true),
        headers: { Authorization: `Bearer ${API_KEY}`, 'X-User-Identity': item.caller } });
      check(bind.status === 200 && bind.transport === 'end' && bind.data?.content?.[0]?.text === 'OK', 'bind_failed');
    }
    const baseline = await poll('bindings_not_drained', state, value => value.leases.length === 4 && value.leases.every(row => !row.request_id));
    check(new Set(baseline.leases.map(row => row.member_identity)).size === 4, 'members_not_distinct');
    for (const item of cases) item.baseline = baseline.leases.find(row => row.caller_id === item.caller);
    pass('four_real_prewarmed_distinct_members', { members: 4, provisioningCallbacks: 4, leaseSeconds: 60 });
    const started = now();
    for (const item of cases) {
      item.pending = httpOnce(item.service, '/v1/messages', { method: 'POST', body: bodyFor(item),
        headers: { Authorization: `Bearer ${API_KEY}`, 'X-User-Identity': item.caller },
        cancelMs: item.expect === 'cancel' ? 5000 : undefined, limitMs: 630000,
      }).then(result => { item.result = result; return result; });
    }
    const admitted = await poll('four_sql_holds_missing', state, value => value.leases.filter(row => row.request_id).length === 4, 4);
    for (const item of cases) {
      item.hold = admitted.leases.find(row => row.caller_id === item.caller);
      const expected = item.service === 'old' ? 120000 : 600000;
      check(item.hold.deadline_at - admitted.now_ms >= expected - 5000 && item.hold.deadline_at - admitted.now_ms <= expected + 1000,
        `${item.id}_wrong_sql_deadline`);
      check(item.hold.hold_expires_at - item.hold.deadline_at === 10000, `${item.id}_wrong_hold_grace`);
    }
    pass('concurrent_sql_deadlines_120_and_600', { requests: 4, graceMs: 10000,
      sql: cases.map(item => ({ id: item.id, remainingMs: item.hold.deadline_at - admitted.now_ms,
        deadlineAt: item.hold.deadline_at, expiresAt: item.hold.hold_expires_at })) });
    let beyond300 = false;
    while (cases.some(item => !item.checked)) {
      const elapsed = (now() - started) / 1000;
      // Reading old's pool invokes its actual SQL sweep; no synthetic time travel.
      const oldView = await pool('old');
      const current = await state();
      const active = cases.filter(item => !item.result && item.expect !== 'cancel');
      for (const item of active) {
        const row = current.leases.find(lease => lease.caller_id === item.caller);
        // Allow only the final 2s race between SQL deadline and HTTP close callback.
        if (elapsed >= item.seconds - 2) continue;
        check(row?.request_id === item.hold.request_id && row.lease_id === item.baseline.lease_id && row.member_identity === item.baseline.member_identity,
          `${item.id}_old_reclaimed_live_hold`);
        check(row.deadline_at === item.hold.deadline_at && row.hold_expires_at === item.hold.hold_expires_at,
          `${item.id}_heartbeat_moved_deadline`);
        check(row.last_success_at === item.baseline.last_success_at, `${item.id}_premature_renewal`);
        check(oldView.leases.some(lease => lease.leaseId === row.lease_id), `${item.id}_old_api_missing_held_lease`);
        if (item.service === 'new') {
          const release = await json('old', `/api/user-pool/leases/${row.lease_id}/release`,
            { method: 'POST', body: { confirm: true }, status: 409 });
          check(release.error?.code === 'lease_in_use', `${item.id}_cross_old_release_unprotected`);
        }
      }
      if (!beyond300 && elapsed >= 305) {
        check(cases.slice(0, 2).every(item => !item.result), 'new_streams_did_not_survive_300');
        beyond300 = true;
        pass('new_streams_survive_120_and_300_old_reclaim_attempts', { elapsedSeconds: Math.round(elapsed) });
      }
      for (const item of cases.filter(candidate => candidate.result && !candidate.checked)) {
        verifyOutcome(item, item.result);
        const logs = await poll(`${item.id}_mock_disconnect_missing`, mock, value => value.inference.some(row => row.marker === item.id && row.outcome !== 'pending'));
        const records = logs.inference.filter(row => row.marker === item.id);
        check(records.length === 1 && records[0].identity === item.baseline.member_identity, `${item.id}_replay_or_rotation`);
        check(records[0].outcome === (item.expect === 'complete' ? 'complete' : 'cancelled'), `${item.id}_wrong_mock_outcome`);
        const mockSeconds = (records[0].endedAt - records[0].startedAt) / 1000;
        check(Math.abs(mockSeconds - item.result.elapsedSeconds) < 5, `${item.id}_upstream_not_cancelled_promptly`);
        const drained = await poll(`${item.id}_sql_hold_not_drained`, state,
          value => !value.leases.some(row => row.request_id === item.hold.request_id));
        const retained = drained.leases.find(row => row.caller_id === item.caller);
        if (item.expect === 'complete') {
          check(retained && retained.last_success_at > item.baseline.last_success_at, 'successful_stream_not_renewed');
        } else if (retained) {
          check(retained.last_success_at === item.baseline.last_success_at && retained.lease_expires_at === item.baseline.lease_expires_at,
            `${item.id}_failed_stream_renewed`);
        }
        check(/^[a-f0-9-]{36}$/.test(item.baseline.lease_id), 'invalid_fixture_lease_id');
        const expectedDetail = item.expect === 'complete' ? 'success' : 'not_renewed';
        await poll(`${item.id}_finish_cause_not_recorded`, () => query(`SELECT detail FROM user_pool_events WHERE action='request_finished'
          AND lease_id='${item.baseline.lease_id}' ORDER BY id DESC LIMIT 1`), rows => rows[0]?.detail === expectedDetail);
        item.checked = true;
        const itemEvidence = { id: item.id, elapsedSeconds: Number(item.result.elapsedSeconds.toFixed(3)),
          mockElapsedSeconds: Number(mockSeconds.toFixed(3)), transport: item.result.transport, terminal: item.result.terminal,
          clientCancelled: item.result.clientCancelled, mockOutcome: records[0].outcome,
          sqlHoldRemoved: true, renewed: item.expect === 'complete', upstreamCount: records.length };
        evidence.push(itemEvidence);
        pass(item.id, itemEvidence);
      }
      if (cases.some(item => !item.checked)) await sleep(5000);
    }
    check(beyond300, 'missing_300_second_observation');
    const final = await poll('remaining_holds', state, value => value.leases.every(row => !row.request_id));
    const finalMock = await mock();
    check(finalMock.counters.scimCreates === 4 && finalMock.counters.taskPosts === 4 && finalMock.counters.callbacksSucceeded === 4,
      'unexpected_reprovisioning');
    pass('all_runtime_cases', { elapsedSeconds: Number(((now() - started) / 1000).toFixed(3)),
      fingerprint: final.config_fingerprint, results: evidence, requestsRetried: 0 });
  } finally {
    clearTimeout(watchdog);
    await db.end();
  }
}

if (process.argv.includes('--self-check')) selfCheck();
else main().catch(error => {
  console.log(JSON.stringify({ case: 'runtime_failure', status: 'FAIL',
    reason: error.fixture === true && /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'fixture_transport_or_sql_error' }));
  process.exit(1);
});
