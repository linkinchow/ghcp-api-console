# Process-level route qualification: frozen-v4 baseline and v5 follow-up

## V5 follow-up (corrected parent run: 5 passed)

The corrected suite passed against actual isolated MySQL: **5 pass / 0 fail / 0 skipped, 12.612 seconds**. All five child pairs exited and all five sibling databases were dropped. Corrected log SHA-256: `5b433f6955dea962cb6badb80f12624a53bcfcfb48481c0f9092cc03e41b3ce8`. Production source remained unchanged; the first failed run below is retained.

First parent-reported engine result: **3 pass / 2 fail, 12.320 seconds**, with all five child pairs exited and random sibling databases dropped. The new all-catalog-cancel case passed in 2.307 seconds. Both 401-first cases reached the post-completion admission probe and failed because the fixture expected 503 but received 429. Production admission reclaims unverified ready inventory to `failed/warmup`, advances generation and expires the lease. With both old holds already drained, it deletes that lease, so no available ready member remains: the exact safe rejection is **429 `pool_exhausted`**, unlike the baseline's retained-live-hold **503 `member_unavailable`**. The test-only correction now asserts that exact code, failed/warmup state, `credential_not_verified`, generation +1, lease-expiration event/deletion, zero holds and no upstream traffic, retaining all pre-admission stale-200/401 fences. Correction checks locally: noEmit PASS; offline guards **4 pass**; v5 discovery **5 skipped / 0 engine passes**; whitespace and unchanged-production checks PASS. **The corrected five-case engine rerun subsequently passed as recorded above.**

Production target: `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`. This test-only follow-up adds **three** scenarios, retains the original two baseline test bodies, and changes only the existing `routes.*` harness files and this README. No production, worker launcher, suspend/login-network/replicas suite, package scripts or deployment changes are required.

### Selection and bounded coverage

There was no route-specific frozen launcher: `routes.mysql.test.ts` was invoked directly. The existing `worker-run.mjs` is separately pinned to v4 and must **not** be used for this suite. The route test entrypoint now explicitly selects:

- Missing `MYSQL_POOL_PROCESS_ROUTES_SUITE`, or `baseline`: exactly the two historical cases; no new v5 qualification claim.
- `MYSQL_POOL_PROCESS_ROUTES_SUITE=v5`: exactly **five** cases (two baseline + three follow-ups). After the existing destructive-fixture gate and before loading the harness, a bounded read-only Git preflight requires `src/proxy` and `src/packages/shared` to match the production target and rejects untracked production files. This compares source content rather than HEAD, allowing test-only follow-up commits while refusing older/modified production. Unknown/empty suite selections hard-refuse.

The added scenarios are:

1. **Every catalog consumer cancels across two processes.** Four GET/HEAD consumers join two independent partial-body cache refreshes. Cancellation is staged with committed SQL-hold barriers: one local survivor keeps its stream alive; the last local consumer aborts that stream while the other PID remains alive; the last remote consumer then aborts its stream. Both mock responses must close prematurely without a body release and all catalog holds drain. Without any cache clear, a different caller makes two fresh refreshes, then hits both successful caches. No inference, lease creation or renewal is allowed. Fresh-only release uses an observed mock-call cursor; release of an old cancelled response still fails.
2. **ABA, old 401 before old 200.** Requests are held on separate PIDs, and SQL proves both request IDs pin the original generation. Production credential writes rotate A → B → A. The old 401 completes and its exact hold drains while the old 200 stays blocked; SQL must retain valid replacement credentials, unchanged inventory/lease, and zero reauth/renewal events. Only then is 200 released. Neither admission, reclaim nor worker runs before **both** old completions, so those operations cannot mask the old-generation fence. Reverification uses the actual worker/provisioner with a held wire warmup; no admission before readiness, no inference replay, and a new active lease afterward.
3. **A → B, old 401 before old 200.** Reuses the same bounded scheduling and exact-generation checks, but verifies the B token is used by replacement warmup and inference. This is one additional rotation variant, not an exhaustive matrix.

The strict localhost/root/random-sibling-DB, environment isolation, child-exit, SQL watchdog, request/barrier and cleanup controls described below remain intact. The test-control allowlist additionally permits `rotate-ab`. The original 5-second production hold heartbeat is unchanged: both old completions must beat it; no parallel engine suites or debugger pauses at those barriers. Counts/timing in the historical v4 record below do not qualify these additions.

### Commands and actual local test report

Run from the checkout root with existing dependencies (no install needed). If dependencies resolve from an ancestor, use its installed TypeScript executable, as in the local check here.

```sh
node "$(node -p "require.resolve('typescript/bin/tsc')")" -p tests/user-pool-process/tsconfig.routes.json
node --check tests/user-pool-process/routes.offline.test.mjs
node --import tsx --test tests/user-pool-process/routes.offline.test.mjs

env -u MYSQL_POOL_PROCESS_ROUTES_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
  -u MYSQL_POOL_PROCESS_ROUTES_SUITE \
  node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
env -u MYSQL_POOL_PROCESS_ROUTES_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
  MYSQL_POOL_PROCESS_ROUTES_SUITE=v5 \
  node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts

node --import tsx --input-type=module -e "const s = await import('./tests/user-pool-process/routes.safety.ts'); await s.assertV5Production(); console.log('PASS: read-only production match to ' + s.v5ProductionRef)"
git diff --check
```

Actual local results on Node `v24.14.0`, 2026-09-15:

| Check | Actual result |
| --- | --- |
| Strict routes TypeScript noEmit | PASS, exit 0 |
| Offline MJS syntax | PASS, exit 0 |
| Offline URL/opt-in guards, suite selection, source-preflight stubs, side-effect sentinels | **4 pass / 0 fail / 0 skipped**, exit 0 |
| Default/baseline discovery, engine opt-ins removed | **0 pass / 0 fail / 2 skipped**, exit 0 |
| Explicit v5 discovery, engine opt-ins removed | **0 pass / 0 fail / 5 skipped**, exit 0 |
| Actual read-only production match to `356f8f5` | PASS, exit 0 |
| Diff whitespace | PASS, exit 0 |
| V5 real MySQL route execution | **NOT EXECUTED locally; pending parent Azure-engine run** |

The offline source-preflight tests stub Git to exercise matching, drift and untracked-source outcomes; the separate actual Git check above verifies this checkout. Entrypoint side-effect sentinels cover both suite selections and invalid selection, rejecting unsafe/missing configuration before Git/process spawn, listener/socket creation or fetch. Neither skip discovery nor offline passes count as MySQL/process acceptance. No cloud, Docker, MySQL fixture, commit or push was run for this preparation.

### Parent-only v5 engine command (not executed here)

Use the designated disposable engine on the Azure test host's **loopback**, with production source matching the target, this complete follow-up harness, and existing dependencies. The URL is only a credential/disposable-marker source; the named database is never selected or changed. Set the actual synthetic/disposable password through the authorized environment; do not put credentials in reports.

```sh
MYSQL_POOL_PROCESS_ROUTES_SUITE=v5 \
MYSQL_POOL_PROCESS_ROUTES_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
MYSQL_TEST_URL='mysql://root:DISPOSABLE_PASSWORD@127.0.0.1:3306/ghcp_pool_test_optin' \
node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
```

Require the v5 production-match banner, **5 non-skipped passes / 0 failures**, distinct PID diagnostics and successful random-sibling drop evidence for all five cases, and exit 0. A baseline-only two-pass run does not cover this follow-up. Parent should serialize this with other disposable-engine suites and report full failing TAP/child-startup diagnostics; do not edit production fences to make a test pass. Remaining exclusions include count_tokens, exhaustive race/cancellation combinations, process death/failover, real upstreams, deployment and long-duration behavior.

## Historical frozen-v4 qualification (two cases passed)

Baseline: `2bc12b363e62923ca6c1db0185e42f9ed5c78bf9` (frozen v4).
These eight harness files were copied unchanged from the prepared worktree before audit, then hardened only within this test directory. The earlier preparation/audit performed offline checks only; the parent subsequently ran both cases sequentially against disposable real MySQL on the frozen baseline. **Actual result: 2 pass / 0 fail / 0 skipped, 5.574 seconds**, with distinct child PID and successful random sibling database cleanup evidence. The frozen production modules and npm scripts were not changed. This is finite process-route qualification, not runtime acceptance of the later observability image.

## Scope

Two finite cases, each with a fresh random database and two independent Node child processes:

1. Four GET/HEAD catalog requests across two processes encounter two separately cached, partial-body upstream responses. Cancel one request; surviving local and remote consumers must continue. Mix in inference from both children, observe exclusive SQL ownership and hold cleanup, and assert catalog traffic cannot promote/renew leases while successful inference can. Later cache-hit catalog traffic must preserve lease timestamps.
2. One old-credential 200 and one old-credential 401, on different PIDs, are held at the external mock. A production repository write rotates A → B → A. Release 200 **before** admission/reclaim so generation-fence bugs cannot be masked, then release 401. Assert no old-epoch renewal, credential invalidation, reauth event or replay. Use the actual worker/provisioner to reverify the replacement, with warmup held on the wire; verify no admission before readiness and a new active lease afterward.

Only the ABA/success-first order is included; this is not the full component-test permutation matrix. The first case tests cancellation of one partial-body consumer, not cancellation of every consumer. GET/HEAD are covered; count_tokens is not. No owner failover, process death, deployment, real upstream or long-duration stability claims.

The expectations derive from `src/proxy/src/routes/userPoolCatalogPressure.mysql.test.ts` and `src/proxy/src/routes/userPoolCredentialRace.test.ts`, but listeners here do **not** share runtime or module cache: both execute `routes.child.ts` in separate OS processes. Ready messages assert different PIDs and instance IDs. Catalog and inference wire observations assert the expected originating child PIDs.

## Safety and architecture

- Requires all three explicit inputs: `MYSQL_POOL_PROCESS_ROUTES_TEST=1`, `MYSQL_POOL_TEST_DISPOSABLE=1`, and `MYSQL_TEST_URL`.
- MySQL URL must use `mysql:`, literal username `root`, loopback (`127.0.0.1`, `localhost`, or `[::1]`), `/ghcp_pool_test_[a-z0-9_]+`, and no query/fragment. No defaults or dotenv source is used for these inputs.
- The supplied database is never selected, migrated, written or dropped. Its URL provides credentials for a fresh `ghcp_pool_test_<32 random hex>` sibling. Only that sibling is created/dropped.
- Main process imports no production runtime/storage/config. Its SQL after database DDL is **SELECT-only**. Authorized synthetic fixtures and credential writes happen via production APIs in child 0. Readiness is established by the production worker/provisioner, not direct `verified_at` fixture writes.
- Children get an allowlisted OS environment plus explicit synthetic test configuration, an asserted-nonexistent random `DOTENV_CONFIG_PATH`, no inherited Node options and no real service endpoints. Product routes use real MySQL storage. The parent pins the child `TSX_TSCONFIG_PATH` to `tsconfig.routes.json`: `@ghcp/shared` resolves to this checkout's source, not an ancestor workspace's built dist. The child asserts that resolution; production proxy imports remain relative to this checkout.
- The only fetch injection is at each child boundary: it checks the exact ephemeral mock origin, restricts paths/tokens, attaches the PID and calls native fetch. It does **not** return fabricated in-process Responses. Redirects are forbidden. Main-to-child and child-to-mock HTTP are real independent wire requests.
- The ephemeral mock lives in the test parent, outside both proxy processes. It streams a partial JSON catalog, holds inference responses, tracks premature socket close and releases responses at explicit barriers. Only registered child PIDs, expected methods/paths, synthetic OAuth tokens and the synthetic internal SSO header are accepted; cancelled responses fail release rather than silently disappearing.
- The child proxy listener mounts production auth, identity, pool admission and compatible routes. It does not start the deployment entrypoint. A separate 127.0.0.1-only test-control listener requires a random per-fixture bearer capability and an exact allowlist (`state`, `seed`, `rotate-aba`, `tick`, `clear-cache`). No product debug endpoint or shared source change is introduced.
- The cache-waiter observation wraps `AbortSignal.addEventListener` without changing subscription semantics. Main SQL snapshots establish persisted outcomes; no SQL result is mocked. Each child keeps its own context/cache/runtime state.
- Requests/barriers/SQL/startup/shutdown are bounded. Test timeout is 100 seconds per case; each child has a 110-second lifetime ceiling installed **before** production imports/initialization, plus a parent-side 115-second kill ceiling. Cases close in `finally`, with an idempotent test cleanup hook also covering setup failures. Cleanup aborts and drains tracked clients/control requests, requests graceful child shutdown, escalates to kill if needed, closes the mock and drops the sibling only after both children exit. Nonzero/forced child exits and failed drops fail cleanup. Successful cleanup prints the exact dropped sibling name. A forced termination of the whole test parent may require manual disposable-DB cleanup.
- The ABA completions must beat the unchanged production 5-second hold-heartbeat fence after rotation. Do not pause at that barrier or run heavy concurrent suites. A heartbeat cancellation is a failed/unqualified run, not a reason to disable or instrument the production fence.

## Offline validation (safe without MySQL)

Run from this worktree root with existing dependencies installed; do not install or modify shared dependencies as part of this preparation.

```sh
node node_modules/typescript/bin/tsc -p tests/user-pool-process/tsconfig.routes.json
node --check tests/user-pool-process/routes.offline.test.mjs
node --import tsx --test tests/user-pool-process/routes.offline.test.mjs
env -u MYSQL_POOL_PROCESS_ROUTES_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
```

In a worktree resolving dependencies from an ancestor, use the installed TypeScript executable's actual path instead of `node_modules/typescript/bin/tsc`.

Offline validation after audit: strict TypeScript check passed; MJS syntax check passed; 2 offline gate tests passed; engine discovery with the dedicated opt-in absent reported **0 pass / 2 skipped**. Offline gates replace socket/listener/fetch/process-spawn entry points with throwing sentinels and verify opted-in missing/unsafe inputs refuse before any side-effect attempt. These are gate/skip results, **not engine results**.

## Explicit engine command (completed run; reference for authorized reruns)

Run from a checkout of the exact frozen baseline with these eight files added, existing dependencies installed, and a **disposable root MySQL endpoint on loopback** already available. The parent may run on its designated Azure test host; the Node parent, both proxy children, mock, and root MySQL endpoint must all be on that test host's loopback. Do not supply an Azure public/FQDN MySQL URL or relax the gate.

```sh
MYSQL_POOL_PROCESS_ROUTES_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
MYSQL_TEST_URL='mysql://root:DISPOSABLE_PASSWORD@127.0.0.1:3306/ghcp_pool_test_optin' \
node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
```

Do not point this at production or any shared non-disposable server. This script does not start Docker or provision a server. No dedicated `MYSQL_POOL_PROCESS_ROUTES_TEST` input gives two explicitly skipped cases; once that input is present, incorrect opt-in or missing/unsafe disposable/URL inputs hard-refuse. Do not mistake a skip run for qualification. No `.env`, inherited product environment, real GitHub or real Login/SSO credentials are needed. Child source pinning is set by the harness, so no extra `TSX_TSCONFIG_PATH` input is needed for the engine command.

Parent acceptance requires exactly two non-skipped passes, distinct child PID diagnostics for each case, successful cleanup/drop diagnostics for both sibling databases, and exit code 0. The completed frozen-v4 run met these criteria. Any separately authorized rerun must remain sequential on the shared disposable engine; send complete failing TAP/child startup diagnostics back for harness-only fixes rather than altering the production generation/heartbeat fences.

## Completed run evidence and remaining limits

The full execution log is archived locally at `.claude/post-v4-routes-full.log`, SHA-256 `1a6aaa63987db510a999f46d28390f0895c70f063810ca54c2b9bb2516ae6bf2`. This document publishes only aggregate results and the checksum, not raw runtime identifiers, endpoints or credentials. The earlier offline gate/skip results above remain a separate preparation-stage record; they are not included in the two engine passes.

Both finite cases described in Scope passed; all exclusions there still apply. In particular, this does not qualify every cancellation or credential permutation, process-death/failover combinations, real upstreams or deployment HA. The later observability image has been built and is starting via preview, but has **not yet passed runtime acceptance**; see [post-v4 progress](../../docs/user-pool-post-v4-progress.md).
