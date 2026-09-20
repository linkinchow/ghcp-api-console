# Phase 7 C — real Console, two admin contexts

This suite is **not** the phase 5 read-only browser smoke test. It performs explicitly authorized synthetic business writes through the actual Console/SSO/Proxy APIs, using two independent Chromium contexts signed in as the same fixture global administrator. No UI/product changes, database reset shortcuts, mocked responses, real providers, commits, pushes, dependency installs, or agent spawning are involved.

## Prerequisites for main

- Main alone runs this in its owned internal Docker fixture, reserved for group C (`20260920c`; use a fresh run ID on rerun). Do not share a fixture with B or run another mutable suite concurrently.
- Use the **phase 5-shaped fresh `init` state**, at `/opt/ghcp-test/phase5-<runId>/fixture/state.json` on the host and `/fixture/state.json` in the browser container. Private state credentials are the only credential source. Host state must be mode `0600`; fixture/results directories should be `0700`.
- Baseline/current committed SHA: `9cbdae111f524a552ee607df4900e5c96189b16d`. Dirty test/source bundles are permitted and reported via `state.source.dirty` plus `state.source.bundleSha256`; this does not claim dirty product fixes were committed.
- Exact existing synthetic IDs, registry slugs `phase5-a`/`phase5-b`, initial caps **6 + 6**, draft lifecycle, empty SSO/Proxy/Login inventory, `paused=1`, `idle_target=0`, `next_ordinal=0`. A reused fixture is intentionally refused rather than silently cleaned.
- Real Console UI/server, SSO, Login API, Proxy load balancer and replicas are healthy. The existing internal synthetic provider is healthy with empty subjects/counters. Console discovery and the private admin file must already be initialized (no setup-admin API is allowed).
- Exact `state.origins`: Console `http://console:7004`, SSO `http://sso:7001`, Login `http://login:7003`, Proxy `http://proxy-lb:3000`, replicas `http://proxy-1:3000` through `proxy-3`, provider `http://provider:8000`. Registry routes must resolve to these internal origins. Browsers use only the Console origin; the Node runner only reads the provider snapshot endpoint. No browser bridge/public origin.
- A locally built **production Login image** tagged `ghcp-phase5-login:<runId>` as `state.images.login`, containing its existing Playwright/Chromium installation. The launcher mounts this directory under `/app/tests/enterprise-phase7`, resolving `/app/node_modules/playwright` from that image. The tooling image need not have a browser; nothing is installed or pulled by this suite.
- All application/provider services must be only on the owned `${project}_isolated` Docker network with `Internal=true`, expected Compose project/run/synthetic labels, no external network. The launcher uses the existing phase 5 `safety.mjs` loader to merge `ownership-app.json` and other append-only ownership ledgers, inspects the recorded immutable container IDs, and requires exact ID/name/service matches through `assertOwnedContainer` before starting. Copied labels or a replaced same-name container are refused; missing ownership ledgers are not adopted. Keep the baseline `tests/enterprise-phase5/safety.mjs` available beside the integrated suite. No host networking, Docker socket mount, privilege escalation, or isolation bypass.

No validation/activation/drain is needed for cap CAS. Both enterprises remain draft, and every global settings write is constrained to paused/target zero. A drain lifecycle claim is deliberately **not** made by these cases.

**SSO delete prerequisite:** the real `delete_sso` implementation performs an SCIM username lookup even for a never-provisioned user. The two successful delete/recreate setup actions therefore cause exactly **two read-only SCIM lookups on the internal synthetic provider, both in A**. Final evidence requires unchanged subjects/seats/tokens and zero SCIM mutation, seat operation, authorization, catalog or inference calls. The stale delete must not cause a third lookup. No request reaches real GitHub or an external provider. Do not replace this with direct DB surgery.

## Main-only run

After integrating the owned files and preparing the fresh fixture using the existing phase 5 machinery:

```sh
PHASE5_SYNTHETIC_ONLY=1 PHASE7_CONSOLE_WRITES=1 \
  node tests/enterprise-phase7/console-run.mjs \
  --state /opt/ghcp-test/phase5-20260920c/fixture/state.json \
  --output /opt/ghcp-test/phase5-20260920c/results/console-c.json
```

The launcher accepts **only `--state` and `--output`**. It uses an existing exact image ID, `--pull never`, read-only filesystem/scripts/fixture, private results mount, dropped capabilities and a tmpfs. It does not create or destroy application fixtures. It stops only its own labelled browser container on deadline. If main already has an equivalent verified owned container, its internal command is:

```sh
PHASE5_SYNTHETIC_ONLY=1 PHASE7_CONSOLE_WRITES=1 \
  node /app/tests/enterprise-phase7/console-browser.mjs \
  --state /fixture/state.json --output /results/console-c.json
```

The direct command still requires the same verified **internal-only Docker isolation**; do not run it on a host with real service routes. The browser has a **90-second soft deadline**, **150-second hard deadline**; launcher adds at most 5 seconds before stopping its own container. Individual waits are bounded (normally 8 seconds); there is no retry-until-pass loop.

## Assertions / actual API contracts

1. Two actual login sessions, same global admin identity, exact enterprise discovery, paused/empty fresh fixture, actual SSO/Proxy/Login API reads.
2. Same enterprise concurrent cap writes with the same captured version: exactly **200 + 409 `policy_version_conflict`**, one version increment, loser retains its draft and cannot save before explicit reload, no automatic retry.
3. Different enterprises at cap sum 9,998 each request +2 concurrently: exactly **200 + 400 `invalid_enterprise_policy`** (not 409), final derived cap 10,000, rejected version unchanged. Caps are decreased to 6 + 6 afterward.
4. Global settings concurrent TTL changes while paused and target zero: **200 + 409 `settings_version_conflict`**, one version increment, stale save disabled.
5. A → B → A while an exact captured cap write is held **before `route.continue`**: it really commits to A; its naturally arriving response cannot overwrite the new A draft, reload the current scope, or even briefly emit a stale toast. DOM `MutationObserver` records transient notifications without changing UI behavior.
6. A → B → A while an exact policy read is held: `route.continue` is released; current draft/notifications remain unchanged. Production `AbortController` may cancel that abandoned request. Report records **`browser-ERR_ABORTED` versus an actual HTTP response honestly**; cancellation is never counted as a server response. This is request delay, not fabricated stale response-body injection.
7. Same-name SSO users in A/B have distinct incarnations. Keep A's edit dialog open, delete/recreate A via the other real session, then save: actual **409 `user_incarnation_conflict`**, replacement and B untouched.
8. Keep A's native delete confirmation open while the other session deletes/recreates A; accept original confirmation: HTTP **200 with one failed row**, captured old incarnation, replacement survives. This batch API does **not** return HTTP 409. Switching A → B → A clears selection/dialog state.
9. Same-origin management guard with real authenticated session and exact Console destination: missing proof, foreign internal Origin, conflicting Fetch Metadata all return **403 `console_same_origin_required`**, policy unchanged. Only request headers vary; no external HTTP destination is visited.
10. Real logout in another tab invalidates an already-rendered draft's next mutation (**401**), while the second context remains signed in. Expiring the second context's actual session-cookie pair likewise causes **401 before mutation**. This is **browser cookie expiry, not an eight-hour server TTL/time-travel test**.
11. Final safety audit: still draft, paused, target zero, no inventory/tasks/names consumed, only two synthetic SCIM reads, no provider mutation, no forbidden browser traffic/page errors, terminal HTTP/cancellation evidence for API requests.

Barriers match one exact page + method + origin + path + no query + captured body where applicable. They use `route.continue()` only. No `route.fulfill()`, synthetic fetch response, local mock API, patched product function, synthetic business-response body, or forced error response is used. API observations and setup writes use the actual signed-in browser session; same-origin negative probes use that context's cookie-sharing API client with redirects disabled.

## Evidence and reruns

`console-c.json` is written exclusively, mode `0600`, with executed assertion codes/counts, per-case actual outcomes/statuses, source provenance, timings and request/status counts. Failure stops later cases and reports only completed assertions. No precomputed expected assertion total is labelled as executed. Screenshots are under `results/private/<output-stem>-screenshots`, files `0600`, directory `0700`; only authenticated non-password views are captured. No HAR, trace, storage state, cookie values, raw credentials, API response bodies or console-error dumps are exported. On failure `failure-private.json` in the same private directory retains the safe stage/code and stack **call frames only**, stripping raw error/call-log text that could expose inputs.

No rollback/teardown is hidden in the suite. Synthetic SSO replacements and policy/settings versions are left for investigation in this dedicated fixture. A repeat requires main to allocate a new fresh fixture/output; main owns final teardown. A failure may have committed a permitted synthetic write before failing a UI assertion: inspect the report, do not rerun blindly against the same fixture.

## Local qualification (not browser execution)

Executed in the implementation worktree:

- `node --check` for the browser, safety helper and launcher: passed.
- `node --test tests/enterprise-phase7/console-support.test.mjs`: **9 tests passed, 0 failed**. These are pure fixture/allowlist/barrier/path/CLI/redaction/ownership tests, with no browser, Docker, DB or HTTP calls.
- Existing TypeScript compiler no-emit JS module parsing (`--allowJs --checkJs false --module NodeNext --target ES2022`): passed. This is parsing/module validation, **not a checked-JS semantic typecheck**.
- **Real browser/API/DB tests: not executed by this worker.** Main must run the command above and report the resulting actual counts. Do not combine the nine pure tests with browser assertion totals.

The deliverable ZIP contains only this README and `console*.mjs` source/tests. The accompanying JSON manifest lists each file's SHA-256, baseline/current SHA, dirty status and executed local qualifications; no fixture credentials or private screenshots are included.
