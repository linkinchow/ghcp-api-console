# User Pool — Docker and Wire Validation

Date: 2026-09-09. Branch: `ghcp-user-pool`. This follow-up supersedes the initial report's Docker-daemon and LiteLLM-runtime availability blockers. **This remains local validation with test doubles, not live GitHub acceptance.**

## Build issue diagnosed and resolved

The first clean Docker builds failed during dependency download (`ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE` against public npm). Host npm already used an approved protected package feed, but Docker's `npm ci` did not inherit host configuration. Registry metadata lookup through the approved feed succeeded; its optional `/-/ping` route returned 404 and was not a valid connectivity test.

All four Dockerfiles now accept `NPM_REGISTRY` at build time, passed through Compose; public projects retain the ordinary default. The approved feed was supplied only for this local build. No TLS verification was disabled, third-party mirror used, or release quarantine bypassed. No credentials were embedded in the image/build arguments, and the lockfile was not rewritten.

| Production Dockerfile | Clean build through approved feed |
| --- | --- |
| Proxy | Passed |
| SSO | Passed |
| Console | Passed |
| Login, including Chromium install | Passed |

An intermediate offline-image experiment used cached Linux dependencies; it was superseded. The container validation uses the clean-built Proxy/SSO/Console images. The real Login service initially used the offline artifact for health checks, was then replaced by the clean-built Login image and rechecked. Chromium launched successfully from the clean Login image. Temporary offline helper files were removed.

## Isolated test topology

Project: `ghcp-user-pool-smoke`. Dedicated disposable volumes and synthetic credentials, no tenant `.env` or certificates. Real applications:

- Production Proxy, SQLite and prewarm worker.
- Production SSO user API, SCIM client, seat integration and signing code.
- Production Console authentication, API bridge and web bundle.
- Production Login health/read-only API and installed Chromium.

The local fixture supplies stateful **GitHub SCIM, Copilot seat API, Login task completion/callback and model APIs**. Fake Login performs the actual HTTP token callback with the real authorization attempt ID; it never writes Proxy storage directly.

Application and mock containers attach only to an internal Docker network. A fixed-destination local bridge exposes host ports for browser/API testing; only that bridge has a second non-internal network. It is not an open forward proxy. No real Login task is dispatched, since its GitHub device-flow endpoints are not locally replaceable. No real GitHub/Azure/customer operations occurred.

## Executed integration checks

The main smoke completed with four accounts, four SCIM creations, four paid-seat **fixture** assignments, four successful token callbacks and 31 model-fixture requests:

- Real service health, Proxy readiness, unauthenticated rejection and Console authenticated service bridges.
- Empty pool target 0→2 using actual SSO creation, strict SCIM create-only, seat API, Login callback and model warmup.
- Exact key hashes exclusively map to different members; repeat and concurrent calls reuse their member.
- Canonical model IDs in JSON and SSE across Messages, Chat Completions and Responses; raw live ID reaches upstream.
- Exhaustion returns 429; autonomous replenishment reaches idle target without exceeding total cap four.
- Upstream 429 retains ownership/cooldown and does not renew or traverse members.
- HTTP 500, in-band SSE errors and early EOF neither renew nor replay requests.
- Manual release is blocked while a request is active; disconnect cancels upstream.
- HTTP 401 invalidates/quarantines only the selected member without request replay.
- Actual Proxy container restart preserved settings, lease ID, credentials and inventory without duplicate provisioning.
- Actual 60-second wall-clock lease expiry reclaimed ownership; a new fenced lease reused inventory without creating more accounts.

## Real application and LiteLLM checks

- Browser login to the running Console succeeded. Opened User pool, unpaused via its form and retried the deliberately failed account via its row action. The real worker reauthorized it through the fixture and returned all four accounts to ready-idle.
- Mobile viewport 375px had no document horizontal overflow or page alerts. Desktop screenshot and actual DOM were inspected.
- Real SSO container `/sso`→password login produced a signed SAML POST form with expected subject, local ACS and RelayState. SP signature acceptance and GitHub device authorization were not exercised.
- Existing local **LiteLLM 1.94.2** image: all **5 real auth-model/callback/Router tests passed**, including fallback into/out of GHCP, with network disabled.
- Real LiteLLM ProxyLogging/Router sent **JSON and SSE requests over HTTP to the running Docker Proxy**; the trusted hash appeared in the active lease and forged identity was replaced. Upstream model output remained a local fixture.
- The wire test injects a server-authenticated `UserAPIKeyAuth` test object. LiteLLM's inbound HTTP key authentication/database, budget/accounting and native Messages/Responses adapters are not certified by this test.

## Remaining release gates

1. Approved real tenant SAML/SCIM/seat/OAuth/model acceptance and a longer-running operational soak.
2. Exact customer LiteLLM image/configuration, real virtual-key database authentication and accounting acceptance.
3. Dependency remediation/review: the clean build's production audit reports **4 advisories (3 high, 1 moderate)** affecting `@xmldom/xmldom`, `brace-expansion`, `multer`, and `qs`. Fixes are reported available. No automatic dependency upgrades were applied; advisory presence is not proof of exploitability, but requires review before release.
4. Existing first-version limits: one Proxy/SQLite, no same-request 401 replay, bounded Console list sizes, and operator handling for ambiguous non-idempotent provisioning results.

Reproduction files are in [the Docker harness](../tests/docker-user-pool/README.md). The local Console is served on `http://127.0.0.1:17304/#user-pool` while this test stack is running. No commits, pushes or customer deployments were performed.
