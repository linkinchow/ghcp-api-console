#!/usr/bin/env node
// Node >=22, built-ins only. Run ONLY against the disposable, network-isolated
// Docker gateway. No Docker commands, upstream credentials, or Login mutations.
// Stock LiteLLM API source: v1.94.2, key_management_endpoints.py (see scenarios).
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const HELP = `Usage: node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture [options]

Requires FRESH Proxy/SSO/mock volumes, READY_IDLE_TARGET=0, real LiteLLM + DB,
mock-only upstream networking, and no concurrent tests. Does not start services.
Creates/revokes real virtual keys, changes pool settings, and releases ONLY this
run's leases. Never POSTs to the real Login service. Outputs no raw credentials.

  --litellm-url URL        default http://127.0.0.1:17505
  --proxy-url URL          default http://127.0.0.1:17500
  --sso-url URL            default http://127.0.0.1:17501
  --mock-url URL           default http://127.0.0.1:17502
  --login-url URL          default http://127.0.0.1:17503
  --console-url URL        default http://127.0.0.1:17504
  --model NAME            default claude-opus-5
  --raw-model NAME        default claude-opus-5 (expected mock wire model)
  --legacy-model NAME     default claude-opus-5-2 (Proxy catalog only)
  --legacy-raw-model NAME default claude-opus-5.2 (must NOT appear in catalog)
  --initial-idle N        default 5 (minimum 4)
  --cap N                 default 20
  --burst N               default 20 (must equal cap)
  --pressure-mode MODE    paused (default) or live
  --retry-rounds N        default 20; only confirmed exhausted keys are retried
  --wait-ms N             default 180000; condition-based waits, no blind sleeps
  --request-ms N          default 45000; includes SSE read deadline
  --poll-ms N             default 200
  --fallback-model NAME   opt-in configured fallback INTO GHCP; no guessed group
  --other-only-model NAME opt-in model-restricted key test; no guessed group
  --help                 no network, no output file

Secrets via env ONLY (never CLI):
  GATEWAY_MASTER_KEY      default sk-local-gateway-master-test-only
  GATEWAY_PROXY_KEY       default local-pool-proxy-test-only
  GATEWAY_INTERNAL_TOKEN  default local-pool-internal-test-only
URL/model/numeric flags also accept GATEWAY_<UPPER_SNAKE_CASE_FLAG> env values.
Only literal loopback origins are allowed; redirects are refused.

Report: local-gateway-results.json beside this script (gitignored in target repo).
Exit: 0 all required scenarios passed; 1 failure; 2 blocked required scenario.
Duplicate key_alias rejection is recorded, not silently converted to a pass of
same-alias isolation. Optional models not supplied are explicitly SKIPped.
Keys are revoked and worker paused in finally; account inventory is retained.
`;
const definitions = {
  'confirm-local-fixture': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  ...Object.fromEntries([
    'litellm-url', 'proxy-url', 'sso-url', 'mock-url', 'login-url', 'console-url',
    'model', 'raw-model', 'legacy-model', 'legacy-raw-model', 'initial-idle', 'cap',
    'burst', 'pressure-mode', 'retry-rounds', 'wait-ms', 'request-ms', 'poll-ms',
    'fallback-model', 'other-only-model',
  ].map(name => [name, { type: 'string' }])),
};
const secrets = new Set();
const ownedKeys = [];
const requests = [];
const expectedMappings = new Map();
const report = {
  schemaVersion: 1, runId: `gw-${randomUUID().slice(0, 12)}`, startedAt: new Date().toISOString(),
  runtime: process.version, outcome: 'running', tests: [], observations: {},
  limitations: [
    'Mock-only validation; not real SAML/SCIM/Copilot acceptance.',
    'Readiness and key CRUD establish DB-backed authentication, not a Postgres restart/durability test.',
    'HTTP loopback checks cannot prove container egress isolation; Compose must enforce mock-only networking.',
    'Pool hashes are persistent pseudonymous identifiers; restrict report access and retention.',
  ],
};
const RESULTS_FILE = fileURLToPath(new URL('./local-gateway-results.json', import.meta.url));
const abort = new AbortController();
let config, credentials, fixtureConfirmed = false, mutatedPool = false, serial = 0;
let maxObservedAccounts = 0;

// Never interpolate remote text in errors. Even JSON parse/fetch errors can carry
// credentials. Only our fixed messages and allowlisted/numeric details escape.
class CheckError extends Error {
  constructor(message, details = {}) { super(message); this.details = details; }
}
function check(ok, message, details) { if (!ok) throw new CheckError(message, details); }
function redact(text) {
  let output = String(text);
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return output.replace(/\b(?:sk-|ghp_|gho_|github_pat_|local-fixture-oauth-)[A-Za-z0-9_.-]+/g, '[REDACTED]');
}
function record(status, label, details = {}) {
  report.tests.push({ status, label, ...details });
  console.log(redact(`${status} ${label} ${JSON.stringify(details)}`));
}
function safeError(error) {
  return error instanceof CheckError
    ? { message: error.message, ...error.details }
    : { message: 'Unexpected local runner error (details suppressed)', errorClass: 'unclassified' };
}
async function scenario(label, fn, { critical = false } = {}) {
  const started = Date.now();
  try {
    const details = await fn();
    record('PASS', label, { durationMs: Date.now() - started, ...(details ?? {}) });
    return true;
  } catch (error) {
    record('FAIL', label, { durationMs: Date.now() - started, ...safeError(error) });
    if (critical) throw new CheckError('Required phase failed; dependent scenarios not run');
    return false;
  }
}
function hashKey(raw) { return `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`; }
function unique(values) { return new Set(values).size === values.length; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return object(value) && Object.hasOwn(value, key); }
function codeOf(response) {
  // Codes only from this fixed vocabulary. All remote messages stay in memory.
  const text = response.text ?? '';
  return ['pool_exhausted', 'member_cooling', 'ghcp_pool_trusted_identity_required',
    'invalid_api_key', 'key_alias', 'not_found_error', 'authentication_error',
    'permission_denied', 'rate_limit_error'].find(code => text.includes(code)) ?? 'unclassified';
}
function httpOk(response, label, allowed = [200]) {
  check(allowed.includes(response.status), `${label}: HTTP contract mismatch`, {
    observedStatus: response.status, expectedStatuses: allowed, observedCode: codeOf(response),
  });
  return response.data;
}
function noSecrets(text, label) {
  check(![...secrets].some(secret => secret && text.includes(secret)), `${label}: raw credential exposed`);
  check(!/\b(?:sk-|ghp_|gho_|github_pat_|local-fixture-oauth-)[A-Za-z0-9_.-]+/.test(text), `${label}: token-shaped value exposed`);
  check(!/"(?:ssoPassword|copilotOauthToken|copilot_oauth_token|oauth_token|password)"\s*:/i.test(text), `${label}: sensitive field exposed`);
}
function options(values) {
  const get = (name, fallback) => values[name] ?? process.env[`GATEWAY_${name.replaceAll('-', '_').toUpperCase()}`] ?? fallback;
  const number = (name, fallback, min, max) => {
    const value = Number(get(name, fallback));
    check(Number.isSafeInteger(value) && value >= min && value <= max, 'Invalid numeric argument', { option: name });
    return value;
  };
  const urls = {};
  for (const [service, port] of Object.entries({ litellm: 17505, proxy: 17500, sso: 17501, mock: 17502, login: 17503, console: 17504 })) {
    let url;
    try { url = new URL(get(`${service}-url`, `http://127.0.0.1:${port}`)); }
    catch { throw new CheckError('Invalid local service URL', { service }); }
    // Literal loopback avoids DNS rebinding and accidental container/public hosts.
    check(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'Refusing non-loopback or non-origin URL', { service });
    urls[service] = url.origin;
  }
  check(unique(Object.values(urls)), 'Every service must have a distinct origin');
  const model = name => {
    const value = get(name, ({ model: 'claude-opus-5', 'raw-model': 'claude-opus-5',
      'legacy-model': 'claude-opus-5-2', 'legacy-raw-model': 'claude-opus-5.2' })[name] ?? null);
    check(value === null || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(value), 'Invalid model argument', { option: name });
    return value;
  };
  const result = {
    urls, model: model('model'), rawModel: model('raw-model'), legacyModel: model('legacy-model'),
    legacyRawModel: model('legacy-raw-model'), fallbackModel: model('fallback-model'), otherOnlyModel: model('other-only-model'),
    initialIdle: number('initial-idle', 5, 4, 100), cap: number('cap', 20, 5, 100),
    burst: number('burst', 20, 4, 100), retryRounds: number('retry-rounds', 20, 1, 100),
    waitMs: number('wait-ms', 180000, 1000, 600000), requestMs: number('request-ms', 45000, 1000, 120000),
    pollMs: number('poll-ms', 200, 25, 2000), pressureMode: get('pressure-mode', 'paused'),
  };
  check(result.initialIdle < result.cap && result.burst === result.cap, 'Require initial-idle < cap and burst == cap');
  check(['paused', 'live'].includes(result.pressureMode), 'pressure-mode must be paused or live');
  check(!result.otherOnlyModel || result.otherOnlyModel !== result.model, 'other-only-model must differ from the GHCP model');
  return result;
}

async function request(service, path, { method = 'GET', body, headers = {}, timeout, cleanup = false } = {}) {
  check(config && own(config.urls, service), 'Unknown service');
  const url = new URL(path, config.urls[service]);
  check(path.startsWith('/') && !path.startsWith('//') && url.origin === config.urls[service], 'Request escaped local service');
  check(service !== 'login' || method === 'GET', 'Real Login is strictly read-only');
  check(!['sso', 'console'].includes(service) || method === 'GET', 'Auxiliary services are read-only');
  const signal = cleanup ? AbortSignal.timeout(timeout ?? config.requestMs)
    : AbortSignal.any([abort.signal, AbortSignal.timeout(timeout ?? config.requestMs)]);
  try {
    const response = await fetch(url, {
      method, redirect: 'error', signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          check(bytes <= 4 * 1024 * 1024, 'Response exceeded 4 MiB limit', { service, status: response.status });
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let data;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* SSE/HTML are parsed separately. */ }
    return { status: response.status, headers: response.headers, text, data };
  } catch (error) {
    if (error instanceof CheckError) throw error;
    throw new CheckError('Local HTTP request failed (body/URL details suppressed)', { service, method, interrupted: abort.signal.aborted });
  }
}
const internalHeaders = () => ({ 'X-Internal-Token': credentials.internal });
const masterHeaders = () => ({ Authorization: `Bearer ${credentials.master}` });
async function poll(label, read, predicate, { timeout = config.waitMs, interval = config.pollMs } = {}) {
  const deadline = Date.now() + timeout;
  let samples = 0;
  do {
    check(!abort.signal.aborted, 'Runner interrupted');
    const value = await read(Math.max(1, deadline - Date.now()));
    samples++;
    if (predicate(value)) return value;
    if (Date.now() >= deadline) break;
    // Delay only follows an unmet condition; it is not a readiness assumption.
    await delay(Math.min(interval, deadline - Date.now()), undefined, { signal: abort.signal }).catch(() => {});
  } while (Date.now() < deadline);
  throw new CheckError('Condition wait expired', { condition: label, timeoutMs: timeout, samples });
}
function validatePool(value) {
  check(object(value) && value.enabled === true && value.poolId === 'default'
    && object(value.settings) && object(value.counts) && Array.isArray(value.accounts)
    && Array.isArray(value.leases) && Array.isArray(value.events), 'Proxy overview DTO changed');
  for (const name of ['total', 'ready_idle', 'leased', 'provisional', 'provisioning', 'cooling', 'failed', 'disabled']) {
    check(Number.isSafeInteger(value.counts[name]) && value.counts[name] >= 0, 'Invalid pool count', { field: name });
  }
  check(value.accounts.length === value.counts.total, 'Inventory is truncated or counts disagree');
  check(value.leases.length === value.counts.leased + value.counts.provisional, 'Lease counts disagree');
  check(value.counts.total <= config.cap, 'Pool exceeded configured total cap', { total: value.counts.total, cap: config.cap });
  maxObservedAccounts = Math.max(maxObservedAccounts, value.counts.total);
  check(unique(value.accounts.map(item => item.identity)) && unique(value.accounts.map(item => item.ordinal)), 'Duplicate inventory identity/ordinal');
  check(unique(value.leases.map(item => item.callerKeyHash)) && unique(value.leases.map(item => item.memberIdentity))
    && unique(value.leases.map(item => item.leaseId)), 'Caller/member/lease uniqueness violated');
  for (const lease of value.leases) {
    check(/^sha256:[a-f0-9]{64}$/.test(lease.callerKeyHash) && typeof lease.leaseId === 'string'
      && ['active', 'provisional'].includes(lease.phase), 'Invalid lease DTO');
    const account = value.accounts.find(item => item.identity === lease.memberIdentity);
    check(account && account.callerKeyHash === lease.callerKeyHash && account.leasePhase === lease.phase,
      'Account and lease caller mapping disagree');
  }
  return value;
}
async function pool(opts = {}) {
  const response = await request('proxy', '/api/user-pool', { headers: internalHeaders(), ...opts });
  const value = httpOk(response, 'Proxy overview');
  noSecrets(response.text, 'Proxy inventory');
  const validated = validatePool(value);
  report.observations.lastCounts = { ...value.counts };
  return validated;
}
async function mock(opts = {}) {
  const response = await request('mock', '/test/state', { headers: internalHeaders(), ...opts });
  const state = httpOk(response, 'Mock state');
  noSecrets(response.text, 'Mock state');
  check(state?.fixture === true && object(state.counters) && Array.isArray(state.inference)
    && Array.isArray(state.users) && Array.isArray(state.seats) && Array.isArray(state.tasks), 'Mock state contract changed');
  return state;
}
async function settings(changes, opts = {}) {
  const before = await pool(opts);
  const value = httpOk(await request('proxy', '/api/user-pool/settings', {
    method: 'PATCH', headers: internalHeaders(), body: { expectedVersion: before.settings.version, changes }, ...opts,
  }), 'Versioned settings PATCH');
  check(value?.version === before.settings.version + 1, 'Settings version did not increment');
  for (const [name, expected] of Object.entries(changes)) check(value[name] === expected, 'Settings change not applied', { field: name });
  return value;
}
const drained = () => poll('all Proxy request holds drained', () => pool(), value => value.accounts.every(item => item.activeRequests === 0)
  && value.leases.every(item => item.inUse === false), { timeout: config.requestMs });
function leaseFor(value, key) {
  const found = value.leases.filter(item => item.callerKeyHash === key.hash);
  check(found.length === 1, 'Expected exactly one SHA256(raw-key) lease', { keyLabel: key.label, matches: found.length });
  return found[0];
}
function stableLease(before, after, label) {
  check(before.leaseId === after.leaseId && before.memberIdentity === after.memberIdentity
    && before.callerKeyHash === after.callerKeyHash, 'Caller mapping changed', { keyLabel: label });
}
function snapshotLeases(value) {
  return JSON.stringify(value.leases.map(item => ({ caller: item.callerKeyHash, member: item.memberIdentity,
    id: item.leaseId, phase: item.phase, lastSuccessAt: item.lastSuccessAt, expiresAt: item.expiresAt })).sort((a, b) => a.caller.localeCompare(b.caller)));
}
async function releaseOwnedLeases(keys) {
  const hashes = new Set(keys.map(key => key.hash));
  const value = await drained();
  const leases = value.leases.filter(item => hashes.has(item.callerKeyHash));
  for (const lease of leases) {
    httpOk(await request('proxy', `/api/user-pool/leases/${encodeURIComponent(lease.leaseId)}/release`, {
      method: 'POST', headers: internalHeaders(), body: { confirm: true },
    }), 'Release runner-owned lease');
    expectedMappings.delete(lease.callerKeyHash);
  }
  await poll('runner-owned leases released', () => pool(), next => !next.leases.some(item => hashes.has(item.callerKeyHash)));
}
async function generate(label, { alias = `${report.runId}-${label}`, metadata = {}, models = [config.model], allowAliasRejection = false } = {}) {
  const userId = `${report.runId}-${label}`;
  httpOk(await request('litellm', '/user/new', { method: 'POST', headers: masterHeaders(),
    body: { user_id: userId, user_role: 'internal_user', auto_create_key: false } }), 'LiteLLM /user/new', [200, 201]);
  const response = await request('litellm', '/key/generate', {
    method: 'POST', headers: masterHeaders(),
    body: { user_id: userId, key_alias: alias, models, duration: '2h', metadata: { test_run: report.runId, test_label: label, ...metadata } },
  });
  if (allowAliasRejection && [400, 409].includes(response.status)
    && /(?:alias[\s\S]*(?:already exists|unique)|unique[\s\S]*alias)/i.test(response.text)) {
    return { aliasRejected: true, status: response.status };
  }
  const value = httpOk(response, 'LiteLLM /key/generate', [200, 201]);
  check(typeof value?.key === 'string' && /^sk-[A-Za-z0-9._-]+$/.test(value.key), 'GenerateKeyResponse.key must be a raw sk- virtual key');
  const raw = value.key;
  secrets.add(raw);
  check(!ownedKeys.some(key => key.raw === raw) && raw !== credentials.master, 'Generated key is not distinct');
  const key = { label, raw, hash: hashKey(raw), alias, metadata, models, deleted: false };
  ownedKeys.push(key);
  if (value.token !== undefined && value.token !== null) check(value.token === key.hash.slice(7), 'Generated DB token is not SHA256(raw-key)');
  await keyInfo(key);
  return key;
}
async function keyInfo(key) {
  // Query with the hash, never raw key in a URL/access log. Stock /key/info
  // removes info.token in newer versions; exact leases prove hash identity.
  const response = await request('litellm', `/key/info?key=${key.hash.slice(7)}`, { headers: masterHeaders() });
  const value = httpOk(response, 'LiteLLM /key/info');
  check(object(value?.info), 'LiteLLM key-info response missing info');
  const info = value.info;
  check(info.key_alias === key.alias && Array.isArray(info.models)
    && key.models.every(model => info.models.includes(model)), 'DB key alias/model permission mismatch', { keyLabel: key.label });
  let metadata = info.metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { /* fail below */ } }
  check(object(metadata) && metadata.test_run === report.runId, 'Key metadata did not persist');
  check(own(key.metadata, 'ghcp_identity') ? metadata.ghcp_identity === key.metadata.ghcp_identity : !own(metadata, 'ghcp_identity'),
    'Key ghcp_identity metadata contract changed');
  return info;
}
async function revoke(key, opts = {}) {
  if (key.deleted) return;
  // Deleting by hash is a documented stock API; never by alias (may duplicate).
  const value = httpOk(await request('litellm', '/key/delete', {
    method: 'POST', headers: masterHeaders(), body: { keys: [key.hash.slice(7)] }, ...opts,
  }), 'LiteLLM /key/delete');
  check(Array.isArray(value?.deleted_keys) && value.deleted_keys.includes(key.hash.slice(7)), 'Delete response did not confirm requested key hash');
  key.deleted = true;
}
function sseEvents(text) {
  const result = [];
  for (const frame of text.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { result.push('[DONE]'); continue; }
    try { result.push(JSON.parse(data)); } catch { throw new CheckError('Malformed JSON SSE data frame'); }
  }
  return result;
}
function successful(response, route, stream) {
  httpOk(response, 'Gateway inference');
  if (stream) {
    check(response.headers.get('content-type')?.includes('text/event-stream'), 'Expected SSE content type');
    const events = sseEvents(response.text);
    check(!events.some(event => event?.type === 'error' || event?.error), 'In-band SSE error despite HTTP 200');
    if (route === 'messages') {
      check(events.some(event => event?.type === 'message_start') && events.some(event => event?.type === 'message_stop'), 'Messages SSE missing start/terminal');
      const text = events.filter(event => event?.delta?.type === 'text_delta').map(event => event.delta.text ?? '').join('');
      check(text.includes('OK'), 'Messages SSE missing mock text');
    } else {
      check(events.includes('[DONE]') && events.some(event => event?.choices?.some(choice => choice.finish_reason)), 'Chat SSE missing finish_reason/[DONE]');
      const text = events.flatMap(event => event?.choices ?? []).map(choice => choice.delta?.content ?? '').join('');
      check(text.includes('OK'), 'Chat SSE missing mock text');
    }
    const models = events.flatMap(event => [event?.model, event?.message?.model]).filter(value => typeof value === 'string');
    check(models.length > 0 && models.every(model => model !== config.legacyRawModel), 'SSE model metadata missing or legacy raw ID leaked');
  } else {
    check(response.headers.get('content-type')?.includes('application/json'), 'Expected JSON content type');
    const value = response.data;
    check(typeof value?.model === 'string' && value.model !== config.legacyRawModel, 'JSON model missing or legacy raw ID leaked');
    if (route === 'messages') check(value.type === 'message' && value.role === 'assistant'
      && value.content?.some(block => block.type === 'text' && block.text === 'OK') && value.stop_reason, 'Invalid Messages JSON completion');
    else check(value.object === 'chat.completion' && value.choices?.some(choice => choice.message?.role === 'assistant'
      && choice.message.content === 'OK' && choice.finish_reason), 'Invalid Chat JSON completion');
  }
}
async function infer(key, { label = 'inference', route = 'messages', stream = false, auth = 'bearer',
  model = config.model, headers = {}, extraBody = {} } = {}) {
  const marker = `${report.runId}-${++serial}-${label}`.slice(0, 80);
  const attempt = { marker, keyLabel: key.label, hash: key.hash, route, stream, auth, model };
  requests.push(attempt);
  const response = await request('litellm', route === 'messages' ? '/v1/messages' : '/v1/chat/completions', {
    method: 'POST', headers: {
      ...(auth === 'x-api-key' ? { 'x-api-key': key.raw } : { Authorization: `Bearer ${key.raw}` }),
      ...(route === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}), ...headers,
    },
    body: { model, max_tokens: 16, stream,
      messages: [{ role: 'user', content: `Reply OK. POOL_TEST:${JSON.stringify({ id: marker })}` }], ...extraBody },
  });
  attempt.status = response.status;
  attempt.code = response.status === 200 ? 'none' : codeOf(response);
  return { ...attempt, response, key };
}
async function verifyMapped(attempts) {
  const value = await drained();
  const state = await mock();
  for (const attempt of attempts) {
    successful(attempt.response, attempt.route, attempt.stream);
    const lease = leaseFor(value, attempt.key);
    check(lease.phase === 'active' && Number.isFinite(lease.lastSuccessAt) && lease.lastSuccessAt > 0
      && lease.expiresAt > Date.now(), 'Success did not activate/renew live lease', { keyLabel: attempt.key.label });
    const prior = expectedMappings.get(attempt.key.hash);
    if (prior) stableLease(prior, lease, attempt.key.label);
    expectedMappings.set(attempt.key.hash, { ...lease });
    const rows = state.inference.filter(row => row.marker === attempt.marker);
    check(rows.length === 1, 'Mock marker missing or request replayed', {
      keyLabel: attempt.key.label, route: attempt.route, upstreamAttempts: rows.length,
    });
    check(rows.every(row => row.identity === lease.memberIdentity && row.model === config.rawModel
      && row.status === 200 && row.outcome === 'complete' && row.stream === attempt.stream),
    'Mock wire identity/model/stream/outcome mismatch', { keyLabel: attempt.key.label });
  }
  return value;
}

async function realLoginEmpty(opts = {}) {
  const value = httpOk(await request('login', '/api/tasks?page=1&pageSize=100', { headers: internalHeaders(), ...opts }), 'Real Login tasks GET');
  check(value?.total === 0 && Array.isArray(value.items) && value.items.length === 0, 'Real Login must have zero tasks; do not launch runnable jobs');
}
async function preflight() {
  const health = { litellm: '/health/readiness', proxy: '/readyz', mock: '/healthz', sso: '/healthz', login: '/healthz', console: '/healthz' };
  for (const [service, path] of Object.entries(health)) {
    const response = await poll(`${service} ready`, async remaining => {
      try { return await request(service, path, { timeout: Math.min(3000, remaining) }); }
      catch (error) { if (abort.signal.aborted) throw error; return { status: 0 }; }
    }, value => value.status === 200);
    if (service === 'litellm') {
      check(response.data?.db === 'connected', 'LiteLLM readiness must confirm connected DB');
      report.observations.litellmDatabase = 'connected';
    }
    if (service === 'mock') check(response.data?.fixture === true, 'Mock fixture safety marker missing');
  }
  const state = await mock(), value = await pool();
  check(value.counts.total === 0 && value.leases.length === 0 && value.settings.idle_target === 0,
    'Require fresh disposable Proxy state with initial idle target zero');
  check(state.users.length === 0 && state.tasks.length === 0 && state.seats.length === 0 && state.inference.length === 0,
    'Require fresh disposable mock state');
  check(state.nextControl === null, 'Pending mock fault control must be cleared externally');
  const users = httpOk(await request('sso', '/api/users?page=1&pageSize=100', { headers: internalHeaders() }), 'SSO user list');
  check(users?.total === 0 && Array.isArray(users.items) && users.items.length === 0, 'Require fresh disposable SSO state');
  await realLoginEmpty();
  fixtureConfirmed = true;
  return { database: 'connected', freshPool: true, freshMock: true, realLoginTasks: 0 };
}
async function initialPool() {
  // A long lease separates worker behavior from expiry; test wall clock is capped
  // at 15 minutes. Do not reuse the earlier 60-second direct-smoke configuration.
  mutatedPool = true;
  await settings({ idle_target: config.initialIdle, max_accounts: config.cap, lease_seconds: 3600, paused: 0 });
  await poll('initial fully verified idle supply', () => pool(), value => value.counts.total === config.initialIdle
    && value.counts.ready_idle === config.initialIdle && value.counts.provisioning === 0);
  await settings({ paused: 1 });
  const value = await drained();
  check(value.counts.failed === 0 && value.accounts.every(item => item.state === 'ready' && item.oauthStatus === 'valid' && item.verifiedAt),
    'Initial members are not fully verified');
  await validateMockCounters(value);
  report.observations.initialCounts = { ...value.counts };
  return { initialIdle: value.counts.ready_idle, cap: config.cap };
}
async function validateMockCounters(value) {
  const state = await mock();
  const total = value.counts.total;
  for (const name of ['scimCreates', 'seatAssignments', 'taskPosts', 'callbacksSucceeded']) {
    check(state.counters[name] === total, 'Provision chain counter mismatch', { counter: name, observed: state.counters[name], total });
  }
  for (const name of ['scimConflicts', 'scimUpdates', 'scimDeletes', 'callbacksFailed']) check(state.counters[name] === 0, 'Unexpected mock provisioning failure/adoption', { counter: name });
  check(state.users.length === total && state.seats.length === total && state.tasks.length === total
    && unique(state.users.map(item => item.userName)) && unique(state.tasks.map(item => item.identity)), 'SCIM/seat/task uniqueness/count mismatch');
  check(state.tasks.every(item => item.status === 'success') && state.counters.modelLists >= total, 'Callback/model discovery incomplete');
  const identities = new Set(value.accounts.map(item => item.identity));
  check(state.users.every(item => identities.has(item.userName)) && state.tasks.every(item => identities.has(item.identity)), 'Mock identities do not match Proxy inventory');
  check(value.accounts.every(account => state.seats.includes(account.ghLogin)), 'Ready inventory has an unassigned seat');
  report.observations.mockCounters = { ...state.counters };
  report.observations.mockConcurrency = { ...state.concurrency };
  return { total, scimCreates: state.counters.scimCreates, callbacksSucceeded: state.counters.callbacksSucceeded };
}
async function catalog(key) {
  const before = await drained();
  const response = await request('proxy', '/v1/models', {
    headers: { Authorization: `Bearer ${credentials.proxy}`, 'X-User-Identity': key.hash },
  });
  const value = httpOk(response, 'Proxy catalog');
  const ids = value?.data?.map(item => item.id);
  check(Array.isArray(ids) && ids.includes(config.model) && ids.includes(config.legacyModel)
    && !ids.includes(config.legacyRawModel), 'Proxy catalog lacks current/legacy canonical fixture models');
  const after = await drained();
  check(snapshotLeases(before) === snapshotLeases(after), 'Catalog consumed or changed a caller lease');
  return { currentModel: config.model, legacyModel: config.legacyModel, leaseFree: true };
}
async function rejectedWithoutConsumption(key, label, options = {}) {
  const before = await drained();
  check(before.counts.ready_idle > 0 && before.settings.paused === 1, 'Rejection test needs paused nonempty idle supply');
  const stateBefore = await mock();
  const attempts = await Promise.all([
    infer(key, { label, route: 'messages', auth: 'x-api-key', ...options }),
    infer(key, { label, route: 'messages', auth: 'bearer', ...options }),
    infer(key, { label, route: 'chat', auth: 'bearer', ...options }),
  ]);
  const after = await drained(), stateAfter = await mock();
  check(snapshotLeases(before) === snapshotLeases(after) && before.counts.ready_idle === after.counts.ready_idle
    && before.counts.total === after.counts.total, 'Rejected authentication consumed/changed idle inventory or a lease');
  check(stateAfter.inference.length === stateBefore.inference.length, 'Rejected authentication reached mock upstream');
  for (const item of attempts) check([401, 403].includes(item.response.status), 'Expected authentication/permission rejection', {
    observedStatus: item.response.status, observedCode: codeOf(item.response), route: item.route, auth: item.auth,
  });
  return { observedStatuses: attempts.map(item => item.response.status), readyIdleUnchanged: after.counts.ready_idle };
}

async function functional() {
  const a = await generate('alias-a');
  const duplicate = await generate('alias-b', { alias: a.alias, allowAliasRejection: true });
  let b;
  if (duplicate.aliasRejected) {
    record('PASS', 'duplicate_alias_stock_rejection_observed', { status: duplicate.status });
    record('BLOCKED', 'same_alias_distinct_key_isolation', { reason: 'Stock LiteLLM rejects duplicate key_alias; no DB mutation/bypass attempted' });
    b = await generate('alias-b-distinct');
  } else b = duplicate;
  await scenario('db_backed_keys_no_identity_metadata', async () => {
    await keyInfo(a); await keyInfo(b);
    check(a.hash !== b.hash, 'Distinct raw keys did not yield distinct caller hashes');
    return { keys: 2, sameAlias: a.alias === b.alias };
  });
  await scenario('canonical_current_legacy_catalog_no_lease', () => catalog(a));

  await scenario('messages_chat_json_sse_auth_matrix', async () => {
    const attempts = [];
    for (const auth of ['x-api-key', 'bearer']) for (const stream of [false, true]) {
      attempts.push(await infer(a, { label: 'matrix', route: 'messages', stream, auth }));
      await verifyMapped([attempts.at(-1)]);
    }
    for (const stream of [false, true]) {
      attempts.push(await infer(a, { label: 'matrix', route: 'chat', stream }));
      await verifyMapped([attempts.at(-1)]);
    }
    return { requests: attempts.length, mappedExactly: true };
  }, { critical: true });
  await scenario('same_key_parallel_reuse_and_distinct_key_isolation', async () => {
    const before = leaseFor(await drained(), a);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => infer(a, { label: 'reuse', route: i % 2 ? 'chat' : 'messages', stream: i % 3 === 0 })));
    // The second key is still unleased: poison the FIRST allocation, not just
    // subsequent requests for a caller already pinned to a member.
    results.push(await infer(b, { label: 'second-key-forged-first-allocation', route: 'chat',
      headers: { 'X-User-Identity': a.hash },
      extraBody: { extra_headers: { 'x-user-identity': a.hash } },
    }));
    const value = await verifyMapped(results);
    const afterA = leaseFor(value, a), afterB = leaseFor(value, b);
    stableLease(before, afterA, a.label);
    check(afterA.memberIdentity !== afterB.memberIdentity, 'Two distinct keys share a member');
    if (a.alias === b.alias) record('PASS', 'same_alias_distinct_key_isolation', { keys: 2, sharedAlias: true });
    return { concurrentSameKey: 8, differentMembers: true };
  }, { critical: true });
  await scenario('alias_update_preserves_exact_key_mapping', async () => {
    const before = leaseFor(await drained(), a);
    const alias = `${report.runId}-renamed`;
    httpOk(await request('litellm', '/key/update', { method: 'POST', headers: masterHeaders(), body: { key: a.raw, key_alias: alias } }), 'LiteLLM /key/update');
    a.alias = alias;
    await keyInfo(a);
    const result = await infer(a, { label: 'renamed', auth: 'x-api-key' });
    const after = leaseFor(await verifyMapped([result]), a);
    stableLease(before, after, a.label);
    return { keyHashStable: true, memberStable: true, leaseIdStable: true };
  });

  const victim = leaseFor(await drained(), a);
  const c = await generate('poisoned-metadata', { metadata: { ghcp_identity: victim.memberIdentity } });
  await scenario('metadata_ghcp_identity_cannot_select_victim', async () => {
    const result = await infer(c, { label: 'metadata-only' });
    const value = await verifyMapped([result]);
    check(leaseFor(value, c).memberIdentity !== victim.memberIdentity, 'Metadata selected another key member');
    return { metadataPersisted: true, exactRawKeyHashUsed: true };
  }, { critical: true });
  const fake = victim.callerKeyHash;
  const headerMap = { 'x-UsEr-IdEnTiTy': fake };
  const attacks = [
    { label: 'http-header', headers: { 'X-User-Identity': fake } },
    ...['headers', 'extra_headers', 'default_headers'].map(name => ({ label: name, extraBody: { [name]: headerMap } })),
    { label: 'extra-body', extraBody: { extra_body: { headers: headerMap, extra_headers: headerMap, default_headers: headerMap } } },
    { label: 'metadata', extraBody: { metadata: { ghcp_identity: victim.memberIdentity, user_api_key_hash: fake.slice(7), user_api_key_alias: a.alias,
      user_api_key_dict: { token: fake.slice(7), hashed_token: fake.slice(7) }, headers: headerMap } } },
    { label: 'litellm-metadata', extraBody: { litellm_metadata: { headers: headerMap, user_api_key_hash: fake.slice(7) } } },
    { label: 'params', extraBody: { litellm_params: { headers: headerMap }, optional_params: { extra_headers: headerMap } } },
    { label: 'provider-headers', extraBody: { provider_specific_header: headerMap } },
    { label: 'proxy-request', extraBody: { proxy_server_request: { headers: headerMap, body: { headers: headerMap } } } },
  ];
  for (const attack of attacks) await scenario(`forgery_${attack.label}_both_ingress_routes`, async () => {
    const results = [];
    for (const route of ['messages', 'chat']) results.push(await infer(c, { ...attack, route, stream: route === 'chat' }));
    await verifyMapped(results);
    return { requests: 2, trustedHashOnly: true };
  });

  const invalid = { label: 'invalid-unissued', raw: `sk-local-invalid-${randomUUID()}` };
  invalid.hash = hashKey(invalid.raw); secrets.add(invalid.raw);
  await scenario('invalid_key_never_consumes_idle', () => rejectedWithoutConsumption(invalid, 'invalid'));
  // Exercise the valid key auth cache without inference, then revoke. The actual
  // revoked inference must fail immediately, not after a permissive polling loop.
  const revoked = await generate('revoked-before-inference');
  const beforePrime = await drained();
  httpOk(await request('litellm', '/v1/models', { headers: { Authorization: `Bearer ${revoked.raw}` } }), 'Prime valid virtual-key auth cache');
  check(snapshotLeases(beforePrime) === snapshotLeases(await drained()), 'LiteLLM model discovery unexpectedly acquired a lease');
  await revoke(revoked);
  await scenario('revoked_key_never_consumes_idle', () => rejectedWithoutConsumption(revoked, 'revoked'));
  await revoke(b);
  await scenario('revoked_previously_used_key_cannot_reuse_or_renew_lease', () => rejectedWithoutConsumption(b, 'revoked-used'));

  if (config.otherOnlyModel) await scenario('model_restricted_key_never_consumes_idle', async () => {
    const restricted = await generate('other-only', { models: [config.otherOnlyModel] });
    return rejectedWithoutConsumption(restricted, 'model-denied');
  });
  else record('SKIP', 'model_restricted_key_never_consumes_idle', { reason: 'Supply --other-only-model for a configured non-GHCP group' });
  if (config.fallbackModel) await scenario('configured_fallback_into_ghcp_preserves_identity', async () => {
    httpOk(await request('litellm', '/key/update', { method: 'POST', headers: masterHeaders(), body: { key: c.raw, models: [config.model, config.fallbackModel] } }), 'Add explicit fallback group permission');
    c.models = [config.model, config.fallbackModel];
    await keyInfo(c);
    const result = await infer(c, { label: 'fallback', route: 'chat', model: config.fallbackModel });
    await verifyMapped([result]);
    return { trustedHashAtGhcp: true, primaryFailureRequiresSeparateFixtureEvidence: true };
  });
  else record('SKIP', 'configured_fallback_into_ghcp_preserves_identity', { reason: 'Supply --fallback-model only after configuring a deterministic fallback group' });

  // Functional keys must not steal capacity from the 20-distinct-key pressure test.
  await scenario('restore_initial_idle_for_fair_pressure', async () => {
    await settings({ paused: 1 });
    await releaseOwnedLeases(ownedKeys);
    for (const key of ownedKeys) await revoke(key);
    const value = await drained();
    check(value.leases.length === 0 && value.counts.total === config.initialIdle && value.counts.ready_idle === config.initialIdle,
      'Functional phase left insufficient initial supply for pressure');
    return { idle: value.counts.ready_idle, liveFunctionalKeys: 0 };
  }, { critical: true });
}

async function burstRound(keys, round) {
  const before = await drained();
  const startReady = new Set(before.accounts.filter(item => item.state === 'ready').map(item => item.identity));
  let monitoring = true, monitorError;
  const samples = [];
  const monitor = (async () => {
    while (monitoring) {
      try {
        const value = await pool();
        samples.push({ at: Date.now(), ...value.counts });
      } catch (error) { monitorError = error; return; }
      if (monitoring) await delay(config.pollMs);
    }
  })();
  // No sequential provisioning calls in the inference path; every fetch starts
  // in the same turn. No client inference retries are hidden in this function.
  const settled = await Promise.allSettled(keys.map((key, index) => infer(key, {
    label: `burst-${round}`, route: index % 2 ? 'chat' : 'messages', stream: index % 4 >= 2,
    auth: index % 2 ? 'bearer' : 'x-api-key',
  })));
  monitoring = false;
  await monitor;
  if (monitorError) throw monitorError;
  const transportFailures = settled.filter(item => item.status === 'rejected');
  check(transportFailures.length === 0, 'Burst had transport failures; unsafe to infer exhaustion or retry', { round, failures: transportFailures.length });
  const attempts = settled.map(item => item.value);
  const after = await drained(), state = await mock();
  const successes = [], exhausted = [], unexpected = [];
  const histogram = {};
  for (const attempt of attempts) {
    histogram[attempt.response.status] = (histogram[attempt.response.status] ?? 0) + 1;
    const rows = state.inference.filter(row => row.marker === attempt.marker);
    if (attempt.response.status === 200) successes.push(attempt);
    else if (attempt.response.status >= 400 && codeOf(attempt.response) === 'pool_exhausted') {
      check(rows.length === 0 && !after.leases.some(item => item.callerKeyHash === attempt.key.hash),
        'Exhausted caller reached upstream or consumed a lease', { keyLabel: attempt.key.label });
      exhausted.push(attempt.key);
    } else unexpected.push({ status: attempt.response.status, code: codeOf(attempt.response), route: attempt.route });
  }
  // A live worker can finish provisioning during a burst. A bound of only the
  // initial five would be false: count newly verified identities at the end.
  const completedDuringRound = after.accounts.filter(item => item.state === 'ready' && !startReady.has(item.identity)).length;
  check(successes.length <= before.counts.ready_idle + completedDuringRound, 'Burst successes exceeded actual available member supply', {
    round, successes: successes.length, initialIdle: before.counts.ready_idle, completedDuringRound,
  });
  report.observations.pressureRounds ??= [];
  report.observations.pressureRounds.push({ round, submitted: keys.length, successes: successes.length, exhausted: exhausted.length,
    statuses: histogram, initialIdle: before.counts.ready_idle, completedDuringRound, counts: { ...after.counts },
    maxSampledTotal: Math.max(before.counts.total, after.counts.total, ...samples.map(item => item.total)), sampleCount: samples.length });
  // Report status distributions even if the native Messages adapter fails.
  console.log(`OBSERVED burst_round=${round} ${JSON.stringify(histogram)}`);
  check(unexpected.length === 0, 'Burst returned non-exhaustion errors; not retrying arbitrary failures', { round, unexpected });
  await verifyMapped(successes);
  return { successes, exhausted, before, after, histogram };
}
async function pressure() {
  const keys = [];
  for (let index = 0; index < config.burst; index++) keys.push(await generate(`burst-key-${String(index + 1).padStart(2, '0')}`));
  report.observations.pressureDistinctKeys = keys.length;
  check(unique(keys.map(key => key.hash)), 'Burst keys are not distinct real virtual keys');
  if (config.pressureMode === 'live') await settings({ paused: 0 });
  let first;
  await scenario('twenty_distinct_keys_initial_simultaneous_burst', async () => {
    first = await burstRound(keys, 0);
    if (config.pressureMode === 'paused') {
      check(first.before.settings.paused === 1 && first.after.counts.total === config.initialIdle, 'Paused burst unexpectedly provisioned');
      check(first.successes.length === config.initialIdle && first.exhausted.length === config.burst - config.initialIdle,
        'Paused burst must use exactly the initial supply and reject remaining callers');
    }
    return { submitted: keys.length, successes: first.successes.length, exhausted: first.exhausted.length, statuses: first.histogram,
      pressureMode: config.pressureMode };
  }, { critical: true });

  let pending = first.exhausted;
  const successfulHashes = new Set(first.successes.map(item => item.key.hash));
  await settings({ paused: 0 });
  for (let round = 1; pending.length && round <= config.retryRounds; round++) {
    const value = await poll('autonomous idle refill before exhausted-only retry', () => pool(), next => {
      const desiredIdle = Math.min(config.initialIdle, config.cap - next.counts.leased - next.counts.provisional);
      return desiredIdle > 0 && next.counts.ready_idle >= desiredIdle && next.counts.provisioning === 0;
    });
    record('PASS', `autonomous_ready_refill_round_${round}`, { readyIdle: value.counts.ready_idle, total: value.counts.total });
    check(pending.every(key => !successfulHashes.has(key.hash)), 'Attempted retry of a successful key');
    const next = await burstRound(pending, round);
    for (const item of next.successes) successfulHashes.add(item.key.hash);
    pending = next.exhausted;
  }
  check(pending.length === 0 && successfulHashes.size === keys.length, 'Finite exhausted-only retry budget depleted', {
    successfulDistinctKeys: successfulHashes.size, stillExhausted: pending.length, retryRounds: config.retryRounds,
  });
  await scenario('all_twenty_keys_exact_unique_mappings_bounded_cap', async () => {
    const value = await drained();
    check(value.counts.total === config.cap && value.leases.length === keys.length && value.counts.leased === keys.length
      && value.counts.provisional === 0 && value.counts.failed === 0 && value.counts.provisioning === 0,
    'Final pressure inventory is not fully active and bounded');
    for (const key of keys) {
      const lease = leaseFor(value, key);
      stableLease(expectedMappings.get(key.hash), lease, key.label);
    }
    report.observations.pressureMappings = keys.map(key => {
      const lease = leaseFor(value, key);
      return { keyLabel: key.label, callerKeyHash: key.hash, memberIdentity: lease.memberIdentity, leaseId: lease.leaseId };
    });
    report.observations.pressureFinalCounts = { ...value.counts };
    return { distinctSuccessfulKeys: keys.length, uniqueMembers: value.leases.length, total: value.counts.total,
      cap: config.cap, maxObservedAccounts };
  }, { critical: true });

  await scenario('cap_exhaustion_does_not_oversubscribe_or_reprovision', async () => {
    const extra = await generate('over-cap');
    const result = await burstRound([extra], 'cap');
    check(result.successes.length === 0 && result.exhausted.length === 1 && result.after.counts.total === config.cap,
      'New caller admitted beyond cap');
    const reconcile = httpOk(await request('proxy', '/api/user-pool/reconcile', { method: 'POST', headers: internalHeaders(), body: {} }), 'Reconcile at cap', [202]);
    check(reconcile?.scheduled === true, 'Reconcile not scheduled');
    await validateMockCounters(await drained());
    return { observedStatuses: result.histogram, maxAccounts: config.cap };
  });

  await scenario('release_owned_capacity_restores_idle_target_at_cap', async () => {
    // At cap=20 with twenty leases the physically possible idle target is zero.
    // Releasing five owned leases demonstrates ready-idle restoration without
    // inventing a twenty-first account or reclaiming another caller's lease.
    const before = await drained(), stateBefore = await mock();
    const released = keys.slice(0, config.initialIdle);
    const retained = keys.slice(config.initialIdle).map(key => ({ key, lease: leaseFor(before, key) }));
    await releaseOwnedLeases(released);
    const after = await poll('released members ready at cap', () => pool(), value => value.counts.ready_idle === config.initialIdle
      && value.counts.total === config.cap && value.counts.provisioning === 0);
    for (const { key, lease } of retained) stableLease(lease, leaseFor(after, key), key.label);
    const stateAfter = await mock();
    for (const name of ['scimCreates', 'seatAssignments', 'taskPosts', 'callbacksSucceeded']) check(stateBefore.counters[name] === stateAfter.counters[name], 'Release reprovisioned an account at cap');
    return { readyIdle: after.counts.ready_idle, retainedLeases: after.leases.length, total: after.counts.total };
  });
  await scenario('final_mock_provision_counters_and_no_real_login_tasks', async () => {
    await realLoginEmpty();
    return validateMockCounters(await drained());
  });
}

async function cleanup() {
  if (!fixtureConfirmed) return;
  if (mutatedPool) await scenario('cleanup_pause_disposable_worker', async () => {
    await settings({ paused: 1 }, { cleanup: true, timeout: 10000 });
    return { paused: true, accountInventoryRetained: true };
  });
  await scenario('cleanup_revoke_runner_created_keys', async () => {
    let failures = 0;
    for (const key of ownedKeys.filter(item => !item.deleted)) {
      try { await revoke(key, { cleanup: true, timeout: 5000 }); } catch { failures++; }
    }
    check(failures === 0, 'Some generated keys could not be revoked; destroy disposable gateway volumes', { failures });
    return { revokedKeys: ownedKeys.filter(item => item.deleted).length };
  });
  await scenario('cleanup_real_login_still_empty', async () => { await realLoginEmpty({ cleanup: true, timeout: 5000 }); return { tasks: 0 }; });
}
async function main() {
  let values;
  try { ({ values } = parseArgs({ options: definitions, strict: true, allowPositionals: false })); }
  catch { console.error('FAIL invalid arguments; run --help (argument values suppressed)'); process.exitCode = 1; return; }
  if (values.help) { console.log(HELP); return; }
  if (!values['confirm-local-fixture']) {
    console.error('FAIL require --confirm-local-fixture; no network requests or report written. Run --help.'); process.exitCode = 1; return;
  }
  let deadline;
  try {
    check(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22 or newer is required');
    credentials = {
      master: process.env.GATEWAY_MASTER_KEY ?? 'sk-local-gateway-master-test-only',
      proxy: process.env.GATEWAY_PROXY_KEY ?? 'local-pool-proxy-test-only',
      internal: process.env.GATEWAY_INTERNAL_TOKEN ?? 'local-pool-internal-test-only',
    };
    for (const value of Object.values(credentials)) { secrets.add(value); check(typeof value === 'string' && value.length >= 12, 'Local test credentials must be nonempty test-only values'); }
    config = options(values);
    report.configuration = { ...config, credentials: 'redacted; environment/default local test-only values', maxTokens: 16, leaseSeconds: 3600 };
    deadline = setTimeout(() => abort.abort(), 15 * 60 * 1000);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
    await scenario('local_fixture_safety_and_real_db_readiness', preflight, { critical: true });
    await scenario('initial_idle_preprovision_scim_seats_callbacks_warmup', initialPool, { critical: true });
    await functional();
    await pressure();
  } catch (error) {
    record('FAIL', 'run_aborted_dependent_scenarios_not_run', safeError(error));
  } finally {
    if (deadline) clearTimeout(deadline);
    await cleanup();
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.observations.maxObservedAccounts = maxObservedAccounts;
    report.observations.requestStatusCounts = requests.reduce((counts, item) => {
      const status = item.status ?? 'transport_failed'; counts[status] = (counts[status] ?? 0) + 1; return counts;
    }, {});
    report.summary = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED', 'SKIP'].map(status => [status.toLowerCase(), report.tests.filter(test => test.status === status).length]));
    report.outcome = report.summary.fail ? 'failed' : report.summary.blocked ? 'blocked' : 'passed';
    const serialized = redact(JSON.stringify(report, null, 2));
    try { await writeFile(RESULTS_FILE, `${serialized}\n`, { mode: 0o600 }); }
    catch { console.error('FAIL report_write_failed (path/error details suppressed)'); process.exitCode = 1; return; }
    console.log(`SUMMARY ${JSON.stringify({ outcome: report.outcome, ...report.summary, report: 'local-gateway-results.json' })}`);
    process.exitCode = report.summary.fail ? 1 : report.summary.blocked ? 2 : 0;
  }
}
await main();
