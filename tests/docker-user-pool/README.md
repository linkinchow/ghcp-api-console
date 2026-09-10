# Local Docker user-pool harness

This starts actual production-built Proxy, SSO, Login and Console images with **fake GitHub SCIM, seat, Login task completion and model services**. Never supply tenant credentials. Real Login is health/API/browser-smoked only; Proxy dispatches its tasks to the fixture, not real GitHub.

## Preparation

Build each image from this checkout. `NPM_REGISTRY` is optional; set it to your organization's approved protected feed when public npm is blocked. Do not put credentials in build args, disable TLS checks, or bypass package holds.

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-proxy:local -f src/proxy/Dockerfile .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-sso:local -f src/sso/Dockerfile .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-login:local -f src/login/Dockerfile .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-console:local -f src/console/Dockerfile .
```

If no custom registry is required, omit the build-arg rather than passing an empty value. Login also downloads Chromium and operating-system libraries through its normal install procedure.

Create temporary self-signed **test** signing files (requires OpenSSL) and a local Compose pointer. Do not run this while the harness is already running.

```bash
node tests/docker-user-pool/prepare.mjs
```

Validate and start the explicitly named test project; no repository `.env` is used.

```bash
node tests/docker-user-pool/compose.mjs config --quiet
```

```bash
node tests/docker-user-pool/compose.mjs up --no-build
```

All application containers are on an **internal Docker network** without direct Internet egress. A small fixed-destination HTTP bridge publishes localhost ports through a second network because Docker Desktop may not publish ports from internal-only networks. The bridge can only forward to the five predetermined internal services; it has no arbitrary proxy/CONNECT support. No application service is attached to the bridge's external network.

Console: `http://127.0.0.1:17304/#user-pool`. The smoke initializes the admin `pool-test-admin` with password `local-pool-console-test-only`. All fixture credentials are public, synthetic and unsuitable for nonlocal deployment.

## Checks

The main smoke requires **fresh test volumes and initial idle target zero**. It creates four test pool accounts; it must never be pointed at existing installations.

```bash
node tests/docker-user-pool/smoke.mjs
```

The final fixture state intentionally has one failed member and paused prewarming after injecting 401. This is expected. Use Console retry/unpause to verify recovery.

Persistence check (run the three commands promptly within the test's 60-second lease):

```bash
node tests/docker-user-pool/smoke.mjs prepare-restart
```

```bash
node tests/docker-user-pool/compose.mjs restart proxy
```

```bash
node tests/docker-user-pool/smoke.mjs verify-restart
```

Additional checks:

```bash
node tests/docker-user-pool/saml-smoke.mjs
```

```bash
node tests/docker-user-pool/expiry-smoke.mjs
```

The SAML check validates login and signed-form generation, **not SP signature acceptance or GitHub OAuth**. The expiry check waits for an actual 60-second lease to expire without changing the clock/database.

`litellm/test_user_pool_runtime.py` supports `GHCP_POOL_TEST_LITELLM_VERSION` for a deliberate exact-version rerun. `litellm/test_user_pool_wire.py` runs inside the local LiteLLM image on `ghcp-user-pool-smoke_default`, with the `litellm` directory mounted read-only. It tests real callback/Router/wire behavior, not inbound gateway database authentication.

## Real gateway v1.99.1 and database-backed keys

`compose.gateway.yaml` adds a dedicated PostgreSQL16 instance and official LiteLLM v1.99.1 with the real pool hook. No public registry downloads occur during runtime. Use `launch-gateway.mjs` to start project `ghcp-user-pool-gateway` on localhost ports17500–17505 (Console17504, LiteLLM17505). It requires the already-prepared test signing files and GHCP test images.

```bash
node tests/docker-user-pool/launch-gateway.mjs
```

Against a **fresh** gateway project's Proxy/SSO/mock state:

```bash
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture --pressure-mode live --other-only-model other-only
```

The main runner performs actual User/Virtual Key CRUD and HTTP auth, 20-key bursts, identity spoofing, reuse/revocation and replenishment. It exits2 if stock LiteLLM refuses duplicate alias (that scenario cannot be constructed through the supported API), not because the executed inference tests failed. JSON results distinguish PASS/FAIL/BLOCKED/SKIP. It pauses the worker and revokes generated keys on exit; existing leases remain governed by TTL unless specifically released.

Then run the non-fresh supplement for master-key filtering, other-provider isolation, explicit fallback and budget checks:

```bash
node tests/docker-user-pool/gateway-supplement.mjs
```

The test-only gateway config disables Router cooldown to isolate pool-capacity behavior and includes a deliberately failing primary group; do not deploy those settings as a production routing policy. The fixture still substitutes GitHub/seat/model and Login completion. See [the full report](../../docs/user-pool-gateway-validation.md) and [scenario matrix](gateway-scenarios.md).

## Lifecycle

Stop the harness without deleting data:

```bash
node tests/docker-user-pool/compose.mjs stop
```

Do not run `down -v` indiscriminately. To repeat the initial smoke, an operator must explicitly retire only this disposable project's test volumes, or use a separately named new project. Do not prune unrelated Docker resources. Local signing files and local run/audit/snapshot files are ignored by Git.
