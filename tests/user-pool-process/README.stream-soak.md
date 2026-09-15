# Bounded independent-proxy longstream/resource soak

**Corrected smoke and bounded soak both passed against real isolated MySQL.** The first smoke and diagnostic stopped on a planned cancellation's production `upstream-stream-failed` log; those failures are retained. The corrected fixture narrowly pairs that event with the exact pre-registered, actually aborted request/PID and native stream closure; other warnings/errors remain failures. Configured120s smoke took121.026s; configured300s soak took299.609s, both with zero unexpected events and complete cleanup. Cumulative campaign usage was482.940/600 seconds including prior failures. See [the final load report](../../docs/user-pool-final-load-validation.md). The parser permits at most1800 seconds per invocation, but does not override a tighter campaign authorization. No day-long mode or local Docker load was used.

## Scope and reuse

New `stream-soak-*` files only; production and existing fixtures are unchanged. The harness starts **three or five independent Node child processes**, each mounting production authentication, `routeUserPool`, compatible SSE routes, real MySQL storage, and the real `startUserPool()` scheduler. Every child PID must return a successful streaming request. Independent UUIDs, PIDs, proxy/control origins, and per-PID mock requests are recorded, so multiple listening ports are not mistaken for independent proxies.

`replicas-safety.ts` supplies the existing disposable-DB, synthetic credential, model, URL, and timeout primitives. `replicas-mock.ts` is reused read-only for bounded provisioning/models/warmup; business SSE passes through a new local mock shim instead of its request ledger. The existing replica child/harness have approximately 190-second lifetimes and retain request history; the new child and harness are necessary finite-lifetime/bounded-memory seams. As in that fixture, synthetic Login callback delivery invokes the production nonce-fenced OAuth repository API, not direct credential/Ready/lease SQL seeding. The deployment callback route/server packaging are not exercised.

## One combined workload, no extra categories

- Default **60 seconds total setup + workload**, 30-second deterministic SSE streams, three client lanes, three children. CLI permits 10–60-second streams, two–five lanes (no more than child count), and three/five children. These small declared bounds are test inputs, **not production capacity claims**.
- Each lane has at most one submitted request and awaits its completion/drain before another. There is no producer queue or automatic retry. Each `(lane, sequence)` must increment exactly once at the mock; a duplicate, delayed replay, skipped sequence, extra upstream attempt, unexpected status, or SSE error fails.
- Each complete cycle runs one partial cancellation plus the other long streams concurrently. Cancellation occurs only after three content deltas and at least two seconds, before the terminal event. Read-only SQL proves the held slot existed, then drains, and lease ID/member/phase/expiry/last-success remain exactly unchanged. The same caller's **explicit new** recovery request runs through a different child, completes valid SSE, and renews its unchanged lease. This is not a transparent retry.
- Successful streams must contain a start, content delta, valid terminal event and clean EOF; full streams must really last at least the declared stream duration. Headers/partial data cannot renew the preceding lease. Every complete cycle and final observation require both SQL hold tables and mock active slots to drain.
- Every child gets a one-second streaming affinity probe before the long cycles. The parser retains only one bounded partial event, not response bodies. A last stream that cannot finish within the declared workload budget is **not started**; the final fraction of a cycle is explicitly idle observation to catch delayed replay. Reports distinguish that phase. At least one full/cancel/recovery cycle is required; slow setup that leaves insufficient time fails rather than claiming acceptance.

## Safety, resource limits and evidence

All engine side effects require `MYSQL_POOL_STREAM_SOAK_TEST=1`, `MYSQL_POOL_TEST_DISPOSABLE=1`, and `MYSQL_TEST_URL`. The URL uses literal `root`, loopback only, `mysql:`, a `/ghcp_pool_test_*` marker and no query/fragment. The marker is never selected or touched. Only a generated `ghcp_pool_test_<32 hex>` sibling is created, used and dropped.

The runner validates options **before git/file/network/fork side effects**, then verifies `HEAD:src`, working source and index against immutable production `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`. It permits the existing frozen356 Azure checkout with additive test overlays (does not demand HEAD5ea). It records SHA-256 of new/reused test files and the production tree. Parent runner environment is stripped to OS + explicit test inputs; children receive OS-allowlisted synthetic settings and an asserted-nonexistent dotenv path. No provider URL/token flags or fallback inherited production endpoints. As with all Node tools, launch from a trusted managed runner with `NODE_OPTIONS`/preloads already cleared; removing inherited environment cannot undo hooks loaded before the script started.

All HTTP listeners bind dynamic `127.0.0.1:0`. Child outbound fetch permits only exact fixture origin, allowed methods/paths and synthetic credentials, with redirects forbidden. The mock requires registered PIDs and provisioned synthetic tokens. No actual SSO/Login/provider accounts or paid providers are called. No Docker/cloud/dependency/setup action is embedded.

Bounds and observations:

| Item | Limit/evidence |
| --- | --- |
| Combined setup/workload | CLI 60–1800 seconds; `>1800` hard refusal |
| Cleanup | 45 seconds separate finite budget, outer watchdog; managed parent must supervise same process-group ceiling |
| Client lanes / queue | 2–5 active, zero producer queue; pending promises removed on settlement |
| Real MySQL connections | Four per child plus one observer/admin; observer counts exact sibling sessions |
| mysql2 queue | Production configuration unchanged (1024 cap); read-only sampled queue must be <=8 in this modest test |
| Synthetic inventory | At most20; real worker provisioning concurrency1, Login pending1 |
| Child/harness RSS | Each <768MiB test safety ceiling, not a production sizing recommendation |
| Telemetry | Parent/child RSS/heap/external, cumulative CPU, child resource usage, HTTP socket counts, pool total/free/queue, DB sessions/holds/events/stats, PID/instance/origin map |
| Report/history | First + latest + ring of120 samples; peak counters; JSON <=2MiB; no per-request ledger |
| Logs | Native output still emitted; bounded 4KiB per-stream scan pairs a single planned-cancel error with authenticated test-control intent and exact request/PID IPC metadata. All other WARN/ERROR and duplicate/unmatched events fail; >2MiB/child fails. No raw log fields are published. |
| SQL data | Accounts<=20, caller leases<=lanes, request stats<=2000+lanes, events<=20000, sampled with bounded SELECTs; no observer mutation beyond sibling create/drop |
| Mock | Constant lane sequence/active maps and counters; provisioning forwarding<=1000 and original finite ledger; no business history |

Checkpoints print one small JSON summary every5–60 seconds (default10). With `--report`, a user-selected **new** `.json` file is atomically replaced each checkpoint; its parent directory must exist. Output includes immutable-source/test hashes, workload counters, elapsed phase, exact disposable sibling, process mapping, recent/first/last/peak telemetry, cleanup and sanitized failure location. Raw MySQL URLs, keys, tokens, errors, and child logs are not reported. Metrics are sampled observations and ceilings, **not proof of absence of all leaks** or a customer capacity result.

No unexpected counter, mock failure, unplanned child exit, unqualified WARN/ERROR, missing terminal, false renewal, replay, leaked final slot or failed cleanup is allowed for `passed`. The sole expected logging case requires registered cancel intent, parent-issued abort, matching active synthetic request/PID, native upstream-aborted and downstream-closed evidence, one paired IPC/log event, unchanged lease, SQL/mock drainage and subsequent explicit recovery. Offline negative cases reject armed-but-not-aborted, wrong identity/PID, false flags and duplicates. All owned child handles are shut down (forced exit counts as failure), clients/mock close, then the random sibling drops only after all owned children are confirmed dead. Ctrl-C/SIGTERM initiates the same bounded cleanup. Whole-runner SIGKILL may leave the recorded sibling for parent recovery; no unrelated process, server or database is killed.

## Commands and shared parent budget

Use already-installed dependencies at the checkout root. Offline checks do not create sockets/MySQL traffic:

```sh
node -e 'process.argv=["node","tsc","-p","tests/user-pool-process/stream-soak-tsconfig.json"]; require("typescript/lib/tsc.js")'
node --check tests/user-pool-process/stream-soak-run.mjs
node --check tests/user-pool-process/stream-soak-offline.test.mjs
node --import tsx --test tests/user-pool-process/stream-soak-offline.test.mjs
env -u MYSQL_POOL_STREAM_SOAK_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
  node --import tsx --test tests/user-pool-process/stream-soak-mysql.test.ts
```

**Parent-managed Linux Azure VM only**, sequential with other resource tests, existing dedicated loopback MySQL and existing dependencies. Supply the disposable password privately. Illustrative smoke command (launch is not authorized merely by this document):

```sh
MYSQL_POOL_STREAM_SOAK_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
MYSQL_TEST_URL='mysql://root:DISPOSABLE_PASSWORD@127.0.0.1:3306/ghcp_pool_test_optin' \
node --import tsx tests/user-pool-process/stream-soak-run.mjs \
  --replicas 5 --concurrency 3 --duration-seconds 60 --stream-seconds 30 \
  --checkpoint-seconds 10 --report /existing-approved-report-directory/stream-smoke.json
```

For the bounded soak use exactly the same workload with parent-selected `--duration-seconds REMAINING_SECONDS` and a new report path. **Do not independently allocate1800 after smoke or multi-hot contention:** the parent deducts their phase durations from the single additional-load window, and accounts for cleanup in the managed wall-clock ceiling. The CLI caps this invocation, not the cumulative duration of separate invocations. No agent launches a second soak, new infrastructure, actual accounts, local desktop load or prolonged run. A managed parent should terminate the owned process group after `duration +45` seconds if the native runner does not finish; record failed cleanup rather than counting a timeout as success.

At five children with three lanes, maximum configured MySQL demand is21 connections plus pre-existing server activity. No process RSS reservation is created; the safety threshold permits up to six Node processes (five children + harness) each under768MiB, so parent must choose concurrency/window using actual available VM resources. The mock and observer live in the harness process. A successful report requires status`passed`, zero unexpected, all evidence checks, and `childrenDead/databaseDropped/complete=true`.

## Actual implementer verification record

Windows Node24.14.0, existing dependencies, no database opt-in:

- Strict TypeScript: passed (final rerun required after any integration edits).
- MJS syntax: passed for runner and offline suite.
- Offline suite: **4 passed, 0 failed, 0 skipped**, including1801/86400 refusal, hostile DB guards, bounded ring/parser, and zero network/fork/git attempts on invalid entrypoints.
- Unopted MySQL discovery: **0 passed, 0 failed, 1 skipped**, as intended. This is not engine acceptance.
- One initial TypeScript command form was refused by isolation command verification and one wrong relative binary path failed to resolve; the dependency-resolved command above passed. No bypass/dependency change was used.
- Parent-managed actual MySQL validation subsequently passed: smoke17sent/6full/3canceled/8recovered; soak41sent/18full/9canceled/14recovered, zero unexpected. All owned children and sibling DBs cleaned. Full report SHA256 `383961942e78a6bec97ff97dd845ffd242991f9e10ed57b5351c05503f1d7102`; smoke SHA256 `1f8fd155a0efc37997cc0f1492fe103725c0fe6ffe899c1423ab601b2b740606`. Real-customer capacity remains unmeasured.
