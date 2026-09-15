// Node 22, zero dependencies, local fixtures only. No telemetry or external APIs.
// The only outbound request is the OAuth callback to http://proxy:3000.
// Authenticated POST /test/control {status?:200|401|429|500,retryAfter?:1..120,
// streamMode?:'success'|'error'|'early-eof'|'hold'} controls ONE next inference,
// including warmup: pause provisioning before using it. {} restores normal reply.
// Alternatively include POOL_TEST:{"id":"label","status":500} in user content.
// Marker accepts the same fields plus id (ASCII [A-Za-z0-9._-], <=80 chars),
// takes precedence, and does not consume the pending control. 'error' includes
// an in-band error AND terminal event; early-eof omits terminal; hold waits for
// cancellation (bounded at 30s). /test/state requires X-Internal-Token and records
// identities/counts only, never tokens, passwords, headers, or request bodies.
// State is in memory: restart Proxy, not this fixture, for persistence testing.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
const MockLoginQueue = process.env.MYSQL_PROVISION_FIXTURE === '1'
  ? (await import('./mock-login-queue.mjs')).MockLoginQueue : undefined;

const PORT = Number(process.env.PORT ?? 8002);
const INTERNAL = process.env.INTERNAL_API_TOKEN ?? 'local-pool-internal-test-only';
const SCIM_TOKEN = process.env.SCIM_TOKEN ?? 'local-pool-scim-test-only';
const SEAT_PAT = process.env.SEAT_PAT ?? 'local-pool-seat-test-only';
const SSO_PASSWORD = process.env.SSO_DEFAULT_USER_PASSWORD ?? 'local-pool-sso-test-only';
const proxyUrl = new URL(process.env.PROXY_BASE_URL ?? 'http://proxy:3000');
const callbackOrigins = process.env.MYSQL_STABILITY_FIXTURE === '1'
  ? ['http://proxy:3000', 'http://pool-lb:8081'] : ['http://proxy:3000'];
if (!callbackOrigins.includes(proxyUrl.origin) || proxyUrl.username || proxyUrl.password || proxyUrl.pathname !== '/' || proxyUrl.search || proxyUrl.hash) throw new Error('Callback must use an isolated fixed Proxy origin');
if (![INTERNAL, SCIM_TOKEN, SEAT_PAT, SSO_PASSWORD].every(Boolean)) throw new Error('Fixture credentials must be nonempty');
const RAW_MODEL = process.env.POOL_MOCK_MODEL ?? 'claude-opus-5.2';
const SCIM_ROOT = '/scim/v2/enterprises/local-test/Users';
const BILLING_ROOT = '/enterprises/local-test/copilot/billing';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const users = new Map(), seats = new Set(), tasks = new Map(), tokens = new Map();
const inference = [];
const otherInference = [];
const counters = { scimCreates: 0, scimConflicts: 0, scimUpdates: 0, scimDeletes: 0, seatAssignments: 0, taskPosts: 0, callbacksSucceeded: 0, callbacksFailed: 0, modelLists: 0 };
let nextControl, sequence = 0;
const stageDelay = Number(process.env.POOL_MOCK_STAGE_DELAY_MS ?? 0);
if (!Number.isInteger(stageDelay) || stageDelay < 0 || stageDelay > 1000) throw new Error('Invalid stage delay');
const concurrency = { activeStages: 0, peakStages: 0, requests: 0 };
const isoNow = () => new Date().toISOString();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeString = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,253}$/.test(value);
function equal(a, b) {
  if (typeof a !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function json(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
function failure(res, status, code) { json(res, status, { error: { code, message: `Local fixture: ${code}` } }); }
function scimFailure(res, status, code) {
  json(res, status, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), detail: code }, { 'Content-Type': 'application/scim+json' });
}
function authorize(req, res, expected, bearer = false) {
  if (equal(req.headers[bearer ? 'authorization' : 'x-internal-token'], bearer ? `Bearer ${expected}` : expected)) return true;
  failure(res, 401, 'unauthorized');
  return false;
}
async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('body_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
  if (!record(body)) throw Object.assign(new Error('object_required'), { status: 400 });
  return body;
}
function pageNumber(value, fallback, max = 1000) {
  const number = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw Object.assign(new Error('invalid_pagination'), { status: 400 });
  return number;
}
function scimResource(body, prior) {
  if (!safeString(body.userName) || body.active !== undefined && typeof body.active !== 'boolean') return undefined;
  const now = isoNow();
  return {
    schemas: [USER_SCHEMA], id: prior?.id ?? randomUUID(), userName: body.userName,
    externalId: safeString(body.externalId) ? body.externalId : body.userName,
    displayName: body.userName,
    emails: Array.isArray(body.emails) ? body.emails.filter(email => record(email) && typeof email.value === 'string').map(email => ({ value: email.value, primary: email.primary === true, type: 'work' })) : [],
    roles: [{ value: body.roles?.[0]?.value === 'enterprise_owner' ? 'enterprise_owner' : 'user', primary: false }],
    active: body.active !== false,
    githubLogin: `${body.userName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}_test`,
    meta: { resourceType: 'User', created: prior?.meta.created ?? now, lastModified: now },
  };
}
const duplicateUser = (name, except) => [...users.values()].some(user => user.id !== except && user.userName.toLowerCase() === name.toLowerCase());
const scimReply = (res, status, user) => json(res, status, user, { 'Content-Type': 'application/scim+json', Location: `${SCIM_ROOT}/${user.id}` });
async function scim(req, res, url) {
  if (!authorize(req, res, SCIM_TOKEN, true)) return;
  const path = url.pathname;
  if (path === SCIM_ROOT && req.method === 'GET') {
    let rows = [...users.values()];
    if (url.searchParams.has('filter')) {
      const match = /^userName eq ("(?:[^"\\]|\\.)*")$/.exec(url.searchParams.get('filter'));
      if (!match) return scimFailure(res, 400, 'unsupported_filter');
      let name;
      try { name = JSON.parse(match[1]); } catch { return scimFailure(res, 400, 'invalid_filter'); }
      rows = rows.filter(user => user.userName.toLowerCase() === name.toLowerCase());
    }
    const startIndex = pageNumber(url.searchParams.get('startIndex'), 1, 100000), count = pageNumber(url.searchParams.get('count'), 100);
    const page = rows.slice(startIndex - 1, startIndex - 1 + count);
    return json(res, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: rows.length, startIndex, itemsPerPage: page.length, Resources: page }, { 'Content-Type': 'application/scim+json' });
  }
  if (path === SCIM_ROOT && req.method === 'POST') {
    const user = scimResource(await bodyJson(req));
    if (!user) return scimFailure(res, 400, 'invalid_user');
    if (duplicateUser(user.userName)) { counters.scimConflicts++; return scimFailure(res, 409, 'uniqueness'); }
    users.set(user.id, user); counters.scimCreates++;
    return scimReply(res, 201, user);
  }
  const id = path.startsWith(`${SCIM_ROOT}/`) ? path.slice(SCIM_ROOT.length + 1) : '';
  if (!id || id.includes('/')) return failure(res, 404, 'not_found');
  const existing = users.get(id);
  if (!existing) return scimFailure(res, 404, 'not_found');
  if (req.method === 'GET') return scimReply(res, 200, existing);
  if (req.method === 'PUT') {
    const user = scimResource(await bodyJson(req), existing);
    if (!user) return scimFailure(res, 400, 'invalid_user');
    if (duplicateUser(user.userName, id)) return scimFailure(res, 409, 'uniqueness');
    if (user.githubLogin !== existing.githubLogin || !user.active) seats.delete(existing.githubLogin);
    users.set(id, user); counters.scimUpdates++;
    return scimReply(res, 200, user);
  }
  if (req.method === 'PATCH') {
    const body = await bodyJson(req);
    if (!Array.isArray(body.Operations) || !body.Operations.length) return scimFailure(res, 400, 'invalid_patch');
    const updated = structuredClone(existing);
    for (const operation of body.Operations) {
      if (!record(operation) || String(operation.op).toLowerCase() !== 'replace') return scimFailure(res, 400, 'unsupported_patch');
      const value = operation.path === 'active' ? operation.value : operation.path === undefined && record(operation.value) && Object.keys(operation.value).length === 1 ? operation.value.active : undefined;
      if (typeof value !== 'boolean') return scimFailure(res, 400, 'unsupported_patch');
      updated.active = value;
    }
    updated.meta.lastModified = isoNow();
    if (!updated.active) seats.delete(updated.githubLogin);
    users.set(id, updated); counters.scimUpdates++;
    return scimReply(res, 200, updated);
  }
  if (req.method === 'DELETE') { users.delete(id); seats.delete(existing.githubLogin); counters.scimDeletes++; return json(res, 204); }
  failure(res, 404, 'not_found');
}
async function billing(req, res, url) {
  if (!authorize(req, res, SEAT_PAT, true)) return;
  if (url.pathname === `${BILLING_ROOT}/seats` && req.method === 'GET') {
    const page = pageNumber(url.searchParams.get('page'), 1, 100000), perPage = pageNumber(url.searchParams.get('per_page'), 100);
    return json(res, 200, { total_seats: seats.size, seats: [...seats].slice((page - 1) * perPage, page * perPage).map(login => ({ assignee: { login }, plan_type: 'enterprise' })) });
  }
  if (url.pathname === `${BILLING_ROOT}/selected_users` && ['POST', 'DELETE'].includes(req.method)) {
    const body = await bodyJson(req);
    if (!Array.isArray(body.selected_usernames) || !body.selected_usernames.length || !body.selected_usernames.every(safeString)) return failure(res, 422, 'selected_usernames_required');
    if (!body.selected_usernames.every(login => [...users.values()].some(user => user.active && user.githubLogin === login))) return failure(res, 422, 'active_scim_login_required');
    for (const login of body.selected_usernames) {
      if (req.method === 'POST') { if (!seats.has(login)) counters.seatAssignments++; seats.add(login); }
      else seats.delete(login);
    }
    return json(res, 201, req.method === 'POST' ? { seats_created: body.selected_usernames.length } : { seats_cancelled: body.selected_usernames.length });
  }
  failure(res, 404, 'not_found');
}
async function callback(task) {
  const token = `local-fixture-oauth-${randomUUID()}`;
  tokens.set(token, { identity: task.identity, ghLogin: task.ghLogin });
  try {
    const target = new URL(`/internal/accounts/${encodeURIComponent(task.identity)}/copilot-oauth-token`, proxyUrl);
    if (!callbackOrigins.includes(target.origin)) throw new Error('forbidden_origin');
    const response = await fetch(target, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'X-Internal-Token': INTERNAL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oauthAttemptId: task.oauthAttemptId, copilotOauthToken: token, ghLogin: task.ghLogin }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('callback_rejected');
    counters.callbacksSucceeded++; task.status = 'success';
  } catch {
    tokens.delete(token); counters.callbacksFailed++; task.status = 'failed'; task.error = 'local_callback_failed';
  }
  task.finishedAt = isoNow();
}
const loginQueue = process.env.MYSQL_PROVISION_FIXTURE === '1' ? new MockLoginQueue({
  concurrency: Number(process.env.POOL_MOCK_LOGIN_CONCURRENCY ?? 1),
  delayMs: Number(process.env.POOL_MOCK_LOGIN_DELAY_MS ?? 50), complete: callback,
}) : undefined;
async function fakeLogin(req, res, url) {
  if (!authorize(req, res, INTERNAL)) return;
  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const body = await bodyJson(req);
    if (!['identity', 'ssoUser', 'ghLogin', 'oauthAttemptId'].every(key => safeString(body[key])) || body.ssoType !== 'custom') return failure(res, 400, 'invalid_login_task');
    if (!equal(body.ssoPassword, SSO_PASSWORD)) return failure(res, 401, 'invalid_sso_credentials');
    const user = [...users.values()].find(user => user.userName === body.ssoUser && user.githubLogin === body.ghLogin && user.active);
    if (body.identity !== body.ssoUser || !user || !seats.has(body.ghLogin)) return failure(res, 409, 'scim_and_seat_required');
    // No deduplication/adoption: accidental duplicate POSTs remain visible.
    const task = { id: randomUUID(), identity: body.identity, ssoUser: body.ssoUser, ghLogin: body.ghLogin, oauthAttemptId: body.oauthAttemptId, ssoType: body.ssoType, status: 'running', attempts: 1, createdAt: isoNow(), startedAt: isoNow() };
    tasks.set(task.id, task); counters.taskPosts++;
    if (loginQueue) loginQueue.enqueue(task);
    json(res, 202, task);
    if (!loginQueue) setImmediate(() => { void callback(task); });
    return;
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase(), status = url.searchParams.get('status');
    const rows = [...tasks.values()].filter(task => (!status || task.status === status) && `${task.identity} ${task.ssoUser} ${task.ghLogin}`.toLowerCase().includes(q));
    if (['q', 'page', 'pageSize', 'status'].some(key => url.searchParams.has(key))) {
      const page = pageNumber(url.searchParams.get('page'), 1, 100000), pageSize = pageNumber(url.searchParams.get('pageSize'), 100);
      return json(res, 200, { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize });
    }
    return json(res, 200, rows.slice(0, pageNumber(url.searchParams.get('limit'), 100)));
  }
  const id = url.pathname.slice('/api/tasks/'.length);
  if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET' && !id.includes('/')) return tasks.has(id) ? json(res, 200, tasks.get(id)) : failure(res, 404, 'task_not_found');
  failure(res, 404, 'not_found');
}
function parseControl(value, marker = false) {
  if (!record(value) || Object.keys(value).some(key => !['status', 'retryAfter', 'streamMode', ...(process.env.MYSQL_STABILITY_FIXTURE === '1' ? ['delayMs'] : []), ...(marker ? ['id'] : [])].includes(key))) throw Object.assign(new Error('invalid_control'), { status: 400 });
  const status = value.status ?? 200, streamMode = value.streamMode ?? 'success';
  if (![200, 401, 429, 500].includes(status) || !['success', 'error', 'early-eof', 'hold'].includes(streamMode)
    || value.retryAfter !== undefined && (!Number.isInteger(value.retryAfter) || value.retryAfter < 1 || value.retryAfter > 120)
    || value.id !== undefined && (typeof value.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.id))) throw Object.assign(new Error('invalid_control'), { status: 400 });
  if (value.delayMs !== undefined && (!Number.isInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 25000)) throw Object.assign(new Error('invalid_delay'), { status: 400 });
  return { status, streamMode, retryAfter: value.retryAfter ?? 5, delayMs: value.delayMs ?? 0, ...(value.id ? { id: value.id } : {}) };
}
function bodyControl(body) {
  const strings = [];
  function visit(value) {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (record(value)) { if ('content' in value) visit(value.content); if ('text' in value) visit(value.text); }
  }
  visit(body.messages); visit(body.input);
  for (const text of strings) {
    const match = /POOL_TEST:(\{[^\n]*?\})/.exec(text);
    if (match) {
      try { return parseControl(JSON.parse(match[1]), true); }
      catch { throw Object.assign(new Error('invalid_marker'), { status: 400 }); }
    }
  }
}
function payload(path, id) {
  if (path === '/v1/messages') return { id: `msg_${id}`, type: 'message', role: 'assistant', model: RAW_MODEL, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 1 } };
  if (path === '/chat/completions') return { id: `chatcmpl_${id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: RAW_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
  return { id: `resp_${id}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: RAW_MODEL, status: 'completed', error: null, incomplete_details: null, output: [{ id: `msg_${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } };
}
async function stream(res, path, data, control, log) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const event = (name, value) => res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  const typed = (name, value) => event(name, { type: name, ...value });
  if (path === '/v1/messages') {
    typed('message_start', { message: { ...data, content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } });
    typed('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
  } else if (path === '/chat/completions') {
    event(null, { id: data.id, object: 'chat.completion.chunk', created: data.created, model: RAW_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] });
  } else {
    typed('response.created', { sequence_number: 0, response: { ...data, status: 'in_progress', output: [], usage: null } });
    typed('response.output_item.added', { sequence_number: 1, output_index: 0, item: { ...data.output[0], status: 'in_progress', content: [] } });
    typed('response.content_part.added', { sequence_number: 2, item_id: data.output[0].id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    typed('response.output_text.delta', { sequence_number: 3, item_id: data.output[0].id, output_index: 0, content_index: 0, delta: 'OK' });
  }
  const end = outcome => { log.outcome = outcome; log.endedAt = Date.now(); res.end(); };
  if (control.streamMode === 'hold') {
    const tick = setInterval(() => { if (!res.destroyed) res.write(': local fixture hold\n\n'); }, 250);
    const deadline = setTimeout(() => end('early_eof'), 30000);
    res.once('close', () => { clearInterval(tick); clearTimeout(deadline); });
    return;
  }
  if (control.delayMs) {
    const pulse = setInterval(() => { if (!res.destroyed) res.write(': fixture stream pending\n\n'); }, 250);
    res.once('close', () => clearInterval(pulse));
    await new Promise(resolve => setTimeout(resolve, control.delayMs));
    clearInterval(pulse);
    if (res.destroyed) return;
  }
  if (control.streamMode === 'early-eof') return end('early_eof');
  if (control.streamMode === 'error') typed('error', { error: { type: 'api_error', code: 'fixture_stream_error', message: 'Local fixture stream failure' } });
  if (path === '/v1/messages') {
    typed('content_block_stop', { index: 0 });
    typed('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    typed('message_stop', {});
  } else if (path === '/chat/completions') {
    event(null, { id: data.id, object: 'chat.completion.chunk', created: data.created, model: RAW_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: data.usage });
    event(null, '[DONE]');
  } else {
    typed('response.output_text.done', { sequence_number: 4, item_id: data.output[0].id, output_index: 0, content_index: 0, text: 'OK' });
    typed('response.content_part.done', { sequence_number: 5, item_id: data.output[0].id, output_index: 0, content_index: 0, part: data.output[0].content[0] });
    typed('response.output_item.done', { sequence_number: 6, output_index: 0, item: data.output[0] });
    typed('response.completed', { sequence_number: 7, response: data });
  }
  end(control.streamMode === 'error' ? 'in_band_error' : 'complete');
}
async function upstream(req, res, url) {
  const auth = req.headers.authorization;
  const member = typeof auth === 'string' && auth.startsWith('Bearer ') ? tokens.get(auth.slice(7)) : undefined;
  if (!member) return failure(res, 401, 'invalid_fixture_token');
  if (url.pathname === '/models' && req.method === 'GET') {
    counters.modelLists++;
    return json(res, 200, { object: 'list',       data: [...new Set([RAW_MODEL, 'claude-opus-5.2'])].map(id => ({ id, object: 'model', name: 'Local fixture model', vendor: 'Anthropic', capabilities: { type: 'chat', endpoints: ['/v1/messages', '/chat/completions', '/responses'] } })) });
  }
  if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') { await bodyJson(req); return json(res, 200, { input_tokens: 4 }); }
  if (!['/v1/messages', '/chat/completions', '/responses'].includes(url.pathname) || req.method !== 'POST') return failure(res, 404, 'not_found');
  const body = await bodyJson(req);
  if (body.model !== RAW_MODEL) return failure(res, 400, 'raw_model_required');
  const marker = bodyControl(body), control = marker ?? nextControl ?? parseControl({});
  if (!marker) nextControl = undefined;
  const log = { seq: ++sequence, identity: member.identity, path: url.pathname, model: body.model, stream: body.stream === true, marker: marker?.id ?? null, status: control.status, streamMode: control.streamMode, startedAt: Date.now(), endedAt: null, outcome: 'pending' };
  inference.push(log);
  if (inference.length > 10000) inference.shift();
  res.once('close', () => { if (log.outcome === 'pending') { log.outcome = 'cancelled'; log.endedAt = Date.now(); } });
  if (control.status !== 200) {
    log.outcome = 'http_error'; log.endedAt = Date.now();
    return json(res, control.status, { type: 'error', error: { type: control.status === 401 ? 'authentication_error' : control.status === 429 ? 'rate_limit_error' : 'api_error', code: `fixture_${control.status}`, message: `Local fixture HTTP ${control.status}` } }, control.status === 429 ? { 'Retry-After': String(control.retryAfter) } : {});
  }
  const data = payload(url.pathname, log.seq);
  if (body.stream === true) return await stream(res, url.pathname, data, control, log);
  if (control.delayMs) await new Promise(resolve => setTimeout(resolve, control.delayMs));
  if (res.destroyed) return;
  if (control.streamMode !== 'success') return failure(res, 400, 'stream_mode_requires_stream');
  log.outcome = 'complete'; log.endedAt = Date.now();
  return json(res, 200, data);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (req.method === 'GET' && ['/healthz', '/readyz'].includes(url.pathname)) return json(res, 200, { status: 'ok', service: 'local-pool-mock', fixture: true });
    if (url.pathname === '/test/counts' && req.method === 'GET') {
      if (!authorize(req, res, INTERNAL)) return;
      return json(res, 200, { fixture: true, counters, loginQueue: loginQueue?.snapshot() ?? null,
        counts: { users: users.size, seats: seats.size, tasks: tasks.size, inference: inference.length, otherInference: otherInference.length },
        nextControl: nextControl ?? null });
    }
    if (url.pathname === '/test/state' && req.method === 'GET') {
      if (!authorize(req, res, INTERNAL)) return;
      return json(res, 200, { fixture: true, counters, concurrency, loginQueue: loginQueue?.snapshot() ?? null, users: [...users.values()].map(({ id, userName, githubLogin, active }) => ({ id, userName, githubLogin, active })), seats: [...seats], tasks: [...tasks.values()], inference, otherInference, nextControl: nextControl ?? null });
    }
    if (url.pathname === '/test/control' && req.method === 'POST') {
      if (!authorize(req, res, INTERNAL)) return;
      nextControl = parseControl(await bodyJson(req));
      return json(res, 200, { accepted: true, next: nextControl });
    }
    if (url.pathname === '/other/v1/messages' && req.method === 'POST') {
      if (!equal(req.headers.authorization, 'Bearer local-other-provider-test-only')
          && !equal(req.headers['x-api-key'], 'local-other-provider-test-only')) return failure(res, 401, 'unauthorized');
      const body = await bodyJson(req);
      otherInference.push({ model: body.model, identityHeaderPresent: Boolean(req.headers['x-user-identity']) });
      return json(res, 200, payload('/v1/messages', `other-${otherInference.length}`));
    }
    if (stageDelay > 0 && !url.pathname.startsWith('/test/')) {
      concurrency.requests++;
      concurrency.activeStages++;
      concurrency.peakStages = Math.max(concurrency.peakStages, concurrency.activeStages);
      let finished = false;
      const complete = () => { if (!finished) { finished = true; concurrency.activeStages--; } };
      res.once('finish', complete);
      res.once('close', complete);
      await new Promise(resolve => setTimeout(resolve, stageDelay));
    }
    if (url.pathname === SCIM_ROOT || url.pathname.startsWith(`${SCIM_ROOT}/`)) return await scim(req, res, url);
    if (url.pathname.startsWith(`${BILLING_ROOT}/`)) return await billing(req, res, url);
    if (url.pathname === '/api/tasks' || url.pathname.startsWith('/api/tasks/')) return await fakeLogin(req, res, url);
    if (['/models', '/v1/messages', '/v1/messages/count_tokens', '/chat/completions', '/responses'].includes(url.pathname)) return await upstream(req, res, url);
    failure(res, 404, 'not_found');
  } catch (error) {
    if (res.headersSent) res.destroy();
    else failure(res, Number.isInteger(error.status) ? error.status : 500, Number.isInteger(error.status) ? error.message : 'fixture_internal_error');
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`LOCAL_POOL_MOCK_READY port=${PORT}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
