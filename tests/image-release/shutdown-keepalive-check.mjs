// Isolated image-level check of the shared graceful shutdown (src/packages/shared/src/shutdown.ts) with keep-alive
// clients, for all four release images. For each service a client (shutdown-keepalive-fixture.mjs) holds
//   A  an idle keep-alive connection,
//   B  a request in flight at SIGTERM (response headers not sent yet),
//   C  for Proxy an SSE stream and for Console a streamed CSV export whose headers were already sent,
// then the service gets SIGTERM through `docker stop`. Once the service logs that it started draining, the client is
// told (a file in its container), opens a new connection D, lets the mock end C and finishes B's upload.
// Expected from the candidate:
//   - A is closed at once (its FIN follows the "draining" log line); D is refused;
//   - B's response carries `Connection: close` and the server sends FIN right after it;
//   - C completes normally and the server sends FIN right after its last chunk;
//   - the container exits 0 well before the 25 s drain timeout, without the force-close log line
//     ("requests still running after ... closing their connections").
// Optional control (RELEASE_QUALIFICATION_CONTROL_TAG, an older multi tag): must show the old behaviour (B and C stay
// open and are reused after SIGTERM until the drain timeout force-closes them), which shows the check is meaningful.
//
// Safety: one internal network (explicit subnet) and containers named `<project>-*`, labelled
// ghcp.qualification=<project>; no published ports; synthetic credentials only; no builds or pulls; mocks only.
// Every container is left stopped (nothing is removed); the report goes to stdout as JSON.
//
// Inputs: RELEASE_QUALIFICATION_PROJECT (ghcp-release-qualification-<suffix>), RELEASE_QUALIFICATION_CANDIDATE_TAG,
// RELEASE_QUALIFICATION_ISOLATED_SUBNET (unused 10.x.y.0/24), RELEASE_QUALIFICATION_CERTS_DIR (synthetic IdP
// certificate directory for SSO), optional RELEASE_QUALIFICATION_CONTROL_TAG.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTEXT = 'desktop-linux';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'shutdown-keepalive-fixture.mjs');
const NODE_IMAGE = 'node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562';
const PROJECT = process.env.RELEASE_QUALIFICATION_PROJECT ?? '';
const CANDIDATE = process.env.RELEASE_QUALIFICATION_CANDIDATE_TAG ?? '';
const CONTROL = process.env.RELEASE_QUALIFICATION_CONTROL_TAG ?? '';
const SUBNET = process.env.RELEASE_QUALIFICATION_ISOLATED_SUBNET ?? '';
const CERTS = resolve(process.env.RELEASE_QUALIFICATION_CERTS_DIR ?? '');
const TOKEN = 'shutdown-fixture-internal-only';
const API_KEY = 'shutdown-fixture-api-only';
const SESSION = 'shutdown-fixture-session-secret-long-only';
const MEMBER = 'shutdown-member';
const DRAIN_TIMEOUT_MS = 25_000; // DEFAULT_SHUTDOWN_TIMEOUT_MS; SHUTDOWN_TIMEOUT_MS is not set here
const WELL_BEFORE_MS = 15_000;
const FIN_WITHIN_MS = 1_000;
const SERVICES = ['proxy', 'sso', 'login', 'console'];
const PORTS = { proxy: 3000, sso: 7001, login: 7003, console: 7004 };

if (!/^ghcp-release-qualification-[a-z0-9-]+$/.test(PROJECT)) throw new Error('RELEASE_QUALIFICATION_PROJECT');
if (!/^multi-[0-9a-f]{7}-amd64-r\d+$/.test(CANDIDATE)) throw new Error('RELEASE_QUALIFICATION_CANDIDATE_TAG');
if (CONTROL && !/^multi-[0-9a-f]{7}-amd64-r\d+$/.test(CONTROL)) throw new Error('RELEASE_QUALIFICATION_CONTROL_TAG');
if (!/^10\.\d{1,3}\.\d{1,3}\.0\/24$/.test(SUBNET)) throw new Error('RELEASE_QUALIFICATION_ISOLATED_SUBNET');
if (!existsSync(join(CERTS, 'idp-cert.pem')) || !existsSync(join(CERTS, 'idp-key.pem'))) {
  throw new Error('RELEASE_QUALIFICATION_CERTS_DIR');
}

const NETWORK = `${PROJECT}_isolated`;
const LABEL = `ghcp.qualification=${PROJECT}`;
const report = { project: PROJECT, candidate: CANDIDATE, control: CONTROL || null, subnet: SUBNET,
  drainTimeoutMs: DRAIN_TIMEOUT_MS, wellBeforeMs: WELL_BEFORE_MS, assertions: [], runs: {}, images: {}, containers: [] };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function docker(args, { allowFail = false, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', ['--context', CONTEXT, ...args], { encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  if (!allowFail && result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function dockerAsync(args) {
  const started = Date.now();
  const child = spawn('docker', ['--context', CONTEXT, ...args], { shell: false });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((done) => child.on('close', (code) => done({ code, ms: Date.now() - started, output })));
}

function check(condition, name, detail) {
  const pass = Boolean(condition);
  report.assertions.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  console.error(JSON.stringify({ assertion: name, pass }));
  return pass;
}

const running = (name) => docker(['inspect', name, '--format', '{{.State.Running}}'], { allowFail: true }).stdout.trim() === 'true';

function run(name, image, env, extra = [], command = []) {
  docker(['run', '-d', '--pull', 'never', '--name', name, '--label', LABEL, '--network', NETWORK, ...extra,
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image, ...command]);
  report.containers.push(name);
}

function serviceEnv(service) {
  const common = { INTERNAL_API_TOKEN: TOKEN, SESSION_SECRET: SESSION };
  if (service === 'proxy') {
    return { ...common, PORT: '3000', STORAGE_DRIVER: 'sqlite', DB_PATH: '/tmp/proxy.sqlite', ACCOUNT_ROUTING_MODE: 'direct',
      API_KEY, COPILOT_API_BASE_URL: 'http://mock:8002', SSO_BASE_URL: 'http://sso:7001', LOGIN_BASE_URL: 'http://login:7003',
      PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', PROXY_ERROR_DIAGNOSTICS_REDACT: 'true' };
  }
  if (service === 'sso') {
    return { ...common, PORT: '7001', DB_PATH: '/tmp/sso.sqlite', CERT_DIR: '/certs', BASE_URL: 'http://sso:7001',
      PROXY_BASE_URL: 'http://proxy:3000', MOCK_GITHUB_BASE_URL: 'http://mock:8002', GITHUB_API_BASE_URL: 'http://mock:8002',
      SCIM_BASE_URL: 'http://mock:8002/scim', SCIM_TOKEN: 'shutdown-fixture-scim-only', ENTERPRISE_SLUG: 'shutdown-fixture',
      ENTERPRISE_SHORTCODE: 'fixture', SSO_DEFAULT_USER_PASSWORD: 'shutdown-fixture-password-only' };
  }
  if (service === 'login') {
    return { ...common, PORT: '7003', DB_PATH: '/tmp/login.sqlite', PROXY_BASE_URL: 'http://proxy:3000',
      SSO_URL: 'http://sso:7001/login', AUTH_HEADLESS: 'true' };
  }
  // Console forwards /api/console/proxy/* to the mock, which serves the slow CSV export.
  return { ...common, PORT: '7004', ADMINS_FILE: '/tmp/admins.json', PROXY_BASE_URL: 'http://mock:8002',
    SSO_BASE_URL: 'http://sso:7001', LOGIN_BASE_URL: 'http://login:7003' };
}

function healthz(container, service, path = '/healthz') {
  const port = PORTS[service];
  const script = `fetch('http://127.0.0.1:${port}${path}').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))`
    + '.catch(e=>console.log(JSON.stringify({status:0})))';
  const out = docker(['exec', container, 'node', '-e', script], { allowFail: true });
  try { return JSON.parse(out.stdout.trim().split('\n').at(-1)); } catch { return { status: 0 }; }
}

async function waitHealthy(container, service, seconds = 90) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (!running(container)) return { running: false };
    const health = healthz(container, service);
    const ready = service === 'proxy' ? healthz(container, service, '/readyz') : health;
    if (health.status === 200 && ready.status === 200) return { running: true, health: health.body };
    await sleep(1000);
  }
  return { running: running(container), timeout: true };
}

const inferenceHeaders = { authorization: `Bearer ${API_KEY}`, 'x-user-identity': MEMBER, 'x-claude-code-optimized': 'true',
  'anthropic-version': '2023-06-01' };
const inferenceBodyTemplate = { model: 'claude-opus-5-5', max_tokens: 64,
  messages: [{ role: 'user', content: 'Synthetic shutdown question' }] };

function clientSpec(service) {
  const base = { host: service, port: PORTS[service], internalToken: TOKEN, inferenceHeaders, inferenceBodyTemplate,
    member: MEMBER, ssoHost: 'sso:7001', mockHost: 'mock:8002', reuseMs: 45_000 };
  const internal = { 'x-internal-token': TOKEN };
  if (service === 'proxy') {
    return { ...base, setup: 'proxy', expectStatus: 200,
      slow: { path: '/v1/messages', headers: inferenceHeaders, body: JSON.stringify({ ...inferenceBodyTemplate, stream: false }) },
      stream: { method: 'POST', path: '/v1/messages', headers: inferenceHeaders,
        body: JSON.stringify({ ...inferenceBodyTemplate, stream: true }), terminal: 'message_stop' } };
  }
  if (service === 'sso') {
    return { ...base, expectStatus: 201, slow: { path: '/api/enterprises/default/users', headers: internal,
      body: JSON.stringify({ ssoUser: 'shutdown-probe', password: 'shutdown-fixture-password-only', email: 'shutdown-probe@example.test' }) } };
  }
  if (service === 'login') {
    // Cancelling a task that does not exist: read-only, answered only after the JSON body was read.
    return { ...base, expectStatus: 404, slow: { path: '/api/enterprises/default/tasks/shutdown-probe/cancel',
      headers: internal, body: JSON.stringify({ reason: 'shutdown-probe' }) } };
  }
  return { ...base, setup: 'console', expectStatus: 401,
    slow: { path: '/api/console/login', headers: {}, body: JSON.stringify({ username: 'shutdown-admin', password: 'wrong-password-only' }) },
    stream: { method: 'GET', path: '/api/console/proxy/shutdown-export.csv', headers: {}, terminal: 'end,complete' } };
}

function clientLines(name) {
  const out = docker(['logs', name], { allowFail: true });
  return out.stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => {
    try { return JSON.parse(line); } catch { return {}; }
  });
}

/** One service: start the client, wait until it is ready, `docker stop` the service, collect everything. */
async function runService(label, service) {
  const target = `${PROJECT}-${label}-${service}`;
  const client = `${PROJECT}-${label}-client-${service}`;
  const spec = clientSpec(service);
  const encoded = Buffer.from(JSON.stringify(spec)).toString('base64');
  run(client, NODE_IMAGE, {}, ['-v', `${FIXTURE}:/fixtures/fixture.mjs:ro`], ['node', '/fixtures/fixture.mjs', 'client', encoded]);
  const readyBy = Date.now() + 90_000;
  let ready;
  while (Date.now() < readyBy && !ready) {
    ready = clientLines(client).find((line) => line.phase === 'ready');
    if (!ready && !running(client)) break;
    if (!ready) await sleep(200);
  }
  if (!ready) return { service, error: 'client_not_ready', clientLogs: docker(['logs', client], { allowFail: true }) };
  const stopping = dockerAsync(['stop', '-t', '60', target]);
  // Wait for the service's own drain log line, then tell the client: B is in flight and C is streaming at that
  // moment by construction, however slowly Docker Desktop delivers the signal.
  let drainLine = null;
  const drainBy = Date.now() + 60_000;
  while (!drainLine && Date.now() < drainBy) {
    const out = docker(['logs', '--timestamps', target], { allowFail: true });
    drainLine = `${out.stdout}\n${out.stderr}`.split(/\r?\n/)
      .find((line) => line.includes('received, draining in-flight requests')) ?? null;
    if (!drainLine) await sleep(100);
  }
  docker(['exec', client, 'touch', '/tmp/shutdown-check-draining'], { allowFail: true });
  const stop = await stopping;
  const clientBy = Date.now() + 120_000;
  while (running(client) && Date.now() < clientBy) await sleep(500);
  const lines = clientLines(client);
  const state = JSON.parse(docker(['inspect', target]).stdout)[0].State;
  const logs = docker(['logs', target], { allowFail: true });
  const text = `${logs.stdout}\n${logs.stderr}`;
  const result = lines.find((line) => line.phase === 'result') ?? null;
  // Docker's log timestamp and the client's wall clock come from the same Docker Desktop VM.
  const millis = (iso) => (iso ? Date.parse(iso.replace(/(\.\d{3})\d+/, '$1')) : NaN);
  const drainLogAt = drainLine ? drainLine.split(' ', 1)[0] : null;
  const aFinAfterDrainLogMs = result?.a.finWall && drainLogAt ? millis(result.a.finWall) - millis(drainLogAt) : null;
  return {
    service, expectStatus: spec.expectStatus, setup: ready.setup, before: ready.before,
    trigger: lines.find((line) => line.phase === 'trigger') ?? null,
    released: lines.find((line) => line.phase === 'released')?.released ?? null,
    drainLogAt, aFinAfterDrainLogMs, result,
    stop: { code: stop.code, ms: stop.ms },
    exitCode: state.ExitCode, oomKilled: state.OOMKilled,
    log: {
      drainStarted: /SIGTERM received, draining in-flight requests/.test(text),
      forcedClose: /closing their connections/.test(text),
      forcedCloseLines: text.split(/\r?\n/).filter((line) => line.includes('closing their connections')).slice(0, 3),
      shutdownComplete: /shutdown complete/.test(text),
      tail: text.split(/\r?\n/).filter((line) => /\[(proxy|sso|login|console)\]/.test(line)).slice(-6),
    },
  };
}

function finAfter(conn, response) {
  return conn && response && conn.finAt !== null && conn.error === null && conn.finAt >= response.completeAt
    && conn.finAt - response.completeAt <= FIN_WITHIN_MS;
}

function assertCandidate(r) {
  const s = r.service;
  const res = r.result;
  if (!check(res, `${s}_client_completed`, { error: r.error ?? null, setup: r.setup ?? null })) return;
  const setupOk = s === 'proxy' ? r.setup.ssoUser === 201 && r.setup.import === 200 && r.setup.sanity === 200
    : s === 'console' ? r.setup.consoleSetup === 201 && r.setup.cookie : true;
  check(setupOk && r.before.aResponses === 1 && r.before.bOpen, `${s}_setup_and_connections_ready`,
    { setup: r.setup, before: r.before });
  // A was refreshed about once a second, so only the drain can have closed it: its FIN must follow the service's
  // "draining" log line closely (the log timestamp is taken by Docker when it reads the line, hence the -200 ms).
  check(res.triggered && res.a.finAt !== null && res.a.error === null && r.aFinAfterDrainLogMs !== null
    && r.aFinAfterDrainLogMs >= -200 && r.aFinAfterDrainLogMs <= FIN_WITHIN_MS, `${s}_idle_connection_closed_at_sigterm`,
  { aFinAfterDrainLogMs: r.aFinAfterDrainLogMs, drainLogAt: r.drainLogAt, a: res.a, trigger: r.trigger });
  check(res.d.ok === false && res.d.code === 'ECONNREFUSED', `${s}_new_connection_refused_while_draining`, { d: res.d });
  const b0 = res.b.responses[0];
  check(b0?.status === r.expectStatus && b0.connection === 'close', `${s}_inflight_response_has_connection_close`,
    { b: res.b });
  check(finAfter(res.b, b0), `${s}_inflight_connection_fin_after_response`,
    { finAfterResponseMs: b0 && res.b.finAt !== null ? res.b.finAt - b0.completeAt : null, error: res.b.error });
  if (res.c) {
    const c0 = res.c.responses[0];
    check(res.c.headersBeforeTrigger && c0?.status === 200 && res.c.terminal && c0.connection !== 'close'
      && finAfter(res.c, c0) && c0.completeAt > 0, `${s}_stream_started_before_sigterm_completes_then_fin`,
    { c: { ...res.c, finAfterCompleteMs: c0 && res.c.finAt !== null ? res.c.finAt - c0.completeAt : null } });
  }
  check(r.exitCode === 0 && r.stop.code === 0 && r.stop.ms < WELL_BEFORE_MS && r.log.drainStarted && r.log.shutdownComplete,
    `${s}_exit_0_well_before_drain_timeout`, { exitCode: r.exitCode, stopMs: r.stop.ms, log: r.log.tail });
  check(!r.log.forcedClose, `${s}_no_forced_close_log_line`, { forcedCloseLines: r.log.forcedCloseLines });
}

function assertControl(r) {
  const s = r.service;
  const res = r.result;
  if (!check(res, `control_${s}_client_completed`, { error: r.error ?? null })) return;
  const b0 = res.b.responses[0];
  check(b0?.status === r.expectStatus && b0.connection !== 'close' && res.reuse.attempted && res.reuse.served >= 1,
    `control_${s}_inflight_connection_left_open_and_reused`,
    { connection: b0?.connection ?? null, reuse: res.reuse, bFinAt: res.b.finAt, bError: res.b.error });
  if (res.c) {
    check(res.c.terminal && res.c.reuse?.served === true, `control_${s}_stream_connection_left_open_and_reused`,
      { reuse: res.c.reuse, finAt: res.c.finAt });
  }
  // Host-side duration: the Docker Desktop VM's monotonic clock can run a few percent fast, so allow 5 s.
  check(r.log.forcedClose && r.stop.ms >= DRAIN_TIMEOUT_MS - 5000, `control_${s}_forced_close_at_drain_timeout`,
    { stopMs: r.stop.ms, exitCode: r.exitCode, forcedCloseLines: r.log.forcedCloseLines });
}

async function runVersion(label, tag) {
  const names = Object.fromEntries(['mock', ...SERVICES].map((service) => [service, `${PROJECT}-${label}-${service}`]));
  run(names.mock, NODE_IMAGE, {}, ['--network-alias', 'mock', '-v', `${FIXTURE}:/fixtures/fixture.mjs:ro`],
    ['node', '/fixtures/fixture.mjs', 'mock']);
  for (const service of SERVICES) {
    const extra = ['--network-alias', service, ...(service === 'sso' ? ['-v', `${CERTS}:/certs:ro`] : [])];
    run(names[service], `ghcp-release-${service}:${tag}`, serviceEnv(service), extra);
  }
  const health = {};
  for (const service of SERVICES) health[service] = await waitHealthy(names[service], service);
  const nodeVersion = docker(['exec', names.proxy, 'node', '-v'], { allowFail: true }).stdout.trim();
  const results = [];
  if (Object.values(health).every((h) => h.running && !h.timeout)) {
    for (const service of SERVICES) results.push(await runService(label, service));
  }
  docker(['stop', '-t', '10', names.mock], { allowFail: true });
  for (const name of Object.values(names)) if (running(name)) docker(['stop', '-t', '60', name], { allowFail: true });
  report.runs[label] = { tag, nodeVersion, health, results };
  return { health, results };
}

async function main() {
  const existing = docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}']).stdout.trim();
  if (existing || docker(['network', 'inspect', NETWORK], { allowFail: true }).status === 0) throw new Error('project_not_fresh');
  const tags = [CANDIDATE, ...(CONTROL ? [CONTROL] : [])];
  for (const image of [NODE_IMAGE, ...tags.flatMap((tag) => SERVICES.map((s) => `ghcp-release-${s}:${tag}`))]) {
    const inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}'], { allowFail: true });
    if (inspected.status !== 0) throw new Error(`image_missing ${image}`);
    report.images[image] = inspected.stdout.trim();
  }
  docker(['network', 'create', '--internal', '--label', LABEL, '--subnet', SUBNET, NETWORK]);
  try {
    const candidate = await runVersion('candidate', CANDIDATE);
    check(Object.values(candidate.health).every((h) => h.running && h.health?.releaseLine === 'multi'),
      'candidate_services_healthy_release_line_multi', candidate.health);
    for (const r of candidate.results) assertCandidate(r);
    if (CONTROL) {
      const control = await runVersion('control', CONTROL);
      check(Object.values(control.health).every((h) => h.running), 'control_services_healthy', control.health);
      for (const r of control.results) assertControl(r);
    }
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    for (const name of report.containers) if (running(name)) docker(['stop', '-t', '60', name], { allowFail: true });
    report.pass = !report.failure && report.assertions.length > 0 && report.assertions.every((a) => a.pass);
    report.counts = { assertions: report.assertions.length, passed: report.assertions.filter((a) => a.pass).length };
    report.cleanup = 'all containers stopped and kept; network kept';
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
}

await main();
