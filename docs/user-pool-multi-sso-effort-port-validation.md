# Multi-enterprise Messages effort port validation

## Scope and provenance

Validated on 2026-10-14 in an isolated Windows worktree.

- Public sanitized baseline: `7e4611806ce394db936946e372eed116aef652b2`.
- Source fix: `5046bca934c6e2b6de66510ff3133d68f34eba58` (`fix(proxy): preserve per-message effort protocol forwarding`). Applied with `cherry-pick --no-commit`; no merge conflicts.
- Candidate branch: `fix/multi-sso-effort-port-20261014`. At validation time HEAD remained the baseline: no candidate commit or push was made by the port worker. The final commit identity must be taken from the audited publication, not inferred from this report.
- Production delta is limited to `claudeCodeCompat.ts`, `compatible.ts`, and `requestIntent.ts`. Existing multi-enterprise registry, caller admission, scoped account lookup, lease/hold, OAuth, and request-stat paths remain intact. No DB schema, migration, dependency, Models, image, or release-packaging changes.

The source fix's single-enterprise historical validation report is not included: its baseline, results, and environment operations are not evidence for this port.

## Behavior checked

Messages with an own `output_config` property retain their complete JSON body through optimized preparation, including empty/nonempty system controls, ordering, prior thinking signatures, tools and cache fields. The existing model catalog resolver may still map the requested model alias to the upstream ID. The complete client `anthropic-beta` and version headers are forwarded; no missing beta is invented and no rejected instruction is silently dropped. Legacy requests retain existing adaptation and unsupported-tool preflight behavior.

Request-intent inference ignores trailing empty system effort controls without deleting them. Tool-result continuations remain `x-initiator: agent`; explicit initiator precedence and nonempty system behavior are unchanged.

The added schema4 pooled regression uses two active enterprise policies, a deliberately reversed registry order, temporary SQLite, synthetic ready members and distinct synthetic OAuth tokens. Requests traverse the real Express caller identity → lease/hold → enterprise/revision/member → scoped OAuth path. Both enterprises exercise optimized/plain JSON and SSE, whole-body equality except the model alias, full protocol headers, final SSE completion, agent continuation, scoped durable statistics, and absence of cross-enterprise credential fallback. Missing beta remains a provider-shaped 400. Ready members are fixtures, not evidence of real provisioning or real upstream support.

## Actual execution results

| Check | Result |
| --- | --- |
| Initial source-fix 3-suite run before schema4 fixture adaptation | 33 tests: 21 PASS, 12 FAIL, 0 SKIP; HTTP setup failed with `enterprise_registry_file_required` |
| Same 3 suites after explicit schema4 fixture initialization | 33 tests: 33 PASS, 0 FAIL, 0 SKIP |
| Added dual-enterprise pooled protocol suite | 12 tests: 12 PASS, 0 FAIL, 0 SKIP |
| Proxy complete suite, serial file concurrency, initial and final reruns | Each run: 686 tests, 657 PASS, 0 FAIL, 29 SKIP; final rerun follows the test-only literal type correction |
| Multi-enterprise isolation/scheduling/recovery subset, rerun | 43 tests: 40 PASS, 0 FAIL, 3 SKIP |
| Parent Browser preview of the direct + pooled protocol suites | 24 tests: 24 PASS, 0 FAIL, 0 SKIP, exit 0; actual localhost HTTP/SSE tests, not a production service |
| Console API/scoped enterprise unit tests | 8 tests: 8 PASS, 0 FAIL, 0 SKIP |
| Initial `typecheck:deploy` | FAIL: new test fixture widened `login.provider` to `string`; fixed with a literal type |
| Final `typecheck:deploy` | PASS, exit 0, including all deploy workspaces and upgrade typechecks |
| `build:deploy` | PASS, exit 0; existing Console bundle-size advisory remains |
| Real MySQL / real upstream / SSO / seats / cloud / model calls | NOT RUN; real DB gates remain disabled, not counted as PASS |

The 45 unique protocol checks and 43 isolation/recovery checks are contained in the Proxy full suite; do not add them again to its totals. No test deadlines or production timeout values were changed. No Docker Desktop performance or long-duration load testing was performed.

Dependencies were installed locally with `npm ci --registry=https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund` (exit 0, 284 packages). The candidate uses its own Windows dependencies and working SQLite native module, not an ancestor checkout's dependencies or Linux binaries. No Minimum Release policy bypass or tracked package/lockfile modification was made.

## Reproduction and local evidence

Build shared first (`npm --workspace @ghcp/shared run build`). Install only through the approved corporate feed. Run from the candidate root in a clean environment with `NODE_ENV=test`, `DOTENV_CONFIG_PATH` pointing to a nonexistent local file, and real-DB gates (including `MYSQL_TEST_URL` and `MYSQL_POOL_TEST_DISPOSABLE`) unset. Do not load deployment credentials or enable real DB/service gates. The following commands use tracked test files and locally installed tools; they do not require the private evidence runner.

Targeted original 3 suites:

```sh
node --import tsx --test --test-concurrency=1 src/proxy/src/routes/claudeCodeCompat.test.ts src/proxy/src/routes/messagesProtocolForwarding.test.ts src/proxy/src/routes/requestIntent.test.ts
```

Dual-enterprise pooled protocol:

```sh
node --import tsx --test --test-concurrency=1 src/proxy/src/routes/multiEnterpriseMessagesProtocol.test.ts
```

Proxy full serial:

```sh
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 src/proxy/src/*.test.ts src/proxy/src/accounts/*.test.ts src/proxy/src/clients/*.test.ts src/proxy/src/copilot/*.test.ts src/proxy/src/db/*.test.ts src/proxy/src/diagnostics/*.test.ts src/proxy/src/routes/*.test.ts src/proxy/src/userPool/*.test.ts
```

Multi-enterprise isolation/recovery subset:

```sh
node --import tsx --test --test-concurrency=1 src/proxy/src/userPool/enterprisePhase4.sqlite.test.ts src/proxy/src/userPool/enterprisePhase4.runtime.test.ts src/proxy/src/userPool/provisioningRecovery.test.ts src/proxy/src/userPool/reauthorization.test.ts src/proxy/src/userPool/loginPollingRecovery.test.ts
```

Console unit tests:

```sh
node --import tsx --test --test-concurrency=1 src/console/src/server/apiProxy.test.ts src/console/src/web/api/enterprises.test.ts
```

Deploy typecheck:

```sh
npm run typecheck:deploy
```

Deploy build:

```sh
npm run build:deploy
```

For the recorded executions, an ignored local runner `.claude/effort-port-logs/runner.mjs` applied the OS-variable environment allowlist before spawning these commands, logged their exact arguments and exit codes, and supplied no deployment configuration. It is private evidence tooling, not part of a fresh clone. The deploy scripts were invoked through the installed npm CLI with the same clean environment.

Local evidence is ignored, not a publication payload: `.claude/effort-port-logs/{npm-ci,shared-build,targeted-initial,targeted,multi-enterprise-protocol,proxy-full-serial,proxy-full-serial-final,multi-enterprise-isolation,console,typecheck-deploy-initial,typecheck-deploy,build-deploy,preview-protocol}.log`. Initial failures are retained rather than overwritten.

The parent verifier started the ignored controller `.claude/multi-sso-effort-preview.mjs` through `preview_start`, launch name `multi-sso-effort-isolated`, port 18814, clicked Run, and inspected `/status`. The controller ran the existing direct and dual-enterprise protocol tests to completion: 24 PASS, 0 FAIL, 0 SKIP, exit 0 (about 23 seconds). This is actual in-process localhost HTTP/SSE test execution with mocked upstream, not a production server or real upstream/cloud proof. The controller has a fixed 180-second harness limit and no tracked server code was added.

## Limits

This validates local forwarding and isolation contracts, not that any real upstream supports the per-message beta or that a deployment has been upgraded. No real credentials, customer prompts, enterprise users, seats, databases, models or cloud resources were exercised or changed. No model was enabled. Real MySQL integration gates remain skipped. No claim of independent security-audit completion is made here; the parent retains the separate sensitive-data audit and authorized commit/push gate.
