#!/usr/bin/env node
// Read-only, one-shot adapter for an existing monitoring platform. Node >= 20; no dependencies.
import http from 'node:http';
import https from 'node:https';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PATH = '/api/user-pool/diagnostics/local';
const LIMIT = 32 * 1024;
const COUNTERS = ['claimAttempts', 'ownershipAcquisitions', 'ownershipLosses'];
const LOSSES = ['local_tenure_expired', 'renewal_rejected', 'storage_unavailable', 'storage_operation_failed'];
const own = (o, k) => Object.hasOwn(o, k);
const record = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const timestamp = n => integer(n) && n > 0;
const age = (t, now, max) => timestamp(t) && t <= now && now - t <= max;
const nullableNumber = n => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
const only = (o, keys) => record(o) && Object.keys(o).every(k => keys.includes(k));
const check = condition => { if (!condition) throw new Error('invalid_input'); };

export function validateConfig(input) {
  check(only(input, ['schemaVersion', 'timeoutMs', 'maxAgeMs', 'concurrency', 'endpoints']));
  check(input.schemaVersion === 1 && Array.isArray(input.endpoints) && input.endpoints.length > 0 && input.endpoints.length <= 32);
  const config = { timeoutMs: 3000, maxAgeMs: 15000, concurrency: 4, ...input };
  check(integer(config.timeoutMs) && config.timeoutMs >= 100 && config.timeoutMs <= 10000);
  check(integer(config.maxAgeMs) && config.maxAgeMs >= config.timeoutMs && config.maxAgeMs <= 60000);
  check(integer(config.concurrency) && config.concurrency >= 1 && config.concurrency <= 4);
  const names = new Set(), urls = new Set();
  config.endpoints = config.endpoints.map(e => {
    check(only(e, ['instance', 'url', 'tokenEnv', 'allowLoopbackHttp', 'processStartUnixMs']));
    check(typeof e.instance === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(e.instance) && !names.has(e.instance));
    check(typeof e.tokenEnv === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(e.tokenEnv));
    check(typeof e.url === 'string' && !/[\s\x00-\x1f\x7f]/.test(e.url));
    const url = new URL(e.url);
    check(!url.username && !url.password && !url.search && !url.hash && url.pathname === PATH);
    check(!own(e, 'allowLoopbackHttp') || typeof e.allowLoopbackHttp === 'boolean');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    check(url.protocol === 'https:' || (url.protocol === 'http:' && loopback && e.allowLoopbackHttp === true));
    check(!own(e, 'processStartUnixMs') || timestamp(e.processStartUnixMs));
    check(!urls.has(url.href));
    names.add(e.instance); urls.add(url.href);
    return { ...e, url: url.href };
  });
  return config;
}

/** Never follows redirects, retries, uses proxy environment variables, or returns error bodies. */
export function getDiagnostics(url, token, timeoutMs, transports = { 'http:': http, 'https:': https }) {
  return new Promise(resolve => {
    let request, response, done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer);
      response?.destroy(); request?.destroy();
      resolve(result);
    };
    // Wall-time budget includes DNS, TLS, response headers and the entire response body.
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    try {
      const parsed = new URL(url);
      request = transports[parsed.protocol].request(parsed, {
        method: 'GET', agent: false, rejectUnauthorized: true,
        headers: { 'X-Internal-Token': token, Accept: 'application/json',
          'Accept-Encoding': 'identity', 'Cache-Control': 'no-store', Connection: 'close' },
      }, incoming => {
        response = incoming;
        if (done) { response.destroy(); return; }
        const status = response.statusCode;
        if (status !== 200) {
          finish({ status: status === 401 || status === 403 ? 'auth_failed'
            : status === 409 ? 'pool_disabled' : status >= 300 && status < 400 ? 'redirect_rejected' : 'http_error',
          httpStatus: integer(status) ? status : null });
          return;
        }
        if (!String(response.headers['cache-control'] ?? '').split(',').some(x => x.trim().toLowerCase() === 'no-store')) {
          finish({ status: 'no_store_missing' }); return;
        }
        if (!/^application\/json(?:;|$)/i.test(String(response.headers['content-type'] ?? ''))
          || !['', 'identity'].includes(String(response.headers['content-encoding'] ?? '').toLowerCase())) {
          finish({ status: 'invalid_response' }); return;
        }
        const chunks = []; let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > LIMIT) { finish({ status: 'response_too_large' }); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try { finish({ status: 'ok', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { finish({ status: 'invalid_response' }); }
        });
        response.on('error', () => finish({ status: 'unreachable' }));
        response.on('aborted', () => finish({ status: 'unreachable' }));
      });
      request.on('error', () => finish({ status: 'unreachable' }));
      request.end();
    } catch { finish({ status: 'unreachable' }); }
  });
}

export function classifyLocal(body, now, maxAgeMs) {
  if (!record(body) || body.enabled !== true || body.scope !== 'local_process' || !timestamp(body.observedAt)
    || !own(body, 'localScheduler')) return { status: 'invalid_response' };
  if (!age(body.observedAt, now, maxAgeMs)) return { status: 'stale_or_clock_skew' };
  if (body.localScheduler === null) return { status: 'ok', state: 'not_started', observedAtUnixMs: body.observedAt };
  const s = body.localScheduler;
  if (!record(s) || s.scope !== 'local_process' || !['owner', 'standby', 'stopped'].includes(s.state)
    || !timestamp(s.observedAtUnixMs) || !COUNTERS.every(k => integer(s[k]))
    || !nullableNumber(s.localTenureAgeMs) || !nullableNumber(s.lastSuccessfulRenewalAgeMs)
    || !(s.lastSuccessfulRenewalAtUnixMs === null || timestamp(s.lastSuccessfulRenewalAtUnixMs))
    || !own(s, 'lastOwnershipLoss')) return { status: 'invalid_response' };
  if (!age(s.observedAtUnixMs, now, maxAgeMs)) return { status: 'stale_or_clock_skew' };
  let lastOwnershipLoss = null;
  if (s.lastOwnershipLoss !== null) {
    const loss = s.lastOwnershipLoss;
    if (!record(loss) || !LOSSES.includes(loss.reason) || !timestamp(loss.atUnixMs)
      || (own(loss, 'storageFailure') && !['deadline', 'connection'].includes(loss.storageFailure))) {
      return { status: 'invalid_response' };
    }
    lastOwnershipLoss = { reason: loss.reason, atUnixMs: loss.atUnixMs,
      ...(own(loss, 'storageFailure') ? { storageFailure: loss.storageFailure } : {}) };
  }
  return { status: 'ok', state: s.state, observedAtUnixMs: s.observedAtUnixMs,
    localTenureAgeMs: s.localTenureAgeMs, lastSuccessfulRenewalAgeMs: s.lastSuccessfulRenewalAgeMs,
    lastSuccessfulRenewalAtUnixMs: s.lastSuccessfulRenewalAtUnixMs,
    counters: Object.fromEntries(COUNTERS.map(k => [k, s[k]])), lastOwnershipLoss };
}

/** The file is an adapter contract with the customer's EXISTING writer DB collector, not DB evidence by itself. */
export function classifyDatabase(input, now, maxAgeMs) {
  const unknown = reason => ({ status: 'unknown', reason, ownerAtObservation: 'unknown', leaseExpiredForMs: null });
  if (!record(input)) return unknown('not_observed');
  if (input.schemaVersion !== 1 || input.source !== 'writer' || !timestamp(input.observedAtUnixMs)) return unknown('invalid_observation');
  if (!age(input.observedAtUnixMs, now, maxAgeMs)) return unknown('stale_or_clock_skew');
  if (input.status === 'sql_unreachable') return { ...unknown('sql_unreachable'), status: 'sql_unreachable' };
  if (input.status !== 'ok') return unknown('query_failed');
  if (!integer(input.queryDurationMs) || input.queryDurationMs > maxAgeMs) return unknown('invalid_observation');
  const r = input.row;
  if (!record(r) || r.rowCount !== 1 || !timestamp(r.dbNowUnixMs) || !integer(r.ownerUntilUnixMs)
    || ![0, 1].includes(r.ownerPresent) || ![0, 1].includes(r.paused)) return unknown('invalid_row');
  // An owner-less row with a future deadline violates the expected fence shape; do not guess.
  if (!r.ownerPresent && r.ownerUntilUnixMs > r.dbNowUnixMs) return unknown('inconsistent_row');
  const present = r.ownerPresent === 1 && r.ownerUntilUnixMs > r.dbNowUnixMs;
  return { status: 'ok', ownerAtObservation: present ? 'present' : 'absent',
    observedAtUnixMs: input.observedAtUnixMs, dbNowUnixMs: r.dbNowUnixMs, paused: r.paused === 1,
    // Never subtract the sampler host's clock from a lease. Zero has no useful expiry history.
    leaseExpiredForMs: !present && r.ownerUntilUnixMs > 0 ? r.dbNowUnixMs - r.ownerUntilUnixMs : null };
}

export function counterChange(current, previous, now, maxAgeMs) {
  const unknown = { counterContinuity: 'unknown', counterDeltas: null };
  if (current.status !== 'ok' || !record(current.counters) || !record(previous) || previous.status !== 'ok'
    || !record(previous.counters) || !COUNTERS.every(k => integer(previous.counters[k]))
    || !age(previous.observedAtUnixMs, now, maxAgeMs)
    || previous.observedAtUnixMs >= current.observedAtUnixMs) return unknown;
  if (COUNTERS.some(k => current.counters[k] < previous.counters[k])
    || (timestamp(current.processStartUnixMs) && timestamp(previous.processStartUnixMs)
      && current.processStartUnixMs !== previous.processStartUnixMs)) {
    return { counterContinuity: 'reset', counterDeltas: null };
  }
  // Diagnostics has no process ID/epoch. Equal or increasing values alone cannot establish continuity.
  if (!timestamp(current.processStartUnixMs) || current.processStartUnixMs !== previous.processStartUnixMs) return unknown;
  return { counterContinuity: 'continuous', counterDeltas: Object.fromEntries(COUNTERS.map(k => [k, current.counters[k] - previous.counters[k]])) };
}

/** Exact pairs only; use on safe existing access-log fields, never raw bodies or exception text. */
export function classifyApiSignal(status, code) {
  const known = { '503:pool_storage_unavailable': 'storage_unavailable', '503:pool_owner_unavailable': 'sqlite_owner_guard',
    '503:member_unavailable': 'member_unavailable', '429:pool_exhausted': 'stock_exhausted', '429:member_cooling': 'cooling' };
  return own(known, `${status}:${code}`) ? known[`${status}:${code}`] : 'other';
}

export async function sample(input, { env = process.env, databaseObservation = null, previous = null,
  transport = getDiagnostics, now = Date.now } = {}) {
  const config = validateConfig(input);
  // Node HTTP debug logging can expose request headers before this adapter can sanitize anything.
  check(!env.NODE_DEBUG && !env.NODE_DEBUG_NATIVE);
  const results = new Array(config.endpoints.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(config.concurrency, config.endpoints.length) }, async () => {
    while (next < config.endpoints.length) {
      const i = next++, e = config.endpoints[i], token = env[e.tokenEnv];
      let local;
      if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) local = { status: 'credential_unavailable' };
      else {
        let result;
        try { result = await transport(e.url, token, config.timeoutMs); }
        catch { result = { status: 'unreachable' }; }
        local = result.status === 'ok' ? classifyLocal(result.body, now(), config.maxAgeMs) : { status:
          ['timeout', 'auth_failed', 'pool_disabled', 'redirect_rejected', 'http_error', 'no_store_missing', 'invalid_response',
            'response_too_large', 'unreachable'].includes(result.status) ? result.status : 'invalid_response' };
        if (integer(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599) local.httpStatus = result.httpStatus;
      }
      results[i] = { instance: e.instance, ...local,
        ...(own(e, 'processStartUnixMs') ? { processStartUnixMs: e.processStartUnixMs } : {}) };
    }
  }));
  const observedAtUnixMs = now();
  for (const current of results) {
    // A slow batch must not relabel an early observation as fresh at report publication.
    if (current.status === 'ok' && !age(current.observedAtUnixMs, observedAtUnixMs, config.maxAgeMs)) {
      const { instance, processStartUnixMs } = current;
      for (const k of Object.keys(current)) delete current[k];
      Object.assign(current, { instance, status: 'stale_or_clock_skew', ...(processStartUnixMs ? { processStartUnixMs } : {}) });
    }
    const prior = previous?.schemaVersion === 1 && Array.isArray(previous.instances)
      ? previous.instances.find(p => p?.instance === current.instance) : undefined;
    Object.assign(current, counterChange(current, prior, observedAtUnixMs, config.maxAgeMs));
  }
  const database = classifyDatabase(databaseObservation, observedAtUnixMs, config.maxAgeMs);
  return { schemaVersion: 1, observedAtUnixMs, scope: 'monitor_observation',
    collectionComplete: results.every(x => x.status === 'ok') && database.status === 'ok',
    database, instances: results };
}

async function readJson(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= 1024 * 1024);
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

export async function main(args) {
  try {
    check(args.length === 1 || args.length === 3 || args.length === 5);
    const options = {};
    for (let i = 1; i < args.length; i += 2) {
      check(['--db-observation', '--previous'].includes(args[i]) && !own(options, args[i]));
      options[args[i]] = args[i + 1];
    }
    const config = await readJson(args[0]);
    let databaseObservation = null, previous = null;
    if (options['--db-observation']) {
      try { databaseObservation = await readJson(options['--db-observation']); }
      catch { databaseObservation = { status: 'invalid' }; }
    }
    if (options['--previous']) {
      try { previous = await readJson(options['--previous']); } catch { /* Restart baseline unavailable. */ }
    }
    const report = await sample(config, { databaseObservation, previous });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.collectionComplete ? 0 : 2;
  } catch {
    process.stdout.write('{"schemaVersion":1,"status":"invalid_input_or_configuration"}\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
