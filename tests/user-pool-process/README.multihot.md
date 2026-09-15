# Multi-distinct-hotcaller overload extension

Single selected case only: **five independent Proxy child processes**, one shared disposable MySQL sibling, **three different hot caller IDs × four requests per caller per child = 60 A requests**, and one ordinary B probe per child. Five baseline B and five recovery B requests are additional checks, not another load matrix. There is no cancellation, owner-death, streaming, soak, throughput or extra replica-count case here.

## Safety and invocation

**Current execution authorization: workload runs only on the parent's isolated Azure test VM, against that VM's loopback disposable MySQL. Local checks are offline/typecheck only. Docker Desktop is authorized for functional/UI testing, not this load case.** This fixture creates no Docker/cloud resources. Never point it at real GHE, SSO/Login services, model endpoints or paid seats. All upstream provisioning, login and inference use the existing `replicas-mock.ts` loopback synthetic service. The unchanged `replicas-child.ts` runtime enforces its existing exact-origin/path/auth/redirect guards, synthetic credentials and empty dotenv path.

From the repository root with installed development dependencies:

```sh
node --import tsx --test tests/user-pool-process/multihot-offline.test.mjs
node node_modules/typescript/bin/tsc -p tests/user-pool-process/multihot-tsconfig.json

MYSQL_POOL_MULTIHOT_TEST=1 MYSQL_POOL_REPLICAS_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
MYSQL_TEST_URL='mysql://root:DISPOSABLE_PASSWORD@127.0.0.1:3306/ghcp_pool_test_optin' \
node --import tsx tests/user-pool-process/multihot-run.mjs
```

Do not put real credentials in saved reports. The URL must use literal `root`, a loopback hostname, a disposable `ghcp_pool_test_*` marker and no URL options/fragments. The marker database is never used: the harness creates and drops a fresh random UUID sibling. One read-only admin/observer connection plus three dedicated named-lock connections is the entire fixture DB budget; the five real children each retain the production four-connection limit (24 connections maximum including observers). No SQL row seeding or forced expiry is used. Only sibling DDL and session-scoped named locks are fixture writes; synthetic OAuth callbacks use the existing production repository path.

The runner accepts test-only descendant HEADs of production baseline `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`. It verifies `src`, root manifests/lockfile and base TypeScript configuration match that baseline and are clean, including untracked source. It does not call the older exact-HEAD `replicas-run.mjs`. The runner has no arguments or adjustable replica/burst/duration knobs. A shared absolute deadline reserves cleanup before 110 seconds; a 119-second outer kill ceiling includes startup/production checks. This one finite run belongs inside the parent's **30-minute aggregate additional-test budget**, never alongside unbudgeted automatic extensions. Parent controls any Azure execution. Missing opt-in skips the live test; unsafe explicit input or direct live entry without the runner deadline refuses before network activity.

## Predeclared contract

1. Real production workers prewarm synthetic Ready inventory. Five ordinary callers establish leases and succeed before pressure; Ready reserve is restored before the overload begins.
2. Three separate MySQL connections acquire the exact production lock name `SHA256(JSON.stringify([randomSiblingDatabase, callerId]))`. Once all three locks are held, a 6,500ms timer releases them and destroys the lock sockets. No production gate, native pool, SQL deadline, worker timing or SQL result is changed.
3. The finite burst must visibly produce **three active caller-gate heads and nine FIFO followers in each child**, plus **five real GET_LOCK waiters for each of the three different lock names**. This qualifies multi-caller resource occupancy, not a single hot caller duplicated in a test label.
4. All 60 A responses must be JSON `503`, `error.code=pool_storage_unavailable`, `Retry-After: 1`, within **4,000–6,500ms**. The unchanged SQL deadline is 5,000ms; the upper bound allows 1,500ms scheduling/transport tolerance. No client transport error, 500, HTML fallback or other error code counts as success.
5. B pressure availability is **measured as successful 200 responses / five probes**, with each PID's status and latency printed. Both valid JSON 200 and the same safe JSON 503 are acceptable within **6,500ms**. There is deliberately **no minimum B success fraction or promise B is always 200 under aggregate exhaustion**. The case does not artificially exhaust the fourth connection, so its results must not be described as a full-pool-exhaustion SLA.
6. Child-only instrumentation reads the actual mysql2 pool internals and existing read-only caller-gate diagnostic. It samples every 25ms and immediately after each real `getConnection()` invocation, returning the original driver promise without modifying its result. Native connections must remain ≤4; configured native queue limit must remain 1024; the **finite-load observed queue high-water must be ≤16 per child**, active callers ≤4, FIFO followers ≤9, retained tickets ≤13. Values/maxima and sample counts are printed per PID. This is observed finite-load behavior, not a proof about arbitrary loads or an event-exact history of every caller ticket.
7. After release, all three named locks must be unowned and all three fixture connection IDs plus timed-out GET_LOCK sessions disappear. Caller tickets and native queues drain. Every replica's ordinary B must return valid 200 with unchanged lease/member affinity. Both durable hold tables drain. No failed A can create a lease or dispatch upstream, including after a further 5,500ms post-release replay observation window. Successful B dispatches exactly once; failed B dispatches zero times.
8. All owned child processes exit and the sibling database is dropped. Failure-path cleanup also destroys all named-lock sockets; if cleanup cannot complete, the random sibling name is reported for manual cleanup. Product child logs are drained but suppressed rather than risk exposing raw SQL credentials.

## Execution report

Local offline verification on 2026-09-15 (Node v24.14.0, checkout `5ea75af7ac0000b37758efd751a606ea86010a00`):

- `multihot-offline.test.mjs`: **3/3 passed**, zero side effects for refused entrypoints; repeated after fixes and still 3/3 passed.
- `tsc -p tests/user-pool-process/multihot-tsconfig.json`: **passed** after correcting two initial test-only typing errors; covers the new TypeScript and reused replica fixture/runtime imports.
- `node --check tests/user-pool-process/multihot-run.mjs`: **passed**.
- Production comparison to `356f8f5`: **no differences** in source, manifests/lockfile or base TypeScript configuration.
- Parent-managed live MySQL execution subsequently **passed**, 26.408s, TAP1 pass/0 failures/skips. All60 A requests returned safe503 in5031.821–5101.432ms; pressure B5/5 returned200 in29.391–124.877ms, and recovery B5/5 returned200 in33.079–65.873ms. Observed native queue peak1 per child; named locks, queues and holds drained, all children exited and the random database was dropped.
- Complete log SHA256: `2dd2329b40a34ea8946b5cc0cc859ec4c548c5871476c918a600bef33543a8e5`; see [the final load report](../../docs/user-pool-final-load-validation.md). No local Docker load was performed.

**Offline authoring and actual MySQL execution are separate evidence**, both recorded above. Measurements are limited to the declared finite scenario, not inferred from test authoring or a general availability SLA. The diagnostics provide per-replica A/B status/latency, B availability fraction, observed native/caller queue bounds, recovery, lock release and cleanup evidence. No old replica matrix was rerun as part of this extension.
