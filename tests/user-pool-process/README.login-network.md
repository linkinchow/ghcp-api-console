# Login network process acceptance (v5 test-only follow-up)

**Both actual Linux/MySQL network cases passed against `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`: two subcases, TAP 3 passes including the parent wrapper, 0 failures/skips, 140.659 seconds.** Windows preparation and offline tests are separate evidence; actual runtime records and retained fixture failures are summarized below.
No production, existing worker/routes helper, build or package files are changed. The runner checks that the production Proxy/shared sources and reused worker helpers equal that baseline (test-only descendant commits are allowed).

## What the two cases exercise

- **Silent connected GET, real production timeout.** A real Worker/Provisioner creates one task with a real HTTP POST and checkpoints its ID/nonce in an isolated shared MySQL database. With the worker stopped, the fixture explicitly establishes an exhausted `failed/3` reservation using the real store failure operation. This is an operator-state precondition, **not** a claim that three naturally timed-out attempts were executed. A new real worker makes a task GET to an independent local wire-server process that accepts the HTTP request but sends **no headers or body**. It neither returns 503 nor uses a promise sentinel. `ServerResponse.close` records GET ID, monotonic start/close and elapsed time when the production client aborts. Existing server-side request/socket timeouts are disabled, not the production client timeout.
- While that GET is in flight, a separately seeded, credential-valid account becomes eligible for real SSO/model lookup/warmup and reaches ready. Ordinary concurrency is **one**, Login capacity is **one**: this proves the supported exhausted-reservation background-observation contract, **not** that a hung ordinary step leaves its own ordinary concurrency slot free. Retained reservation identity, nonce, task ID, generation, attempts, error and slot count remain unchanged. Worker diagnostics must report owner with zero ownership losses, ruling out early tenure-loss cancellation.
- Production `readPoolConfig` supplies the unmodified **120,000 ms** request timeout. Worker and Provisioner both use it. The existing worker fixture's 15-second timeout and 120-second child lifetime are deliberately not reused. Assertions require wire GET and worker observation duration in **118–135 seconds**: up to two seconds may already have elapsed in real SQL/assertions before GET reaches the wire. The harness never shortens the client deadline, advances clocks, changes owner TTL/expiry, or manually closes that GET. It records the actual duration, requires no headers, and verifies production timeout reason. Later GETs can respond, but changing the future-GET mode cannot release the stalled connection.
- **Independent wire-server death and restart.** Login POST is accepted in the synthetic server but its response stays open. The test observes that accepted task over IPC, observes persisted `oauth-dispatch` intent with no task ID, then kills only that server via its own `ChildProcess` handle and waits for the real exit event. After the ordinary POST failure, the fixture establishes exhausted operator state without changing any retry deadlines. A live worker's read-only observation fails against the stopped port; this connection-refused observation is **not** counted as timeout coverage. A new server process binds the same loopback port and restores the exact accepted task DTO from the parent IPC ledger. Recovery uses list GETs only, retains the original nonce and provisioning attempt, and issues no second task POST.
- Both cases apply a repository-layer nonce-checked synthetic callback, publish synthetic task success, and observe capacity release while preserving failed/3/error/retry protection. Three further scheduler periods must not warm or retry the failed member. Only an **explicit** `store.retry` operator action is then allowed to reach ready through the real Provisioner/model resolver/warmup, still with exactly one task POST. Wrong/repeated callback nonces cannot overwrite credentials.

The synthetic task ledger lives in parent memory, survives the wire process, and is restored over IPC. This tests process-boundary wire recovery, **not durable actual Login storage**, the actual Login service, Playwright/browser execution, real SSO/GitHub/Copilot, or the callback HTTP route. SSO/model/warmup responses reuse `worker-mock.ts` unchanged; its Login routes are never used. Production HTTP fetch, worker, store, mutation fences, warmup resolver and SQL execute for real against synthetic loopback services/shared isolated MySQL.

## Safety and bounds

Use only the wrapper below. `--run` validates all three opt-ins **before git, loaders, test/child spawn, HTTP listener or database connection**. Direct children independently validate gates/IPC/random sibling name before side effects. No `.env` loading: wrapper and children use allowlisted environments and `DOTENV_CONFIG_PATH=/dev/null` (`NUL` on Windows). Provider credentials, `NODE_OPTIONS`, proxy variables and HTTP timeout overrides are not inherited. Provider origins are assigned locally; HTTP clients forbid redirects.

MySQL must be disposable, on literal `localhost`, `127.0.0.1` or `[::1]`, with literal `root` username and `/ghcp_pool_test_...` marker. URL query/fragment options are rejected. Each case creates a **random sibling** `ghcp_pool_test_<32 hex>`; the supplied marker database is never selected, migrated, cleared or dropped. Parent and real worker use independent pools to that sibling. Nothing creates Docker/cloud infrastructure.

- Production request deadline: 120 seconds; production SQL budgets stay unchanged (ordinary pool operations 5 seconds; migration implementation capped at 60 seconds).
- Test migration waits: 25/20 seconds with socket destruction on cleanup; parent CREATE/DROP statement deadlines: 8 seconds, reads: 5 seconds, connection establishment: 5 seconds; finite MySQL queues (4/16).
- Socket-timeout case: 230 seconds; restart case: 90 seconds; complete suite: 360 seconds.
- Cleanup: one 30-second budget; all tracked children killed/drained before DROP, all tracked SQL sockets destroyed, listener closed, pools ended. DROP is refused if any child exit is unconfirmed. Failure names only the generated sibling for manual inspection.
- Child lifetime: 400 seconds, plus immediate parent-disconnect exit. Engine mode runs the `node:test` file directly, without an intermediate coordinator. The runner forwards SIGTERM on interruption or at 380 seconds, allows 30 seconds for fixture cleanup, then escalates to SIGKILL at the 410-second ceiling. Fixture signal handlers abort outstanding work and perform bounded cleanup. If an OS hard kill prevents cleanup, a sibling can remain: inspect the printed random name; never guess or drop the marker. A hard-kill deadline is not a successful cleanup claim.
- At most two fixture accounts, four synthetic tasks, 1,500 wire HTTP calls and 10,000 IPC proofs per process; long stalled-GET SQL verification polls once per second.

Expected healthy Linux duration is roughly **155–190 seconds**, dominated by the real 120-second timeout; allow the stated finite upper bounds. Run serially with other tests using this disposable server because production migration advisory locks are server-wide. Normal execution has no owner-TTL sleep and never rewrites owner leases.

## Commands

Prerequisites: Node 22+, existing project dependencies/shared build, and an already running disposable local MySQL 8.4 instance. Run from this checkout. Do not put credentials into command arguments or shared logs.

```sh
node --check tests/user-pool-process/login-network-run.mjs
node --check tests/user-pool-process/login-network-offline.test.mjs
node tests/user-pool-process/login-network-run.mjs --typecheck
node tests/user-pool-process/login-network-run.mjs --offline
```

Linux acceptance, only after the disposable MySQL instance has been independently selected:

```sh
# MYSQL_TEST_URL is supplied privately via environment, for example through an
# existing secret environment. It must target only a loopback ghcp_pool_test_* marker.
MYSQL_POOL_LOGIN_NETWORK_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
  node tests/user-pool-process/login-network-run.mjs --run
```

Save stdout/stderr with the parent test report if desired. Each case emits sanitized JSON TAP diagnostics with generated sibling, parent/worker/wire PIDs, actual GET start/abort and timeout reason, full task HTTP call ledger, task ID/nonce, before/released/final inventory, explicit retry flag and warmup counts. Synthetic nonces/IDs are evidence, not real credentials. Failed assertions fail the case; an absent opt-in is a clearly named **UNRUN skip**, never acceptance success.

## Actual local test report

Windows 11, Node `v24.14.0`; no MySQL/acceptance server/cloud/Docker/external traffic was run locally.

| Executed check | Actual result |
| --- | --- |
| Runner and offline-file `node --check` | PASS; final rerun 0.207 s / 0.158 s |
| First scoped noEmit typecheck | FAIL: unsupported `shell` property in `ForkOptions`; removed in new fixture only |
| Corrected scoped `--typecheck` | PASS, 3.465 s; intermediate rerun 2.879 s; final hardened rerun 7.652 s |
| `--offline` | PASS each run: 3 tests, 0 failures, 1 explicit MySQL/network UNRUN skip; first 1.493 s, intermediate 1.339 s, final hardened rerun 2.498 s (1962.819 ms test runner) |
| Working-tree scope/whitespace check | Only new `login-network-*` files and this README; no existing tracked diff |
| Real MySQL silent-GET/restart acceptance | **UNRUN locally; parent Linux execution required** |

## Actual Linux execution

The first run stopped after 2.207 seconds because the test worker treated its own graceful IPC disconnect as abnormal, and the stop waiter rejected a queued acknowledgement after exit. The fixture now distinguishes deliberate shutdown and requires both the acknowledgement and exit 0; missing acknowledgement, nonzero exit, signals and fatal IPC remain failures. Three new deterministic regression tests increased offline checks to six passes.

The second run stopped after 3.071 seconds because ordinary `store.update` correctly refuses disabled members. The unrelated warmup setup now uses supported operator `store.retry`, asserting the new attempt and Ready outcome, without changing the stalled member or production fences. Both early failure logs are retained; neither completed the 120-second timeout scenario.

The corrected third run completed both actual scenarios: **TAP 3 pass / 0 fail / 0 skipped, 140.659 seconds**. Log SHA-256: `9c30f7ee4149d8f16b529dc259d1e8054d0f74eee509f79d9a6e604eb3e9f8d6`. See [the bounded resilience report](../../docs/user-pool-v5-resilience-tests.md) for measured socket durations and final evidence. No production changes were required.

Offline tests validate unsafe/partial opt-in refusal, random sibling construction, exact production timeout, child environment sanitization, and instrument socket/listener/fetch/process APIs to prove entrypoints reject **before even attempting** side effects. They do not stand in for the real socket/MySQL cases.
