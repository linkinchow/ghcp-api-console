# Isolated LiteLLM–MySQL gateway qualification notes

This is a **fixture-only artifact**, not production deployment guidance. It adds an actual authenticated LiteLLM v1.99.1 HTTP gateway to the HAProxy/shared-MySQL fixture without changing the production identity hook or Proxy logic.

## What is real and what is synthetic

- Real pinned LiteLLM server, standard HTTP virtual-key authentication, Router, PostgreSQL key records, existing `litellm/user_pool_hook.py`, HAProxy, and two real Proxy processes sharing MySQL.
- Synthetic gateway users/keys, provider key, member OAuth tokens, GitHub/SCIM/seat/Login responses, and inference outputs. No real model or account credentials; no external provider call is necessary.
- The static master key is **only management authentication**. It is deliberately tested to receive 403 for pool inference; it is not mislabeled as a virtual key.
- Stock virtual-key persistence needs LiteLLM's supported PostgreSQL database, separate from the Proxy's MySQL. Use the existing `postgres:16` image and a fresh disposable volume. Do not insert auth rows directly or install a fake authentication callback.

## Compose service contract

The parent fixture's `compose.stability.yaml` owns service lifecycle. All gateway/model/database services join **only** `isolated` (`internal: true`); only the existing fixed-target bridge joins the preview network. No published Postgres/gateway port, Docker socket, host credentials, or production `.env` mount.

`gateway-postgres`:

- Image `postgres:16`.
- `POSTGRES_USER=pool_gateway`, `POSTGRES_PASSWORD=mysql-fixture-gateway-db-only`, `POSTGRES_DB=litellm_mysql_fixture`.
- Disposable named volume `gateway-pg-data:/var/lib/postgresql/data`.
- Healthcheck `pg_isready -U pool_gateway -d litellm_mysql_fixture`.

`litellm`:

- Image `ghcr.io/berriai/litellm:v1.99.1` (already available locally).
- Command `["--config", "/fixtures/config.yaml", "--port", "7000", "--num_workers", "1"]`.
- Wait for healthy `gateway-postgres`; runner independently waits for `/health/readiness` with `db=connected` and healthy Proxy/MySQL roles.
- Mount `tests/docker-user-pool/litellm-mysql-config.yaml:/fixtures/config.yaml:ro`.
- Mount **existing** `litellm/user_pool_hook.py:/fixtures/user_pool_hook.py:ro`.
- Environment:

```text
DATABASE_URL=postgresql://pool_gateway:mysql-fixture-gateway-db-only@gateway-postgres:5432/litellm_mysql_fixture
LITELLM_MASTER_KEY=sk-mysql-fixture-gateway-master-only
LITELLM_SALT_KEY=mysql-fixture-gateway-salt-only
GHCP_POOL_API_BASES=http://pool-lb:8080
GHCP_PROXY_API_KEY=mysql-fixture-api-only
LITELLM_LOCAL_MODEL_COST_MAP=True
LITELLM_TELEMETRY=False
PYTHONPATH=/fixtures
```

The literal credentials above belong only to this isolated disposable fixture. They must never be reused for deployment. Local cost-map selection avoids fetching a remote model catalog; unknown synthetic model costs can warn and do not establish pricing/budget correctness.

Bridge targets used by the runner:

| Host loopback | Fixed target | Purpose |
|---|---|---|
| 18100 | proxy:3000 | Read member/lease state and release runner-owned leases |
| 18101 | proxy2:3000 | Independently read the same shared-MySQL lease |
| 18102 | mock:8002 | Fixture counters/markers; read-only bridge to real Login tasks |
| 18103 | litellm:7000 | Real gateway HTTP authentication and inference |
| 18107 | pool-lb:8082 | HAProxy `/stats;csv` business counters |

Each target must expose the bridge's `/__mysql/manifest`, with project `ghcp-user-pool-mysql-test`, database `ghcp_pool_mysql_test`, MySQL port 33184, and correct service role (`pool-lb` for 18107). Manifests identify fixture routes; they are not cryptographic proof of container network isolation.

## Bootstrap and execution

Start services with the parent fixture launcher through approved preview tooling, **not** this test script. The image performs its normal supported database initialization; no host package install or dependency download is required. The test then bootstraps keys via the standard API:

1. Master-authenticated `POST /user/new` with a random run-prefixed `internal_user`, `auto_create_key=false`, `send_invite_email=false`.
2. Master-authenticated `POST /key/generate`, user binding, model allowlist, one-hour lifetime, and synthetic run metadata.
3. Master-authenticated `/key/info?key=<sha256>` validates persisted user/model scope; virtual-key-authenticated `/v2/user/info` validates the actual `internal_user` role. Raw key material stays in memory and is never placed in a URL or report.
4. In `finally`, `POST /key/delete` by hash revokes every generated key, independently of lease cleanup errors. Only leases belonging to this run's exact raw-key hashes are released. Synthetic user audit rows remain in the disposable DB.

Before running: stop concurrent soak/requests; restore both backends; pause the worker with at least three ready-idle members, zero provisioning and **zero existing active/provisional leases**. The inventory does not need to be empty or exactly three members. If the soak used short TTLs, wait for expiry/reconciliation before pausing. The runner never changes global pool settings or provisions accounts.

```sh
node tests/docker-user-pool/litellm-mysql-smoke.mjs --confirm-local-fixture
```

No URL, credential, environment, or service override is supported. `--help` does no I/O. Exit 0 means every required assertion and cleanup passed; a failed prerequisite, missing ledger, transport ambiguity, or changed runtime fails closed. The report path printed as `LITELLM_MYSQL_REPORT` is a newly created OS temporary directory, not a tracked output artifact.

## Evidence and anti-replay checks

- Missing/invalid key with forged identity headers, management master key, model-restricted key, and revoked cached key are rejected with no mock upstream activity or inventory consumption.
- Keys A and B are real, distinct DB-backed virtual keys. First allocation of B poisons both request headers/body and `ghcp_identity` metadata with A's identity; B must receive its own `sha256(raw-key)` lease/member. Header variants and nested override containers are also exercised on reuse.
- Six serial requests for A mix Messages and Chat, JSON and SSE, bearer and `x-api-key`. The same lease/member must be visible through both direct Proxy APIs.
- Those six calls are bracketed by per-server HAProxy `hrsp_2xx` counters. Both servers must increase and the sum must be exactly six. No pool reads, catalog, or other LB requests occur inside the measured interval. Healthchecks do not count as business `hrsp_2xx`. This proves both backends handled the same authenticated caller without relying on LiteLLM preserving an arbitrary response header.
- Every successful pool request includes a unique `POOL_TEST` marker. Mock inference must show exactly one completed attempt with the correct member, raw wire model, stream flag and HTTP status. There are no inference-POST retries in the runner, LiteLLM config, or HAProxy config.
- The non-pool `other-only` route must receive no hook-injected identity and allocate no pool member.
- Fallback starts at `http://mock:8002/other` using the deliberately invalid synthetic provider key. The stability mock must record rejected primary attempts at authenticated `/__mysql/gateway-state` as `{fixture:true, primaryAttempts:[{marker,status:503,identityHeaderPresent:false}]}`. A single fallback invocation must produce exactly one such primary record and exactly one successful real Proxy→mock record using its fresh caller's allocated member. A successful final response alone is insufficient evidence.
- The real Login task list is read-only and must remain empty; SCIM, seat, task and callback counts must not change.

## Offline validation

```sh
node --test tests/docker-user-pool/litellm-mysql-smoke.test.mjs
```

The five built-in-only runner tests validate exact two-backend accounting, hash identity, SSE terminals/in-band errors, output sanitization, and help/confirmation refusal without network calls.

The existing optional callbacks test was also run using the actual pinned image as a **one-shot** process with `--network none`, read-only mount of `litellm/`, `PYTHONPATH=/fixtures`, `GHCP_POOL_API_BASES=http://proxy.test:3000`, `LITELLM_LOCAL_MODEL_COST_MAP=True`, `LITELLM_TELEMETRY=False`, and `PYTHONDONTWRITEBYTECODE=1`:

```text
python -m unittest test_user_pool_runtime -v
Ran 5 tests — OK
```

A second one-shot `--network none` check loaded the new YAML into the pinned real Router and existing hook, validated its three models and exact LB-only allowlist. This is config/callback evidence only, **not** proof of HTTP authentication. Full gateway results belong in the runner's JSON after actual fixture execution.

## Explicit limits

No real GitHub/SAML/SCIM acceptance, real seat allocation, model inference, live key material, gateway Postgres restart durability, pricing/budget accounting, or TLS exposure qualification is claimed. HAProxy/shared-MySQL soak, outage/recovery and scheduler failover remain the parent qualification's responsibility. Default stock logging can contain synthetic request metadata; keep and destroy these isolated fixture logs with the disposable volumes rather than treating them as production-ready log-redaction evidence.
