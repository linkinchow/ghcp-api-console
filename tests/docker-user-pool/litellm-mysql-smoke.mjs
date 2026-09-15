#!/usr/bin/env node
// Node >=22, built-ins only. Never starts services, loads .env, or runs Docker.
// Actual v1.99.1 HTTP auth + Router -> HAProxy -> two MySQL Proxies -> mock.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const PROJECT = 'ghcp-user-pool-mysql-test';
const MODEL = 'claude-opus-5-2', RAW_MODEL = 'claude-opus-5.2';
const MASTER = 'sk-mysql-fixture-gateway-master-only';
const INTERNAL = 'mysql-fixture-internal-only';
const URLS = Object.freeze({ proxy: 'http://127.0.0.1:18100', proxy2: 'http://127.0.0.1:18101',
  mock: 'http://127.0.0.1:18102', litellm: 'http://127.0.0.1:18103', stats: 'http://127.0.0.1:18107' });
const INTERNAL_HEADERS = { 'X-Internal-Token': INTERNAL };
const MASTER_HEADERS = { Authorization: `Bearer ${MASTER}` };
const HELP = `Usage: node tests/docker-user-pool/litellm-mysql-smoke.mjs --confirm-local-fixture

ONLY the disposable compose.mysql.yaml + compose.stability.yaml gateway profile.
Pinned actual LiteLLM v1.99.1 + its isolated Postgres + the EXISTING user_pool_hook.
Fixed loopback bridge ports 18100/18101/18102/18103/18107; no env/URL/secret overrides.
Requires BOTH healthy MySQL Proxies, PAUSED worker, >=3 ready idle members, no leases,
no pending mock faults, and EXCLUSIVE use (stop the soak first). Inventory need not
be empty. No global pool settings, Login, seats, OAuth, or production code changes.
Creates real synthetic virtual keys through /user/new + /key/generate. Master key
is management-only, not passed off as a virtual key. Revokes keys and releases only
this run's leases in finally. Leaves synthetic user audit rows in disposable DB.
Raw keys remain in memory, never in URLs, output, or report. --help does no I/O.
Writes a redacted JSON report into a new OS temporary directory. Never retries an
inference POST: every marker must have exactly one mock attempt (or zero for auth
rejection); fallback must have one recorded 503 primary + one successful target.
`;

export function check(condition, label) {
  if (!condition) throw Object.assign(new Error(label), { fixtureCheck: true });
}
export function safeFailure(error) {
  return error?.fixtureCheck === true && /^[a-z0-9_]+$/.test(error.message)
    ? error.message : 'unexpected_fixture_or_transport_failure';
}
export const callerHash = raw => `sha256:${createHash('sha256').update(raw).digest('hex')}`;
export function parseSse(text) {
  return text.replaceAll('\r\n', '\n').split('\n\n').flatMap(frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return [];
    if (data === '[DONE]') return [data];
    try { return [JSON.parse(data)]; } catch { check(false, 'invalid_json_sse_frame'); }
  });
}
// HAProxy's CSV fields used here contain no commas/quotes; nevertheless handle
// quoted cells so a harmless banner/description cannot shift counter columns.
export function parseStats(text) {
  const lines = text.trim().split(/\r?\n/);
  const cells = line => {
    const fields = []; let field = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
      } else if (char === ',' && !quoted) { fields.push(field); field = ''; } else field += char;
    }
    check(!quoted, 'invalid_haproxy_csv');
    fields.push(field); return fields;
  };
  check(lines[0]?.startsWith('# '), 'missing_haproxy_csv_header');
  const names = cells(lines[0].slice(2));
  check(['pxname', 'svname', 'status', 'hrsp_2xx'].every(name => names.includes(name)), 'missing_haproxy_counters');
  const result = {};
  for (const line of lines.slice(1)) {
    const values = cells(line), row = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    if (row.pxname !== 'proxies' || !['proxy', 'proxy2'].includes(row.svname)) continue;
    check(!Object.hasOwn(result, row.svname), 'duplicate_haproxy_server');
    check(row.status === 'UP' && /^\d+$/.test(row.hrsp_2xx), 'haproxy_backend_not_up');
    const successes = Number(row.hrsp_2xx);
    check(Number.isSafeInteger(successes), 'invalid_haproxy_counter');
    result[row.svname] = successes;
  }
  check(Object.keys(result).length === 2, 'two_haproxy_backends_required');
  return result;
}
export function backendDelta(before, after, expected) {
  const delta = Object.fromEntries(['proxy', 'proxy2'].map(server => [server, after[server] - before[server]]));
  check(Object.values(delta).every(value => Number.isSafeInteger(value) && value > 0), 'both_backends_must_receive_same_caller');
  check(delta.proxy + delta.proxy2 === expected, 'concurrent_traffic_or_http_replay');
  return delta;
}
export function success(response, route, streaming) {
  check(response.status === 200, `gateway_inference_http_${response.status}`);
  check(response.headers.get('x-litellm-version') === '1.99.1', 'unexpected_litellm_version');
  if (!streaming) {
    check(response.data?.model === MODEL, 'noncanonical_gateway_model');
    check(route === 'messages'
      ? response.data.type === 'message' && response.data.content?.some(block => block.text === 'OK') && response.data.stop_reason
      : response.data.object === 'chat.completion' && response.data.choices?.some(choice => choice.message?.content === 'OK' && choice.finish_reason),
    'invalid_gateway_json_completion');
    return;
  }
  check(response.headers.get('content-type')?.includes('text/event-stream'), 'missing_gateway_sse_type');
  const events = parseSse(response.text);
  check(!events.some(event => event?.error || event?.type === 'error'), 'in_band_gateway_sse_error');
  if (route === 'messages') {
    check(events.some(event => event?.type === 'message_start') && events.some(event => event?.type === 'message_stop'), 'missing_messages_sse_terminal');
    check(events.filter(event => event?.delta?.type === 'text_delta').map(event => event.delta.text).join('') === 'OK', 'missing_messages_sse_text');
  } else {
    check(events.includes('[DONE]') && events.some(event => event?.choices?.some(choice => choice.finish_reason)), 'missing_chat_sse_terminal');
    check(events.flatMap(event => event?.choices ?? []).map(choice => choice.delta?.content ?? '').join('') === 'OK', 'missing_chat_sse_text');
  }
  const models = events.flatMap(event => [event?.model, event?.message?.model]).filter(value => typeof value === 'string');
  check(models.length > 0 && models.every(model => model === MODEL), 'noncanonical_gateway_sse_model');
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  if (args.length !== 1 || args[0] !== '--confirm-local-fixture') {
    console.error('FAIL explicit_local_fixture_confirmation_required'); return 1;
  }
  const runId = `lmg-${randomUUID().slice(0, 12)}`, keys = [], secrets = new Set([MASTER, INTERNAL]);
  const report = { schemaVersion: 1, project: PROJECT, runId, startedAt: new Date().toISOString(),
    image: 'ghcr.io/berriai/litellm:v1.99.1', outcome: 'running', checks: [], limitations: [
      'Synthetic local credentials and mock model outputs only; no real GitHub, seats, models, or production authentication.',
      'Postgres key CRUD/role/cache-revocation checked; Postgres restart durability is not checked.',
      'Crossbackend proof requires exclusive traffic; HAProxy healthchecks are not business hrsp_2xx responses.',
      'Fixture manifests constrain targets but cannot independently prove container egress isolation; Compose must enforce internal-only networking.',
      'Synthetic user audit rows remain in the disposable gateway Postgres; all generated virtual keys are revoked.',
    ] };
  let serial = 0, confirmed = false, failed = false, provisionCounters;
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  function record(label, details = {}) {
    report.checks.push({ status: 'PASS', label, ...details });
    console.log(`PASS ${label} ${JSON.stringify(details)}`);
  }
  async function scenario(label, operation) {
    const started = Date.now();
    const details = await operation();
    record(label, { durationMs: Date.now() - started, ...(details ?? {}) });
  }
  async function request(service, path, { method = 'GET', body, headers = {}, timeout = 45000, cleanup = false } = {}) {
    check(Object.hasOwn(URLS, service) && path.startsWith('/') && !path.startsWith('//'), 'invalid_fixed_fixture_target');
    const response = await fetch(URLS[service] + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: cleanup ? AbortSignal.timeout(timeout) : AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]) });
    const reader = response.body?.getReader(), chunks = []; let bytes = 0;
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; check(bytes <= 16 * 1024 * 1024, 'response_size_exceeded'); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString('utf8'); let data;
    try { data = JSON.parse(text); } catch { /* CSV, SSE, or non-JSON failure. */ }
    return { status: response.status, headers: response.headers, text, data };
  }
  function ok(response, label, statuses = [200]) {
    check(statuses.includes(response.status), `${label}_http_${response.status}`); return response.data;
  }
  async function poll(label, read, predicate, timeout = 15000) {
    const end = Date.now() + timeout;
    do {
      const result = await read(); if (predicate(result)) return result;
      if (abort.signal.aborted) check(false, 'runner_interrupted');
      await delay(150);
    } while (Date.now() < end);
    check(false, `${label}_timeout`);
  }
  const summary = async (service = 'proxy', cleanup = false) => ok(await request(service, '/api/user-pool/summary', { headers: INTERNAL_HEADERS, cleanup }), 'pool_summary');
  const mock = async (cleanup = false) => {
    const value = ok(await request('mock', '/test/state', { headers: INTERNAL_HEADERS, cleanup }), 'mock_state');
    check(value?.fixture === true && Array.isArray(value.inference) && Array.isArray(value.otherInference), 'invalid_mock_state'); return value;
  };
  const primary = async () => {
    const value = ok(await request('mock', '/__mysql/gateway-state', { headers: INTERNAL_HEADERS }), 'primary_ledger');
    check(value?.fixture === true && Array.isArray(value.primaryAttempts), 'invalid_primary_ledger'); return value.primaryAttempts;
  };
  const stats = async () => {
    const response = await request('stats', '/stats;csv'); ok(response, 'haproxy_stats'); return parseStats(response.text);
  };
  async function leases(key, service = 'proxy', cleanup = false) {
    const value = ok(await request(service, `/api/user-pool/page/leases?page=1&pageSize=100&q=${encodeURIComponent(key.hash)}`,
      { headers: INTERNAL_HEADERS, cleanup }), 'caller_leases');
    check(Array.isArray(value?.items) && value.total === value.items.length && value.items.every(row => row.callerKeyHash === key.hash), 'invalid_caller_lease_page');
    return value.items;
  }
  async function lease(key) {
    const rows = await poll('caller_hold_drain', () => leases(key), rows => rows.length === 1 && !rows[0].inUse);
    const other = await leases(key, 'proxy2');
    check(other.length === 1 && JSON.stringify(rows[0]) === JSON.stringify(other[0]), 'crossbackend_shared_lease_disagrees');
    check(rows[0].phase === 'active' && rows[0].lastSuccessAt > 0 && rows[0].expiresAt > Date.now(), 'lease_not_active');
    return rows[0];
  }
  const mapping = row => JSON.stringify([row.leaseId, row.callerKeyHash, row.memberIdentity]);
  async function verify(attempts, key, previous) {
    const row = await lease(key), state = await mock();
    if (previous) check(mapping(previous) === mapping(row), 'caller_member_rotated');
    for (const attempt of attempts) {
      success(attempt.response, attempt.route, attempt.streaming);
      const records = state.inference.filter(record => record.marker === attempt.marker);
      check(records.length === 1, 'mock_upstream_missing_or_replayed');
      check(records[0].identity === row.memberIdentity && records[0].model === RAW_MODEL && records[0].status === 200
        && records[0].outcome === 'complete' && records[0].stream === attempt.streaming, 'mock_wire_mapping_mismatch');
    }
    return row;
  }
  async function generate(label, models = [MODEL, 'fallback-probe', 'other-only'], metadata = {}) {
    const user = `${runId}-${label}`, alias = user;
    ok(await request('litellm', '/user/new', { method: 'POST', headers: MASTER_HEADERS,
      body: { user_id: user, user_role: 'internal_user', auto_create_key: false, send_invite_email: false } }), 'create_synthetic_user', [200, 201]);
    const value = ok(await request('litellm', '/key/generate', { method: 'POST', headers: MASTER_HEADERS,
      body: { user_id: user, key_alias: alias, models, duration: '1h', metadata: { test_run: runId, ...metadata } } }), 'generate_virtual_key', [200, 201]);
    check(typeof value?.key === 'string' && /^sk-[A-Za-z0-9._-]+$/.test(value.key), 'invalid_generated_virtual_key');
    const key = { label, raw: value.key, hash: callerHash(value.key), user, deleted: false };
    secrets.add(key.raw); keys.push(key); // Track before any subsequent assertion so cleanup always revokes.
    check(key.raw !== MASTER && keys.filter(item => item.hash === key.hash).length === 1, 'generated_virtual_key_not_distinct');
    const info = ok(await request('litellm', `/key/info?key=${key.hash.slice(7)}`, { headers: MASTER_HEADERS }), 'key_info').info;
    check(info?.user_id === user && info.key_alias === alias && models.every(model => info.models.includes(model)), 'db_backed_key_scope_mismatch');
    const ownRole = ok(await request('litellm', '/v2/user/info', { headers: { Authorization: `Bearer ${key.raw}` } }), 'virtual_key_self_role');
    check(ownRole.user_id === user && ownRole.user_role === 'internal_user', 'virtual_key_not_internal_user');
    return key;
  }
  async function revoke(key, cleanup = false) {
    if (key.deleted) return;
    const result = ok(await request('litellm', '/key/delete', { method: 'POST', headers: MASTER_HEADERS,
      body: { keys: [key.hash.slice(7)] }, cleanup }), 'revoke_virtual_key');
    check(result?.deleted_keys?.includes(key.hash.slice(7)), 'key_revocation_not_confirmed'); key.deleted = true;
  }
  async function infer(key, { route = 'messages', streaming = false, model = MODEL, auth = 'bearer', headers = {}, extra = {} } = {}) {
    const marker = `${runId}-${++serial}`;
    const response = await request('litellm', route === 'messages' ? '/v1/messages' : '/v1/chat/completions', {
      method: 'POST', headers: { ...(key ? auth === 'x-api-key' ? { 'x-api-key': key.raw } : { Authorization: `Bearer ${key.raw}` } : {}),
        ...(route === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}), ...headers },
      body: { model, stream: streaming, max_tokens: 16,
        messages: [{ role: 'user', content: `Reply OK. POOL_TEST:${JSON.stringify({ id: marker })}` }], ...extra },
    });
    return { marker, response, route, streaming };
  }
  async function rejected(key, label, allowed = [401, 403], options = {}) {
    const before = await summary(), state = await mock(), primaryBefore = await primary();
    const attempts = [];
    for (const [route, auth] of [['messages', 'x-api-key'], ['messages', 'bearer'], ['chat', 'bearer']]) {
      const item = await infer(key, { route, auth, ...options }); attempts.push(item);
      check(allowed.includes(item.response.status), `${label}_not_rejected_http_${item.response.status}`);
    }
    const after = await summary(), next = await mock();
    check(JSON.stringify(before.counts) === JSON.stringify(after.counts), 'rejected_auth_consumed_inventory');
    check(next.inference.length === state.inference.length && next.otherInference.length === state.otherInference.length
      && (await primary()).length === primaryBefore.length, 'rejected_auth_reached_upstream');
    return { statuses: attempts.map(attempt => attempt.response.status), upstreamAttempts: 0 };
  }
  function counters(state) {
    return JSON.stringify(Object.fromEntries(['scimCreates', 'seatAssignments', 'taskPosts', 'callbacksSucceeded', 'callbacksFailed'].map(name => [name, state.counters[name]])));
  }
  try {
    await scenario('fixture_roles_actual_gateway_and_shared_mysql_ready', async () => {
      for (const [service, expected] of Object.entries({ proxy: 'proxy', proxy2: 'proxy2', mock: 'mock', litellm: 'litellm', stats: 'lbStats' })) {
        const manifest = ok(await request(service, '/__mysql/manifest'), 'fixture_manifest');
        check(manifest.fixture === true && manifest.project === PROJECT && manifest.database === 'ghcp_pool_mysql_test'
          && manifest.service === expected && manifest.mysqlPort === 33184, 'wrong_disposable_fixture_role');
      }
      for (const service of ['proxy', 'proxy2']) check(ok(await request(service, '/readyz'), 'proxy_ready').storage === 'mysql', 'proxy_not_mysql');
      const ready = await poll('gateway_readiness', async () => {
        try { return await request('litellm', '/health/readiness', { headers: MASTER_HEADERS, timeout: 3000 }); }
        catch { return { status: 0 }; }
      }, result => result.status === 200, 120000);
      check(ready.data?.db === 'connected', 'gateway_postgres_not_connected');
      const value = await summary(), state = await mock();
      check(value.enabled === true && value.poolId === 'default' && value.settings.paused === 1
        && value.counts.ready_idle >= 3 && value.counts.leased === 0 && value.counts.provisional === 0 && value.counts.provisioning === 0,
      'require_paused_pool_three_idle_no_existing_leases');
      check(state.nextControl === null, 'pending_mock_fault_control');
      check(ok(await request('mock', '/__mysql/login/api/tasks?page=1&pageSize=100', { headers: INTERNAL_HEADERS }), 'real_login_readonly').total === 0,
        'real_login_must_have_no_tasks');
      await primary(); await stats(); provisionCounters = counters(state); confirmed = true;
      return { gatewayDatabase: 'connected', proxyStorage: 'mysql', readyIdle: value.counts.ready_idle };
    });
    const unauthenticatedSpoof = { headers: { 'X-User-Identity': `sha256:${'f'.repeat(64)}` },
      extra: { extra_headers: { 'x-user-identity': `sha256:${'f'.repeat(64)}` } } };
    await scenario('missing_auth_denied_without_upstream', () => rejected(null, 'missing_auth', [401, 403], unauthenticatedSpoof));
    await scenario('invalid_auth_denied_without_upstream', () => rejected({ raw: 'sk-mysql-fixture-invalid-never-created' }, 'invalid_auth', [401, 403], unauthenticatedSpoof));
    await scenario('master_not_a_virtual_key_and_cannot_allocate', () => rejected({ raw: MASTER }, 'master_key', [403]));
    const a = await generate('caller-a');
    record('real_virtual_key_internal_user_role_and_db_model_permissions');
    const first = await infer(a); const firstLease = await verify([first], a);
    await scenario('same_authenticated_caller_both_haproxy_backends_no_http_replay', async () => {
      // No pool reads, administrative requests, model catalog, or POST retries
      // between these counters. Healthchecks do not increment server hrsp_2xx.
      const before = await stats(), attempts = [];
      for (let i = 0; i < 6; i++) attempts.push(await infer(a, {
        route: i % 2 ? 'chat' : 'messages', auth: i % 2 ? 'bearer' : 'x-api-key', streaming: i >= 2,
      }));
      const after = await stats();
      const delta = backendDelta(before, after, attempts.length);
      await verify(attempts, a, firstLease);
      return { requests: attempts.length, successfulResponsesByBackend: delta, uniqueCallerMembers: 1, uniqueUpstreamAttemptsPerMarker: 1 };
    });
    const b = await generate('caller-b', [MODEL], { ghcp_identity: firstLease.memberIdentity });
    await scenario('forged_identity_overwritten_on_first_allocation_and_reuse', async () => {
      const forged = { 'x-UsEr-IdEnTiTy': a.hash };
      const attempts = [await infer(b, { route: 'chat', headers: forged,
        extra: { extra_headers: forged, metadata: { user_api_key_hash: a.hash.slice(7), ghcp_identity: firstLease.memberIdentity } } })];
      const allocated = await verify(attempts, b);
      check(allocated.memberIdentity !== firstLease.memberIdentity && allocated.callerKeyHash === b.hash, 'spoof_selected_victim_member');
      for (const field of ['headers', 'extra_headers', 'default_headers']) attempts.push(await infer(b, {
        auth: 'x-api-key', headers: forged, extra: { [field]: forged, extra_body: { extra_headers: forged } },
      }));
      await verify(attempts, b, allocated);
      check(mapping(await lease(a)) === mapping(firstLease), 'spoof_changed_victim_mapping');
      return { requests: attempts.length, distinctKeyDistinctMember: true, injectedIdentity: 'sha256_of_authenticated_raw_virtual_key' };
    });
    const other = await generate('other-only', ['other-only']);
    await scenario('model_restricted_virtual_key_cannot_allocate_pool', () => rejected(other, 'model_permission', [400, 401, 403]));
    await scenario('non_pool_provider_not_injected_and_consumes_no_pool_member', async () => {
      const before = await summary(), state = await mock(), result = await infer(other, { model: 'other-only' });
      ok(result.response, 'other_provider_completion');
      check(result.response.data?.content?.some(block => block.text === 'OK'), 'other_provider_output');
      const next = await mock();
      check(next.otherInference.length === state.otherInference.length + 1 && next.otherInference.at(-1).identityHeaderPresent === false,
        'identity_injected_to_non_pool_provider');
      check(next.inference.length === state.inference.length && (await leases(other)).length === 0
        && JSON.stringify((await summary()).counts) === JSON.stringify(before.counts), 'non_pool_provider_allocated_pool');
    });
    const c = await generate('fallback');
    await scenario('actual_router_fallback_one_primary_one_lb_pool_attempt', async () => {
      const before = await primary(), beforeLease = await leases(c);
      check(beforeLease.length === 0, 'fallback_caller_not_fresh');
      const attempt = await infer(c, { model: 'fallback-probe' });
      const row = await verify([attempt], c), after = await primary();
      const records = after.filter(record => record.marker === attempt.marker);
      check(after.length === before.length + 1 && records.length === 1 && records[0].status === 503
        && records[0].identityHeaderPresent === false, 'fallback_primary_attempt_count_or_header');
      check(![firstLease.memberIdentity, (await lease(b)).memberIdentity].includes(row.memberIdentity), 'fallback_caller_shared_member');
      return { primaryHttpStatus: 503, primaryAttempts: 1, poolAttempts: 1, primaryIdentityHeaderPresent: false };
    });
    const revoked = await generate('revoked');
    ok(await request('litellm', '/v1/models', { headers: { Authorization: `Bearer ${revoked.raw}` } }), 'prime_virtual_key_cache');
    await revoke(revoked);
    await scenario('revoked_cached_virtual_key_denied_without_upstream', () => rejected(revoked, 'revoked_auth'));
    await scenario('no_new_login_seats_or_provisioning_from_gateway_tests', async () => {
      check(counters(await mock()) === provisionCounters, 'gateway_mutated_provisioning');
      check(ok(await request('mock', '/__mysql/login/api/tasks?page=1&pageSize=100', { headers: INTERNAL_HEADERS }), 'real_login_readonly').total === 0,
        'gateway_created_real_login_task');
    });
  } catch (error) {
    failed = true;
    const label = safeFailure(error); report.checks.push({ status: 'FAIL', label }); console.error(`FAIL ${label}`);
  } finally {
    // Revocation is attempted independently for every generated key. A release
    // failure must never skip revocation, or another key's cleanup.
    for (const key of keys) {
      try { await revoke(key, true); }
      catch (error) { failed = true; report.checks.push({ status: 'FAIL', label: `cleanup_${safeFailure(error)}` }); }
      if (!confirmed) continue;
      try {
        const end = Date.now() + 15000; let rows;
        do { rows = await leases(key, 'proxy', true); if (rows.every(row => !row.inUse)) break; await delay(150); } while (Date.now() < end);
        check(rows.every(row => !row.inUse), 'owned_lease_still_in_use');
        for (const row of rows) ok(await request('proxy', `/api/user-pool/leases/${encodeURIComponent(row.leaseId)}/release`, {
          method: 'POST', headers: INTERNAL_HEADERS, body: { confirm: true }, cleanup: true,
        }), 'release_owned_lease');
        check((await leases(key, 'proxy', true)).length === 0, 'owned_lease_cleanup_incomplete');
      } catch (error) { failed = true; report.checks.push({ status: 'FAIL', label: `cleanup_${safeFailure(error)}` }); }
    }
    if (keys.length && keys.every(key => key.deleted)) record('all_generated_virtual_keys_revoked', { count: keys.length });
    report.outcome = failed ? 'FAIL' : 'PASS'; report.finishedAt = new Date().toISOString();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try {
      let text = JSON.stringify(report, null, 2);
      for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
      const path = join(await mkdtemp(join(tmpdir(), 'litellm-mysql-')), 'gateway-results.json');
      await writeFile(path, text, { flag: 'wx', mode: 0o600 }); console.log(`LITELLM_MYSQL_REPORT ${path}`);
    } catch { failed = true; console.error('FAIL report_write'); }
  }
  return failed ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
