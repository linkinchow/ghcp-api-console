#!/usr/bin/env python3
"""Bounded, disposable old120/new600 container test. No cloud calls, builds or pulls.

python3 tests/user-pool-timeout/run.py --self-check
python3 tests/user-pool-timeout/run.py --execute-isolated-test

Requires preloaded Docker images and host openssl. Runtime results are NOT implied
by --self-check. Only this run's random Compose project/volumes are removed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MOCK = ROOT / 'tests/docker-user-pool/mock-services.mjs'
OLD_IMAGE = 'ghcp-pool-mysql-proxy:observability-v5'
OLD_ID = 'sha256:552d81e938703c8f46f6d8d85821938a1e1b6bef2f3a1247067feaa53c06a1cb'
NEW_IMAGE = 'ghcp-pool-mysql-proxy:inference600'
SSO_IMAGE = 'ghcp-pool-mysql-sso:check'
INTERNAL = 'timeout-fixture-internal-only'
DATABASE = 'ghcp_pool_timeout_test'
DB_PASSWORD = 'timeout-fixture-db-only'


def check(value, label):
    if not value:
        raise RuntimeError(label)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def patch_mock(source):
    # Extend ONLY a private copy's existing delay limit, retaining auth, OAuth,
    # markers, token validation, SSE pulses, terminal events and state recording.
    before = 'value.delayMs > 25000'
    check(source.count(before) == 1, 'mock_delay_patch_contract_changed')
    check("process.env.MYSQL_STABILITY_FIXTURE === '1' ? ['delayMs']" in source,
          'mock_delay_gate_contract_changed')
    check("const pulse = setInterval(" in source, 'mock_stream_heartbeat_missing')
    return source.replace(before, 'value.delayMs > 700000')


def specification(project, directory):
    auth = {'INTERNAL_API_TOKEN': INTERNAL, 'LOG_LEVEL': 'warn'}
    env = dict(auth, PORT='3000', STORAGE_DRIVER='mysql',
               MYSQL_URL=f'mysql://pool_fixture:{DB_PASSWORD}@mysql:3306/{DATABASE}',
               MYSQL_CONNECTION_LIMIT='10', MYSQL_SSL_MODE='disabled',
               API_KEY='timeout-fixture-api-only', ACCOUNT_ROUTING_MODE='caller-lease',
               POOL_ACCOUNT_EMAIL_DOMAIN='pool.timeout.example.test',
               POOL_WARMUP_MODEL='claude-opus-5-2', READY_IDLE_TARGET='0',
               POOL_MAX_ACCOUNTS='4', CALLER_LEASE_TTL_SECONDS='600',
               PROVISIONAL_LEASE_TTL_SECONDS='60', PREWARM_POLL_SECONDS='1',
               PREWARM_CONCURRENCY='2', POOL_REQUEST_TIMEOUT_SECONDS='120',
               SSO_BASE_URL='http://sso:7001', LOGIN_BASE_URL='http://mock:8002',
               COPILOT_API_BASE_URL='http://mock:8002', ENTERPRISE_SHORTCODE='test',
               PROXY_ERROR_DIAGNOSTICS_ENABLED='false', PROXY_ERROR_DIAGNOSTICS_REDACT='true')

    def health(port, path='/healthz'):
        return {'test': ['CMD', 'node', '-e',
                         f"fetch('http://127.0.0.1:{port}{path}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                'interval': '2s', 'timeout': '5s', 'retries': 60, 'start_period': '5s'}

    def proxy(image, environment):
        return {'image': image, 'pull_policy': 'never', 'working_dir': '/app/src/proxy',
                'command': ['node', 'dist/index.js'], 'environment': environment,
                'networks': ['isolated'], 'healthcheck': health(3000, '/readyz'),
                'depends_on': {name: {'condition': 'service_healthy'} for name in ['mysql', 'sso', 'mock']}}

    return {'name': project, 'services': {
        'mysql': {'image': 'mysql:8.4', 'pull_policy': 'never',
                  'command': ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_bin', '--max-connections=50', '--log-bin-trust-function-creators=1'],
                  'environment': {'MYSQL_DATABASE': DATABASE, 'MYSQL_USER': 'pool_fixture',
                                  'MYSQL_PASSWORD': DB_PASSWORD, 'MYSQL_ROOT_PASSWORD': 'timeout-fixture-root-only'},
                  'volumes': ['mysql-data:/var/lib/mysql'], 'networks': ['isolated'],
                  'healthcheck': {'test': ['CMD-SHELL', "MYSQL_PWD=$$MYSQL_ROOT_PASSWORD mysql --protocol=tcp -h 127.0.0.1 -uroot -Nse 'SELECT 1' >/dev/null 2>&1"],
                                  'interval': '2s', 'timeout': '5s', 'retries': 60}},
        'mock': {'image': 'node:22-bookworm-slim', 'pull_policy': 'never',
                 'command': ['node', '/fixtures/mock-services.mjs'],
                 'environment': dict(auth, MYSQL_STABILITY_FIXTURE='1', PROXY_BASE_URL='http://proxy:3000',
                                     SCIM_TOKEN='timeout-fixture-scim-only', SEAT_PAT='timeout-fixture-seat-only',
                                     SSO_DEFAULT_USER_PASSWORD='timeout-fixture-sso-only'),
                 'volumes': [f'{directory.as_posix()}/mock-services.mjs:/fixtures/mock-services.mjs:ro'],
                 'networks': ['isolated'], 'healthcheck': health(8002)},
        'sso': {'image': SSO_IMAGE, 'pull_policy': 'never', 'working_dir': '/app/src/sso',
                'command': ['node', 'dist/index.js'],
                'environment': dict(auth, PORT='7001', DB_PATH='/data/sso.sqlite', BASE_URL='http://sso:7001',
                                    PROXY_BASE_URL='http://proxy:3000', SESSION_SECRET='timeout-fixture-session-only',
                                    SSO_DEFAULT_USER_PASSWORD='timeout-fixture-sso-only',
                                    SSO_USER_EVENTS_LOG='/data/sso-user-events.log', ENTERPRISE_SLUG='local-test',
                                    ENTERPRISE_SHORTCODE='test', GITHUB_API_BASE_URL='http://mock:8002',
                                    GITHUB_COPILOT_SEAT_PAT='timeout-fixture-seat-only',
                                    SCIM_BASE_URL='http://mock:8002/scim/v2/enterprises/local-test',
                                    SCIM_TOKEN='timeout-fixture-scim-only', SP_ENTITY_ID='http://mock:8002/saml',
                                    SP_ACS_URL='http://mock:8002/saml/acs', CERT_DIR='/certs'),
                'volumes': ['sso-data:/data', f'{directory.as_posix()}/certs:/certs:ro'],
                'networks': ['isolated'], 'depends_on': {'mock': {'condition': 'service_healthy'}},
                'healthcheck': health(7001)},
        'proxy': proxy(OLD_IMAGE, env),
        'new': proxy(NEW_IMAGE, dict(env, POOL_INFERENCE_TIMEOUT_SECONDS='600')),
    }, 'networks': {'isolated': {'internal': True}}, 'volumes': {'mysql-data': {}, 'sso-data': {}}}


def validate(spec):
    check(re.fullmatch(r'ghcp-timeout-[a-f0-9]{12}', spec['name']), 'invalid_project')
    check(spec['networks'] == {'isolated': {'internal': True}}, 'network_not_internal')
    for svc in spec['services'].values():
        check(not any(key in svc for key in ['ports', 'build', 'privileged', 'network_mode', 'container_name']),
              'unsafe_service_configuration')
        check(svc['networks'] == ['isolated'], 'service_external_network')
    old = spec['services']['proxy']['environment']
    new = spec['services']['new']['environment']
    check('POOL_INFERENCE_TIMEOUT_SECONDS' not in old, 'old_override_forbidden')
    check(old['POOL_REQUEST_TIMEOUT_SECONDS'] == new['POOL_REQUEST_TIMEOUT_SECONDS'] == '120', 'legacy_timeout_mismatch')
    check(dict(old, POOL_INFERENCE_TIMEOUT_SECONDS='600') == new, 'replica_env_diff_exceeds_override')
    check(all(not value for value in spec['volumes'].values()), 'external_or_fixed_volume')


def self_check():
    source = MOCK.read_text(encoding='utf-8')
    patch_mock(source)
    try:
        patch_mock(source.replace('value.delayMs > 25000', 'value.delayMs > 25001'))
        raise AssertionError('missing patch contract accepted')
    except RuntimeError:
        pass
    spec = specification('ghcp-timeout-0123456789ab', Path('/tmp/timeout-fixture'))
    validate(spec)
    for mutation in ['ports', 'environment']:
        bad = json.loads(json.dumps(spec))
        if mutation == 'ports':
            bad['services']['proxy']['ports'] = ['3000:3000']
        else:
            bad['services']['new']['environment']['POOL_REQUEST_TIMEOUT_SECONDS'] = '600'
        try:
            validate(bad)
            raise AssertionError('unsafe specification accepted')
        except RuntimeError:
            pass
    node = shutil.which('node')
    check(node, 'node_required_for_offline_probe_self_check')
    result = subprocess.run([node, str(HERE / 'probe.mjs'), '--self-check'], capture_output=True, text=True, timeout=15)
    check(result.returncode == 0, 'probe_self_check_failed')
    print(result.stdout.strip())
    print(json.dumps({'case': 'launcher_self_check', 'status': 'PASS', 'runtimeExecuted': False,
                      'checks': ['private_mock_patch_contract', 'internal_no_ports', 'random_volumes', 'only_new_override', 'reject_unsafe_specs']}))


def execute():
    check(sys.platform.startswith('linux'), 'execution_requires_linux_services_vm')
    check(shutil.which('docker') and shutil.which('openssl'), 'docker_and_openssl_required')
    started = time.monotonic()
    project = 'ghcp-timeout-' + secrets.token_hex(6)
    report = {'project': project, 'runtimeExecuted': False, 'status': 'FAIL', 'events': [], 'cleanup': 'not_started'}
    output = HERE / 'reports' / f'{project}.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix=project + '-'))
    directory.chmod(0o755)
    compose = ['docker', 'compose', '--project-name', project, '--project-directory', str(directory),
               '--env-file', '/dev/null', '-f', str(directory / 'compose.json')]
    # Ignore inherited compose selection/project profiles and Docker context overrides.
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith('COMPOSE_') and key not in ['DOCKER_HOST', 'DOCKER_CONTEXT']}
    provisioned = False

    def command(args, budget=30, input_text=None):
        remaining = 900 - (time.monotonic() - started) - 35
        check(remaining > 0, 'overall_900_second_budget_exhausted')
        result = subprocess.run(args, input=input_text, capture_output=True, text=True,
                                timeout=min(budget, remaining), env=environment)
        with (directory / 'execution.private.log').open('a', encoding='utf-8') as log:
            log.write(result.stdout + result.stderr)
        (directory / 'execution.private.log').chmod(0o600)
        check(result.returncode == 0, 'subprocess_failed_' + re.sub('[^a-z0-9_]', '_', args[0]))
        return result.stdout.strip()

    try:
        images = {}
        for image in [OLD_IMAGE, NEW_IMAGE, SSO_IMAGE, 'mysql:8.4', 'node:22-bookworm-slim']:
            image_id = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
            check(re.fullmatch(r'sha256:[a-f0-9]{64}', image_id), 'invalid_image_id')
            images[image] = image_id
        check(images[OLD_IMAGE] == OLD_ID, 'old_image_id_mismatch')
        check(images[NEW_IMAGE] != OLD_ID, 'new_image_equals_old')
        report['images'] = images
        check(not command(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={project}']), 'project_collision')
        source = MOCK.read_bytes()
        patched = patch_mock(source.decode('utf-8')).encode('utf-8')
        (directory / 'mock-services.mjs').write_bytes(patched)
        report['sourceSha256'] = {'mockOriginal': digest(source), 'mockPatched': digest(patched),
                                  'launcher': digest(Path(__file__).read_bytes()), 'probe': digest((HERE / 'probe.mjs').read_bytes())}
        (directory / 'certs').mkdir()
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(directory / 'certs/idp-key.pem'),
                 '-out', str(directory / 'certs/idp-cert.pem'), '-days', '1', '-subj', '/CN=timeout-fixture.test'])
        for name in ['idp-key.pem', 'idp-cert.pem']:
            (directory / 'certs' / name).chmod(0o644)
        spec = specification(project, directory)
        validate(spec)
        (directory / 'compose.json').write_text(json.dumps(spec), encoding='utf-8')
        report['composeSha256'] = digest((directory / 'compose.json').read_bytes())
        provisioned = True
        command(compose + ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '140', 'proxy'], 150)
        fingerprint = command(compose + ['exec', '-T', '-e', f'MYSQL_PWD={DB_PASSWORD}', 'mysql', 'mysql',
                                          '-upool_fixture', '-Nse', f'SELECT config_fingerprint FROM {DATABASE}.user_pool_settings WHERE id=1'])
        check(re.fullmatch(r'[a-f0-9]{64}', fingerprint), 'old_fingerprint_missing')
        report['oldOnlyFingerprint'] = fingerprint
        command(compose + ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '30', 'new'], 40)
        report['runtimeExecuted'] = True
        probe_command = compose + ['exec', '-T', '-e', 'TIMEOUT_FIXTURE_EXECUTE=1', '-e', f'BASELINE_FINGERPRINT={fingerprint}',
                                   'proxy', 'node', '--input-type=module']
        with subprocess.Popen(probe_command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              env=environment) as process:
            process.stdin.write((HERE / 'probe.mjs').read_bytes())
            process.stdin.close()
            deadline = min(started + 865, time.monotonic() + 710)
            pending = ''
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            try:
                while selector.get_map():
                    check(time.monotonic() < deadline, 'probe_deadline_exhausted')
                    for key, _ in selector.select(timeout=min(1, max(0, deadline - time.monotonic()))):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        pending += chunk.decode('utf-8')
                        check(len(pending) < 65536, 'probe_report_line_too_large')
                        while '\n' in pending:
                            line, pending = pending.split('\n', 1)
                            if not line.strip():
                                continue
                            event = json.loads(line)
                            report['events'].append(event)
                            print(json.dumps(event), flush=True)
                            output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
                check(process.wait(timeout=5) == 0, 'probe_runtime_failed')
            finally:
                selector.close()
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        check(any(event.get('case') == 'all_runtime_cases' and event.get('status') == 'PASS' for event in report['events']),
              'probe_completion_missing')
        report['status'] = 'PASS'
    except Exception as error:
        # Never serialize subprocess stderr, environment, raw API bodies or credentials.
        report['failure'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        if provisioned:
            try:
                logs = subprocess.run(compose + ['logs', '--no-color'], capture_output=True, text=True, timeout=15, env=environment)
                (directory / 'containers.private.log').write_text(logs.stdout + logs.stderr, encoding='utf-8')
                (directory / 'containers.private.log').chmod(0o600)
                result = subprocess.run(compose + ['down', '--volumes', '--remove-orphans', '--timeout', '5'],
                                        capture_output=True, text=True, timeout=30, env=environment)
                report['cleanup'] = 'PASS' if result.returncode == 0 else 'FAIL'
            except Exception:
                report['cleanup'] = 'FAIL'
        else:
            report['cleanup'] = 'not_needed'
        if report['cleanup'] == 'FAIL':
            report['status'] = 'FAIL'
        report['elapsedSeconds'] = round(time.monotonic() - started, 3)
        output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        report['evidenceDirectory'] = str(directory)
        print(json.dumps({'report': str(output), 'status': report['status'], 'cleanup': report['cleanup']}), flush=True)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--self-check', action='store_true')
    modes.add_argument('--execute-isolated-test', action='store_true')
    args = parser.parse_args()
    if args.self_check:
        self_check()
    else:
        sys.exit(execute())
