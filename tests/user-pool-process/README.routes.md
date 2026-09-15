# Frozen-v4 process-level route qualification (two cases passed)

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
