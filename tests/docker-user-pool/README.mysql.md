# Isolated multi-Proxy MySQL fixture

This harness exercises **two actual Proxy containers against one MySQL 8.4 database**. SSO, Login and Console are actual application images. Only SCIM, seat assignment, OAuth completion and inference are mocked. It never provisions GitHub users or calls real models.

## Safety and prerequisites

- Fixed Compose project: `ghcp-user-pool-mysql-test`. No other project's containers or volumes are addressed.
- Images: `ghcp-pool-mysql-proxy:check` (both replicas), `ghcp-pool-mysql-sso:check`, `ghcp-pool-mysql-login:check`, `ghcp-pool-mysql-console:check`, `mysql:8.4`, `node:22-bookworm-slim`.
- Build the application images **from the checkout containing the current MySQL implementation**, not a stale worktree. The Compose build contexts are relative to this fixture folder. The launcher `build` action builds Proxy once, then SSO/Login/Console.
- Node 22, Docker Compose v2, OpenSSL on PATH, and the repository's installed `mysql2` dependency are required. No `npx`, dependency installation, or image pull is performed by the tests. `up` uses `--no-build --pull never`; arrange missing images separately. A blocked MySQL pull is a blocked runtime test, not a passing result.
- All app services and MySQL belong **only** to an `internal: true` network. Only the fixed-target bridge joins the preview network and publishes loopback ports. It has no Docker socket, host network, arbitrary forwarding target, executable HTTP endpoint, or writable host bind.
- Every credential in this fixture is public, synthetic and test-only. No existing `.env`, `.env.example`, `local-run.json`, deployment directory or certificate is read. App images do not mount these files. Do not use real credentials here.
- `launch-mysql.mjs` creates a unique OS `mkdtemp` directory containing a two-day self-signed SSO certificate, empty Compose env file and synthetic MySQL initialization SQL. OpenSSL is spawned directly, without a shell. Existing files are never overwritten. The printed `MYSQL_FIXTURE_STATE` path contains configuration paths but no passwords. Retain it for lifecycle actions; temporary directories are intentionally not automatically deleted.

Published ports (only the bridge publishes them):

| Loopback port | Target |
| --- | --- |
| 18100 | Proxy 1, service name `proxy` |
| 18101 | Proxy 2, service name `proxy2` |
| 18102 | Mock fixture and read-only SSO/Login inspection |
| 18104 | Console |
| 33184 | Fixed TCP bridge to test MySQL |

Each HTTP root exposes `/__mysql/manifest` identifying this project and fixture. The scripts verify these manifests **and** the actual app health/readiness responses before changing anything. Proxy `/readyz` must report `storage: mysql`; the mock's own health must report `fixture: true`. Actual SSO/Login health and lists are forwarded through read-only `18102/__mysql/{sso,login}/...` routes; no real Login task can be posted through them.

## Launch through preview

The parent session owns `.claude/launch.json` and starts servers with `preview_start`. A suitable configuration entry is:

```json
{
  "name": "user-pool-mysql-test",
  "runtimeExecutable": "node",
  "runtimeArgs": ["tests/docker-user-pool/launch-mysql.mjs", "up"],
  "port": 18104
}
```

Do not run a server via Bash. The launcher stays attached to `docker compose up` and forwards termination signals. This does not alter the older SQLite harness.

To prepare files without starting containers, use `node tests/docker-user-pool/launch-mysql.mjs prepare`. The `build` action can be used independently once package/base-image access is available. To reuse the generated directory, append `--state=/absolute/path/to/run.json`. Without a state argument, `prepare`, `build` and `up` each create a new directory. No implicit state lookup is performed.

Lifecycle actions always require the explicit state path:

```text
node tests/docker-user-pool/launch-mysql.mjs stop-owner --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs start-owner --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs restart-replicas --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs down --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs destroy --state=/absolute/path/to/run.json
```

The scripts themselves never restart containers. `down` keeps test volumes. Prefer a new `POOL_MYSQL_VOLUME_SET` (lowercase letters, digits and hyphens, maximum 32 characters) when changing from smoke to load: this selects separate fixed-prefix test volumes while retaining previous evidence. Use the same value for every lifecycle action. The `recreate` launch action recreates all fixture processes, including the in-memory mock; changing database volumes alone does not reset mock state. `destroy` deletes the currently selected disposable volume set and requires an explicit operator decision. Stop the preview before changing sets and release the fixture bridge's ports; never delete another project's volumes.

## HTTP smoke and failover

Run the one-shot test only after preview reports a healthy stack:

```text
node tests/docker-user-pool/mysql-smoke.mjs run
```

A fresh run requires empty Proxy, SSO, real Login and mock inventories, and initial idle target zero. It performs:

1. Health, authenticated fixture identity and two MySQL readiness checks; read-only SQL singleton/migration, live scheduler owner and renewal checks.
2. Cross-replica settings version conflict; real worker prewarm to two accounts using actual SSO and mock SCIM → seats → fake Login callback → model catalog/warmup. Neither source inventory nor SQL READY records are preseeded for smoke. The unchanged fixture callback deliberately targets `http://proxy:3000`; Proxy 2 can advance work and consume shared credentials.
3. Canonical model catalog, JSON/SSE on Messages, Chat Completions and Responses; same-caller concurrency and alternating replicas converge on one lease/member. Distinct callers are exclusive; exhausted requests do not reach the upstream.
4. Autonomous replenishment of a spare member; upstream 429 persists cooling across replicas without renewal, replay or rotation **despite the spare**.
5. A held Responses stream, SQL hold visibility, release refusal through the other replica, client cancellation, upstream disconnect and complete hold drainage.
6. Exact mock provisioning/callback counts, SQL lease uniqueness and bounded holds. No identities, caller hashes, credentials or raw SQL errors are printed.

It leaves provisioning paused and prints a unique `MYSQL_SMOKE_SNAPSHOT` path. The snapshot contains hashes, counters and expiry, not identities/tokens. `prepare-failover` creates a new snapshot and renews the healthy test caller if more time is needed; an explicit new snapshot path may be passed as the third argument. Files use exclusive creation rather than overwrite.

For fresh-start owner failover:

1. `proxy2` initially depends on `proxy` readiness, so `proxy` is the initial scheduler owner. Do not perform an earlier takeover before this sequence.
2. After `run` or `prepare-failover`, have the parent **stop only `proxy`** using `stop-owner` and the launcher state. Keep MySQL, mock, SSO, Login, Console and `proxy2` running. A restart that immediately returns is not sufficient.
3. Within the snapshot's 600-second lease, run `node tests/docker-user-pool/mysql-smoke.mjs verify-failover /absolute/snapshot.json`.
4. Verification demands that Proxy 1 is actually unavailable, waits up to 45 seconds for a different live owner hash, checks renewed ownership, and serves the same persisted lease/credential through Proxy 2 without reprovisioning. No provisioning is attempted while the pinned callback target is down.
5. Have the parent `start-owner`; once both replicas are healthy, run `node tests/docker-user-pool/mysql-smoke.mjs verify-restart /absolute/snapshot.json`. The same mode can verify both replicas after `restart-replicas`.

Scheduler observation uses a **SELECT-only** `pool_observer` MySQL user and never steals/updates ownership. A singleton persisted owner plus stable renewal and exact side-effect counts is evidence of this scenario, not proof of all fencing failure modes. Named DDL-lock interleavings, stale checkpoints, database partitions and uncertain external side effects require the separate integration/worker suites. The observer cannot inspect credential-fence trigger definitions because it has no TRIGGER privilege; startup's migration marker is checked instead.

## Bounded 2,000-member HTTP load

Use a **new empty volume set and recreated mock processes**, not the smoke run's three-member inventory. This is an explicit opt-in, one-shot host Node test, not a server:

```sh
POOL_MYSQL_LOAD_CONFIRM=ghcp-user-pool-mysql-test node tests/docker-user-pool/mysql-load.mjs
```

Optional flags: `--concurrency=25 --iterations=2`. Concurrency is bounded to 1–100; defaults are 25 workers and two passes over 2,000 distinct callers (4,000 inference requests). Iterations are limited to 2–4; total measured HTTP requests, including management/catalog checks, stay below 10,000. No retries inflate the request count. Each caller's next pass uses the opposite replica. Requests alternate all three supported protocols, including streaming Responses, with a canonical known mock model.

The script has **no host, port, DB name or password override**: it connects only to `127.0.0.1:33184`, database `ghcp_pool_mysql_test`, checks the database's synthetic fixture marker and HTTP manifests, and requires the exact confirmation env value. `MYSQL_URL`, `MYSQL_TEST_URL` and deployment credentials are ignored. It does not truncate/delete anything and rejects nonempty inventory; reruns require a fresh project. A separate `pool_load` user has SELECT/INSERT/UPDATE on this database only, with no DDL or deletion permission.

Before seeding it pauses both workers through shared versioned settings and sets idle target zero. It inserts exactly 2,000 obviously synthetic READY credentials/inventory rows under the shared settings lock, then registers those synthetic token slots only in the mock adapter. This bypasses provisioning **only for the load corpus**; no SCIM/seat/Login calls should occur. The original `mock-services.mjs` continues handling the full real-worker smoke chain unchanged. The adapter has a fixed 20ms upstream delay to make persisted holds observable.

The load report includes actual HTTP phase wall time, successful requests/second, status/error counts, per-protocol JSON/SSE p50/p95/p99 latency, sampled SQL holds, and management-page latency. It verifies page 20 beyond the old 1,000-row cap, 2,000 active exclusive leases with unchanged caller/member assignments across replicas, unique upstream markers (no replay), caller/lease-attributed request statistics, no orphan/invalid-deadline holds and final hold drainage. Only numeric aggregates and fixed labels are printed. Failed runs print partial measurements with `passed: false`; seed time is never reported as inference throughput.

These results measure this machine, Docker, MySQL, pool transactions and tiny local synthetic responses—not real model latency, GitHub capacity or production throughput. The fixture deliberately does not promise a throughput threshold. Runtime validation is not implied by JavaScript/YAML syntax validation.

The [production review and remediation](../../docs/user-pool-mysql-production-review.md) records the original failures and 2026-09-14 fixes. Separate regressions cover simultaneous expiry, delayed SQL, terminal callbacks and UI ordering; normal-load success alone does not exercise these. The load now asserts exact account identities/ordinals 1900–1999 on page 20 and compares lease IDs with the same database ordering/offset. New `mysqlRecovery.integration.test.ts` uses the same disposable loopback gate for full 2,000-lease backlog drainage, held/busy-prefix fairness, no unnecessary replenishment and runtime-parser consistency. Customer infrastructure/SLO acceptance remains separate.

## Real-worker 0 → 2,000 provisioning

`mysql-provision-load.mjs` is **not** `mysql-load.mjs`: it never seeds READY inventory, registers synthetic credentials, modifies SQL, or calls account retry. It starts from zero and asks the real shared scheduler to provision all 2,000 members through actual SSO → mock SCIM/seat → queued mock Login callback → real Proxy catalog/warmup verification. Real Login remains running but empty; no real browser Login or external model is invoked.

Before running, the operator must prepare a **new empty MySQL/SSO/Login volume set and recreate the in-memory mock**. The runner rejects nonempty inventories, leases, request/catalog holds, cooldowns, identity initialization claims, request statistics and pool events; it never deletes/reset data to make the gate pass. The synthetic load adapter must be unregistered. Start with runtime idle target **zero**. Use the current provisioning fixture configuration with both proxies `PREWARM_CONCURRENCY=5`, `POOL_LOGIN_MAX_PENDING=5`, and the fast mock Login queue **concurrency 1, delay 50ms**. The report records the queue's actual configuration and enforces its concurrency and the pending reservation cap.

This runner requires the stability fixture's authenticated, fixed SSO runtime-settings bridge, `/test/counts` plus `loginQueue` diagnostics, and `stability-control.mjs` resource snapshots. It fails closed if these capabilities are absent. The SSO cap is read and printed before any mutation, then set to exactly 2,000 using supported `PATCH /api/settings/runtime` with `expectedVersion` and `changes.maxSsoUsers`. The current source default is **null/unlimited**, not an assumed 1,000; an existing image's configured 1,000 cap is detected rather than silently ignored. No SSO database edit or unsupported environment cap is used. Shared pool settings are changed through their versioned API to `idle_target=2000`, `max_accounts=2000`, `paused=0`.

On the isolated Azure **load VM**, after the operator has established the existing mysql-smoke loopback bridges and verified the fixed SSH forced-command key/host key, run the first pass **without fault injection**:

```sh
POOL_AZURE_SPLIT_FIXTURE=1 \
POOL_MYSQL_PROVISION_CONFIRM=ghcp-user-pool-mysql-test \
node tests/docker-user-pool/mysql-provision-load.mjs --members=2000
```

The exact confirmation value is mandatory. HTTP/MySQL targets, fixture marker, DB name and observer credentials are inherited from `mysql-smoke.mjs`; there are no target/credential overrides and no `.env` loading. In split mode resource snapshots and optional fault control go through the existing fixed `stability-control.mjs` SSH wrapper, not arbitrary SSH/Docker commands. Local mode addresses only that controller's fixed fixture containers. No service is launched by the runner. Do not run it against a deployment or alongside another test.

The bounded wait is two hours (plus bounded cleanup). It polls summary, counts-only mock status, SSO count and **SELECT-only** SQL every two seconds, emits safe progress every 30 seconds and collects fixed-controller container/MySQL metrics every 60 seconds. Only forward stage/count progress resets the 180-second stall timer; scheduler renewal does not. Any failed account, provisioning failure event, callback failure, SCIM conflict, duplicate/over-cap count, or no-progress interval fails the run; no blind retries conceal it. Response bodies are bounded while reading, including a 4MiB maximum for final `/test/state` (never fetched during progress polling).

Success requires all 2,000 inventory rows to be `ready`/stage `ready`, verified with nonempty valid OAuth credentials, unique identity/SSO/ordinal/task linkage, exact SSO/mock user and seat counts, exactly 2,000 Login tasks and successful callbacks, and one complete warmup per identity. Tokens and identities are checked in memory only, never written to reports; SQL returns a credential-valid boolean rather than token bytes. Both proxies' entire paginated inventory and **true page 20** are checked against SQL, rather than trusting the truncated legacy list. Finally two distinct callers each make one request through **each** proxy (four canaries), proving stable exclusive bindings, exact attributed statistics and hold drainage with no extra accounts. Their two leases are released through the supported API. The final pool has 2,000 ready idle members, no leases/holds and four preserved canary statistics.

For a **separate fresh run**, optional `--failover --failover-after=500` stops only Proxy 1 after at least 500 ready members, verifies a different live scheduler owner and additional READY progress **while Proxy 1 stays down**, then restores it. This needs the stability LB callback route (the base fixture pins callbacks to Proxy 1 and cannot prove live provisioning during its outage). It still demands zero conflicts/failures/duplicate side effects; interruption of an ambiguous stage may legitimately fail this strict test and is never automatically repaired. A fast run that finishes before the requested fault can be exercised is not a passing failover test. No MySQL pause is injected.

`--members=2..1999` is available only for smaller diagnostics; reports explicitly set `full2000: false`, and these runs are **not** 2,000-member evidence. Default is exactly 2,000. The printed `MYSQL_PROVISION_REPORT` points to a new host OS-temp directory containing `report.json` and `progress.jsonl`, created without overwriting existing files. They contain fixed labels and aggregate counts/timings/resources only, not tokens, passwords, identities, caller hashes, task records or raw transport/SQL errors. On success workers remain paused. On failure/interruption, the runner pauses shared workers and sets idle target zero before restoring any Proxy 1 it stopped; it does not resume provisioning, remove accounts, or restore a previous SSO cap below the new inventory. Cleanup failure is reported as failure, not hidden. Retain the isolated evidence and make an explicit operator decision before another fresh run.

Offline syntax validation only (no network, Docker or server startup):

```sh
node --check tests/docker-user-pool/mysql-provision-load.mjs
```

## Separate MySQL integration tests

Port 33184 is also available for a separately authorized integration run. The current integration suite requires a URL whose pathname begins `ghcp_pool_test_` and creates/drops a random sibling database; **do not change its safety gate to point at this harness's live pool database**. Use the synthetic root account only for that explicitly scoped suite (password is in `compose.mysql.yaml`, not runtime tenant state). The smoke/load observers never use root. Do not run the integration suite concurrently with measured load.

## Offline validation

`node --check` can validate all four `.mjs` files without opening sockets. Parse `compose.mysql.yaml` as YAML offline; Compose config validation requires a prepared temporary fixture directory. No smoke/load/launch network actions should be executed merely to check syntax.
