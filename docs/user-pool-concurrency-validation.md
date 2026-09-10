# Bounded concurrent prewarming — validation

Date: 2026-09-09. Branch: `ghcp-user-pool`. This supersedes the initial serial-worker behavior. No changes to customer/AKS environments or real GitHub accounts were made.

## Implemented behavior

- `PREWARM_CONCURRENCY=5` by default; valid range 1–20. It is a Proxy startup setting, not yet a Console-editable setting. Change the environment and recreate Proxy to apply it.
- One process owner, one scheduler, separate per-account controllers/promises. At most the configured number of asynchronous account stages run simultaneously; a single identity never has overlapping stages.
- A scheduling pass atomically reserves the entire deficit, bounded by total account cap and remaining name capacity. Queued/provisioning jobs and retryable failures (even during backoff) count as projected future supply. Reservations are persisted before side effects.
- Example: target 50, ready 30, no existing queued/retrying work: reserve 20 candidates and start up to 5 account stages. This is not 20 simultaneous browser sessions.
- Progressed stages become eligible for further work immediately; a free slot refills without waiting for another lane's slow request. Waiting stages persist their next poll time and release their slot. Wake storms do not bypass this delay.
- Pause prevents new dispatch, allowing already-running stages to settle. Shrinking target/cap never deletes pending accounts or seats; already-reserved jobs drain when unpaused. Idle may exceed a subsequently lowered target.
- All controllers abort on ownership loss/shutdown. Persisted intent/attempt and credential-generation fences remain in force; restart resumes each account's own checkpoint.

## Verification

- Full workspace typecheck passed.
- Full deployment build passed.
- Proxy suite: **154 passed, 0 failed, 1 MySQL integration test skipped**.
- Compose configuration tests: **3 passed**.
- Clean Proxy Docker build passed using the already-approved protected npm feed.
- Added nine real-SQLite concurrency tests: the 50/30/20 case; cap five under wake storms; immediate refill behind a slow lane; waiting-stage yield/poll bounds; backoff supply accounting; partial catalog exhaustion; selection fairness; pause/shrink; multi-lane ownership loss; and concurrent checkpoint restart (some behaviors share a test case).
- Separate actual Docker project `ghcp-user-pool-concurrent` with fresh volumes and local mocks reserved a **20-account deficit** immediately and completed **20 unique SCIM creations, 20 seat assignments, 20 OAuth callbacks**, with **peak concurrent HTTP stages exactly 5**. All 20 became ready, no failures or duplicate jobs.
- Production Console at `http://127.0.0.1:17404/#user-pool` showed 20/20 ready. Existing port-17304 test project was not replaced.
- Actual concurrent-project Proxy restart preserved settings, caller lease, credentials and all 20 inventory rows without repeated provisioning; the authenticated HTTP restart checks passed.

Run the fresh-project fixture with `tests/docker-user-pool/launch-concurrent.mjs`, then `node tests/docker-user-pool/concurrent-smoke.mjs`. The harness uses only synthetic credentials and local mocks; see [Docker harness](../tests/docker-user-pool/README.md).

## Login concurrency five — separate browser check

The concurrent test environment's actual Login service (`17403`, Console `17404`) was updated through its version-checked runtime API from concurrency 1 to **5** (settings version 2). Other settings were unchanged. A Login container restart preserved the value; the older `17303` test environment remains at 1. Console Settings displayed 5 after restart.

`tests/docker-user-pool/login-concurrency-smoke.mjs` executed inside the actual Login container using the compiled `LoginQueue` class and its persisted concurrency snapshot. It injected an in-memory task repository and local-page runner instead of the GitHub device-flow runner. Ten tasks ran through the queue in two batches, with five **separate real Chromium browser instances** simultaneously open per batch. Each filled/submitted a local page; all ten succeeded. Peak active tasks = 5, peak live browsers = 5; observed container memory at the batch checkpoints was approximately 513 MiB. That measurement is for trivial local pages, not a production GitHub browser memory estimate. No test tasks were persisted and no GitHub/OAuth calls were made.

Login regression suite also passed **7/7**, including dynamic queue-limit changes. This test verifies queue bounds and local browser capacity; it does **not** claim five real SAML/OAuth authorizations or the entire prewarm-to-real-Login chain passed. The pool harness still uses fake Login completion.

## Operational boundary

`PREWARM_CONCURRENCY` controls Proxy **stage concurrency**, not the number of pending Login tasks or running browsers. The Login service has its own runtime concurrency setting (default one); SCIM has its own request pacing and retries. Configure those capacities together. OAuth waits yield slots, so Login may accumulate more pending jobs than the prewarm concurrency value. The existing 15-minute Login task age guard includes queue time; very large deficits with slow login need appropriate Login capacity and monitoring.

The implementation remains single Proxy/SQLite; SSO does not need multiple replicas. No schema migration or new queue service is required: existing provisioning rows and `retry_at` persist the queue. Real tenant SAML/OAuth/SCIM and quota acceptance remain a separate release gate. No commit or push was performed.
