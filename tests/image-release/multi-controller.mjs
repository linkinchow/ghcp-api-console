// Loopback controller for the multi-enterprise qualification (design §9.4), meant to be started with the desktop
// preview tools (see README). It runs qualification-prepare.mjs then qualification-run.mjs for one mode at a time
// and exposes progress; it never touches Docker itself.
//
//   POST /run    {"mode":<one of MULTI_MODES>,"isolatedSubnet"?,"ingressSubnet"?}  -> 202
//   POST /stop   aborts the active run (the runner stops its own containers; nothing is removed)
//   GET  /status the active/last runs, their recent step events and report summaries
//   GET  /plan?mode=...  the dry-run step plan (no Docker)
//   GET  /report?id=...  the full qualification-report.json of a finished run
//
// Inputs come from this process's environment (never from .env): RELEASE_QUALIFICATION_CANDIDATE_TAG,
// RELEASE_QUALIFICATION_CERTS_DIR, RELEASE_QUALIFICATION_MYSQL_IMAGE, RELEASE_QUALIFICATION_ISOLATED_SUBNET,
// RELEASE_QUALIFICATION_INGRESS_SUBNET (MySQL mode), RELEASE_QUALIFICATION_SQLITE_SUBNET (SQLite mode), and optional
// RELEASE_QUALIFICATION_BASELINE_TAG, RELEASE_QUALIFICATION_BUDGET_MINUTES, RELEASE_QUALIFICATION_PROJECT_PREFIX.
// Each run gets a fresh project name; subnets must be unused and may be given per run in the POST body.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFreshMode, isSqliteMode, MULTI_MODES, PROJECT_PATTERN, SUBNET_PATTERN } from './qualification-multi-lib.mjs';

const PORT = 18821;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MAX_EVENTS = 400;
const runs = [];
const usedSubnets = new Set();
let active;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error('body_too_large');
  }
  return text ? JSON.parse(text) : {};
}

/** Child environment: the controller's own variables plus this run's; Compose/Docker overrides never pass through. */
function childEnvironment(run) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(COMPOSE_|DOCKER_HOST$|DOCKER_CONTEXT$|MYSQL_URL$|MYSQL_TEST_URL$)/.test(name)) delete env[name];
  }
  return {
    ...env,
    RELEASE_QUALIFICATION_MODE: run.mode,
    RELEASE_QUALIFICATION_PROJECT: run.project,
    RELEASE_QUALIFICATION_CONFIRM: run.project,
    RELEASE_QUALIFICATION_ISOLATED_SUBNET: run.isolatedSubnet,
    ...(run.ingressSubnet ? { RELEASE_QUALIFICATION_INGRESS_SUBNET: run.ingressSubnet } : {}),
  };
}

function record(run, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  run.events.push({ at: new Date().toISOString(), ...event });
  if (run.events.length > MAX_EVENTS) run.events.shift();
  if (event.step && event.phase === 'start') run.currentStep = event.step;
}

function launch(run, script, args) {
  return new Promise((accept) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], {
      cwd: ROOT, env: childEnvironment(run), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;
    let stdout = '';
    let buffer = '';
    const log = (chunk) => appendFile(run.logPath, chunk).catch(() => {});
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      log(chunk);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) record(run, line);
    });
    child.stderr.on('data', log);
    child.once('error', () => accept({ code: null, stdout }));
    child.once('exit', (code) => {
      run.child = undefined;
      if (buffer) record(run, buffer);
      accept({ code, stdout });
    });
  });
}

async function execute(run) {
  try {
    run.phase = 'preparing';
    const prepared = await launch(run, 'qualification-prepare.mjs', []);
    run.statePath = /RELEASE_QUALIFICATION_STATE (.+)/.exec(prepared.stdout)?.[1]?.trim();
    if (prepared.code !== 0 || !run.statePath) throw new Error('prepare_failed');
    run.reportPath = join(dirname(run.statePath), 'qualification-report.json');
    run.phase = 'running';
    const result = await launch(run, 'qualification-run.mjs', [run.statePath]);
    run.exitCode = result.code;
    const report = JSON.parse(await readFile(run.reportPath, 'utf8'));
    run.summary = {
      pass: report.pass, failure: report.failure ?? null, failedStep: report.failedStep ?? null,
      planCoverage: report.planCoverage, cleanup: report.cleanup ?? null, elapsedMs: report.elapsedMs,
      steps: report.stepResults.map((step) => ({ id: step.id, pass: step.pass, assertions: step.assertions.length })),
    };
  } catch (error) {
    run.error = /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'controller_run_failed';
  } finally {
    run.phase = 'done';
    run.finishedAt = new Date().toISOString();
    active = undefined;
  }
}

function startRun(body) {
  const mode = body.mode;
  if (!MULTI_MODES.includes(mode)) return [400, { error: 'invalid_mode', modes: MULTI_MODES }];
  if (active) return [409, { error: 'run_active', id: active.id }];
  const sqlite = isSqliteMode(mode);
  const isolatedSubnet = body.isolatedSubnet ?? (sqlite
    ? process.env.RELEASE_QUALIFICATION_SQLITE_SUBNET
    : process.env.RELEASE_QUALIFICATION_ISOLATED_SUBNET);
  const ingressSubnet = sqlite ? undefined : body.ingressSubnet ?? process.env.RELEASE_QUALIFICATION_INGRESS_SUBNET;
  const subnets = [isolatedSubnet, ...(sqlite ? [] : [ingressSubnet])];
  if (!subnets.every((subnet) => SUBNET_PATTERN.test(subnet ?? '')) || new Set(subnets).size !== subnets.length) {
    return [400, { error: 'fresh_subnets_required' }];
  }
  if (subnets.some((subnet) => usedSubnets.has(subnet))) {
    return [409, { error: 'subnet_already_used_by_this_controller' }];
  }
  const prefix = process.env.RELEASE_QUALIFICATION_PROJECT_PREFIX || 'ghcp-release-qualification-multi';
  const kind = `${isFreshMode(mode) ? 'f' : ''}${mode === 'multi-fresh-dba' ? 'd' : sqlite ? 's' : 'm'}`;
  const project = `${prefix}-${kind}-${Date.now().toString(36)}`;
  if (!PROJECT_PATTERN.test(project)) return [400, { error: 'invalid_project_prefix' }];
  subnets.forEach((subnet) => usedSubnets.add(subnet));
  const id = randomUUID();
  const run = {
    id, mode, project, isolatedSubnet, ingressSubnet, phase: 'queued', events: [], startedAt: new Date().toISOString(),
    logPath: join(ROOT, '.claude', `multi-controller-${id}.log`),
  };
  runs.push(run);
  active = run;
  void execute(run);
  return [202, { id, project, mode, isolatedSubnet, ingressSubnet: ingressSubnet ?? null, log: run.logPath }];
}

function publicRun(run, events = 40) {
  const { child: _child, events: all, ...rest } = run;
  return { ...rest, events: all.slice(-events) };
}

const server = http.createServer(async (req, res) => {
  try {
    // Loopback only, and no browser cross-origin use (DNS rebinding or a page posting to the port).
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '') || req.headers.origin) return json(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/status') {
      const events = Math.min(Number(url.searchParams.get('events') ?? 40) || 40, MAX_EVENTS);
      return json(res, 200, { active: active?.id ?? null, runs: runs.map((run) => publicRun(run, events)) });
    }
    if (req.method === 'GET' && url.pathname === '/plan') {
      const mode = url.searchParams.get('mode');
      if (!MULTI_MODES.includes(mode)) return json(res, 400, { error: 'invalid_mode', modes: MULTI_MODES });
      const { planText } = await import('./qualification-multi-run.mjs');
      return json(res, 200, JSON.parse(planText(mode)));
    }
    if (req.method === 'GET' && url.pathname === '/report') {
      const run = runs.find((row) => row.id === url.searchParams.get('id'));
      if (!run?.reportPath) return json(res, 404, { error: 'report_not_found' });
      return json(res, 200, JSON.parse(await readFile(run.reportPath, 'utf8')));
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
        return json(res, 415, { error: 'json_required' });
      }
      const [status, body] = startRun(await readBody(req));
      return json(res, status, body);
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      if (!active?.statePath) return json(res, 409, { error: 'no_active_run' });
      // The runner polls this file, aborts and still stops its own containers (signals are not portable to Windows).
      await writeFile(join(dirname(active.statePath), 'stop.request'), `${new Date().toISOString()}\n`);
      return json(res, 202, { stopping: active.id });
    }
    return json(res, 404, { error: 'not_found' });
  } catch {
    return json(res, 400, { error: 'invalid_request' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`MULTI_QUALIFICATION_CONTROLLER http://127.0.0.1:${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    active?.child?.kill('SIGTERM');
    server.close();
  });
}
