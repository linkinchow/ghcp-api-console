# Real local gateway smoke scenarios

## Scope and safety

`gateway-smoke.mjs` is a standalone Node **22+** runner using only built-in modules and `fetch`. It tests **real inbound LiteLLM HTTP authentication and virtual-key management backed by its database**, then real Proxy/SSO pool behavior against the local SCIM, seat, OAuth-callback, model-discovery, and inference fixture. It does not instantiate fake `UserAPIKeyAuth` objects or inject hashes directly into gateway inference requests.

The runner does **not** start Docker, change Compose/hook/product code, call external model APIs, access Postgres directly, or enqueue/cancel/retry real Login tasks. Real Login, SSO, and Console are read-only from the runner. Pool-worker requests must use the **mock** Login endpoint. `--confirm-local-fixture` is mandatory. Without it, the runner performs no HTTP requests and writes no report.

All six runner destinations must be distinct literal loopback HTTP origins (`127.0.0.1` or `[::1]`); URLs with credentials, paths, queries, fragments, non-loopback hosts, and redirects are rejected. This is a client safeguard, **not proof of container egress isolation**. The externally prepared Docker stack must have mock-only networking. Never point these ports at forwarded production services. Use fresh, disposable volumes and no concurrent tests.

Default origins:

| Service | Origin | Runner activity |
|---|---|---|
| LiteLLM | `http://127.0.0.1:17505` | Readiness, catalog auth, real key CRUD, inference |
| Proxy | `http://127.0.0.1:17500` | Readiness, inventory/catalog, versioned pool settings, reconcile, owned-lease release |
| SSO | `http://127.0.0.1:17501` | Health and empty initial user list |
| Mock | `http://127.0.0.1:17502` | Health and authenticated `/test/state` reads only |
| Real Login | `http://127.0.0.1:17503` | Health and authenticated task list; must stay completely empty |
| Console | `http://127.0.0.1:17504` | Health only; no admin creation/login required |

## Commands and preparation contract

Prepare/start the stack **separately**. Run from the repository into which these two files were copied:

```sh
node --check tests/docker-user-pool/gateway-smoke.mjs
node tests/docker-user-pool/gateway-smoke.mjs --help
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture
```

A separate fresh-stack run can exercise live replenishment racing the first burst:

```sh
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture --pressure-mode live
```

Required stack configuration:

- Real LiteLLM and a connected Postgres database. `/health/readiness` must return HTTP 200 and `db: "connected"`.
- GHCP model group `claude-opus-5`, deployment provider `anthropic/claude-opus-5`, root `api_base: http://proxy:3000`, separate Proxy service key, and the identity callback configured for that exact base.
- Disable inference response caches, retries/fallbacks on the main group, and conflicting identity/URL callbacks. Primary success calls must produce **exactly one** marked mock inference each. Do not enable per-key/request endpoint or credential overrides.
- Proxy in `caller-lease` mode with initial `READY_IDLE_TARGET=0`, empty inventory, and no leases. SSO and mock must also be empty. The runner sets `idle_target=5`, `max_accounts=20`, `lease_seconds=3600`, and later toggles `paused`. The long TTL intentionally excludes lease expiration from pressure results; the overall active test deadline is 15 minutes.
- Mock advertises both raw `claude-opus-5` and legacy raw `claude-opus-5.2`, accepts the former for inference, returns `OK`, and preserves `POOL_TEST:{"id":"..."}` request markers. Proxy catalog must include `claude-opus-5` and canonical legacy `claude-opus-5-2`, not raw `claude-opus-5.2`.
- Mock stage delay around **150 ms** for SCIM/seats helps observe worker concurrency. Correctness depends on observed state/counters, not on a presumed exact delay, exact concurrency peak, or timed sleep.
- Real Login must have **zero tasks** throughout. Proxy's pool-worker Login base must target the mock.
- Existing target-repository `.gitignore` pattern `/tests/docker-user-pool/local-*.json` covers the report. The isolated authoring worktree may not have that uncommitted ignore rule: copy into the shared target before executing, or have the coordinating owner ensure the report is ignored. This implementation does not edit `.gitignore`.

Secrets are read only from environment variables, not CLI arguments:

| Variable | Local-test default |
|---|---|
| `GATEWAY_MASTER_KEY` | `sk-local-gateway-master-test-only` |
| `GATEWAY_PROXY_KEY` | `local-pool-proxy-test-only` |
| `GATEWAY_INTERNAL_TOKEN` | `local-pool-internal-test-only` |

Nonsecret CLI flags also accept `GATEWAY_<UPPER_SNAKE_CASE_FLAG>`, e.g. `GATEWAY_LITELLM_URL`, `GATEWAY_WAIT_MS`. CLI values win. Supported knobs are listed by `--help`; key ones are `--initial-idle`, `--cap`, `--burst`, `--wait-ms`, `--request-ms`, `--poll-ms`, `--retry-rounds`, and `--pressure-mode paused|live`. Require `initial-idle >= 4`, `initial-idle < cap`, and `burst == cap`. Four is the minimum to leave idle supply available after three functional callers for meaningful invalid/revoked-key tests. Defaults remain five/twenty/twenty.

Model coordination uses explicit flags, never invented deployment names:

```sh
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture \
  --model claude-opus-5 --raw-model claude-opus-5 \
  --legacy-model claude-opus-5-2 --legacy-raw-model claude-opus-5.2
```

- `--other-only-model <configured-other-group>` creates a key whose allowed models contain **only** that group, then asserts both GHCP ingress protocols reject it before any lease/upstream use. It does not claim the other provider's inference or outbound-header lifecycle is validated.
- `--fallback-model <configured-fallback-into-ghcp-group>` grants an existing key access and requests that group via Chat, then checks the final GHCP attempt uses the same trusted hash/member. The fixture must guarantee deterministic primary failure followed by GHCP. This test proves final GHCP identity, **not by itself proof of the first leg's failure**; primary-provider fixture counters need a separately agreed contract before expanding that assertion.
- Without either option, its scenario is explicitly `SKIP`, not an implied pass. There is no fallback-out-to-other-provider certification in this runner.

## Implemented scenarios and acceptance criteria

### 1. Local fixture and key-management contracts

1. Condition-poll health/readiness; assert connected database, `fixture: true`, empty Proxy inventory/leases, empty SSO users, empty mock users/seats/tasks/inference, no pending fault control, and zero real Login tasks. Refuse dirty state instead of resetting it.
2. PATCH pool settings with the current `expectedVersion`. Assert version increments and every setting echoes correctly. Poll until exactly the configured idle target is fully ready, verified, OAuth-valid, and no longer provisioning; pause replenishment before functional cases.
3. Check one SCIM create, seat assignment, mocked OAuth task, and successful callback per inventory account; zero SCIM conflicts/updates/deletes and zero failed callbacks. Check unique mock usernames/tasks, model discovery, seats, and exact correspondence to Proxy member identities.
4. Generate individual keys through master-authenticated `POST /key/generate` with `key_alias`, `models`, `duration: "2h"`, and test metadata **without `ghcp_identity`**. Require distinct returned raw keys. Compute `sha256:` plus lowercase SHA256 over the exact UTF-8 raw key. If a returned `token` exists, require the expected DB hash.
5. Read each key through master-authenticated `GET /key/info?key=<hash>`; no raw key is placed in query strings/access logs. Require stored alias/model permissions/test metadata and absence of `ghcp_identity` except in its explicit poisoning case.
6. Attempt duplicate `key_alias` via real `/key/generate`. If allowed, both keys must get separate callers/members. If stock LiteLLM rejects duplicates with a recognizable HTTP 400/409 alias-uniqueness error, record the observed rejection as a pass and **the required same-alias isolation case as `BLOCKED`**. Continue independent cases with a uniquely aliased second key. Never edit Postgres, alter aliases through undocumented paths, or mislabel distinct-alias results as same-alias validation.

### 2. Protocol and dynamic lease behavior

7. Direct authenticated Proxy catalog discovery with a legitimate caller hash must show current and canonical legacy model IDs **without creating a lease**. Inference itself still goes exclusively through LiteLLM.
8. Use the first real virtual key for `/v1/messages` JSON and SSE with `x-api-key`, repeat both with Bearer, then `/v1/chat/completions` JSON and SSE with Bearer: **six required combinations**, `max_tokens: 16` on every inference.
9. JSON requires the appropriate Messages/Chat envelope, nonempty model, `OK`, and termination reason. SSE is fully read under a bounded deadline and size limit; parse frames, require start/terminal Messages events or Chat finish reason plus `[DONE]`, concatenate text deltas, and reject any in-band error even on HTTP 200. Legacy raw model spelling must not leak back.
10. After every successful request, wait for holds to drain; require exactly one active lease under `sha256(raw-key)`, valid renewal timestamps, and a matching account DTO. The mock's marked request must match that lease's member, expected raw model, streaming mode, status 200, and complete outcome. Normal requests must appear exactly once, detecting accidental inference replay.
11. Send eight simultaneous requests for the same key, mixing both routes and streaming modes. All must retain the first member and lease ID. A second distinct key's **first allocation** includes a forged victim HTTP and body header, yet must select its own distinct member.
12. Rename the first key with `POST /key/update {key, key_alias}`; require persisted renamed alias and stable exact raw-key hash, member, and lease ID on subsequent inference.

### 3. Identity and authentication attacks

13. Generate a third key with stored `metadata.ghcp_identity` pointing at the victim member. Its first request must still lease by its own exact raw-key hash, never the victim. Read the DB metadata to prove the poisoning setup actually persisted.
14. On both Messages and Chat, test each forgery location independently: inbound `X-User-Identity`, case-varied body `headers`, `extra_headers`, `default_headers`, nested `extra_body`, `metadata`, `litellm_metadata`, `litellm_params`/`optional_params`, `provider_specific_header`, and `proxy_server_request`. Include forged hash, alias, and `user_api_key_dict` token/hashed-token data in metadata. Expect successful inference under the trusted key mapping; a silently ignored attack is safe, an adapter error is a reported failed coverage case, and a changed member/hash is a failure. These tests do not try URL or credential override attacks that could escape the fixture.
15. Send an unissued key using Messages x-api-key/Bearer and Chat Bearer while replenishment is paused and idle capacity remains. Require 401/403, byte-for-byte stable lease identity/renewal snapshot, unchanged idle and total counts, and zero new mock inference.
16. Generate a valid unused key, authenticate it via `/v1/models` to prime the gateway cache without acquiring a lease, then revoke by `POST /key/delete {keys:[<hash>]}`. Require the response confirms deletion. Repeat the three rejection calls immediately—do not poll until revocation eventually succeeds. Assert no allocation or upstream dispatch.
17. Revoke a **previously used** key and repeat rejection checks. Its existing Proxy lease may remain until expiry/manual release; it must not be used or renewed. This distinguishes gateway key revocation from Proxy lease reclamation.
18. If an explicit other-only group is supplied, run the same no-consumption assertions for a model-restricted real key denied access to GHCP.
19. If an explicit fallback group is supplied, verify the same hash/member on its final GHCP leg, with the limitation noted above.

### 4. Fair distinct-key pressure and refill

20. Keep the worker paused, drain all requests, release **only this run's functional leases**, and revoke functional keys by their hashes. Require the original five ready-idle accounts and no leases before pressure. Do not let setup callers steal burst capacity or increase the cap to hide that problem.
21. Generate **twenty new distinct DB-backed virtual keys**, each without identity metadata. Start their inference fetches in one `Promise.allSettled` wave; mix Messages/Chat and JSON/SSE. No SDK or runner inference retries are hidden in this wave.
22. Default paused case: require exactly five successful distinct callers and fifteen exhausted callers, with no provisioning during the burst. Do **not** require every exhausted HTTP response to be exactly 429: LiteLLM may translate transport status. A candidate must be a non-2xx containing the known `pool_exhausted` code, have no lease, and have no mock marker. Report the observed status histogram. Unknown authentication/adapter/rate-limit/transport errors are failures, not retryable exhaustion.
23. Live first-burst mode: allow provisioning to finish during requests. Require successes no greater than initial idle supply **plus newly verified ready members observed by the end**. Assert uniqueness and cap throughout sampled inventories. Do not claim an exact fifteen rejections when the worker can race ahead.
24. Unpause the worker and poll actual ready-idle inventory **without sending inference** until the target is restored or physically available remaining capacity is ready. Verify provisioning drains. This demonstrates autonomous refill rather than request-triggered provisioning.
25. Retry only the keys previously confirmed exhausted; never resend a successful key to improve counts. Each retry wave is simultaneous, finite (`--retry-rounds`, default 20), rechecked against exact leases/mock identities, and may again yield measured exhaustion. No arbitrary status or transport failure is retried.
26. Require eventual successful mappings for all twenty keys, exactly twenty distinct active leases and members, zero provisional/failed/provisioning entries, and `total <= cap` on every overview observation. Save pseudonymous key-label/hash/member/lease mappings, wave counts/statuses, and maximum observed total. At twenty active callers and cap twenty, idle zero is correct—not a refill failure.
27. Generate a twenty-first real key and require confirmed exhaustion with no upstream request or account increase. Reconcile once at cap and recheck provisioning counters; the runner does not relax the cap.
28. Release five owned pressure leases. Require five ready-idle accounts restored at the same total cap, retained keys' mappings unchanged, and no new SCIM/seat/OAuth provisioning. This is capacity reuse, separately labeled from autonomous creation in step 24.
29. Assert final mock counters/uniqueness, no raw keys or OAuth tokens in the Proxy inventory or mock state, and zero real Login tasks.

## Output, failure behavior, and teardown

- Console lines have `PASS`, `FAIL`, `BLOCKED`, `SKIP`, and numeric-only `OBSERVED` burst histograms. All API bodies, prompts, headers, cookies, and arbitrary remote error text stay unprinted.
- `tests/docker-user-pool/local-gateway-results.json` is written beside the script with mode `0600` where supported. It contains labels, durations, explicit limitations, safe counts/statuses, bounded observations, and pseudonymous lease mappings—**never raw virtual keys, service credentials, or response bodies**. Every acquired raw key is registered with the redactor. Hashes are sensitive pseudonymous IDs even though they cannot directly authenticate.
- Runtime failures produce a structured report and still attempt to pause the disposable worker and revoke every known generated key. Dependent phases stop after critical contract failures; other independent functional attacks continue to expose multiple failures. No catch block interpolates arbitrary fetch/error bodies.
- Exit code **0** means all required scenarios passed; **1** means at least one failure; **2** means a required case is blocked (currently duplicate-alias prohibition) with no other failures. Optional missing groups are explicit skips and do not cause failure.
- Cleanup does not destroy accounts/SSO users, operate Docker, or release unknown callers. It pauses provisioning, revokes owned keys, and checks real Login again. Successful pressure accounts and remaining lease evidence are deliberately left for inspection; externally destroy disposable volumes before another run. A dirty rerun is rejected.
- Request bodies including SSE are bounded at 4 MiB and `--request-ms`; readiness/refill/hold waits are condition-based with deadlines. SIGINT/SIGTERM and the 15-minute active-run deadline abort fetches and proceed to bounded cleanup. Raw response errors are never printed. SIGKILL/process crash cannot guarantee cleanup; destroy the disposable environment externally.

## Verified source contracts and gaps to coordinate

### Current Proxy and fixture source

- `src/proxy/src/routes/userPoolApi.ts`: GET `/api/user-pool` fields `enabled`, `poolId`, `settings`, `counts`, `accounts`, `leases`, `events`; PATCH `/settings` body `{expectedVersion,changes}`; paused is numeric 0/1; POST `/leases/:leaseId/release` requires `{confirm:true}`; POST `/reconcile` uses `{}` and returns 202.
- Counts used are `total`, `ready_idle`, `leased`, `provisional`, `provisioning`, `cooling`, `failed`, `disabled`. Account fields include `identity`, `ordinal`, `state`, `ghLogin`, `oauthStatus`, `verifiedAt`, `callerKeyHash`, `leasePhase`, and `activeRequests`. Lease fields include `leaseId`, `memberIdentity`, `callerKeyHash`, `phase`, `lastSuccessAt`, `expiresAt`, and `inUse`.
- `tests/docker-user-pool/mock-services.mjs`: `/test/state` needs `X-Internal-Token`; counters, inference `marker/identity/model/status/stream/outcome`, users, seats, tasks, and `fixture` match the runner. **At authoring time it advertises only raw `claude-opus-5.2`**. The coordinating mock owner must add raw `claude-opus-5` while keeping legacy 5.2. This runner intentionally fails if the required fixture model contract is missing; it does not substitute a real upstream.
- `src/login/src/routes/tasksApi.ts`: GET `/api/tasks?page=1&pageSize=100` returns `{items,total,...}`. No runnable Login calls are made.

### Stock LiteLLM APIs

Source inspected for public tag `v1.94.2`:

- [`key_management_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.94.2/litellm/proxy/management_endpoints/key_management_endpoints.py): `generate_key_fn` / `_common_key_generation_helper`; POST `/key/generate` returns `key` (raw) and may return `token` (DB hash). `key_alias` is a display alias, not the model-remapping `aliases` object.
- Same file: POST `/key/update` accepts `{key,key_alias}`; GET `/key/info` accepts raw or hashed key via `_hash_token_if_needed`, loads the DB row, and removes `info.token` in newer code. Thus the runner never depends on `info.token` being present.
- Same file, `delete_key_fn`: POST `/key/delete` accepts `keys` containing raw keys **or hashes**, and returns `deleted_keys`. The runner always deletes by hash, not ambiguous duplicate aliases.
- Same file, `_enforce_unique_key_alias`: duplicate non-null aliases raise HTTP 400 with an alias-uniqueness message. The inspected implementation has **no uniqueness-disable switch**. The requested same-alias test is therefore a compatibility blocker for this stock version, not grounds to edit DB rows or weaken auth. Actual runtime behavior is still tested rather than assumed from source.
- [`_health_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.94.2/litellm/proxy/health_endpoints/_health_endpoints.py): `/health/readiness` exposes minimal `status`/`db`; connected DB is required. Do not substitute `/health` model probes.
- [Virtual key documentation](https://docs.litellm.ai/docs/proxy/virtual_keys) provides CRUD usage; exact runtime responses remain assertions with safe failure reporting.

### Explicitly unproven until the real gateway run

1. Native `/v1/messages` (x-api-key and Bearer) must traverse the early authenticated hook and final Anthropic deployment hook on the actual selected LiteLLM version. Existing project wire tests only certified injected-auth Chat paths; a failure here is a real route/lifecycle gap, not a runner fallback opportunity.
2. `db: connected` plus stock key CRUD shows DB-backed auth but does not independently prove the engine is Postgres, restart persistence, migrations, spend settlement, or cache behavior across multiple gateway replicas. Compose ownership must establish engine/network topology; restart/accounting tests need separate contracts.
3. Fallback primary-attempt counters, fallback-out header scoping, and other-provider success/no-mutation checks require an explicit non-GHCP mock API/counter contract. Only final GHCP identity and model-permission denial are implemented through optional args now.
4. Gateway and infrastructure **logs** are outside the Node redactor. Keep LiteLLM debug off and restrict/redact management/request logs. The runner uses hashes in URLs and deletion bodies but cannot guarantee upstream logging of generate/update responses is safe.
5. Concurrent worker-stage observations are reported, not asserted to equal a guessed worker limit. Exact worker parallelism, crash recovery, and live SAML/SCIM/Copilot acceptance remain separate tests.
