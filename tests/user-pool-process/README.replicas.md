# Frozen-v5 three/five-process replica qualification

Baseline: `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846` (v5). **Both actual MySQL replica cases passed on the isolated Linux host**, after the Windows implementer completed preparation. The designated verifier used the parent's explicitly scheduled Azure load-VM window against its existing dedicated loopback MySQL. No new infrastructure, Docker deployment, production traffic, commits or pushes are part of this suite.

## What is actually exercised

Two sequential top-level TAP cases: **startup3** and **startup5**, each using a new random sibling database and respectively three or five independent Node OS child processes. Each child mounts the production API-key/identity middleware, `routeUserPool`, compatible inference routes, actual MySQL storage, and calls production `startUserPool()` to initialize and start its real `PrewarmWorker`/`realProvisioner`. Separate address spaces provide separate model caches, caller gates, pools and runtime singletons.

The existing `routes.child.ts` is not used: it constructs a separate worker and manually ticks it, but does **not** start the runtime's production scheduler. Existing `routes.*`, worker files, package scripts and the frozen launcher are untouched. All adapters here are test-only `replicas-*` files. The production deployment entrypoint/server packaging is not exercised.

Five core business checks **per size** (ten grouped checks, but only **two engine TAP tests**, not ten passes):

1. **One DB-valid owner, all replicas route.** Read the singleton SQL owner and unexpired DB-clock TTL, map its tenure UUID to one child through a pass-through observer of successful `claimOwner` calls, and check all local worker snapshots. Mock provisioning POSTs initially originate only from that owner. Authentication denial is tested on every child before workers start.
2. **Concurrent same-caller affinity.** Clear local model caches; one concurrent held inference per replica must produce a cold upstream model lookup from every distinct PID, one SQL member/lease, and one hold per outstanding request. All return business 200 with a valid synthetic assistant response; holds drain and the lease stays the same.
3. **Concurrent distinct-caller exclusivity.** One different caller per replica remains simultaneously held at the mock. SQL and wire member identities must be distinct (including the original caller). All responses succeed and both lease/catalog hold tables drain.
4. **Bounded hot-caller lock isolation.** Hold the exact production named-lock key `SHA256(JSON.stringify([randomDatabase, hotCaller]))` in a dedicated session for at least 6.5 seconds. Issue **four A admissions per child** (12 at startup3, 20 at startup5), so the process-local caller gate is actually needed with each child's four-connection pool. While A waits, issue one existing distinct B caller per child. Every B must return a real business 200 within the predeclared **3,000 ms** ceiling; exact per-PID milliseconds are printed. All A responses must be 503 `pool_storage_unavailable`, at least 4 seconds and **at most 6,000 ms**: the unchanged 5-second production SQL budget plus an explicit 1-second fixture scheduling tolerance, selected before any engine run. Every A duration is printed individually by PID/request, not just an aggregate. There must be no upstream request, replay, lease or residual hold. No replay is checked both immediately after lock release and against the **final raw mock ledger after election and provisioning**, catching delayed work. This phase costs about 6.5 seconds per size and is not a throughput benchmark.
5. **Actual owner death and automatic recovery.** Natural idle-inventory consumption causes a fresh Login POST. The mock records/accepts that POST but withholds its response; SQL must still show the original nonce at `oauth-dispatch`, with no task ID. Kill the **actual DB owner child via its own `ChildProcess.kill('SIGKILL')` handle**, not a PID lookup or fake clock. Check the retained owner row still has 24–30 seconds left, is not renewed/cleared/shortened, and can only change after the real DB expiry. Surviving processes execute successful same-caller inference every second throughout the election gap; one new caller must also obtain a member from pre-existing Ready inventory. The successor must search for the retained task, reverify it through real warmup, then provision another genuinely new account. Raw mock POST accounting must contain exactly one user POST and one Login POST per identity, with no deduplication hiding a duplicate. Original caller member/lease identity survives the failure.

SSO/SCIM/seat state, Login tasks and model/inference responses are synthetic local services. SSO create returns an already-active/seat-assigned synthetic identity, so actual remote SCIM or seat-assignment POST paths are **not** qualified. Synthetic Login callback delivery calls the nonce-fenced production `saveCopilotOauthToken` repository API through a separate capability-protected test endpoint; the deployment's internal HTTP callback route is **not** mounted. No inventory Ready/verified timestamps, leases, owner UUIDs or owner TTLs are seeded/mutated by test SQL. Every Ready member was provisioned and warmed by production worker code.

## Safety and cleanup

- All three explicit inputs are mandatory for engine side effects: `MYSQL_POOL_REPLICAS_TEST=1`, `MYSQL_POOL_TEST_DISPOSABLE=1`, `MYSQL_TEST_URL`. Missing dedicated opt-in causes direct engine discovery to skip both cases. A present but invalid opt-in or unsafe URL hard-refuses. The dedicated runner always requires full opt-in.
- MySQL accepts only `mysql:`, literal username `root`, loopback `127.0.0.1`/`localhost`/`[::1]`, a `/ghcp_pool_test_[a-z0-9_]+` marker, and no query or fragment. The marker database is never selected, migrated, written or dropped. The fixture creates/drops only its own `ghcp_pool_test_<32 random hex>` sibling.
- The guarded runner refuses any HEAD other than exact v5 and any staged/unstaged/untracked change under `src`. It is additive and does not invoke/modify the frozen launcher. It strips inherited product configuration and Node hooks before launching the test process.
- Child environments are OS-allowlisted plus explicit synthetic configuration. Each uses an asserted-nonexistent random dotenv path. No inherited provider credentials, proxies, `NODE_OPTIONS`, product URLs or SQLite fallback. The shared package is pinned to this checkout's source via `replicas-tsconfig.json`, and the child asserts its resolution.
- Listeners bind dynamically allocated `127.0.0.1:0` ports. Child fetch permits only the exact fixture mock origin, expected methods/paths and synthetic credentials, attaches its PID and uses native fetch with redirects forbidden. The mock only accepts registered child PIDs. No external service traffic is allowed.
- Provisioning concurrency is **1 per active worker**, Login pending cap **1**, child MySQL pool **4**. Synthetic member cap is **20 per database** (expected final count 11 for startup3, 15 for startup5); no size exceeds 20 simultaneous blocked A requests plus its three/five short B probes. MySQL connection demand is approximately `4 * replicaCount + 2` at peak, plus existing server/admin connections. Run sequentially with other shared-engine resource tests.
- Parent imports no production runtime/config/storage. SQL after create/drop DDL is read-only except the explicitly documented dedicated named-lock session. Observer queries have 3-second deadlines; DDL 5 seconds; connection establishment 3 seconds. Lock socket destruction releases the named lock on failure.
- Client/control requests, setup barriers and shutdown are bounded and linked to the test abort signal. Idempotent cleanup is registered before setup side effects. It aborts clients, destroys the lock socket, drains or kills owned children, closes the mock and drops the sibling **only after every child is confirmed dead**. Intentional owner SIGKILL is accepted; every other forced/nonzero child exit fails cleanup. The exact sibling drop is printed. Child internal ceiling is 190 seconds plus 5-second forced shutdown; parent child ceiling 195 seconds; each TAP case has a 180-second timeout. Runner ceiling is 410 seconds. Unexpected whole-runner termination may still require manual cleanup of the printed disposable sibling.
- No test authorizes killing MySQL, unrelated Node processes or changing shared/prod database state. No paid/cloud resource creation is needed.

## Local checks (no MySQL needed)

Run at the worktree root using already-installed dependencies:

```sh
node -e "process.argv=['node','tsc','-p','tests/user-pool-process/replicas-tsconfig.json']; require('typescript/lib/tsc.js')"
node --check tests/user-pool-process/replicas-run.mjs
node --check tests/user-pool-process/replicas-offline.test.mjs
node --import tsx --test tests/user-pool-process/replicas-offline.test.mjs
env -u MYSQL_POOL_REPLICAS_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
  node --import tsx --test --test-concurrency=1 tests/user-pool-process/replicas-mysql.test.ts
```

Offline entrypoint checks replace sockets/listeners/fetch/child-spawn APIs with throwing sentinels, then prove child, fixture, engine and runner refuse absent/unsafe opt-ins with **zero attempted side effects**. Do not count either offline guards or skipped engine discovery as real MySQL acceptance.

## Dedicated verifier command (Linux Azure load VM)

Only in the agreed shared-engine window, with existing dependencies and dedicated disposable MySQL already running on the VM loopback, and exact frozen-v5 source plus these files:

```sh
MYSQL_POOL_REPLICAS_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
MYSQL_TEST_URL='mysql://root:DISPOSABLE_PASSWORD@127.0.0.1:3306/ghcp_pool_test_optin' \
node --import tsx tests/user-pool-process/replicas-run.mjs
```

Supply the dedicated password privately; do not publish URLs/credentials in the report. No npm install/build or Docker command is part of this runner. The marker name above is only an opt-in marker; both real case schemas are random siblings.

Expected normal duration: **60–90 seconds per size, approximately 2–3 minutes total** (estimate, not measured). Hard test budget: 180 seconds per size; outer runner ceiling 410 seconds. Exactly **two non-skipped engine TAP passes**, exit code zero, distinct child PID evidence for both sizes, complete per-phase diagnostics, fixed-threshold hot-caller probe latencies, real election timing, duplicate-POST assertions and successful drop diagnostics for **both** sibling databases are required for acceptance. A partially executed case or failed cleanup is not a pass. Do not relax latency/election/POST assertions retrospectively to make a run pass.

## Preparation validation record

- Strict TypeScript: passed locally on Node v24.14.0 (Windows); final validation repeated after all edits.
- Offline guards: two tests passed, zero failed/skipped; runner coverage included in final rerun.
- MJS syntax: checked in final validation.
- Unopted engine discovery: expected zero passes/two skipped; recorded separately in final handoff.
- Real startup3/startup5 MySQL execution was subsequently performed by the designated verifier: **2 passed, 0 failed, 0 skipped**, 101.921 seconds total. At three replicas, B probes completed in 29–39ms and all 12 A probes failed safely in 5010.975–5025.720ms; at five replicas, B took 46–76ms and all 20 A probes 5009.806–5024.028ms. Natural elections took 30.239/30.505 seconds with 58/112 successful survivor requests across the gaps. All phase assertions and child/sibling cleanup passed.
- Actual log SHA-256: `c068687cb2a861652259896aad5677ba6122ed14b04b2b13dc0819453a1b083f`. See [the bounded resilience report](../../docs/user-pool-v5-resilience-tests.md).

This finite single-host multi-process test is not production throughput, cross-node HA, long-duration soak, all cancellation/credential-race permutations, packaging or a real-provider acceptance result. It intentionally does not rerun 2,000-call or 30-minute tests for each size.
