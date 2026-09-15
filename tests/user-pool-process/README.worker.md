# Frozen-v4 worker process/owner-failure qualification

**Status: actual disposable-MySQL process acceptance passed — two subcases, TAP 3 pass / 0 fail / 0 skipped including the parent wrapper, 66.454 seconds.** Both subcases used a real SIGKILL and a real approximately 30-second owner-TTL wait. This is not three business cases or coverage of every process-failure permutation.

Frozen source commit: `2bc12b363e62923ca6c1db0185e42f9ed5c78bf9`.
Only `worker*.ts`, `worker*.mjs`, and this README belong to this harness. It does not
modify production source, package scripts, configuration, route fixtures, or Docker.
The harness was run against frozen v4; it does not qualify the later observability
production increment, whose image is starting via preview with runtime acceptance still pending.

## Two executed cases

Both cases start two **independent Node child processes**, each with the real
`PrewarmWorker`, `realProvisioner`, `MysqlPoolStore`, and `MysqlStorage`. HTTP uses
real `fetch`, the real model resolver and real warmup request code. A synthetic
SSO/Login/model HTTP server lives in the **parent test process**, bound by
`listen(0, '127.0.0.1')` to a dynamically assigned port. That exact origin is passed
only to its own children; tasks and captured request ledger survive child termination.
It does not deduplicate Login POSTs. Control barriers are in-process/IPC fixture
controls, not production debug HTTP APIs.

1. **Accepted Login POST, checkpoint held, owner killed.** Seed one synthetic
   already-synced member (SSO/SCIM/seat creation are deliberately outside scope).
   The real worker creates the nonce, begins authorization and reserves the Login
   slot. Login accepts exactly one POST and returns a task. A fixture wrapper
   holds the owner's `oauth-wait` checkpoint before its SQL write. The parent
   verifies persisted `oauth-dispatch`, original nonce and null task ID, then
   sends `SIGKILL` and waits for the actual child exit event. No `worker.stop()`,
   `releaseOwner`, SQL owner replacement, clock override or lease truncation is
   used for this fault. The successor first proves standby, waits for real
   **30-second DB owner TTL**, claims with a fresh owner UUID, searches Login by
   identity, and adopts the **original task and nonce without a second POST**.
   A repository callback using the correct nonce then permits real HTTP warmup
   and `ready`. Incorrect/replayed nonce callbacks cannot overwrite credentials.
2. **Aged running Login task and late callback safety.** Repeat the same actual
   accepted-POST/owner-kill/recovery sequence, but the external mock task is born
   16 minutes old. The successor must terminally fail with `oauth_task_stalled`,
   retain the task/nonce and Login slot, and perform no warmup. Hold a terminal
   observation GET response containing the old `running` task. Deliver the
   matching late callback through real `MysqlStorage.saveCopilotOauthToken`, mark
   the external task successful, and release the captured OLD response while holding
   the next, fresh success response. Child IPC must prove the old-generation
   observation finished; SQL must still exactly match the post-callback failed row.
   Only then release the fresh response. It may release the slot, but state/attempt
   count/error remain `failed`/`3`/`oauth_task_stalled`; there is no automatic retry or
   warmup. This prevents a quick fresh release from masking a stale-response bug.

The second case tests stalled-task callback safety, **not** a request-deadline
network-hang/restart case. SSO creation ambiguity and network-hang restart are not
implemented. Callback acceptance is exercised at the real repository nonce fence,
not through the production HTTP callback route; route fixtures are separately
owned. No real Login service, SSO service, browser automation or upstream provider
is started. The checkpoint wrapper holds only one `store.update` invocation and
never fakes database contents, switches owners, or changes production code.

## Safe execution

Use Node 22+ with the project's dependencies already available (`tsx`, TypeScript,
`mysql2`, and built `@ghcp/shared`). No installation/build is performed by these
commands. The launcher requires a real Git checkout: `git rev-parse HEAD` must be
exactly the frozen SHA, and `git diff --exit-code <SHA> -- src/proxy src/packages/shared`
must succeed. For a remote runner, restore a frozen Git bundle/checkout; a source
archive without Git metadata is deliberately rejected. Do not bypass this guard.
It expects the existing built shared dependency to match the checkout; resolving
an ancestor workspace's built package is not a hermetic build attestation.

From the frozen worktree root:

```sh
node --check tests/user-pool-process/worker-run.mjs
node tests/user-pool-process/worker-run.mjs --typecheck
node tests/user-pool-process/worker-run.mjs --gate-check
```

`--typecheck` uses the TypeScript API with `noEmit`, including the production
Express type augmentation. `--gate-check` strips MySQL opt-ins even if present in
the calling shell, runs socket-free URL/environment safety tests, and reports the
process acceptance suite **skipped**. Neither mode contacts MySQL or starts HTTP.
Do not count its green gate tests as process acceptance.

An actual acceptance run must be separately, explicitly opted in against an
already-running disposable LOCAL MySQL server. Supply credentials via the process
environment only; do not put them in argv, load `.env`/`production.env`, or use a
production server. Required environment variables:

- `MYSQL_POOL_PROCESS_TEST=1`
- `MYSQL_POOL_TEST_DISPOSABLE=1`
- `MYSQL_TEST_URL`: `mysql:` URL with username exactly `root`, hostname exactly
  `localhost`, `127.0.0.1` or `[::1]`, and database marker
  `ghcp_pool_test_[a-z0-9_]+`. No query parameters or fragment. Root must be able to
  create/drop an isolated database and install the normal schema/trigger.

Then run:

```sh
node tests/user-pool-process/worker-run.mjs --run
```

The URL's named database is **never selected, migrated, cleared, or dropped**.
The suite generates exactly one random sibling database named
`ghcp_pool_test_<32 random hex>`, uses it for both cases, and drops only that sibling
in `finally`. The random name is printed so an interrupted parent can be cleaned
up manually. Never use wildcard drops. Ordinary failure cleanup terminates remaining
children before closing mock sockets/pools and dropping the sibling. Abruptly
killing the parent may leave the disposable sibling behind; children exit on IPC
disconnect, and have a 120s absolute lifetime. Mock ports and random sibling names
are independent between concurrent suites; there is no shared fixed-port fixture.
The runner has a 300s hard watchdog, ordinary case/suite cleanup uses bounded waits,
tracked MySQL connections are destroyed before pool shutdown, and only actual
`ChildProcess` handles created by this harness receive SIGKILL. A DROP is refused if
a worker's exit was not confirmed. Hard watchdog/OS interruption can leave a sibling
for exact-name manual cleanup; never claim that destructive interruption is clean.

The launcher/children use an environment allowlist, discard inherited provider
credentials/proxy variables/`NODE_OPTIONS`, suppress child stdout/stderr, and set
`DOTENV_CONFIG_PATH` to the OS null device before production imports. Credentials
are fixed synthetic values; HTTP URLs use the parent-owned dynamic loopback port.
The only externally configurable network target is the gated local MySQL endpoint.
The launcher validates all three opt-ins and the complete URL before any test/worker
spawn or DB connection; the child independently revalidates its random database and
mock origin. Launcher uses `spawn(process.execPath, ..., { shell: false })`; workers
use `fork(worker-child.ts, [], { execArgv: ['--import', 'tsx'] })` (no shell or argv
credentials). All seven harness paths are ordinary files, not symlinks. Do not launch
the test/child files directly; use the launcher so its commit/environment guards apply.

Budget: two cases, each with a real ~30s lease wait; 100s timeout per case, 240s
suite timeout, bounded IPC/SQL polling and cleanup. No artificial DB-clock changes
are made. Expected success normally takes roughly 65–90 seconds on healthy local
MySQL. Cleanup can add bounded time; a forced parent interruption is not guaranteed
to remove the random sibling.

## Evidence and exact current validation limits

A successful actual run emits TAP diagnostics containing parent/killed/successor
PIDs, OS exit result, old/new owner UUIDs, DB expiry/claim times, original nonce and
task ID, HTTP task POST/GET ledger, warmup count and final state. Passwords, tokens,
DB URLs and connection error details are not included in that evidence. Before
clean shutdown, SQL and child IPC must agree that the fresh successor is the live
owner. Callback wrong-nonce and replay rejection, stage/attempt/generation fences,
slot retention/release and absence of a second Login POST are asserted, not merely
logged.

Preparation-stage history: prepared locally on Windows with Node **v24.14.0**.
During that preparation, Docker was not started, no cloud was contacted, and no
local MySQL engine run was attempted (unavailable there). Its syntax, TypeScript
`noEmit`, socket-free gate and skipped acceptance results remain offline evidence,
not process-acceptance passes.

The parent subsequently completed the explicitly opted-in disposable real-MySQL
run against frozen v4: **two actual subcases passed; TAP 3 pass / 0 fail / 0 skipped
includes the parent wrapper; elapsed 66.454 seconds**. Both actual SIGKILL/exit and
real approximately 30-second TTL waits completed. The independent successor
recovered the original task/nonce without a second Login POST; the normal recovery
and aged-task/late-callback subcases reached their expected ready/failed states.
The run exercised the normal schema setup, HTTP recovery, stale-observation fences
and live-run cleanup on that runner. It is not certification of every grant
configuration or kill/exit behavior on both Windows and POSIX.

The complete execution log is archived locally at `.claude/post-v4-worker-full.log`,
SHA-256 `7a6328f89a35c72f200ad484ec31cef269edb6b5e0cde62ed5573cde2deb1eb5`.
Only aggregate results and this checksum are published here, not raw runtime
identifiers, endpoints or credentials. See [post-v4 progress](../../docs/user-pool-post-v4-progress.md)
for the separate routes result and observability increment status.

All scope exclusions above remain: no SSO/SCIM/seat side-effect process matrix,
network-hang/service-restart case, long-paused old process resuming after takeover,
production HTTP callback-route acceptance, real upstream or deployment HA claim.
The later local-diagnostics implementation does not deliver global owner alerts or
customer SQLite owner-loss recovery; its new image has not yet passed runtime acceptance.
