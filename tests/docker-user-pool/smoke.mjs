// Node 22, zero dependencies. Only run against the disposable internal Docker stack.
// Usage: node smoke.mjs [run|prepare-restart|verify-restart]
// run requires EMPTY Proxy/SSO/mock state and READY_IDLE_TARGET=0. It leaves the
// worker paused and writes a sanitized restart snapshot (default OS temp dir).
// Restart ONLY Proxy externally, then verify-restart within its 60-second lease.
// prepare-restart refreshes the healthy test caller and snapshot if time elapsed.
// POOL_SMOKE_STATE_FILE overrides the snapshot path; never stores credentials.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const urls = {
  proxy: env.POOL_SMOKE_PROXY_URL ?? 'http://127.0.0.1:17300',
  console: env.CONSOLE_URL ?? 'http://127.0.0.1:17304',
  sso: env.SSO_URL ?? 'http://127.0.0.1:17301',
  login: env.LOGIN_URL ?? 'http://127.0.0.1:17303',
  mock: env.MOCK_URL ?? 'http://127.0.0.1:17302',
};
for (const [service, value] of Object.entries(urls)) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', 'proxy', 'console', 'sso', 'login', 'mock'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Refusing non-local ${service} URL`);
  urls[service] = url.origin;
}
const INTERNAL = env.INTERNAL_API_TOKEN ?? 'local-pool-internal-test-only';
const API_KEY = env.API_KEY ?? 'local-pool-proxy-test-only';
const CONSOLE_PASSWORD = env.POOL_SMOKE_CONSOLE_PASSWORD ?? 'local-pool-console-test-only';
const SCIM_TOKEN = env.SCIM_TOKEN ?? 'local-pool-scim-test-only';
const SEAT_PAT = env.SEAT_PAT ?? 'local-pool-seat-test-only';
const SNAPSHOT = env.POOL_SMOKE_STATE_FILE ?? join(tmpdir(), 'ghcp-user-pool-smoke-restart.json');
const MODEL = 'claude-opus-5-2';
const callers = ['a', 'b', 'c', 'd', 'e'].map(name => `sha256:${createHash('sha256').update(`local-pool-smoke-${name}`).digest('hex')}`);
const INTERNAL_HEADERS = { 'X-Internal-Token': INTERNAL };
const cookies = new Map();
let passes = 0;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const pass = name => { passes++; console.log(`PASS ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const credentialValues = [INTERNAL, API_KEY, CONSOLE_PASSWORD, SCIM_TOKEN, SEAT_PAT];
function captureCookies(headers) {
  // Node 22 exposes both cookie-session cookies (value AND signature) separately.
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
  for (const line of lines) {
    const part = line.split(';', 1)[0].trim(), equals = part.indexOf('=');
    if (equals > 0) cookies.set(part.slice(0, equals), part.slice(equals + 1));
  }
}
function headersFor(service, extra = {}, session = false) {
  return { ...(session && service === 'console' ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...extra };
}
async function request(service, path, { method = 'GET', body, headers = {}, session = false, timeout = 15000, signal } = {}) {
  // This script must NEVER dispatch runnable tasks to the real Login app.
  check(!(service === 'login' && method !== 'GET'), 'Real Login is read-only in smoke tests');
  const response = await fetch(`${urls[service]}${path}`, {
    method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    headers: headersFor(service, { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, session),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (service === 'console' && session) captureCookies(response.headers);
  const text = await response.text();
  check(text.length <= 4 * 1024 * 1024, 'Response exceeds smoke size bound');
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* SSE and HTML are not JSON. */ }
  return { status: response.status, headers: response.headers, text, data };
}
function status(response, expected, label) { check(response.status === expected, `${label}: expected HTTP ${expected}, got ${response.status}`); return response; }
async function poll(label, read, predicate, timeout = 120000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(300);
  } while (Date.now() < end);
  throw new Error(`${label}: timed out after ${timeout / 1000}s`);
}
const pool = async () => status(await request('proxy', '/api/user-pool', { headers: INTERNAL_HEADERS }), 200, 'pool status').data;
const mock = async () => status(await request('mock', '/test/state', { headers: INTERNAL_HEADERS }), 200, 'mock state').data;
const bridge = (path, options = {}) => request('console', `/api/console/proxy/user-pool${path}`, { ...options, session: true });
async function settings(changes) {
  const before = await pool();
  const result = status(await bridge('/settings', { method: 'PATCH', body: { expectedVersion: before.settings.version, changes } }), 200, 'Console pool settings');
  check(result.data.version === before.settings.version + 1, 'Settings version did not increment');
  for (const [key, value] of Object.entries(changes)) check(result.data[key] === value, 'Settings change not returned');
  return result.data;
}
function inferenceOptions(caller, path, id, control = {}, streaming = false) {
  const text = id === null ? 'Reply OK' : `Reply OK. POOL_TEST:${JSON.stringify({ id, ...control })}`;
  return {
    method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'X-User-Identity': caller },
    body: { model: MODEL, stream: streaming, ...(path === '/responses' ? { input: text, max_output_tokens: 16 } : { messages: [{ role: 'user', content: text }], max_tokens: 16 }) },
  };
}
const infer = (caller, path, id, control = {}, streaming = false) => request('proxy', path, inferenceOptions(caller, path, id, control, streaming));
async function idlePool() { return poll('active requests drain', pool, value => value.accounts.every(account => account.activeRequests === 0), 10000); }
function leaseFor(value, caller) { const lease = value.leases.find(item => item.callerKeyHash === caller); check(lease, 'Expected caller lease missing'); return lease; }
function unchangedLease(before, after) {
  for (const key of ['leaseId', 'memberIdentity', 'phase', 'lastSuccessAt', 'expiresAt']) check(before[key] === after[key], `Failed request changed lease ${key}`);
}
function sseEvents(text) {
  const events = [];
  for (const frame of text.split(/\r?\n\r?\n/).filter(part => part.trim())) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { events.push('[DONE]'); continue; }
    try { events.push(JSON.parse(data)); } catch { throw new Error('Invalid JSON inside SSE'); }
  }
  return events;
}
function terminal(path, events) {
  return path === '/chat/completions' ? events.includes('[DONE]') : events.some(item => item.type === (path === '/v1/messages' ? 'message_stop' : 'response.completed'));
}
function successful(response, path, streaming) {
  status(response, 200, 'inference success');
  if (streaming) {
    check(response.headers.get('content-type')?.includes('text/event-stream'), 'Missing SSE content type');
    const events = sseEvents(response.text);
    check(terminal(path, events), 'Missing protocol terminal marker');
    check(!events.some(event => event.type === 'error' || event.error), 'Unexpected in-band stream error');
    check(response.text.includes(MODEL) && !response.text.includes('claude-opus-5.2'), 'SSE model was not canonicalized');
  } else {
    check(response.data?.model === MODEL, 'JSON model was not canonicalized');
    const good = path === '/v1/messages' ? response.data.content?.[0]?.text === 'OK' : path === '/chat/completions' ? response.data.choices?.[0]?.message?.content === 'OK' : response.data.status === 'completed' && response.data.output?.[0]?.content?.[0]?.text === 'OK';
    check(good, 'Unexpected inference JSON shape');
  }
}
async function exactlyOne(id, identity) {
  const rows = (await mock()).inference.filter(row => row.marker === id);
  check(rows.length === 1, 'Inference replay or missing marker');
  if (identity) check(rows[0].identity === identity, 'Inference traversed another member');
  check(rows[0].model === 'claude-opus-5.2', 'Upstream did not receive raw model ID');
  return rows[0];
}
async function healthAndLogin() {
  await Promise.all(Object.keys(urls).map(service => poll(`${service} health`, async () => {
    try { return await request(service, '/healthz', { timeout: 3000 }); } catch { return { status: 0 }; }
  }, result => result.status === 200)));
  status(await request('proxy', '/readyz'), 200, 'Proxy readiness');
  const health = status(await request('mock', '/healthz'), 200, 'mock health');
  check(health.data.fixture === true, 'This is not the local mock fixture');
  for (const [service, path] of [['proxy', '/api/user-pool'], ['sso', '/api/users'], ['login', '/api/tasks'], ['mock', '/test/state'], ['console', '/api/console/proxy/user-pool']]) status(await request(service, path), 401, `${service} unauthorized`);
  status(await request('mock', '/test/control', { method: 'POST', body: { status: 500 } }), 401, 'unauthorized control');
  const realTasks = status(await request('login', '/api/tasks?page=1&pageSize=100', { headers: INTERNAL_HEADERS }), 200, 'real Login internal list').data;
  check(realTasks.total === 0 && realTasks.items.length === 0, 'Real Login must have no runnable tasks');
  const setup = status(await request('console', '/api/console/setup'), 200, 'Console setup status').data;
  const authPath = setup.initialized ? '/api/console/login' : '/api/console/setup';
  status(await request('console', authPath, { method: 'POST', body: { username: 'pool-test-admin', password: CONSOLE_PASSWORD }, session: true }), setup.initialized ? 200 : 201, 'Console authentication');
  check(cookies.size >= 2, 'Console session value/signature cookies missing');
  status(await request('console', '/api/console/me', { session: true }), 200, 'Console session');
  status(await bridge(''), 200, 'Console Proxy bridge');
  status(await request('console', '/api/console/sso/users?page=1&pageSize=100', { session: true }), 200, 'Console SSO bridge');
  status(await request('console', '/api/console/login-service/tasks?page=1&pageSize=100', { session: true }), 200, 'Console real Login read-only bridge');
  pass('health_readiness_auth_console_bridges');
}
async function saveRestart() {
  successful(await infer(callers[1], '/v1/messages', `restart-baseline-${Date.now()}`), '/v1/messages', false);
  const value = await idlePool(), state = await mock();
  const lease = leaseFor(value, callers[1]);
  check(lease.phase === 'active', 'Restart baseline requires active lease');
  const snapshot = { version: 1, savedAt: Date.now(), settings: value.settings, identities: value.accounts.map(account => account.identity).sort(), lease, counters: state.counters };
  await writeFile(SNAPSHOT, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  pass('restart_snapshot_saved_60_second_window');
}
async function verifyRestart() {
  const saved = JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  check(saved.version === 1 && saved.lease?.expiresAt > Date.now(), 'Restart snapshot lease expired; run prepare-restart, restart Proxy, verify within 60s');
  const value = await idlePool(), state = await mock();
  check(JSON.stringify(saved.settings) === JSON.stringify(value.settings), 'Settings did not persist across Proxy restart');
  check(JSON.stringify(saved.identities) === JSON.stringify(value.accounts.map(account => account.identity).sort()), 'Pool identities changed across restart');
  unchangedLease(saved.lease, leaseFor(value, callers[1]));
  for (const key of ['scimCreates', 'taskPosts', 'callbacksSucceeded']) check(saved.counters[key] === state.counters[key], 'Proxy restart repeated provisioning');
  const id = `after-restart-${Date.now()}`;
  successful(await infer(callers[1], '/v1/messages', id), '/v1/messages', false);
  await exactlyOne(id, saved.lease.memberIdentity);
  pass('restart_settings_lease_credentials_persist_no_reprovision');
}
async function run() {
  let value = await pool();
  check(value.enabled === true && value.settings.idle_target === 0 && value.counts.total === 0, 'run requires fresh disposable volumes and initial target=0');
  check((await mock()).users.length === 0 && (await mock()).tasks.length === 0, 'run requires a fresh mock');
  const initial = await settings({ idle_target: 0, max_accounts: 4, lease_seconds: 60, paused: 1 });
  status(await bridge('/settings', { method: 'PATCH', body: { expectedVersion: initial.version - 1, changes: { idle_target: 1 } } }), 409, 'stale settings conflict');
  status(await bridge('/settings', { method: 'PATCH', body: { expectedVersion: initial.version, changes: { lease_seconds: 59 } } }), 400, 'TTL lower bound');
  await settings({ idle_target: 2, paused: 0 });
  value = await poll('two fully prewarmed members', pool, state => state.counts.ready_idle === 2 && state.counts.provisioning === 0 && state.counts.total === 2);
  await settings({ paused: 1 });
  let state = await mock();
  check(state.counters.scimCreates === 2 && state.counters.taskPosts === 2 && state.counters.callbacksSucceeded === 2 && state.seats.length === 2, 'Provision chain did not finish twice');
  check(state.counters.scimUpdates === 0 && state.counters.scimConflicts === 0, 'Provisioner unexpectedly adopted an existing SCIM identity');
  check(value.accounts.every(account => account.oauthStatus === 'valid' && account.verifiedAt), 'Ready members lack verified credentials');
  const scim = status(await request('mock', '/scim/v2/enterprises/local-test/Users?startIndex=1&count=100', { headers: { Authorization: `Bearer ${SCIM_TOKEN}` } }), 200, 'SCIM list').data;
  const seatList = status(await request('mock', '/enterprises/local-test/copilot/billing/seats', { headers: { Authorization: `Bearer ${SEAT_PAT}` } }), 200, 'seat list').data;
  check(scim.totalResults === 2 && seatList.total_seats === 2, 'SCIM/seat list state mismatch');
  pass('target_zero_to_two_real_sso_scim_seat_callback_warmup');

  const catalog = status(await request('proxy', '/v1/models', { headers: { Authorization: `Bearer ${API_KEY}`, 'X-User-Identity': callers[0] } }), 200, 'model catalog');
  check(catalog.data.data.some(model => model.id === MODEL) && !catalog.text.includes('claude-opus-5.2'), 'Model catalog not canonical');
  check((await idlePool()).leases.length === 0, 'Catalog created caller lease');
  for (const path of ['/v1/messages', '/chat/completions', '/responses']) {
    for (const streaming of [false, true]) {
      const id = `canonical-${path.split('/').pop()}-${streaming}`;
      successful(await infer(callers[0], path, id, {}, streaming), path, streaming);
      await exactlyOne(id);
    }
  }
  const parallel = await Promise.all(Array.from({ length: 8 }, (_, index) => infer(callers[0], '/v1/messages', `parallel-${index}`)));
  parallel.forEach(response => successful(response, '/v1/messages', false));
  successful(await infer(callers[1], '/v1/messages', 'caller-b'), '/v1/messages', false);
  value = await idlePool();
  const a = leaseFor(value, callers[0]), b = leaseFor(value, callers[1]);
  check(a.phase === 'active' && b.phase === 'active' && a.memberIdentity !== b.memberIdentity && value.leases.length === 2, 'Callers are not exclusively leased');
  state = await mock();
  check(state.inference.filter(row => row.marker?.startsWith('canonical-') || row.marker?.startsWith('parallel-')).every(row => row.identity === a.memberIdentity), 'Repeat/concurrent calls changed selected member');
  const beforeExhaustion = state.inference.length;
  const third = status(await infer(callers[2], '/v1/messages', 'third-exhausted'), 429, 'third caller with replenisher paused');
  check(third.data?.error?.code === 'pool_exhausted' && Number(third.headers.get('retry-after')) > 0, 'Exhaustion error/Retry-After missing');
  check((await mock()).inference.length === beforeExhaustion, 'Exhaustion sent upstream request');
  pass('canonical_json_sse_exclusivity_repeat_concurrency_third_exhaustion');

  await settings({ paused: 0 });
  // No inference requests while waiting: the worker must replenish autonomously.
  value = await poll('autonomous replenishment at cap four', pool, result => result.counts.total === 4 && result.counts.ready_idle === 2 && result.counts.leased === 2 && result.counts.provisioning === 0);
  await settings({ paused: 1 });
  state = await mock();
  check(state.counters.scimCreates === 4 && state.counters.taskPosts === 4 && state.counters.callbacksSucceeded === 4 && state.seats.length === 4, 'Autonomous replenishment did not finish the full chain');
  for (const index of [2, 3]) successful(await infer(callers[index], '/v1/messages', `caller-${index}`), '/v1/messages', false);
  value = await idlePool();
  check(value.leases.length === 4 && new Set(value.leases.map(lease => lease.memberIdentity)).size === 4, 'Cap-four exclusivity failed');
  const beforeFifth = (await mock()).inference.length;
  const fifth = status(await infer(callers[4], '/v1/messages', 'fifth-exhausted'), 429, 'fifth caller');
  check(fifth.data.error.code === 'pool_exhausted' && (await mock()).inference.length === beforeFifth, 'Fifth caller traversed/replayed');
  pass('autonomous_replenishment_cap_four_fifth_exhaustion');

  let before = leaseFor(await idlePool(), callers[0]);
  const limited = status(await infer(callers[0], '/v1/messages', 'rate-limited', { status: 429, retryAfter: 3 }), 429, 'upstream 429');
  check(limited.headers.get('retry-after') === '3', 'Upstream Retry-After not preserved');
  await exactlyOne('rate-limited', before.memberIdentity);
  unchangedLease(before, leaseFor(await idlePool(), callers[0]));
  const blocked = status(await infer(callers[0], '/v1/messages', 'cooldown-blocked'), 429, 'cooldown retry');
  check(blocked.data.error.code === 'member_cooling', '429 did not retain caller cooldown');
  check(!(await mock()).inference.some(row => row.marker === 'cooldown-blocked'), 'Cooling caller traversed another member');
  unchangedLease(before, leaseFor(await idlePool(), callers[0]));
  pass('upstream_429_retains_owner_no_renewal_no_traversal');

  before = leaseFor(await idlePool(), callers[1]);
  const seq = (await mock()).inference.length;
  status(await request('mock', '/test/control', { method: 'POST', headers: INTERNAL_HEADERS, body: { status: 500 } }), 200, 'next-response control');
  status(await infer(callers[1], '/v1/messages', null), 500, 'upstream 500');
  state = await mock();
  check(state.nextControl === null && state.inference.length === seq + 1 && state.inference.at(-1).identity === before.memberIdentity, '500 was replayed or control was not one-shot');
  unchangedLease(before, leaseFor(await idlePool(), callers[1]));
  for (const path of ['/v1/messages', '/chat/completions', '/responses']) {
    for (const streamMode of ['error', 'early-eof']) {
      const id = `failed-${path.split('/').pop()}-${streamMode}`;
      const result = status(await infer(callers[1], path, id, { streamMode }, true), 200, 'stream transport');
      const events = sseEvents(result.text);
      check(streamMode === 'error' ? events.some(event => event.type === 'error') && terminal(path, events) : !terminal(path, events), 'Fault fixture emitted unexpected SSE');
      await exactlyOne(id, before.memberIdentity);
      unchangedLease(before, leaseFor(await idlePool(), callers[1]));
    }
  }
  pass('http_500_inband_errors_early_eof_no_replay_no_renewal');

  const controller = new AbortController();
  const holdOptions = inferenceOptions(callers[1], '/v1/messages', 'cancel-hold', { streamMode: 'hold' }, true);
  const heldResponse = await fetch(`${urls.proxy}/v1/messages`, { ...holdOptions, body: JSON.stringify(holdOptions.body), headers: { ...holdOptions.headers, 'Content-Type': 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), redirect: 'error' });
  try {
    check(heldResponse.status === 200, 'Held stream did not start');
    const held = await poll('in-flight lease hold', pool, result => leaseFor(result, callers[1]).inUse, 5000);
    const release = status(await bridge(`/leases/${leaseFor(held, callers[1]).leaseId}/release`, { method: 'POST', body: { confirm: true } }), 409, 'manual release while active');
    check(release.data.error.code === 'lease_in_use', 'Active release returned wrong error');
  } finally { controller.abort(); await heldResponse.body?.cancel().catch(() => {}); }
  await poll('upstream disconnect cancellation', mock, state => state.inference.some(row => row.marker === 'cancel-hold' && row.outcome === 'cancelled'), 10000);
  unchangedLease(before, leaseFor(await idlePool(), callers[1]));
  await exactlyOne('cancel-hold', before.memberIdentity);
  pass('active_release_blocked_disconnect_cancels_no_renewal');

  await poll('cooldown ends', pool, result => result.accounts.find(account => account.identity === a.memberIdentity)?.state === 'ready', 10000);
  status(await infer(callers[0], '/v1/messages', 'unauthorized-upstream', { status: 401 }), 401, 'upstream unauthorized');
  await exactlyOne('unauthorized-upstream', a.memberIdentity);
  value = await idlePool();
  const quarantined = value.accounts.find(account => account.identity === a.memberIdentity);
  check(quarantined.state === 'failed' && quarantined.oauthStatus === 'expired', '401 did not quarantine selected credential');
  check(value.accounts.filter(account => account.identity !== a.memberIdentity).every(account => account.oauthStatus === 'valid'), '401 invalidated another member');
  pass('upstream_401_quarantines_only_selected_member_no_replay');

  state = await mock();
  const sanitized = JSON.stringify(state);
  check(!credentialValues.some(secret => sanitized.includes(secret)) && !sanitized.includes('local-fixture-oauth-') && !sanitized.includes('ssoPassword'), 'Mock state leaked credentials');
  check(state.tasks.every(task => task.status === 'success') && state.counters.callbacksFailed === 0, 'Fake Login had a failed callback');
  check(state.counters.scimCreates === 4 && state.counters.taskPosts === 4, 'Unexpected background provisioning at cap');
  status(await request('mock', '/unknown-fixture-endpoint'), 404, 'unknown fixture route');
  await saveRestart();
  console.log(`COUNTS accounts=${value.counts.total} scim=${state.counters.scimCreates} seats=${state.seats.length} callbacks=${state.counters.callbacksSucceeded} inference=${state.inference.length}`);
}
try {
  const phase = process.argv[2] ?? 'run';
  check(['run', 'prepare-restart', 'verify-restart'].includes(phase), 'Expected run, prepare-restart, or verify-restart');
  await healthAndLogin();
  if (phase === 'run') await run();
  else if (phase === 'prepare-restart') { await settings({ paused: 1 }); await saveRestart(); }
  else await verifyRestart();
  console.log(`PASS smoke_${phase} checks=${passes}`);
} catch (error) {
  // Deliberately no response bodies, headers, stack, or arbitrary fetch details.
  const message = String(error.message ?? 'test_failed');
  const safe = credentialValues.some(secret => message.includes(secret)) ? 'test_failed_redacted' : message.replace(/https?:\/\/\S+/g, '[local-service]');
  console.error(`FAIL ${safe}`);
  process.exitCode = 1;
}
