# Offline user-pool SQLite → MySQL 8 migration

This tool migrates **caller-lease pool data**, unlike `upgrade/sqlite-to-mysql` (the older direct-mode tool). It performs no GitHub, SSO, SCIM, Login, seat, or model requests. Use a maintenance window, a consistent offline backup, and a dedicated empty MySQL 8/InnoDB database. Migration is not zero-downtime.

**Status (2026-09-14): reviewed defects fixed and isolated regressions passed.** The [production review and remediation record](../../docs/user-pool-mysql-production-review.md) retains the original failures and records the repairs. This remains an unpublished candidate; customer backup rehearsal, resource/SLO and infrastructure acceptance are separate. These instructions do not authorize production access.

## Before running

1. Pause pool prewarming. Stop admitting new traffic and drain every inference/catalog request and every dispatched provisioning/Login operation. Resolve ambiguous creation, SCIM, seat, and OAuth outcomes using the operational reconciliation process; do not simply clear safety fields to pass validation.
2. Stop all old Proxy writers and their scheduler. Stop any Login callback writer that could change the backup's source. Keep the original deployment, credentials, certificates, SSO/Login/Console volumes, and original SQLite files untouched by this tool.
3. Produce a consistent **standalone backup copy**, not a raw copy of a live SQLite main file with an uncheckpointed WAL. This tool requires a rollback-journal-format backup, with no `-wal`, `-shm`, or `-journal` sidecars. If the backup is in WAL mode, produce another standalone copy offline, or convert only the disposable backup copy to `journal_mode=DELETE` with SQLite after confirming consistency. Never do this to a running/original database as part of migration.
4. Stop every service connected to the target. Provision an empty, dedicated MySQL 8 database and a migration login with schema creation, DML, verification, and advisory-lock permissions. No target traffic until acceptance is complete. Injected test pools need at least **three connections**: the importer holds one connection throughout schema initialization.

## Commands

From the repository root (root scripts wrap the corresponding `tsx` files):

```sh
npm run upgrade:user-pool-mysql -- --sqlite /safe/offline/backup.sqlite --dry-run
```

Dry-run is **source-only**: no MySQL connection, no environment loading, no schema writes, and no target inspection. It checks the complete source snapshot, integrity, relationships, values, and maintenance-state conditions. It prints only per-table counts.

Provide `MYSQL_URL` using your secure environment injection mechanism. The tool does not load `.env` files and deliberately rejects `--mysql-url` and all URL query parameters. Do not put credentials into command arguments or paste them into logs.

For writes, also provide the intended deployment's `POOL_WARMUP_MODEL` and pool invariant environment options (`PROVISIONAL_LEASE_TTL_SECONDS`, `PREWARM_POLL_SECONDS`, `PREWARM_CONCURRENCY`, `POOL_EXHAUSTED_RETRY_AFTER_SECONDS`, `POOL_REQUEST_TIMEOUT_SECONDS`, and any new runtime pool options). The normal `readPoolConfig` defaults apply. The backup supplies domain and mutable idle-target/cap/lease settings; an explicitly different domain is refused. `MysqlPoolStore.initialize()` seeds the fingerprint from these real deployment options; no placeholder model is used and no warmup request is made. Every future Proxy must use the same invariant configuration. The programmatic API accepts an exact `poolConfig: PoolConfig` and an optional caller-owned `pool: mysql2.Pool`; injected pools must use verified TLS for remote targets and at least three connections. `MYSQL_CONNECTION_LIMIT` configures the built-in pool (3–100, default 3).

TLS environment variables use the existing names and modes:

- `MYSQL_SSL_MODE=disabled`: allowed only for `localhost`, `127.0.0.1`, or `::1`.
- `MYSQL_SSL_MODE=required`: encrypted but unverified; allowed only for those loopback hosts.
- `MYSQL_SSL_MODE=verify-ca`: requires `MYSQL_SSL_CA_PATH`; validates certificate trust **and host identity**. Mandatory for nonlocal hosts; it is the nonlocal default. Loopback defaults to `disabled`.

Then explicitly attest to both maintenance conditions:

```sh
npm run upgrade:user-pool-mysql -- --sqlite /safe/offline/backup.sqlite \
  --confirm-offline-source --confirm-empty-target
```

Both flags are required for writes. They are operational attestations, not an automated guarantee that external services are stopped.

## Validation and preservation

Supported input is the current pool schema, including OAuth recovery fields and caller/lease stats columns. Unknown tables, views, trigger names, missing/extra critical columns, generated columns, or incompatible SQLite column types are refused. **The credential-fence exception requires the canonical SQLite trigger definition, not just its name.** Legacy/custom schemas require a separate reviewed upgrade; the importer never upgrades or modifies its source. Arbitrary SQLite indexes and schema migration history are not copied; MySQL creates its own indexes and migration history.

Preflight uses a readonly connection with `query_only`, one read transaction for the schema, `integrity_check`, `foreign_key_check`, and every data table, plus explicit relationship/value validation. Refusal includes:

- Source not paused, live owner deadline, any inference/catalog hold **even expired**, or any identity-initialization claim.
- Any provisioning member, refreshing account, unresolved account OAuth callback, unknown state/stage, intent-stage or ambiguous/unconfirmed external work.
- Failed/disabled members with unresolved Login task evidence. Historical task and OAuth IDs are accepted and preserved only when both exist on a verified `ready`/`cooling` member at stage `ready` with valid account credentials and no pending account callback. That is the worker's persisted completed-provisioning checkpoint; it is not an external Login query.
- Invalid caller hashes, orphan references, duplicate allocation keys, unsafe/fractional/negative epoch values, inconsistent lease deadlines, invalid name ordinals/domain/settings, or malformed/noncanonical ISO dates.

Copies all proxy accounts and their OAuth credentials; request stats with caller/lease attribution; settings including version, domain, capacity, lease duration, and next ordinal; inventory with generation, recovery counters/window, errors, retry/verification/cooldown times, and settled correlation fields; leases; catalog cooldowns; and event IDs/content. Historical stat/event references to no-longer-existing leases remain historical references and do not require a current lease row.

Valid leases retain their original deadlines. Expired leases and cooldowns are also copied unchanged for normal runtime reclamation; migration never renews TTLs or runs reclamation. Only account timestamps and stats `requested_at` convert canonical UTC ISO strings to MySQL `DATETIME(3)`. All pool epoch-millisecond values and the SSO creation marker remain unchanged. Owner is cleared, owner deadline is zero, and target prewarming is forcibly paused.

## Target atomicity and failures

The importer holds a target advisory lock from the first target empty check through initialization, copy, verification, and commit/rollback. It permits only empty application tables (plus the known MySQL migration history and an unused, unpaused, matching singleton settings seed from `MysqlPoolStore.initialize()`). A nonempty partial schema is refused **before migrations run**. Empty base stats tables without caller/lease columns can be initialized. Unexpected tables, views, trigger metadata, migration history, generated columns, and non-InnoDB tables are refused. Shared startup/importer schema validation checks supported column types/nullability/defaults, required binary collations, complete primary/unique keys, foreign-key actions, required query indexes/CHECK predicates and the canonical credential-fence body. Altered or missing fences after the migration marker are refused without repair. The known historical TEXT token collation upgrade remains available only before its marker; unknown custom shapes require a reviewed migration.

Schema initialization calls the base MySQL migrations and `MysqlPoolStore(pool, config).initialize()`. MySQL DDL and the initial settings seed are **not transactional with the import** and may remain after failure. All imported DML uses one serializable transaction: settings mutex first, then locking empty checks on all tables, copy, and read-back verification. All field values—including tokens—are compared internally, together with counts and key relationships, before commit. No credentials, caller values, source paths, URLs, or driver errors are printed. The target is never merged with existing data.

A failed transaction rolls back imported data; schema/seed can remain. A COMMIT error returns `commit_outcome_unknown`, destroys the connection, and **does not attempt rollback or retry**. A rollback error returns `rollback_unconfirmed`. In either case, **do not blindly retry or resume either deployment**. Inspect the target privately under maintenance conditions first. The tool does not retry writes automatically. A nonempty target blocks reruns, including a successful migration of an empty source (the persisted settings are paused). A failed advisory-lock release destroys rather than recycles the connection.

## Cutover and rollback

Start **one** MySQL Proxy first while prewarming remains paused. Privately verify inventory counts, credentials/leases, readiness, routing, and deadline behavior using authorized acceptance procedures. Ensure shared pool configuration matches the migrated domain/settings, then resume prewarming/traffic deliberately and scale routing proxies only after acceptance. Never serve traffic from old SQLite and MySQL simultaneously.

A cutover may return to the preserved source only while the target has had **no post-import runtime writes**, not merely while public traffic is still closed. Startup pruning, scheduler and reclamation writes also count. After any such MySQL writes, do not switch to the old SQLite snapshot without separately planned reconciliation and maintenance. Existing SSO/Login/Console volumes and certificates remain in place.

Set and verify the same `REQUEST_STATS_PER_ACCOUNT_LIMIT` on every Proxy before startup, and archive history independently when required. The default retains two records per account; runtime pruning can remove statistics the importer correctly preserved. Startup now validates pool configuration before pruning or starting the worker. A rejected pool configuration cannot first prune history; a valid startup still applies retention.

Programmatic `poolConfig` optional concurrency defaults are normalized and validated before fingerprinting, matching `readPoolConfig`. The real-parser cutover path is covered by integration tests. Existing fingerprints produced by the full runtime parser are unchanged; a legacy development fixture seeded with omitted fields is not silently rewritten. Rehearse offline rather than altering the persisted hash to bypass a mismatch.

## Tests

```sh
npx tsc -p upgrade/user-pool-mysql/tsconfig.json
npx tsx --test upgrade/user-pool-mysql/migrate.test.ts
```

Default tests use only generated synthetic SQLite fixtures in the OS temporary directory. They do not read deployment `.env`, `.local-sso`, old databases, or volumes. The MySQL test is skipped unless `RUN_USER_POOL_MIGRATION_MYSQL_TESTS=1` **and** `USER_POOL_MIGRATION_TEST_MYSQL_URL` is provided. It never uses `MYSQL_URL`.

The integration URL must point to a loopback host and database named `user_pool_migration_test`, on an independently provisioned **disposable local** MySQL 8 server. The test creates and drops only a uniquely suffixed database (`user_pool_migration_test_<uuid>`) on that server; it needs create/drop database permissions. The test covers a source-only dry-run, competing importers, exact preserved credentials/timestamps/leases/recovery fields, and rollback after a synthetic token mismatch. Do not enable it against an existing deployment or use real credentials. Integration execution is separate from the default offline test suite and requires the MySQL pool provider implementation.
