#!/usr/bin/env node
// End-to-end validation of deploy/kubernetes on a local kind cluster (tests/kubernetes/README.md).
//
//   node tests/kubernetes/kind-e2e.mjs setup     # kind cluster (dedicated kubeconfig) + local images loaded
//   node tests/kubernetes/kind-e2e.mjs run       # fresh "external" MySQL container + phases A and B
//   node tests/kubernetes/kind-e2e.mjs clean     # delete the test namespaces and the MySQL container
//   node tests/kubernetes/kind-e2e.mjs teardown  # clean + delete the kind cluster, its kubeconfig and the image tag
//
// Required: KIND_E2E_KUBECONFIG = absolute path of a kubeconfig used ONLY for this cluster (never ~/.kube/config).
// Optional: KIND_BIN (default `kind`), KIND_E2E_CLUSTER (ghcp-k8s-check), KIND_E2E_MYSQL_IMAGE (mysql:8.4),
// KIND_E2E_RUN_DIR (default .claude/kind-e2e-run-<time>, git-ignored).
//
// Every kubectl call passes --kubeconfig and --context explicitly. Only mocks and synthetic credentials are used:
// GitHub, GHE.com, SCIM and Copilot are tests/docker-user-pool/mock-services.mjs inside the cluster; no request
// leaves the machine. Images are local release tags loaded with `kind load docker-image` (never pulled); the
// manifests' image names are replaced by the kind-shared overlay.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../image-release/qualification-multi-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TAG = 'multi-f43f27e-amd64-r3'; // must match the newTag values in overlays/kind-shared
const SERVICES = ['proxy', 'sso', 'login', 'console'];
const PORTS = { proxy: 3000, sso: 7001, login: 7003, console: 7004 };
const NODE_FIXTURE_SOURCE = lib.NODE_IMAGE;
const NODE_FIXTURE = 'ghcp-k8s-check/node-fixture:efd0ab5';
const MYSQL_CONTAINER = 'ghcp-k8s-check-mysql';
const MYSQL_MARKER = '198.51.100.77/32';
const NS = { ghe: 'ghcp-e2e-ghe', dba: 'ghcp-e2e-dba', mock: 'ghcp-e2e-mock', caller: 'ghcp-e2e-caller',
  outsider: 'ghcp-e2e-outsider' };
const MOCK_URL = `http://ghcp-mock.${NS.mock}.svc.cluster.local:8002`;
const MODEL = 'claude-opus-5-2';
const PROTOCOLS = ['/v1/messages', '/chat/completions', '/responses'];
const GHE_ENTITY = 'http://fixture.ghe.com:8002/enterprises/local-test';
/** An old Proxy pod must go from SIGTERM to "shutdown complete" well within SHUTDOWN_TIMEOUT_MS (25 s). */
const DRAIN_BOUND_MS = 5000;

const cfg = {
  kubeconfig: process.env.KIND_E2E_KUBECONFIG ?? '',
  cluster: process.env.KIND_E2E_CLUSTER ?? 'ghcp-k8s-check',
  kind: process.env.KIND_BIN ?? 'kind',
  mysqlImage: process.env.KIND_E2E_MYSQL_IMAGE ?? 'mysql:8.4',
};
cfg.context = `kind-${cfg.cluster}`;
cfg.runDir = process.env.KIND_E2E_RUN_DIR
  ?? join(ROOT, '.claude', `kind-e2e-run-${new Date().toISOString().replace(/[:.]/g, '-')}`);

const report = { started: new Date().toISOString(), tag: TAG, cluster: cfg.cluster, assertions: [], notes: [] };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const random = (bytes = 24) => randomBytes(bytes).toString('base64url');

// ------------------------------------------------------------------------------------------------------------
// Process helpers

function exec(command, args, { input, timeout = 120000, allowFail = false } = {}) {
  const result = spawnSync(command, args, { input, timeout, encoding: 'utf8', shell: false, maxBuffer: 64 << 20 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    const shown = args.map((arg) => (arg.length > 200 ? `${arg.slice(0, 60)}...` : arg)).join(' ');
    throw new Error(`${command} ${shown} exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  return result;
}

const kubeArgs = (args) => ['--kubeconfig', cfg.kubeconfig, '--context', cfg.context, ...args];
const kc = (args, options) => exec('kubectl', kubeArgs(args), options);
const kcJson = (args, options) => JSON.parse(kc([...args, '-o', 'json'], options).stdout);

function kcAsync(args) {
  const child = spawn('kubectl', kubeArgs(args), { shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolveDone) => child.on('close', (code) => resolveDone({ code, stdout, stderr })));
  return { child, done };
}

function guardContext() {
  if (!cfg.kubeconfig || !isAbsolute(cfg.kubeconfig)) throw new Error('Set KIND_E2E_KUBECONFIG to an absolute path.');
  const defaults = [join(homedir(), '.kube', 'config'), process.env.KUBECONFIG].filter(Boolean).map((p) => resolve(p));
  if (defaults.includes(resolve(cfg.kubeconfig))) throw new Error('Refusing to use a default kubeconfig.');
  if (!/^ghcp-[a-z0-9-]+$/.test(cfg.cluster)) throw new Error('Cluster name must start with ghcp-.');
}

function guardCluster() {
  const view = JSON.parse(exec('kubectl', ['--kubeconfig', cfg.kubeconfig, 'config', 'view', '-o', 'json']).stdout);
  const context = view.contexts?.find((entry) => entry.name === cfg.context);
  const cluster = view.clusters?.find((entry) => entry.name === context?.context?.cluster);
  const server = cluster?.cluster?.server ?? '';
  if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(server)) throw new Error(`Context ${cfg.context} is not a local kind API server.`);
  const nodes = kcJson(['get', 'nodes']).items.map((node) => node.metadata.name);
  if (!nodes.every((name) => name.startsWith(`${cfg.cluster}-`))) throw new Error(`Unexpected nodes: ${nodes}`);
  return nodes;
}

// ------------------------------------------------------------------------------------------------------------
// Report

/** Records an assertion; a failure stops the run unless `soft` (then only the report fails). */
function check(phase, name, pass, details = {}, { soft = false } = {}) {
  const entry = { phase, name, pass: Boolean(pass), details };
  report.assertions.push(entry);
  console.log(`${pass ? 'PASS' : 'FAIL'} [${phase}] ${name} ${JSON.stringify(details).slice(0, soft ? 3000 : 600)}`);
  if (!pass && !soft) {
    const error = new Error(`${phase}/${name} failed`);
    error.assertion = entry;
    throw error;
  }
  return entry;
}

function note(message, details = {}) {
  report.notes.push({ message, details });
  console.log(`NOTE ${message} ${JSON.stringify(details).slice(0, 400)}`);
}

function saveReport() {
  mkdirSync(cfg.runDir, { recursive: true });
  writeFileSync(join(cfg.runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

async function poll(label, read, predicate, timeoutMs = 120000, intervalMs = 2000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: String(error.message ?? error) };
    }
    await sleep(intervalMs);
  }
  throw Object.assign(new Error(`${label} timed out`), { last });
}

// ------------------------------------------------------------------------------------------------------------
// In-cluster HTTP (tests/kubernetes/fixtures/driver.mjs) and container probes

function driver(op, { ns = NS.caller, pod = 'litellm-sim', timeout = 120000 } = {}) {
  const encoded = Buffer.from(JSON.stringify(op)).toString('base64');
  const result = kc(['-n', ns, 'exec', pod, '-c', 'driver', '--', 'node', '/drv/driver.mjs', encoded], { timeout });
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function driverAsync(op, { ns = NS.caller, pod = 'litellm-sim' } = {}) {
  const encoded = Buffer.from(JSON.stringify(op)).toString('base64');
  const { child, done } = kcAsync(['-n', ns, 'exec', pod, '-c', 'driver', '--', 'node', '/drv/driver.mjs', encoded]);
  return { child, done: done.then((out) => JSON.parse(out.stdout.trim().split(/\r?\n/).at(-1))) };
}

/** Runs a Node snippet inside a running app container (the release image has node but no shell tools). */
function inContainer(ns, pod, container, script, { timeout = 60000 } = {}) {
  const result = kc(['-n', ns, 'exec', pod, '-c', container, '--', 'node', '-e', script], { timeout });
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function pods(ns, name) {
  return kcJson(['-n', ns, 'get', 'pods', '-l', `app.kubernetes.io/name=ghcp-${name}`]).items
    .filter((pod) => !pod.metadata.deletionTimestamp);
}

function readyPods(ns, name) {
  return pods(ns, name).filter((pod) => pod.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
}

const svc = (ns, service) => `http://ghcp-${service}.${ns}.svc.cluster.local:${PORTS[service]}`;
const podUrl = (pod, service) => `http://${pod.status.podIP}:${PORTS[service]}`;

// ------------------------------------------------------------------------------------------------------------
// External MySQL (a Docker container on the kind network, outside every namespace)

const state = { secrets: {} };

function mysql(sql, { database = '', timeout = 120000, args = [] } = {}) {
  const result = exec('docker', ['exec', '-i', '-e', `MYSQL_PWD=${state.mysqlRootPassword}`, MYSQL_CONTAINER,
    'mysql', '-uroot', '-N', '-B', ...args, ...(database ? [database] : [])], { input: sql, timeout });
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function startMysql() {
  const existing = exec('docker', ['ps', '-a', '--filter', `name=^${MYSQL_CONTAINER}$`, '--format', '{{.Labels}}']).stdout.trim();
  if (existing) {
    if (!existing.includes('ghcp.k8s-check=kind-e2e')) throw new Error(`${MYSQL_CONTAINER} exists and is not ours`);
    exec('docker', ['rm', '-f', MYSQL_CONTAINER]);
  }
  state.mysqlRootPassword = random();
  exec('docker', ['run', '-d', '--name', MYSQL_CONTAINER, '--label', 'ghcp.k8s-check=kind-e2e', '--network', 'kind',
    '-e', `MYSQL_ROOT_PASSWORD=${state.mysqlRootPassword}`, cfg.mysqlImage,
    // Like a managed MySQL: TLS required, utf8mb4 defaults. Trigger creation by the migrating (non-SUPER)
    // account with binary logging on needs log_bin_trust_function_creators (DBA decision on managed servers).
    '--require-secure-transport=ON', '--log-bin-trust-function-creators=1']);
  // The image's entrypoint first runs a temporary server without networking, then restarts: wait for TCP.
  await poll('mysql_ready', () => mysql('SELECT 1;', { args: ['--protocol=tcp', '-h127.0.0.1'] }),
    (lines) => lines[0] === '1', 180000, 3000);
  const inspect = JSON.parse(exec('docker', ['inspect', MYSQL_CONTAINER]).stdout)[0];
  state.mysqlIp = inspect.NetworkSettings.Networks.kind.IPAddress;
  state.mysqlCa = exec('docker', ['exec', MYSQL_CONTAINER, 'cat', '/var/lib/mysql/ca.pem']).stdout;
  const variables = mysql("SHOW VARIABLES WHERE Variable_name IN ('require_secure_transport','version','character_set_server','log_bin');");
  report.mysql = { image: cfg.mysqlImage, ip: state.mysqlIp, variables };
  // Synthetic, per-run values only; the run directory is git-ignored. Kept so a failed run can be inspected.
  writeFileSync(join(cfg.runDir, 'state.json'), JSON.stringify({ mysqlRootPassword: state.mysqlRootPassword,
    mysqlIp: state.mysqlIp, secrets: state.secrets }, null, 2), { mode: 0o600 });
  note('external MySQL container started on the kind network', { ip: state.mysqlIp, variables });
}

function schemaFingerprint(database) {
  const parts = [
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${database}' ORDER BY 1,2;`,
    `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='${database}' ORDER BY 1,2,3;`,
    `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${database}' ORDER BY 1;`,
    `SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='${database}' ORDER BY 1;`,
  ];
  return sha(parts.map((sql) => mysql(sql).join('\n')).join('\n--\n'));
}

// ------------------------------------------------------------------------------------------------------------
// Fixtures in the cluster

function generateCerts() {
  const dir = join(cfg.runDir, 'certs');
  mkdirSync(dir, { recursive: true });
  exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'idp-key.pem'),
    '-out', join(dir, 'idp-cert.pem'), '-days', '30', '-subj', '/CN=ghcp-kind-e2e-synthetic-idp']);
  state.certPem = readFileSync(join(dir, 'idp-cert.pem'), 'utf8');
  state.certDir = dir;
  new X509Certificate(state.certPem); // parses
}

function syntheticSecrets() {
  state.secrets = {
    internal: random(), session: random(), apiKey: random(), scim: random(), seat: random(),
    ssoPassword: `pool-${random(18)}`, consolePassword: `console-${random(18)}`,
  };
}

function deployFixtures() {
  kc(['apply', '-f', join(ROOT, 'tests/kubernetes/fixtures/mock.yaml')], { allowFail: true });
  const mockDir = join(ROOT, 'tests/docker-user-pool');
  const fixture = ['create', 'configmap', 'ghcp-mock-fixtures', '-n', NS.mock,
    `--from-file=mock-services.mjs=${join(mockDir, 'mock-services.mjs')}`,
    `--from-file=mock-ghe.mjs=${join(mockDir, 'mock-ghe.mjs')}`,
    `--from-file=mock-login-queue.mjs=${join(mockDir, 'mock-login-queue.mjs')}`];
  kc(fixture);
  kc(['create', 'secret', 'generic', 'ghcp-mock-credentials', '-n', NS.mock,
    `--from-literal=INTERNAL_API_TOKEN=${state.secrets.internal}`, `--from-literal=SCIM_TOKEN=${state.secrets.scim}`,
    `--from-literal=SEAT_PAT=${state.secrets.seat}`,
    `--from-literal=SSO_DEFAULT_USER_PASSWORD=${state.secrets.ssoPassword}`]);
  kc(['apply', '-f', join(ROOT, 'tests/kubernetes/fixtures/mock.yaml')]);
  for (const ns of [NS.caller, NS.outsider]) {
    kc(['create', 'namespace', ns]);
    kc(['create', 'configmap', 'ghcp-driver', '-n', ns,
      `--from-file=driver.mjs=${join(ROOT, 'tests/kubernetes/fixtures/driver.mjs')}`]);
  }
  kc(['apply', '-f', join(ROOT, 'tests/kubernetes/fixtures/clients.yaml')]);
  kc(['-n', NS.mock, 'rollout', 'status', 'deployment/ghcp-mock', '--timeout=180s'], { timeout: 200000 });
  for (const [ns, pod] of [[NS.caller, 'litellm-sim'], [NS.outsider, 'outsider']]) {
    kc(['-n', ns, 'wait', '--for=condition=Ready', `pod/${pod}`, '--timeout=180s'], { timeout: 200000 });
  }
}

/** Secrets the base references by name, created like an operator would (README section 3). */
function createAppSecrets(ns, mysqlUrl) {
  kc(['create', 'namespace', ns]);
  const s = state.secrets;
  kc(['-n', ns, 'create', 'secret', 'generic', 'ghcp-internal',
    `--from-literal=INTERNAL_API_TOKEN=${s.internal}`, `--from-literal=SESSION_SECRET=${s.session}`]);
  kc(['-n', ns, 'create', 'secret', 'generic', 'ghcp-proxy',
    `--from-literal=API_KEY=${s.apiKey}`, `--from-literal=MYSQL_URL=${mysqlUrl}`]);
  kc(['-n', ns, 'create', 'secret', 'generic', 'ghcp-sso', `--from-literal=SCIM_TOKEN=${s.scim}`,
    `--from-literal=GITHUB_COPILOT_SEAT_PAT=${s.seat}`, `--from-literal=SSO_DEFAULT_USER_PASSWORD=${s.ssoPassword}`]);
  kc(['-n', ns, 'create', 'secret', 'generic', 'ghcp-sso-saml',
    `--from-file=idp-cert.pem=${join(state.certDir, 'idp-cert.pem')}`,
    `--from-file=idp-key.pem=${join(state.certDir, 'idp-key.pem')}`]);
  const caFile = join(cfg.runDir, 'mysql-ca.pem');
  writeFileSync(caFile, state.mysqlCa);
  kc(['-n', ns, 'create', 'configmap', 'ghcp-mysql-ca', `--from-file=ca.pem=${caFile}`]);
}

function renderOverlay(overlay) {
  const rendered = exec('kubectl', ['kustomize', join(ROOT, 'tests/kubernetes/overlays', overlay)]).stdout;
  const occurrences = rendered.split(MYSQL_MARKER).length - 1;
  if (occurrences !== 1) throw new Error(`expected one MySQL CIDR marker in ${overlay}, found ${occurrences}`);
  const text = rendered.replace(MYSQL_MARKER, `${state.mysqlIp}/32`);
  writeFileSync(join(cfg.runDir, `${overlay}.rendered.yaml`), text);
  return text;
}

function waitRollouts(ns, timeoutSeconds = 600) {
  for (const service of SERVICES) {
    kc(['-n', ns, 'rollout', 'status', `deployment/ghcp-${service}`, `--timeout=${timeoutSeconds}s`],
      { timeout: (timeoutSeconds + 30) * 1000 });
  }
}

function dumpDiagnostics(ns, label) {
  try {
    const dir = join(cfg.runDir, 'diagnostics', label);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pods.json'), kc(['-n', ns, 'get', 'pods', '-o', 'json'], { allowFail: true }).stdout);
    writeFileSync(join(dir, 'events.txt'), kc(['-n', ns, 'get', 'events', '--sort-by=.lastTimestamp'], { allowFail: true }).stdout);
    for (const service of SERVICES) {
      for (const flag of [[], ['--previous']]) {
        const out = kc(['-n', ns, 'logs', `deployment/ghcp-${service}`, '--all-containers', '--tail=400', ...flag],
          { allowFail: true });
        writeFileSync(join(dir, `${service}${flag.length ? '-previous' : ''}.log`), `${out.stdout}${out.stderr}`);
      }
    }
  } catch (error) {
    console.log(`diagnostics failed: ${error.message}`);
  }
}

// ------------------------------------------------------------------------------------------------------------
// Pod lifecycle watch: records how each container ended before its pod was deleted

function startPodWatch(ns) {
  const { child, done } = kcAsync(['-n', ns, 'get', 'pods', '-l', 'app.kubernetes.io/part-of=ghcp', '--watch',
    '--output-watch-events', '-o', 'json']);
  const terminated = new Map(); // pod name -> { container -> { exitCode, reason, finishedAt } }
  const deleted = new Map(); // pod name -> deletionTimestamp
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = completeJsonEnd(buffer);
      if (end < 0) break;
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end).replace(/^\s+/, '');
      const pod = event.object;
      const name = pod?.metadata?.name;
      if (!name) continue;
      if (pod.metadata.deletionTimestamp && !deleted.has(name)) deleted.set(name, pod.metadata.deletionTimestamp);
      for (const status of pod.status?.containerStatuses ?? []) {
        const ended = status.state?.terminated;
        if (ended) {
          const entry = terminated.get(name) ?? {};
          entry[status.name] = { exitCode: ended.exitCode, reason: ended.reason, finishedAt: ended.finishedAt,
            startedAt: ended.startedAt };
          terminated.set(name, entry);
        }
      }
    }
  });
  return { stop: async () => { child.kill(); await done; return { terminated, deleted }; } };
}

/** Index just past the first complete top-level JSON value in `text`, or -1. */
function completeJsonEnd(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return i + 1;
    }
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------------------
// Product API helpers (all from inside the cluster)

const internal = () => ({ 'X-Internal-Token': state.secrets.internal });

function proxyApi(pod, path, { method = 'GET', body } = {}) {
  return driver({ url: `${podUrl(pod, 'proxy')}${path}`, method, body, headers: internal() });
}

function inferRequest(url, caller, path, marker, stream) {
  const body = path === '/responses'
    ? { model: MODEL, stream, input: marker, max_output_tokens: 16 }
    : { model: MODEL, stream, messages: [{ role: 'user', content: marker }], max_tokens: 16 };
  return { url: `${url}${path}`, method: 'POST', body, timeoutMs: 60000,
    headers: { Authorization: `Bearer ${state.secrets.apiKey}`, 'X-User-Identity': caller } };
}

function inferenceOk(result, path, stream) {
  if (result.status !== 200) return false;
  if (!stream) {
    const data = result.json;
    return data?.model === MODEL && (path === '/responses' ? data.status === 'completed'
      : path === '/chat/completions' ? data.choices?.[0]?.message?.content === 'OK' : data.content?.[0]?.text === 'OK');
  }
  if (!result.headers['content-type']?.includes('text/event-stream')) return false;
  const events = (result.text ?? '').split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) return [];
    try { return [data === '[DONE]' ? data : JSON.parse(data)]; } catch { return [{ unparsable: true }]; }
  });
  const terminal = path === '/chat/completions' ? events.includes('[DONE]')
    : events.some((event) => event.type === (path === '/responses' ? 'response.completed' : 'message_stop'));
  return terminal && !events.some((event) => event.error || event.type === 'error' || event.unparsable);
}

const callerId = (label) => `sha256:${sha(label)}`;
const mockState = () => driver({ url: `${MOCK_URL}/test/state`, headers: internal() }).json;

function settings(pod) {
  const result = proxyApi(pod, '/api/user-pool/settings');
  if (result.status !== 200) throw new Error(`settings ${result.status}`);
  return result.json;
}

function patchSettings(pod, changes) {
  const previous = settings(pod);
  const result = proxyApi(pod, '/api/user-pool/settings', { method: 'PATCH',
    body: { expectedVersion: previous.version, changes } });
  if (result.status !== 200) throw new Error(`settings patch ${result.status} ${JSON.stringify(result.json)}`);
  return result.json;
}

function consoleLogin(ns) {
  const login = driver({ url: `${svc(ns, 'console')}/api/console/login`, method: 'POST',
    body: { username: 'kind-admin', password: state.secrets.consolePassword } });
  const cookie = (login.headers?.['set-cookie'] ?? []).map((line) => line.split(';', 1)[0]).join('; ');
  return { status: login.status, cookie };
}

function releaseLines(ns) {
  const lines = {};
  for (const service of SERVICES) {
    for (const pod of readyPods(ns, service)) {
      const health = inContainer(ns, pod.metadata.name, service,
        `fetch('http://127.0.0.1:${PORTS[service]}/healthz').then((r) => r.json()).then((j) => console.log(JSON.stringify(j)))`);
      lines[pod.metadata.name] = health.releaseLine;
    }
  }
  return lines;
}

// ------------------------------------------------------------------------------------------------------------
// Phase A: GHE.com overlay + network policies, MySQL auto-migration, real SSO and Login (Chromium) against the mock

async function phaseA() {
  const P = 'A';
  const ns = NS.ghe;
  const dbPassword = random();
  // The privilege list of docs/multi-enterprise-new-deployment-guide.md section 3.1 (method A), nothing more.
  mysql([
    'CREATE DATABASE ghcp_ghe CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
    `CREATE USER 'ghcp_ghe'@'%' IDENTIFIED BY '${dbPassword}' REQUIRE SSL;`,
    "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON `ghcp_ghe`.* TO 'ghcp_ghe'@'%';",
  ].join('\n'));
  createAppSecrets(ns, `mysql://ghcp_ghe:${encodeURIComponent(dbPassword)}@${state.mysqlIp}:3306/ghcp_ghe`);
  kc(['apply', '-f', '-'], { input: renderOverlay('kind-ghe') });

  // 1. Start gate: nothing starts until GHCP_CONFIG_APPROVED is "true".
  const gated = await poll('config_gate', () => SERVICES.map((service) => {
    const pod = pods(ns, service)[0];
    const init = pod?.status?.initContainerStatuses?.[0];
    return { service, exitCode: init?.lastState?.terminated?.exitCode ?? init?.state?.terminated?.exitCode, pod: pod?.metadata.name };
  }), (rows) => rows.every((row) => row.exitCode === 1), 180000, 3000);
  const gateLogs = gated.map((row) => kc(['-n', ns, 'logs', row.pod, '-c', 'require-approved-config'], { allowFail: true }).stdout);
  check(P, 'config_gate_blocks_unapproved_start', gateLogs.every((log) => log.includes('GHCP_CONFIG_APPROVED is not "true"'))
    && SERVICES.every((service) => readyPods(ns, service).length === 0), { services: gated.map((row) => row.service) });

  kc(['-n', ns, 'patch', 'configmap', 'ghcp-common', '--type', 'merge', '-p', '{"data":{"GHCP_CONFIG_APPROVED":"true"}}']);
  kc(['-n', ns, 'rollout', 'restart', 'deployment']);
  try {
    waitRollouts(ns, 600);
  } catch (error) {
    dumpDiagnostics(ns, 'phaseA-start');
    throw error;
  }

  // 2. Fresh start
  const proxies = readyPods(ns, 'proxy');
  check(P, 'all_pods_ready', proxies.length === 2 && ['sso', 'login', 'console'].every((s) => readyPods(ns, s).length === 1),
    { proxy: proxies.length });
  const lines = releaseLines(ns);
  check(P, 'healthz_release_line_multi', Object.keys(lines).length === 5 && Object.values(lines).every((line) => line === 'multi'), lines);
  const readyz = proxies.map((pod) => driver({ url: `${podUrl(pod, 'proxy')}/readyz` }));
  check(P, 'proxy_readyz_mysql_both_replicas', readyz.every((r) => r.status === 200 && r.json?.storage === 'mysql'),
    { readyz: readyz.map((r) => r.json) });
  const identity = proxies.map((pod) => inContainer(ns, pod.metadata.name, 'proxy',
    "let ro; try { require('node:fs').writeFileSync('/app/.probe', 'x'); ro = false } catch (e) { ro = e.code } console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), rootWrite: ro }))"));
  check(P, 'non_root_read_only_root_fs', identity.every((row) => row.uid === 1000 && row.rootWrite === 'EROFS'), identity);

  const migrations = mysql('SELECT id FROM schema_migrations ORDER BY id;', { database: 'ghcp_ghe' });
  const expected = lib.expectedFreshMysqlMigrationIds();
  check(P, 'mysql_migrations_complete', lib.missingMigrationIds(migrations, expected).length === 0
    && migrations.length === expected.length, { migrations: migrations.length, expected: expected.length });
  const enterprises = mysql('SELECT id, state, max_accounts, inventory_count FROM proxy_enterprises;', { database: 'ghcp_ghe' });
  const lists = proxies.map((pod) => proxyApi(pod, '/api/enterprises').json?.items ?? []);
  check(P, 'only_default_enterprise_active', enterprises.length === 1 && enterprises[0] === 'default\tactive\t5\t0'
    && lists.every((items) => items.length === 1 && items[0].id === 'default' && items[0].pool?.state === 'active'),
  { mysql: enterprises, listed: lists.map((items) => items.map((item) => ({ id: item.id, pool: item.pool?.state }))) });
  const readiness = await poll('default_ready', () => proxyApi(proxies[0], '/api/enterprises').json.items[0].readiness,
    (value) => value?.ready === true || (Array.isArray(value?.blockers) && value.blockers.length === 0), 120000, 5000);
  check(P, 'default_readiness_no_blockers', true, { readiness });
  const tls = mysql("SELECT COUNT(*) FROM performance_schema.status_by_thread s JOIN performance_schema.threads t USING (thread_id) WHERE t.processlist_user='ghcp_ghe' AND s.variable_name='Ssl_version' AND s.variable_value LIKE 'TLS%';");
  check(P, 'proxy_mysql_connections_use_tls_verify_ca', Number(tls[0]) > 0, { tlsSessions: Number(tls[0]), sslMode: 'verify-ca' });

  // 3. Console first run
  const setupBefore = driver({ url: `${svc(ns, 'console')}/api/console/setup` });
  const crossSite = driver({ url: `${svc(ns, 'console')}/api/console/setup`, method: 'POST',
    headers: { Origin: 'http://attacker.invalid' }, body: { username: 'kind-admin', password: state.secrets.consolePassword } });
  const setup = driver({ url: `${svc(ns, 'console')}/api/console/setup`, method: 'POST',
    body: { username: 'kind-admin', password: state.secrets.consolePassword } });
  const again = driver({ url: `${svc(ns, 'console')}/api/console/setup`, method: 'POST',
    body: { username: 'second-admin', password: `x-${state.secrets.consolePassword}` } });
  check(P, 'console_first_run_initialization', setupBefore.json?.initialized === false && crossSite.status === 403
    && setup.status === 201 && again.status === 400,
  { statuses: [setupBefore.status, crossSite.status, setup.status, again.status] });
  const session = consoleLogin(ns);
  const me = driver({ url: `${svc(ns, 'console')}/api/console/me`, headers: { cookie: session.cookie } });
  const wrong = driver({ url: `${svc(ns, 'console')}/api/console/login`, method: 'POST',
    body: { username: 'kind-admin', password: 'wrong-password-for-kind' } });
  const consoleEnterprises = driver({ url: `${svc(ns, 'console')}/api/console/proxy/enterprises`, headers: { cookie: session.cookie } });
  check(P, 'console_login_and_default_overview', session.status === 200 && me.json?.username === 'kind-admin'
    && wrong.status === 401 && consoleEnterprises.json?.items?.length === 1 && consoleEnterprises.json.items[0].id === 'default',
  { statuses: [session.status, me.status, wrong.status, consoleEnterprises.status] });
  state.consoleCookie = session.cookie;

  // 4. Open the pool: synthetic accounts through real SSO + real Login (Chromium) + mock GHE.com
  const initial = settings(proxies[1]);
  check(P, 'pool_starts_at_idle_target_zero', Number(initial.idle_target) === 0, { idle_target: initial.idle_target, paused: initial.paused });
  patchSettings(proxies[1], { idle_target: 2, paused: 0 });
  const started = Date.now();
  let summary;
  try {
    summary = await poll('pool_fill', () => proxyApi(proxies[0], '/api/enterprises/default/user-pool/summary').json,
      (value) => value?.counts?.ready_idle === 2 && value.counts.provisioning === 0, 600000, 5000);
  } catch (error) {
    dumpDiagnostics(ns, 'phaseA-pool');
    note('pool fill failed', { last: error.last });
    throw error;
  }
  patchSettings(proxies[0], { paused: 1 });
  const ghe = driver({ url: `${MOCK_URL}/test/ghe`, headers: internal() }).json;
  const accepted = ghe.ghe.samlResponses.filter((row) => row.accepted);
  const hosts = Object.keys(ghe.ghe.hosts);
  check(P, 'pool_provisions_synthetic_accounts', summary.counts.ready_idle === 2
    && ghe.ghe.deviceCodeRequests.length >= 2 && accepted.length >= 2 && accepted.every((row) => row.audience === GHE_ENTITY)
    && ghe.ghe.tokensIssued.length >= 2 && ghe.users.length === 2 && ghe.users.every((u) => !u.githubLogin.includes('_'))
    && hosts.includes('scim:api.fixture.ghe.com') && hosts.includes('seats:api.fixture.ghe.com'),
  { fillMs: Date.now() - started, counts: summary.counts, deviceCodes: ghe.ghe.deviceCodeRequests.length,
    samlAccepted: accepted.length, hosts: ghe.ghe.hosts });
  const ssoUsers = driver({ url: `${svc(ns, 'sso')}/api/enterprises/default/users?page=1&pageSize=100`, headers: internal() }).json;
  const tasks = driver({ url: `${svc(ns, 'console')}/api/console/login-service/enterprises/default/tasks?page=1&pageSize=100`,
    headers: { cookie: state.consoleCookie } }).json;
  check(P, 'sso_users_and_login_tasks_recorded', ssoUsers?.total === 2 && tasks?.items?.filter((t) => t.status === 'success').length === 2,
    { ssoUsers: ssoUsers?.total, tasks: tasks?.items?.map((t) => t.status) });
  state.ssoUser = ssoUsers.items[0].ssoUser ?? ssoUsers.items[0].username;
  state.counts = { ssoUsers: ssoUsers.total, tasks: tasks.total ?? tasks.items.length };

  // 5. Caller through both Proxy replicas: JSON and SSE, same member
  const caller = callerId('kind-e2e-caller-1');
  const results = [];
  let n = 0;
  for (const path of PROTOCOLS) {
    for (const stream of [false, true]) {
      const pod = proxies[n % 2];
      const marker = `POOL_TEST:${JSON.stringify({ id: `k8s-proto-${n}` })}`;
      const result = driver(inferRequest(podUrl(pod, 'proxy'), caller, path, marker, stream));
      results.push({ path, stream, replica: pod.metadata.name, status: result.status, ok: inferenceOk(result, path, stream) });
      n++;
    }
  }
  const inference = mockState().inference.filter((row) => row.marker?.startsWith('k8s-proto-'));
  const members = [...new Set(inference.map((row) => row.identity))];
  check(P, 'caller_json_sse_both_replicas_same_member', results.every((row) => row.ok) && inference.length === 6
    && members.length === 1 && inference.every((row) => row.outcome === 'complete'), { results, members: members.length });
  const leases = proxies.map((pod) => proxyApi(pod, '/api/enterprises/default/user-pool/leases').json.items
    .find((row) => row.callerKeyHash === caller));
  check(P, 'caller_lease_shared_by_replicas', leases.every((lease) => lease?.phase === 'active'
    && lease.leaseId === leases[0].leaseId && lease.memberIdentity === members[0]), { phases: leases.map((l) => l?.phase) });
  state.caller = caller;
  state.member = members[0];
  const other = driver(inferRequest(podUrl(proxies[1], 'proxy'), callerId('kind-e2e-caller-2'), '/v1/messages',
    'POOL_TEST:{"id":"k8s-other"}', false));
  const otherRow = mockState().inference.find((row) => row.marker === 'k8s-other');
  check(P, 'second_caller_gets_other_member', other.status === 200 && otherRow?.identity && otherRow.identity !== state.member,
    { status: other.status });
  const badKey = driver({ ...inferRequest(svc(ns, 'proxy'), caller, '/v1/messages', 'x', false),
    headers: { Authorization: 'Bearer wrong', 'X-User-Identity': caller } });
  const badIdentity = driver({ ...inferRequest(svc(ns, 'proxy'), caller, '/v1/messages', 'x', false),
    headers: { Authorization: `Bearer ${state.secrets.apiKey}`, 'X-User-Identity': 'alice' } });
  check(P, 'proxy_rejects_bad_key_and_identity', badKey.status === 401 && badIdentity.status === 403
    && badIdentity.json?.error?.code === 'invalid_caller_identity', { statuses: [badKey.status, badIdentity.status] });

  // 6. SSO root paths: metadata and SAML login
  ssoChecks(P, ns);

  // 7. Network policies (enforced by kindnet in this kind version)
  networkPolicyChecks(P, ns, proxies);

  // 8. Rolling restarts: clean exits, Proxy keeps serving
  await restartChecks(P, ns);

  // 9. Deleting the SQLite pods keeps their PVC data
  await pvcChecks(P, ns);
}

function ssoChecks(P, ns) {
  const base = svc(ns, 'sso');
  const metadata = driver({ url: `${base}/metadata` });
  const identity = lib.metadataIdentity(metadata.text);
  const expectedCert = lib.pemCertificateSha256(state.certPem);
  const scopedDefault = driver({ url: `${base}/enterprises/default/metadata` });
  check(P, 'sso_metadata_root_path', metadata.status === 200 && identity.entityId === `${base}/metadata`
    && identity.certificateSha256 === expectedCert && scopedDefault.status === 404,
  { entityId: identity.entityId, certMatches: identity.certificateSha256 === expectedCert, scopedDefault: scopedDefault.status });
  const wrong = driver({ url: `${base}/login`, method: 'POST', form: { username: state.ssoUser, password: 'wrong-password' } });
  const login = driver({ url: `${base}/login`, method: 'POST', form: { username: state.ssoUser, password: state.secrets.ssoPassword } });
  const cookies = lib.parseSetCookies(login.headers?.['set-cookie'] ?? []);
  const cookie = lib.cookieHeader(cookies, 'sso_session');
  const saml = driver({ url: `${base}/sso`, headers: { cookie } });
  const anonymous = driver({ url: `${base}/sso` });
  check(P, 'sso_saml_login_root_path', wrong.status === 401 && login.status === 200 && Boolean(cookie)
    && lib.samlOutcome(saml, '/login') === 'saml_response' && lib.samlOutcome(anonymous, '/login') === 'login_redirect',
  { statuses: { wrong: wrong.status, login: login.status, saml: saml.status, anonymous: anonymous.status } });
}

function networkPolicyChecks(P, ns, proxies) {
  const blocked = (result) => result.status === 0;
  const outsider = { ns: NS.outsider, pod: 'outsider' };
  const probes = {
    outsiderToProxyPod: driver({ url: `${podUrl(proxies[0], 'proxy')}/healthz`, timeoutMs: 4000 }, outsider),
    outsiderToProxyService: driver({ url: `${svc(ns, 'proxy')}/healthz`, timeoutMs: 4000 }, outsider),
    outsiderToSso: driver({ url: `${svc(ns, 'sso')}/healthz`, timeoutMs: 4000 }, outsider),
    outsiderToConsole: driver({ url: `${svc(ns, 'console')}/healthz`, timeoutMs: 4000 }, outsider),
    callerToLogin: driver({ url: `${svc(ns, 'login')}/healthz`, timeoutMs: 4000 }),
  };
  const control = {
    outsiderToMock: driver({ url: `${MOCK_URL}/healthz`, timeoutMs: 4000 }, outsider),
    callerToProxy: driver({ url: `${svc(ns, 'proxy')}/healthz`, timeoutMs: 4000 }),
  };
  const outsiderIp = kcJson(['-n', NS.outsider, 'get', 'pod', 'outsider']).status.podIP;
  const egress = inContainer(ns, proxies[0].metadata.name, 'proxy',
    `Promise.all([fetch('http://${outsiderIp}:8080', { signal: AbortSignal.timeout(4000) }).then((r) => r.status, (e) => 0),
      fetch('${MOCK_URL}/healthz', { signal: AbortSignal.timeout(4000) }).then((r) => r.status, (e) => 0)])
      .then(([outsider, mock]) => console.log(JSON.stringify({ outsider, mock })))`);
  check(P, 'network_policy_enforced', Object.values(probes).every(blocked) && control.outsiderToMock.status === 200
    && control.callerToProxy.status === 200 && egress.outsider === 0 && egress.mock === 200, {
    blocked: Object.fromEntries(Object.entries(probes).map(([key, value]) => [key, value.status])),
    allowed: { outsiderToMock: control.outsiderToMock.status, callerToProxy: control.callerToProxy.status },
    proxyEgress: egress,
  });
}

/** Follows the logs of every Proxy pod (old and new) so shutdown messages survive pod deletion. */
function followProxyLogs(ns, label) {
  const dir = join(cfg.runDir, 'logs', label);
  mkdirSync(dir, { recursive: true });
  const followed = new Map();
  const timer = setInterval(() => {
    let items = [];
    try { items = kcJson(['-n', ns, 'get', 'pods', '-l', 'app.kubernetes.io/name=ghcp-proxy']).items; } catch { return; }
    for (const pod of items) {
      const name = pod.metadata.name;
      const running = pod.status.containerStatuses?.some((c) => c.name === 'proxy' && c.state?.running);
      if (followed.has(name) || !running) continue;
      const follower = kcAsync(['-n', ns, 'logs', '-f', '--timestamps', name, '-c', 'proxy']);
      followed.set(name, follower);
      follower.done.then((out) => writeFileSync(join(dir, `${name}.log`), `${out.stdout}${out.stderr}`));
    }
  }, 1500);
  return async () => {
    clearInterval(timer);
    await sleep(3000);
    for (const follower of followed.values()) follower.child.kill();
    await Promise.all([...followed.values()].map((follower) => follower.done));
    await sleep(500);
    return [...followed.keys()];
  };
}

/** Samples MySQL sessions, open transactions and lock waits (as root) while a rollout runs. */
function sampleMysql(label) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        samples.push({
          at: new Date().toISOString(),
          sessions: mysql("SELECT USER, COMMAND, TIME, STATE, LEFT(INFO, 160) FROM information_schema.PROCESSLIST WHERE USER LIKE 'ghcp%' AND (COMMAND <> 'Sleep' OR TIME > 5) ORDER BY TIME DESC;"),
          trx: mysql('SELECT trx_state, TIMESTAMPDIFF(SECOND, trx_started, NOW()), trx_rows_locked, LEFT(trx_query, 160) FROM information_schema.INNODB_TRX;'),
          lockWaits: mysql('SELECT COUNT(*) FROM performance_schema.data_lock_waits;')[0],
          connections: mysql("SELECT USER, COUNT(*) FROM information_schema.PROCESSLIST WHERE USER LIKE 'ghcp%' GROUP BY USER;"),
        });
      } catch (error) {
        samples.push({ at: new Date().toISOString(), error: String(error.message).slice(0, 300) });
      }
      await sleep(1500);
    }
  })();
  return async () => {
    running = false;
    await loop;
    writeFileSync(join(cfg.runDir, `mysql-samples-${label}.json`), JSON.stringify(samples, null, 1));
    return samples.filter((sample) => Number(sample.lockWaits) > 0).length;
  };
}

/** Rolling restart of Proxy while a caller sends requests through the Service with the given connection policy. */
async function proxyRollout(ns, connection) {
  const names = pods(ns, 'proxy').map((pod) => pod.metadata.name);
  const stopLogs = followProxyLogs(ns, `rollout-${connection}`);
  const stopSampler = sampleMysql(`rollout-${connection}`);
  const load = driverAsync({ op: 'load', connection, durationMs: 110000, concurrency: 2, intervalMs: 250,
    request: inferRequest(svc(ns, 'proxy'), state.caller, '/v1/messages', 'POOL_TEST:{"id":"k8s-rollout"}', false) });
  await sleep(5000);
  const started = Date.now();
  kc(['-n', ns, 'rollout', 'restart', 'deployment/ghcp-proxy']);
  kc(['-n', ns, 'rollout', 'status', 'deployment/ghcp-proxy', '--timeout=400s'], { timeout: 420000 });
  const rolloutMs = Date.now() - started;
  const result = await load.done;
  const followed = await stopLogs();
  const lockWaitSamples = await stopSampler();
  const logs = followed.map((name) => {
    const file = join(cfg.runDir, 'logs', `rollout-${connection}`, `${name}.log`);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // `kubectl logs --timestamps` prefixes each line with its RFC 3339 time.
    const lines = text.split(/\r?\n/);
    const at = (needle) => lines.filter((line) => line.includes(needle)).map((line) => line.split(' ', 1)[0]);
    const forcedCloseAt = at('closing their connections');
    const sigtermAt = at('received, draining in-flight requests')[0] ?? null;
    const completeAt = at('shutdown complete')[0] ?? null;
    return { pod: name, old: names.includes(name), forcedClose: forcedCloseAt.length > 0, forcedCloseAt,
      shutdownComplete: completeAt !== null, sigtermAt, completeAt,
      drainMs: sigtermAt && completeAt ? Date.parse(completeAt) - Date.parse(sigtermAt) : null,
      errors: lines.filter((line) => /ERROR|WARN|failed/.test(line)).slice(0, 10) };
  });
  return { names, rolloutMs, ...result, logs, lockWaitSamples };
}

/** A failed request's time relative to each old pod's SIGTERM, for the report if a client-side race ever shows up. */
function failureTiming(run) {
  const old = run.logs.filter((row) => row.old && row.sigtermAt);
  return run.failures.map((failure) => ({ ...failure,
    msAfterSigterm: Object.fromEntries(old.map((row) => [row.pod, Date.parse(failure.at) - Date.parse(row.sigtermAt)])) }));
}

async function restartChecks(P, ns) {
  const watch = startPodWatch(ns);
  await sleep(2000);
  // A gateway-like client that reuses pooled connections (LiteLLM's HTTP client does).
  const pooled = await proxyRollout(ns, 'keep-alive');
  const summary = (run) => ({ sent: run.sent, counts: run.counts, failures: failureTiming(run), latencyMs: run.latencyMs,
    rolloutMs: run.rolloutMs, oldPods: run.logs.filter((row) => row.old), lockWaitSamples: run.lockWaitSamples,
    buckets: run.buckets });
  // Fixed in r3 (deploy/kubernetes/README.md section 10.1): while draining, the shared graceful shutdown closes each
  // keep-alive connection after its current response (`Connection: close`, or FIN after a streamed response) and
  // closes idle ones at once, so a pooled client moves to the new pods without errors. Zero failures are required for
  // both clients, every old pod must finish its drain well before SHUTDOWN_TIMEOUT_MS (25 s) and none may log the
  // force-close line. Failures are reported with their time relative to each old pod's SIGTERM; a request written
  // exactly as the server closes an idle connection would show up here and must be investigated, not tolerated.
  const drained = (run) => {
    const old = run.logs.filter((row) => row.old);
    return old.length === 2 && old.every((row) => row.shutdownComplete && !row.forcedClose
      && row.drainMs !== null && row.drainMs < DRAIN_BOUND_MS);
  };
  // Recorded without stopping the run, so the remaining checks still execute; any failure fails the report.
  check(P, 'proxy_rollout_keepalive_client_zero_failures', (pooled.counts['200'] ?? 0) > 50
    && pooled.counts['200'] === pooled.sent && pooled.failures.length === 0 && drained(pooled),
  summary(pooled), { soft: true });
  // The same rollout with a new connection per request.
  const fresh = await proxyRollout(ns, 'close');
  check(P, 'proxy_rollout_new_connections_zero_failures', (fresh.counts['200'] ?? 0) > 50
    && fresh.counts['200'] === fresh.sent && fresh.failures.length === 0 && drained(fresh),
  summary(fresh), { soft: true });

  const before = { proxy: [...pooled.names, ...fresh.names] };
  for (const service of ['sso', 'login', 'console']) {
    before[service] = pods(ns, service).map((pod) => pod.metadata.name);
    kc(['-n', ns, 'rollout', 'restart', `deployment/ghcp-${service}`]);
    kc(['-n', ns, 'rollout', 'status', `deployment/ghcp-${service}`, '--timeout=400s'], { timeout: 420000 });
  }
  await sleep(5000);
  const { terminated, deleted } = await watch.stop();
  const grace = 45;
  // The first deletionTimestamp of a pod is the deadline: delete request + terminationGracePeriodSeconds.
  const exits = Object.fromEntries(SERVICES.flatMap((service) => before[service].map((name) => {
    const ended = terminated.get(name)?.[service];
    const deadline = deleted.get(name);
    const secondsAfterDeleteRequest = ended && deadline
      ? grace - (Date.parse(deadline) - Date.parse(ended.finishedAt)) / 1000 : null;
    return [name, { exitCode: ended?.exitCode ?? null, reason: ended?.reason ?? null, secondsAfterDeleteRequest }];
  })));
  check(P, 'rollout_restart_clean_exit_all_services', Object.values(exits).length === 7
    && Object.values(exits).every((row) => row.exitCode === 0 && row.reason === 'Completed'
      && row.secondsAfterDeleteRequest !== null && row.secondsAfterDeleteRequest < grace), exits);
  waitRollouts(ns, 300);

  const session = consoleLogin(ns);
  const proxies = readyPods(ns, 'proxy');
  const after = driver(inferRequest(podUrl(proxies[0], 'proxy'), state.caller, '/v1/messages', 'POOL_TEST:{"id":"k8s-after-restart"}', false));
  const row = mockState().inference.find((entry) => entry.marker === 'k8s-after-restart');
  check(P, 'state_survives_restarts', session.status === 200 && after.status === 200 && row?.identity === state.member,
    { consoleLogin: session.status, sameMember: row?.identity === state.member });
  state.consoleCookie = session.cookie;
}

async function pvcChecks(P, ns) {
  const volumes = Object.fromEntries(['ghcp-sso-data', 'ghcp-login-data', 'ghcp-login-logs', 'ghcp-console-data']
    .map((claim) => [claim, kcJson(['-n', ns, 'get', 'pvc', claim]).spec.volumeName]));
  const oldPods = { sso: pods(ns, 'sso')[0].metadata.uid, login: pods(ns, 'login')[0].metadata.uid };
  kc(['-n', ns, 'delete', 'pod', '-l', 'app.kubernetes.io/name in (ghcp-sso,ghcp-login)', '--wait=true', '--timeout=120s'],
    { timeout: 150000 });
  waitRollouts(ns, 300);
  const newPods = { sso: pods(ns, 'sso')[0].metadata.uid, login: pods(ns, 'login')[0].metadata.uid };
  const volumesAfter = Object.fromEntries(Object.keys(volumes)
    .map((claim) => [claim, kcJson(['-n', ns, 'get', 'pvc', claim]).spec.volumeName]));
  const ssoUsers = driver({ url: `${svc(ns, 'sso')}/api/enterprises/default/users?page=1&pageSize=100`, headers: internal() }).json;
  const tasks = driver({ url: `${svc(ns, 'console')}/api/console/login-service/enterprises/default/tasks?page=1&pageSize=100`,
    headers: { cookie: state.consoleCookie } }).json;
  const login = driver({ url: `${svc(ns, 'sso')}/login`, method: 'POST',
    form: { username: state.ssoUser, password: state.secrets.ssoPassword } });
  check(P, 'pod_deletion_keeps_pvc_data', newPods.sso !== oldPods.sso && newPods.login !== oldPods.login
    && JSON.stringify(volumes) === JSON.stringify(volumesAfter) && ssoUsers?.total === state.counts.ssoUsers
    && (tasks?.total ?? tasks?.items?.length) === state.counts.tasks && login.status === 200,
  { ssoUsers: ssoUsers?.total, tasks: tasks?.total ?? tasks?.items?.length, ssoLogin: login.status,
    volumesUnchanged: JSON.stringify(volumes) === JSON.stringify(volumesAfter) });
}

// ------------------------------------------------------------------------------------------------------------
// Phase B: github.com overlay + every component, DBA-applied schema, MYSQL_AUTO_MIGRATE=false

async function phaseB() {
  const P = 'B';
  const ns = NS.dba;
  const script = readFileSync(join(ROOT, 'scripts/proxy-mysql-initial.sql'), 'utf8');
  // The client's default session, no --default-character-set (the script sets utf8mb4 itself).
  const clientCharset = mysql('SELECT @@session.character_set_client;')[0];
  mysql(script, { timeout: 300000 });
  const tables = mysql("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='ghcp_proxy' ORDER BY 1;");
  const recorded = mysql('SELECT id FROM schema_migrations ORDER BY id;', { database: 'ghcp_proxy' });
  const scripted = lib.initialSqlMigrationIds(script);
  const clauses = mysql("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='ghcp_proxy';").join('\n');
  const introducers = [...new Set([...clauses.matchAll(/_([a-z0-9]+)\\*'/g)].map((match) => match[1]))].sort();
  const defaultRows = mysql('SELECT COUNT(*) FROM proxy_enterprises;', { database: 'ghcp_proxy' })[0];
  check(P, 'dba_initial_sql_default_session', tables.includes('proxy_enterprises') && tables.includes('user_pool_leases')
    && JSON.stringify(recorded) === JSON.stringify(scripted) && JSON.stringify(introducers) === '["utf8mb4"]'
    && defaultRows === '0', { clientCharset, tables: tables.length, recorded: recorded.length, introducers });

  const dbPassword = random();
  mysql([
    `CREATE USER 'ghcp_dba_rt'@'%' IDENTIFIED BY '${dbPassword}' REQUIRE SSL;`,
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `ghcp_proxy`.* TO 'ghcp_dba_rt'@'%';",
    "GRANT TRIGGER ON `ghcp_proxy`.`proxy_accounts` TO 'ghcp_dba_rt'@'%';",
  ].join('\n'));
  const grants = mysql("SHOW GRANTS FOR 'ghcp_dba_rt'@'%';");
  check(P, 'runtime_account_dml_only', lib.ddlPrivileges(grants).length === 0, { grants });
  const schemaBefore = schemaFingerprint('ghcp_proxy');

  createAppSecrets(ns, `mysql://ghcp_dba_rt:${encodeURIComponent(dbPassword)}@${state.mysqlIp}:3306/ghcp_proxy`);
  kc(['apply', '-f', '-'], { input: renderOverlay('kind-dba') });
  try {
    waitRollouts(ns, 600);
  } catch (error) {
    dumpDiagnostics(ns, 'phaseB-start');
    throw error;
  }
  const proxies = readyPods(ns, 'proxy');
  const autoMigrate = kcJson(['-n', ns, 'get', 'configmap', 'ghcp-proxy-config']).data.MYSQL_AUTO_MIGRATE;
  check(P, 'proxy_ready_with_auto_migrate_false', proxies.length === 2 && autoMigrate === 'false', { proxies: proxies.length, autoMigrate });
  const lines = releaseLines(ns);
  check(P, 'healthz_release_line_multi', Object.values(lines).length === 5 && Object.values(lines).every((line) => line === 'multi'), lines);
  const migrations = mysql('SELECT id FROM schema_migrations ORDER BY id;', { database: 'ghcp_proxy' });
  const added = migrations.filter((id) => !recorded.includes(id));
  check(P, 'proxy_startup_no_ddl', schemaFingerprint('ghcp_proxy') === schemaBefore
    && JSON.stringify(added) === JSON.stringify([lib.PROXY_MIGRATION_IDS[1], lib.PROXY_MIGRATION_IDS[7]]), { addedByProxy: added });
  const enterprises = mysql('SELECT id, state FROM proxy_enterprises;', { database: 'ghcp_proxy' });
  const readiness = await poll('dba_default_ready', () => proxyApi(proxies[0], '/api/enterprises').json.items,
    (items) => items.length === 1 && (items[0].readiness?.ready === true || items[0].readiness?.blockers?.length === 0),
    120000, 5000);
  check(P, 'only_default_enterprise_ready', enterprises.length === 1 && enterprises[0] === 'default\tactive',
    { mysql: enterprises, readiness: readiness[0].readiness });
  const caller = callerId('kind-e2e-dba-caller');
  const exhausted = proxies.map((pod) => driver(inferRequest(podUrl(pod, 'proxy'), caller, '/v1/messages', 'x', false)));
  check(P, 'empty_pool_returns_429_on_both_replicas', exhausted.every((r) => r.status === 429
    && r.json?.error?.code === 'pool_exhausted' && r.headers['retry-after'] === '7'),
  { statuses: exhausted.map((r) => r.status), codes: exhausted.map((r) => r.json?.error?.code) });
  const metadata = driver({ url: `${svc(ns, 'sso')}/metadata` });
  check(P, 'sso_metadata_root_path', metadata.status === 200
    && lib.metadataIdentity(metadata.text).entityId === `${svc(ns, 'sso')}/metadata`, { status: metadata.status });
  const ingresses = kcJson(['-n', ns, 'get', 'ingress']).items.map((item) => item.metadata.name).sort();
  check(P, 'ingress_objects_accepted', JSON.stringify(ingresses) === '["ghcp-console","ghcp-sso"]', { ingresses });
}

// ------------------------------------------------------------------------------------------------------------
// Subcommands

function kindBin(args, options) {
  return exec(cfg.kind, args, options);
}

function setup() {
  guardContext();
  const clusters = kindBin(['get', 'clusters']).stdout.split(/\r?\n/).filter(Boolean);
  if (!clusters.includes(cfg.cluster)) {
    kindBin(['create', 'cluster', '--name', cfg.cluster, '--kubeconfig', cfg.kubeconfig, '--wait', '180s'], { timeout: 600000 });
  }
  guardCluster();
  exec('docker', ['image', 'inspect', NODE_FIXTURE_SOURCE]);
  exec('docker', ['tag', NODE_FIXTURE_SOURCE, NODE_FIXTURE]);
  const images = [NODE_FIXTURE, ...SERVICES.map((service) => `ghcp-release-${service}:${TAG}`)];
  kindBin(['load', 'docker-image', '--name', cfg.cluster, ...images], { timeout: 1200000 });
  console.log(`setup complete: cluster ${cfg.cluster}, images ${images.join(', ')}`);
}

function clean() {
  guardContext();
  guardCluster();
  for (const ns of Object.values(NS)) kc(['delete', 'namespace', ns, '--ignore-not-found', '--wait=true', '--timeout=300s'], { timeout: 330000 });
  const existing = exec('docker', ['ps', '-a', '--filter', `name=^${MYSQL_CONTAINER}$`, '--format', '{{.Labels}}']).stdout.trim();
  if (existing.includes('ghcp.k8s-check=kind-e2e')) exec('docker', ['rm', '-f', MYSQL_CONTAINER]);
}

function teardown() {
  guardContext();
  const clusters = kindBin(['get', 'clusters']).stdout.split(/\r?\n/).filter(Boolean);
  const existing = exec('docker', ['ps', '-a', '--filter', `name=^${MYSQL_CONTAINER}$`, '--format', '{{.Labels}}']).stdout.trim();
  if (existing.includes('ghcp.k8s-check=kind-e2e')) exec('docker', ['rm', '-f', MYSQL_CONTAINER]);
  if (clusters.includes(cfg.cluster)) kindBin(['delete', 'cluster', '--name', cfg.cluster, '--kubeconfig', cfg.kubeconfig], { timeout: 300000 });
  if (existsSync(cfg.kubeconfig)) rmSync(cfg.kubeconfig);
  exec('docker', ['image', 'rm', NODE_FIXTURE], { allowFail: true }); // removes only this tag
  console.log('teardown complete');
}

async function runAll() {
  guardContext();
  const nodes = guardCluster();
  for (const ns of Object.values(NS)) {
    const found = kc(['get', 'namespace', ns, '--ignore-not-found', '-o', 'name']).stdout.trim();
    if (found) throw new Error(`namespace ${ns} exists: run "clean" first`);
  }
  mkdirSync(cfg.runDir, { recursive: true });
  report.nodes = nodes;
  report.serverVersion = JSON.parse(kc(['version', '-o', 'json'], { allowFail: true }).stdout || '{}').serverVersion?.gitVersion;
  let failed;
  try {
    syntheticSecrets();
    generateCerts();
    await startMysql();
    deployFixtures();
    await phaseA();
    await phaseB();
  } catch (error) {
    failed = error;
    console.log(`FAILED: ${error.stack ?? error}`);
    report.failure = { message: String(error.message ?? error), last: error.last };
  } finally {
    report.finished = new Date().toISOString();
    report.pass = !failed && report.assertions.every((entry) => entry.pass);
    saveReport();
    console.log(`report: ${join(cfg.runDir, 'report.json')} pass=${report.pass} assertions=${report.assertions.length}`);
  }
  if (!report.pass) process.exitCode = 1;
}

const command = process.argv[2];
if (command === 'setup') setup();
else if (command === 'run') await runAll();
else if (command === 'clean') clean();
else if (command === 'teardown') teardown();
else {
  console.error('usage: node tests/kubernetes/kind-e2e.mjs setup|run|clean|teardown');
  process.exitCode = 2;
}
