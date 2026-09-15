# v5 SIGSTOP/SIGCONT owner-expiry process acceptance

TEST ONLY. Source baseline is exactly `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`
(parent branch `ghcp-user-pool-resilience-tests`). The isolated implementation checkout
was verified clean at that HEAD before adding these files. `suspend-run.mjs` rejects
another HEAD or changes to production/reused helper sources. Existing `worker-*`
helpers are read/reused, never modified; **the frozen-v4 worker launcher remains
unchanged** and is not the entry point for this test.

## Commands

Run from a checkout at the exact baseline with these new test files overlaid and
Node 22+, workspace dependencies (including `tsx`, `typescript`, `mysql2`) already
available. Do not load dotenv, supply NODE_OPTIONS, or use real service credentials.

```sh
node tests/user-pool-process/suspend-run.mjs --typecheck
node tests/user-pool-process/suspend-run.mjs --gate-check
```

Actual acceptance is **Linux only**, with procfs available to verify kernel state `T`.
Windows cannot perform this test; neither typecheck nor offline guards imply a
SIGSTOP/MySQL pass. On Linux, provision the disposable local MySQL separately and
export only these explicit opt-ins using synthetic, disposable credentials:

```sh
export MYSQL_POOL_SUSPEND_TEST=1
export MYSQL_POOL_PROCESS_TEST=1
export MYSQL_POOL_TEST_DISPOSABLE=1
export MYSQL_TEST_URL='mysql://root:DISPOSABLE_TEST_PASSWORD@127.0.0.1:3306/ghcp_pool_test_marker'
node tests/user-pool-process/suspend-run.mjs --run
```

The URL is read from environment, never child arguments or printed. The account
must be `root`, scheme `mysql:`, hostname literal loopback (`localhost`, `127.0.0.1`,
`[::1]`), database marker `ghcp_pool_test_[a-z0-9_]+`, no options or fragments.
Only a random sibling `ghcp_pool_test_<32 hex>` is created/migrated/dropped; the
marker database is never opened. Use an actually disposable local instance, not a
port-forward/tunnel to a real service. This harness does not start MySQL, Docker,
Azure, or any real provider. Expected runtime **35–90 seconds**, including a real
30-second owner lease expiry; bounded test timeout 140s, launcher watchdog 160s.

## Evidence and assertions

1. Parent seeds one synthetic synced account, then makes only bounded SELECTs
   until cleanup DROP. Two IPC children construct the real MySQL store,
   `PrewarmWorker` (multi-replica), and `realProvisioner`. Only the account-read
   dependency is wired to the child's MySQL storage; the fetch wrapper counts and
   delegates actual HTTP. Existing `WorkerMock` listens at a dynamic loopback port,
   retains task state outside both children, and does not deduplicate POSTs.
2. Old worker performs exactly one Login POST. A test-only barrier intercepts its
   resulting `oauth-wait` checkpoint immediately before the real store update,
   outside any SQL transaction/lock. Parent sends actual `SIGSTOP` and confirms
   `/proc/<child pid>/stat` is `T`. Owner row still has 25–30s of the production 30s
   lease. No fake clock, direct owner mutation, shortened lease, or worker stop.
3. Successor first reports standby, then claims a distinct UUID only after natural
   DB expiry. DB time and elapsed wall time are recorded. It searches and finds
   the original task/nonce, and is held at its own checkpoint. The inventory stays
   **exactly the original row**, making owner the only mismatching fence.
4. Parent sends `SIGCONT`. The old worker's original retained call invokes the
   **real SQL-backed store update** with its original row fence/old owner. It must
   return false, with exact inventory and credentials unchanged. This exercises
   the storage transaction's owner rejection, not a fake store return and not
   merely a rejection caused by a successor changing the row generation/stage.
   Snapshot diagnostics must report `local_tenure_expired`, one acquisition,
   one loss, inactive/standby. Retained context assertion/checkpoint calls must
   reject without reaching another store update or HTTP operation.
5. Release successor checkpoint; it succeeds. The successor performs a synthetic
   repository OAuth callback with the original nonce (not HTTP callback route
   acceptance). Parent marks the mock task successful; successor performs real
   model lookup/warmup and reaches ready with original attempt/task/nonce. Exactly
   one Login POST, one credential-reset request, one model GET, one warmup POST.
   Old process stays alive in standby through additional scheduling cycles, with
   no extra steps, provider HTTP, checkpoint calls or ownership acquisitions.

TAP diagnostics include baseline, sibling, PIDs, both owner UUIDs, expiry/claim
DB timestamps, wall wait, retained SQL result, local-loss snapshot, synthetic
nonce/task ID and counts. They do not include credentials or MySQL URLs.

## Lifetime and cleanup

Fresh allowlisted child environments discard inherited provider secrets, proxy
variables and NODE_OPTIONS; dotenv path is the null device before production
imports. Mock origins are fixed to the dynamically assigned loopback listener.
Connection/query deadlines, bounded observations, child lifetime timers and a
**parent-side watchdog that still runs during SIGSTOP** bound the fixture.
Cleanup always sends SIGCONT before terminating each owned ChildProcess and awaits
its real exit event before DROP. No process-group kill, PID discovery/kill,
`pkill`, `taskkill`, or global reset. Interrupt handlers perform the same cleanup.
Failure to confirm child exit refuses DROP and reports the sibling for inspection.
As with any process harness, SIGKILL of the entire parent or machine loss cannot
run its cleanup handlers; inspect the reported disposable sibling in that case.

## Local test report

Implementation platform: Windows 11. Executed local checks:

- `--typecheck`: PASS (after correcting a test-only assertion-narrowing error in
  the initial run); final noEmit check has no diagnostics.
- `--gate-check`: PASS, 4 offline checks, 0 failures, 1 intentional live-acceptance
  skip. Verifies strict gates, environment/sibling isolation, safe refusal before
  loader/network, exact v5 baseline and unchanged frozen-v4 launcher.
- Scope check: exactly these six new files; no tracked-file changes.

Actual Linux SIGSTOP/TTL/MySQL acceptance was not run by the Windows implementer. The parent subsequently executed it on the approved isolated Linux/MySQL host: **1 passed, 0 failed, 0 skipped**, 34.808 seconds. Natural takeover consumed 30.092 seconds; the retained old SQL checkpoint returned false with the same row fence and unchanged data. Original Login POST count was one, warmup count one, final state Ready. Production source remained exactly v5.

Execution log SHA-256: `30f2cf6e424eabe854e04e3a05c498c35b459da5cee6c9a7731e7f7397df9766`. See [the bounded resilience report](../../docs/user-pool-v5-resilience-tests.md). Offline gates and the Linux acceptance result are separate counts.
