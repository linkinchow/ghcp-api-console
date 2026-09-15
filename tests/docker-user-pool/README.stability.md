# Isolated MySQL stability qualification

This fixture extends the two-Proxy test stack with an actual **HAProxy** and optionally a fixed **LiteLLM v1.99.1 + PostgreSQL** gateway. All provider URLs remain on the internal Docker network; nothing here is a customer deployment or authorization for real seats/models.

## Existing verified candidate

See [review/remediation](../../docs/user-pool-mysql-production-review.md) and [validation](../../docs/user-pool-mysql-validation.md) for the frozen production-fix images and earlier 2,000-member results. The additional work follows the [stability plan](../../docs/user-pool-mysql-stability-plan.md).

Upstream's MySQL support supplies shared storage for multiple Proxy replicas, not a concrete LB deployment. This HAProxy is a new **test fixture**. The production overlay still accepts an operator-provided trusted LB; the operator template is optional, not an inherited upstream service.

## Safe startup

Prepare the ordinary MySQL fixture with `launch-mysql.mjs prepare`, retaining its printed state path. Start only via preview tools, using `launch-stability.mjs up --state=<that run.json> --set=stability-<unique-name> --profile=base`. Never use a deployment env or old live volumes. New sets preserve earlier data/evidence. `start` reuses containers; `up` force-recreates them, including mock memory. `config` is silent configuration validation; `stop-bridge` frees only the fixed test ingress ports.

Combine `compose.mysql.yaml` then `compose.stability.yaml`. Both Proxy images and Console use the reviewed `production-fix` tags; record their digests before each run. HAProxy uses a pinned digest. App/MySQL/mock/LB/gateway/Postgres use only the internal network; the fixed bridge alone also has a preview network and publishes loopback ports. There is no Docker socket or arbitrary forwarding endpoint.

Resource ceilings: each Proxy 2 CPUs/1 GiB; MySQL 3 CPUs/3 GiB; mock 1 CPU/512 MiB; HAProxy 1 CPU/256 MiB; optional LiteLLM 2 CPUs/2 GiB and gateway Postgres 1 CPU/1 GiB. These are test ceilings on a shared host, not reserved cores or production sizing recommendations.

| Port | Purpose |
| --- | --- |
| 18100 / 18101 | Direct Proxy diagnostics/assertions |
| 18102 | Mock and authenticated read-only SSO/Login inspection |
| 18103 | Actual LiteLLM HTTP gateway (gateway profile) |
| 18104 | Actual Console |
| 18105 / 18106 | HAProxy business / authenticated internal paths |
| 18107 | Read-only HAProxy statistics |
| 33184 | Fixed TCP bridge to test MySQL |

HAProxy uses round-robin and `/readyz`; failed backends are removed after two checks and require two successful checks to return. Health detection is not instantaneous. It has `retries 0`, no redispatch and no session affinity. Separate path ACLs are not authentication: Proxy still checks its API/internal tokens. The fixture adds `X-Fixture-Backend` for test proof only. All internal service roots, including mock OAuth completion, use `http://pool-lb:8081`.

## Functional and gateway sequence

1. Wait for app/DB readiness, then run existing `mysql-smoke.mjs run` on an empty set. It provisions exactly three synthetic accounts through the real worker/SSO and mocked external chain.
2. Run `mysql-lb-smoke.mjs`. It validates ACLs, stops the first test Proxy, waits for actual LB health removal, uses the survivor, creates a fourth synthetic member through the surviving callback path, then restores and observes both backends. Cleanup restores the stopped Proxy. An already elected second-Proxy scheduler is valid; do not require owner UUID change when stopping a nonowner.
3. For gateway qualification, start the same fixture with `--profile=gateway` and `start`, not force-recreate. Wait for LiteLLM migrations/readiness. Release only drained synthetic fixture leases and keep prewarming paused with at least three ready-idle members. Run `litellm-mysql-smoke.mjs --confirm-local-fixture` exclusively, without concurrent business/Console polling through the LB. It creates actual internal-user DB virtual keys via supported HTTP APIs, verifies auth/spoofing/revocation/fallback, and revokes its keys in cleanup. See [gateway notes](litellm-mysql-notes.md). PostgreSQL is only LiteLLM's test database, not a new pool backend.

## Bounded soak

`mysql-soak.mjs --seconds=1800 --concurrency=6` requires `POOL_MYSQL_SOAK_CONFIRM=ghcp-user-pool-mysql-test`. It accepts the verified three/four-member setup or a previously qualified twelve-member synthetic fixture, drains prior requests and releases only fixture leases, then uses twelve real mock-provisioned members. It sets TTL60 for natural expiry and target0 after initial warmup; worker stays active for one controlled401 repair. It does not seed SQL or provision real accounts.

The runner mixes JSON/SSE, successful2–20s delayed streams, cancellation,10s429cooling with strict binding checks, one401repair of the original member, and an inactive caller's natural expiry. Caller/member continuity is checked against the same unexpired lease epoch; a correctly expired or401-invalidated lease may later allocate another member and is not mislabeled sharing. Markers establish no HTTP replay and correlate every mock inference. Maximum10,000requests and duration60–3600seconds plus bounded setup/drain;60seconds is debugging, not30-minute acceptance.

At about one-third of traffic duration the fixed controller stops Proxy1 for35seconds, then restores it; around two-thirds it pauses MySQL for12seconds then unpauses. Faults are serialized and cleanup restores resources. Network/502/503/504/incomplete stream outcomes count as expected only within explicit fault/recovery windows; other errors fail. Infrastructure outage tests do not promise already-running streams survive.

The cooldown baseline waits for the caller's previous hold to drain before reading lease timestamps. The ten-second injected interval is distinct from product defaults; the immediate probe must still observe a live database cooldown, so a delayed probe after expiry cannot be called a product failure. Unexpected responses retain sanitized error codes for diagnosis. Failures outside explicit fault windows remain failures.

`stability-control.mjs` only accepts `stop-proxy`, `start-proxy`, `pause-mysql`, `unpause-mysql`, `snapshot`. It inspects fixed project/service labels before actions. Snapshot returns fixed-service aggregate CPU/memory/pids and MySQL connection counters, never credentials. Do not reuse this against any other project. No Docker command is accepted from HTTP.

Run long tests via a preview-owned process or another approved supervisor with a timeout exceeding the runner's bound. A terminal tool's ten-minute command limit cannot certify30minutes. JSONL progress and final JSON are created under a new OS temp directory; preserve failures, stop/recovery reasons, resources and reported actual traffic duration. Never count an interrupted pilot as a completed soak. No builds or unrelated load during measurements.

## Offline migration rehearsal

`mysql-rehearsal.mjs generate` uses current schemas to produce standalone readonly synthetic SQLite, state and a narrowly scoped Compose override in a new `ghcp-mysql-rehearsal-*` directory. `preflight --state=...` is source-only. `import` and `verify` require `POOL_MYSQL_REHEARSAL_CONFIRM=ghcp-user-pool-mysql-test`.

Import first verifies the original control DB marker at loopback33184, creates a random `ghcp_pool_test_rehearsal_<uuid>` target, and runs the unchanged importer. Never add a fixture marker to the import target; the importer correctly refuses unknown tables. The generated override changes both Proxy MYSQL_URLs and the bridge's explicit rehearsal manifest, and gives SSO/Login/Console auxiliary volumes unique rehearsal names so previous synthetic users do not contaminate the freshness assertions. It deliberately leaves the MySQL volume unchanged. Start it through the preview launcher with `--rehearsal=<generated compose.rehearsal.yaml>` only after the soak is finished. Recreate mock memory, preserve the existing MySQL volume/target, and keep imported settings paused.

`verify` registers the existing load adapter's synthetic tokens (only three corresponding credentials exist in the imported DB), checks two retained leases through both direct replicas/LB, executes twelve JSON/SSE requests without reprovisioning, verifies source bytes unchanged and statistics retention106→103 after startup→109 after requests. Regenerate immediately before import: source leases last3600seconds, and the helper rejects ≤120seconds remaining. This tests synthetic migration, not a customer's backup or external provisioning state.

## Additional lifecycle and failure-boundary runners

See the [extended report](../../docs/user-pool-extended-test-report.md) for actual outcomes and candidate digests; preparation or syntax checks are not passes.

- `mysql-lifecycle.mjs`: exact `POOL_MYSQL_LIFECYCLE_CONFIRM=ghcp-user-pool-mysql-test`, empty fixture only. Real worker growth 8→14→20→26→32 under traffic, settings/cap/pause/disable/retry, held release, full-pool401 repair, and distinct post-repair lease epochs. SELECT-only observer; no Ready seed; bounded ten-minute run. Old lease IDs are deliberately expired by401, not preserved forever.
- `mysql-contention.mjs`: exact `POOL_MYSQL_CONTENTION_CONFIRM`, paused mock-provisioned Ready fixture. Two-replica hot-caller requests, named-lock contention and cancellation, SQL deadline plus delayed cleanup/quiet-window checks. Other callers may share pool exhaustion; their latency/errors are reported rather than hidden.
- `mysql-restart.mjs`: exact `POOL_MYSQL_RESTART_CONFIRM`, service-VM-only fixed labelled MySQL container. Real SSE before a35-second database stop/start; preserves the volume, checks owner/lease/settings and no Proxy restart. It exposes no arbitrary target/control and restores MySQL on failure. Reports include synthetic per-request diagnostics and belong in private test evidence, not public logs.
- `mysql-failover-recovery.mjs` is a retained-failure diagnostic, not an empty-start benchmark: an acknowledged failed Login task can have one new nonce; same-nonce dispatch cannot repeat. Preserve the original strict failed run. It is not a migration or real-account recovery tool.

The HTTP bridge must propagate **response** aborted/error/incomplete-close after headers; plain `pipe()` does not do this. `mysql-bridge.test.mjs` runs real local HTTP normal-EOF and truncated-response regressions against the forwarder's actual source. Do not turn a truncated stream into clean EOF to make a fault test pass.

## Results discipline

Record actual outcomes separately from this procedure. A passing short load, gate test, or node syntax check is not a soak or migration-runtime pass. Representative customer resources/SLO, remote TLS, DB primary failover/HA, backups and real-tenant authorization remain separate release gates.
