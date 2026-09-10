# User Pool — Local Validation Report

Date: 2026-09-09. Branch: `ghcp-user-pool`. Scope: Docker fork only; single Proxy process and SQLite. This report records the **initial local automated pass**, not production acceptance. **Follow-up Docker builds, container/wire tests and runtime results are recorded in [Docker validation](user-pool-docker-validation.md); they supersede the earlier Docker/LiteLLM blockers below.** No live tenant, GitHub, Azure or paid-seat operations were performed. Changes remain uncommitted; no push or customer deployment was performed.

## Delivered behavior

- Exact authenticated LiteLLM key hash (`sha256:<64 lowercase hex>`) maps to one exclusive GHCP member. No alias/email/team/session routing.
- New generation requests receive a five-minute provisional lease; completed successful generation promotes/renews a configurable TTL (48-hour default).
- In-flight holds, absolute deadlines, credential generations and owner fencing prevent stale completions or failed credentials from renewing/reassigning an active member.
- Catalog and token counting use request-scoped holds without creating/renewing caller leases.
- Serial prewarm maintains the configured ready-idle target and total account cap using 1,000 synthetic bases × ten suffixes. Stages include SSO, strict create-only SCIM, paid seat, Login callback and validated model output.
- Read-only SSO login-credential retrieval verifies the recorded user's creation time/email and never creates or resets users. SCIM conflicts cannot adopt existing GitHub identities.
- Console supports counts, settings/pause, reconciliation, member disable/retry/resume, confirmed lease release and bounded account/lease/event lists.
- Canonical Claude IDs and direct routing remain covered by regression tests. Warmup can select Messages, Chat Completions or Responses from live model capabilities.
- HTTP 429 keeps binding/cooldown and does not rotate accounts. HTTP 401 quarantines the selected member and returns failure **without automatic replay**.

## Executed checks

| Check | Result |
| --- | --- |
| Full workspace typecheck, including upgrade utilities | Passed |
| Full workspace production build | Passed |
| Proxy tests | 145 passed, 0 failed, 1 MySQL integration test skipped |
| SSO tests | 21 passed, 0 failed |
| Login tests | 7 passed, 0 failed |
| Console tests | 6 passed, 0 failed |
| Offline Console browser regression using installed Microsoft Edge | 1 passed, 0 failed |
| LiteLLM hook offline tests | 15 passed, 0 failed |
| Docker Compose rendering/contract tests | 3 passed, 0 failed |
| Real LiteLLM runtime tests | 5 skipped; pinned dependency unavailable |
| Whitespace validation | Passed |
| Changed/new deliverable scan for known customer identifiers, credential literals and private endpoints | No matches; heuristic scan, not a secret-scanner certification |

**Total: 198 passed, 0 failed, 6 skipped.** Core SQLite tests use real parallel database connections; browser tests intercept network requests locally. Runtime dependency installation was blocked by package-feed/TLS access. No bypass of TLS verification was used.

## Integrated mock lifecycle

`src/proxy/src/userPool/e2e.test.ts` uses the actual SQLite pool store, actual prewarm worker/provisioner and actual Express inference path with fake SSO/Login/Copilot responses:

1. Start with empty inventory and idle target two.
2. Create two synthetic SSO users; strictly create EMU identities; assign mock seats; execute mock Login callbacks; validate model output.
3. Confirm two ready-idle members.
4. Send requests for two different hashes; confirm exclusive members, stable repeat mapping and canonical model IDs.
5. Reconcile until two additional idle members are ready while the first two remain leased.
6. Advance the test clock beyond the active TTL; reclaim leases and reuse an existing member for a third caller without increasing total inventory.

This proves local orchestration and state integration. It does not exercise real SAML/Playwright, GitHub propagation or provider policies.

## Known release gates and limits

- Docker Desktop's Linux engine was not running (`dockerDesktopLinuxEngine` named pipe absent). Compose rendering passed, but **image builds and container startup smoke were not run**.
- The LiteLLM hook was source-inspected against 1.81.14 and offline-tested. Real installed-LiteLLM callback/Router tests and final HTTP-wire tests remain unverified. The initial supported integration contract is async Proxy/Router chat completion; native Messages/Responses gateway adapters are not certified.
- Real SAML, SCIM propagation, entitlement, OAuth and upstream model calls require separately authorized tenant acceptance.
- One Proxy process and SQLite only. Multiple replicas/MySQL pool mode are unsupported.
- Console loads at most 1,000 accounts, 1,000 leases and 200 recent events. Its filtering/pagination applies to loaded rows only.
- No same-request 401 replacement/replay is implemented; another caller request may select a ready member after the quarantined member's holds drain.
- Ambiguous non-idempotent external operations stop for reconciliation after bounded retries. Account/seat deletion and automatic shrinking are intentionally absent.
- Default-password policy is unchanged. Existing custom passwords that cannot be retrieved are rejected, not reset.
- Proxy, SSO and Console must be rebuilt from this branch together because prewarm uses the new authenticated SSO safety endpoints.

See [design](user-pool-design.md), [setup and operations](user-pool-implementation.md), and [LiteLLM integration](user-pool-litellm.md).
