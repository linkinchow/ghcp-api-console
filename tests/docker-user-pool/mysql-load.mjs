// Destructive synthetic INSERTs into ONE fixed fixture DB, never a deployment.
// Opt in: POOL_MYSQL_LOAD_CONFIRM=ghcp-user-pool-mysql-test node mysql-load.mjs
// [--concurrency=25] [--iterations=2]  2000 callers, 2..4 passes (4000..8000 POSTs).
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PROJECT, MODEL, API_KEY, auth, hash, check, safeFailure, sleep, request, status, pool, mock, settings,
  inferOptions, successful, health, connectDatabase, databaseState, invariants, poll } from './mysql-smoke.mjs';

const MEMBERS = 2000;
let writer, observer, sampling = false, sampler;
const paths = ['/v1/messages', '/chat/completions', '/responses'];
const reports = [];
const httpCounts = {};
let errorCount = 0, actualRequests = 0, maxHolds = 0, samples = 0, observerFailure = false;
const latencies = new Map();
const callers = Array.from({ length: MEMBERS }, (_, n) => `sha256:${hash(`mysql-load-caller-${n}`)}`);
const token = n => `mysql-fixture-load-token-${String(n).padStart(4, '0')}`;
const identity = n => `mysql-load-${String(n).padStart(4, '0')}@pool.mysql.example.test`;
function parseOptions() {
  const options = { concurrency: 25, iterations: 2 };
  const seen = new Set();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(concurrency|iterations)=([0-9]+)$/.exec(argument);
    check(match && !seen.has(match[1]), 'invalid_load_argument');
    seen.add(match[1]); options[match[1]] = Number(match[2]);
  }
  check(Number.isSafeInteger(options.concurrency) && options.concurrency >= 1 && options.concurrency <= 100, 'concurrency_bound');
  check(Number.isSafeInteger(options.iterations) && options.iterations >= 2 && options.iterations <= 4, 'iteration_bound');
  check(MEMBERS * options.iterations + 100 < 10000, 'total_request_bound');
  return options;
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted.length ? Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 100) / 100 : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
}
function observeLatency(key, duration) {
  const values = latencies.get(key) ?? []; values.push(duration); latencies.set(key, values);
}
async function measured(service, path, options, validate, category) {
  const start = performance.now(); actualRequests++;
  try {
    const result = await request(service, path, options);
    httpCounts[result.status] = (httpCounts[result.status] ?? 0) + 1;
    validate(result); return result;
  } catch {
    errorCount++;
    return undefined;
  } finally { observeLatency(category, performance.now() - start); }
}
async function assertEmpty() {
  const [first, second, fixture, sso, login] = await Promise.all([
    pool('proxy', true), pool('proxy2', true), mock(),
    request('mock', '/__mysql/sso/api/users?page=1&pageSize=1', { headers: auth }),
    request('mock', '/__mysql/login/api/tasks?page=1&pageSize=1', { headers: auth }),
  ]);
  check(first.counts.total === 0 && second.counts.total === 0 && first.settings.idle_target === 0, 'load_requires_empty_pool');
  check(fixture.users.length === 0 && fixture.tasks.length === 0 && fixture.inference.length === 0, 'load_requires_fresh_mock');
  check(status(sso, 200, 'sso').data.total === 0 && status(login, 200, 'login').data.total === 0, 'load_requires_empty_sources');
  const [[row]] = await observer.query(`SELECT (SELECT COUNT(*) FROM proxy_accounts) accounts,
    (SELECT COUNT(*) FROM proxy_request_stats) stats, (SELECT COUNT(*) FROM user_pool_accounts) members,
    (SELECT COUNT(*) FROM user_pool_leases) leases, (SELECT COUNT(*) FROM user_pool_holds) holds`);
  check(Object.values(row).every(value => Number(value) === 0), 'load_database_not_empty');
}
async function seed() {
  await settings({ paused: 1, idle_target: 0, max_accounts: MEMBERS, lease_seconds: 3600 });
  check((await pool('proxy2', true)).settings.paused === 1, 'standby_not_paused');
  // Registration affects only the isolated adapter, not SCIM/Login or GitHub.
  status(await request('mock', '/__mysql/load-register', { method: 'POST', headers: auth,
    body: { confirm: PROJECT, members: MEMBERS } }), 201, 'fixture_load_registration');
  await writer.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await writer.beginTransaction();
  try {
    const [[locked]] = await writer.query('SELECT paused, idle_target, next_ordinal FROM user_pool_settings WHERE id=1 FOR UPDATE');
    check(Number(locked.paused) === 1 && Number(locked.idle_target) === 0 && Number(locked.next_ordinal) === 0, 'seed_not_fresh_and_paused');
    const [[{ total }]] = await writer.query('SELECT COUNT(*) total FROM proxy_accounts');
    check(Number(total) === 0, 'seed_accounts_not_empty');
    const [[{ now_ms }]] = await writer.query("SELECT (TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000) now_ms");
    for (let start = 0; start < MEMBERS; start += 100) {
      const accounts = [], inventory = [];
      for (let n = start; n < start + 100; n++) {
        accounts.push([identity(n), identity(n), `mysql_load_${n}_test`, token(n), 'valid']);
        inventory.push([identity(n), n, 'ready', 'ready', randomUUID(), Number(now_ms), Number(now_ms)]);
      }
      const placeholders = accounts.map(() => '(?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))').join(',');
      await writer.query(`INSERT INTO proxy_accounts (identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at) VALUES ${placeholders}`, accounts.flat());
      await writer.query(`INSERT INTO user_pool_accounts (identity,ordinal,state,stage,attempt_id,updated_at,verified_at) VALUES ${inventory.map(() => '(?,?,?,?,?,?,?)').join(',')}`, inventory.flat());
    }
    await writer.query('UPDATE user_pool_settings SET next_ordinal=? WHERE id=1', [MEMBERS]);
    await writer.commit();
  } catch (error) { await writer.rollback(); throw error; }
  const current = await databaseState(observer); invariants(current);
  check(Number(current.members) === MEMBERS && Number(current.leases) === 0 && Number(current.holds) === 0, 'seed_counts');
  console.log('PASS seeded_2000_synthetic_ready_members_workers_paused_no_throughput_claim');
}
async function mappings() {
  const [rows] = await observer.query('SELECT caller_id, member_identity, lease_id, phase, last_success_at, expires_at FROM user_pool_leases ORDER BY caller_id');
  return new Map(rows.map(row => [row.caller_id, row]));
}
async function pageChecks() {
  const start = performance.now();
  const [lastLeases] = await observer.query('SELECT lease_id FROM user_pool_leases ORDER BY assigned_at DESC, lease_id LIMIT 100 OFFSET 1900');
  for (const service of ['proxy', 'proxy2']) {
    for (const kind of ['accounts', 'leases']) {
      await measured(service, `/api/user-pool/page/${kind}?page=20&pageSize=100`, { headers: auth }, result => {
        check(status(result, 200, 'last_page').data.total === MEMBERS && result.data.items.length === 100, 'paging_truncated_2000');
        check(result.data.items.every((item, index) => kind === 'accounts'
          ? item.ordinal === 1900 + index && item.identity === identity(1900 + index)
          : item.leaseId === lastLeases[index].lease_id), 'paging_last_page_identity_and_order');
      }, `admin-${kind}`);
    }
  }
  reports.push({ phase: 'management_pages', wallMs: Math.round(performance.now() - start) });
}
async function runLoad(options) {
  const prefix = randomUUID().slice(0, 8);
  let firstMappings;
  sampling = true;
  sampler = (async () => {
    while (sampling) {
      try {
        const current = await databaseState(observer); invariants(current);
        maxHolds = Math.max(maxHolds, Number(current.holds) + Number(current.catalog_holds)); samples++;
      } catch { observerFailure = true; }
      await sleep(500);
    }
  })();
  try {
    for (let pass = 0; pass < options.iterations; pass++) {
      let next = 0;
      const begin = performance.now(), priorErrors = errorCount;
      let inferenceSuccesses = 0;
      await Promise.all(Array.from({ length: options.concurrency }, async () => {
        for (;;) {
          const n = next++; if (n >= MEMBERS) return;
          const path = paths[(n + pass) % paths.length], stream = (n + pass) % 4 === 0;
          const service = (n + pass) % 2 ? 'proxy2' : 'proxy';
          const result = await measured(service, path, inferOptions(callers[n], path, `MYSQL_LOAD:${prefix}-${pass}-${n}`, stream),
            response => successful(response, path, stream), `${path}-${stream ? 'sse' : 'json'}`);
          if (result) inferenceSuccesses++;
          // Management queries share the same bounded worker, not another fan-out.
          if (n % 250 === 0) await measured(service, '/api/user-pool/page/events?page=1&pageSize=25', { headers: auth }, result => {
            check(status(result, 200, 'events_page').data.items.length <= 25, 'events_page_bound');
          }, 'admin-events-during-load');
        }
      }));
      const wallMs = performance.now() - begin;
      reports.push({ phase: `http_pass_${pass + 1}`, requests: MEMBERS, concurrency: options.concurrency,
        wallMs: Math.round(wallMs), successfulRequestsPerSecond: Math.round(inferenceSuccesses / (wallMs / 1000) * 100) / 100,
        errors: errorCount - priorErrors });
      // A separate observer connection is shared only after the sampler stops.
      sampling = false; await sampler;
      await poll('load_hold_drain', () => databaseState(observer), row => Number(row.holds) === 0 && Number(row.catalog_holds) === 0, 30000);
      const map = await mappings();
      check(map.size === MEMBERS && [...map.values()].every(row => row.phase === 'active'), 'all_callers_active');
      if (!firstMappings) firstMappings = map;
      else for (const caller of callers) check(map.get(caller)?.member_identity === firstMappings.get(caller)?.member_identity
        && map.get(caller)?.lease_id === firstMappings.get(caller)?.lease_id, 'alternating_replica_lease_rotation');
      if (pass === 0) await pageChecks();
      if (pass + 1 < options.iterations) {
        sampling = true;
        sampler = (async () => {
          while (sampling) {
            try { const row = await databaseState(observer); invariants(row); maxHolds = Math.max(maxHolds, Number(row.holds)); samples++; }
            catch { observerFailure = true; }
            await sleep(500);
          }
        })();
      }
    }
  } finally { sampling = false; await sampler; }
  check(!observerFailure, 'sql_observer_invariants_failed');
  check(errorCount === 0, 'http_load_errors');
  const fixture = status(await request('mock', '/__mysql/load-state', { headers: auth }), 200, 'load_state').data;
  check(fixture.fixture && fixture.requests === MEMBERS * options.iterations && fixture.active === 0, 'upstream_count_or_active');
  const markers = new Set();
  for (const row of fixture.records) {
    check(!markers.has(row.marker) && row.complete, 'upstream_replay_or_incomplete'); markers.add(row.marker);
    const match = new RegExp(`^${prefix}-([0-3])-([0-9]+)$`).exec(row.marker);
    check(match && Number(match[2]) < MEMBERS, 'unexpected_upstream_marker');
    check(firstMappings.get(callers[Number(match[2])])?.member_identity === identity(row.memberIndex), 'upstream_member_mismatch');
  }
  // Read-only catalog on both replicas must not change existing inference leases.
  const beforeCatalog = await mappings();
  for (const service of ['proxy', 'proxy2']) await measured(service, '/v1/models', { headers: { Authorization: `Bearer ${API_KEY}`, 'X-User-Identity': callers[0] } }, result => {
    check(status(result, 200, 'catalog').data.data.some(model => model.id === MODEL), 'catalog_model');
  }, 'catalog');
  await poll('catalog_drain', () => databaseState(observer), row => Number(row.catalog_holds) === 0, 10000);
  check(hash([...beforeCatalog]) === hash([...await mappings()]), 'catalog_mutated_lease');
  const original = await mock();
  check(original.counters.scimCreates === 0 && original.counters.taskPosts === 0 && original.counters.callbacksSucceeded === 0, 'seed_load_dispatched_provisioning');
  const [[stats]] = await observer.query(`SELECT COUNT(*) requests, COUNT(DISTINCT caller_id) callers,
    SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) failures,
    SUM(CASE WHEN caller_id IS NULL OR lease_id IS NULL THEN 1 ELSE 0 END) missing_ownership
    FROM proxy_request_stats WHERE path <> '/v1/models'`);
  check(Number(stats.requests) === MEMBERS * options.iterations && Number(stats.callers) === MEMBERS
    && Number(stats.failures) === 0 && Number(stats.missing_ownership) === 0, 'request_stats_ownership');
  const [[mismatched]] = await observer.query(`SELECT COUNT(*) total FROM proxy_request_stats s
    LEFT JOIN user_pool_leases l ON l.caller_id=s.caller_id
    WHERE s.path <> '/v1/models' AND (l.lease_id IS NULL OR l.lease_id<>s.lease_id OR l.member_identity<>s.identity)`);
  check(Number(mismatched.total) === 0, 'stats_lease_identity_mismatch');
  const final = await databaseState(observer); invariants(final);
  check(Number(final.members) === MEMBERS && Number(final.leases) === MEMBERS && Number(final.holds) === 0 && Number(final.catalog_holds) === 0, 'final_counts');
  check(errorCount === 0 && actualRequests <= 10000, 'final_request_budget');
  console.log('PASS 2000_callers_both_replicas_json_sse_responses_paging_stats_unique_leases_no_rotation');
}
try {
  const options = parseOptions();
  check(process.env.POOL_MYSQL_LOAD_CONFIRM === PROJECT, 'explicit_load_confirmation_required');
  await health();
  observer = await connectDatabase(); writer = await connectDatabase('load');
  await assertEmpty(); await seed(); await runLoad(options);
} catch (error) {
  console.error(`FAIL mysql_load ${safeFailure(error)}`);
  process.exitCode = 1;
} finally {
  sampling = false; await sampler;
  await writer?.end(); await observer?.end();
  // Only safe numbers and fixed labels. Never print SQL/driver errors, identities,
  // request bodies, caller hashes, member tokens, credentials or fixture records.
  console.log(JSON.stringify({ fixture: PROJECT, node: process.version, syntheticMembers: MEMBERS,
    environment: 'two Proxy containers, MySQL 8.4, fixed 20ms local mock; not production capacity',
    actualMeasuredHttpRequests: actualRequests, errors: errorCount, httpStatuses: httpCounts,
    phases: reports, latency: Object.fromEntries([...latencies].map(([key, values]) => [key, distribution(values)])),
    sqlObservation: { samples, maxObservedHolds: maxHolds, failed: observerFailure },
    passed: process.exitCode !== 1 }, null, 2));
}
