#!/usr/bin/env python3
"""Opt-in, isolated Linux Docker E2E. --help/--self-check never invoke Docker.

Input directory: hook.py (or user_pool_hook.py), canary.py (or
user_pool_canary_hook.py), render.py, nginx.conf.template, mock-services.mjs,
and optionally test_user_pool_runtime.py + test_user_pool_canary_runtime.py.
No downloads/builds, production config, host ports, or reusable data volumes.
"""
from __future__ import annotations
import argparse
import ast
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
IMAGES = dict(proxy="ghcp-pool-mysql-proxy:observability-v5", sso="ghcp-pool-mysql-sso:check",
              mock="node:22-bookworm-slim", mysql="mysql:8.4", postgres="postgres:16",
              litellm="ghcr.io/berriai/litellm:v1.99.1", nginx="nginx:1.30.5-alpine", tester="python:3.12-alpine")


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def compose_document(root, subnet, secret):
    """Pure builder, deliberately no ports/external networks/named volumes/builds."""
    def mount(name, target=None):
        return f"{root / name}:{target or '/fixtures/' + name}:ro"
    def service(image, networks, **kw):
        return dict(image=IMAGES[image], networks=networks, restart="no", cpus=1,
                    mem_limit="512m", pids_limit=160, logging={"driver": "json-file", "options": {"max-size": "5m", "max-file": "2"}}, **kw)
    networks = {f"pool{i}": {"internal": True} for i in range(1, 6)}
    networks["router"] = {"internal": True, "ipam": {"config": [{"subnet": subnet}]}}
    auth = {"INTERNAL_API_TOKEN": secret["internal"], "LOG_LEVEL": "warn"}
    mysqlnets = {f"pool{i}": {"aliases": ["mysql"]} for i in range(1, 6)}
    services = {
        "mysql": service("mysql", mysqlnets, command=["--character-set-server=utf8mb4", "--collation-server=utf8mb4_bin", "--max-connections=100", "--log-bin-trust-function-creators=1"],
                         environment={"MYSQL_ROOT_PASSWORD": secret["mysql"], "MYSQL_ROOT_HOST": "%"},
                         volumes=[mount("mysql-init.sql", "/docker-entrypoint-initdb.d/01-fixture.sql")], tmpfs=["/var/lib/mysql:rw,size=768m"]),
        "postgres": service("postgres", ["router"], environment={"POSTGRES_USER": "fixture", "POSTGRES_PASSWORD": secret["postgres"], "POSTGRES_DB": "litellm"}, tmpfs=["/var/lib/postgresql/data:rw,size=768m"]),
        "tester": service("tester", ["router"] + [f"pool{i}" for i in range(1, 6)],
                          command=["python", "-c", "import time; time.sleep(900)"], volumes=[mount("probe.py"), mount("secrets.json")]),
        "nginx": service("nginx", ["router"], user="101:101", read_only=True, tmpfs=["/tmp:rw,size=64m,mode=1777"],
                         entrypoint=["nginx"], command=["-c", "/etc/nginx/nginx.conf", "-g", "daemon off;"],
                         volumes=[mount("nginx.conf", "/etc/nginx/nginx.conf")], cap_drop=["ALL"], security_opt=["no-new-privileges:true"]),
        "litellm": service("litellm", {"router": {"ipv4_address": str(ipaddress.ip_network(subnet).network_address + 10)}},
                           command=["--config", "/fixtures/litellm.json", "--port", "7000", "--num_workers", "1"],
                           environment={"DATABASE_URL": f"postgresql://fixture:{secret['postgres']}@postgres:5432/litellm", "LITELLM_MASTER_KEY": secret["master"], "LITELLM_SALT_KEY": secret["salt"], "GHCP_POOL_API_BASES": "http://nginx:8080", "GHCP_PROXY_API_KEY": secret["api"], "LITELLM_LOCAL_MODEL_COST_MAP": "True", "LITELLM_TELEMETRY": "False", "PYTHONPATH": "/fixtures"},
                           volumes=[mount(x) for x in ["litellm.json", "user_pool_hook.py", "user_pool_canary_hook.py", "fixture_hook.py"]]),
    }
    services["mysql"]["mem_limit"] = "1536m"
    services["postgres"]["mem_limit"] = "1g"
    services["litellm"]["mem_limit"] = "2g"
    services["litellm"]["cpus"] = 2
    for i in range(1, 6):
        net = f"pool{i}"
        services[f"mock{i}"] = service("mock", {net: {"aliases": ["mock"]}}, command=["node", "/fixtures/mock-services.mjs"],
            environment={**auth, "SCIM_TOKEN": secret["scim"], "SEAT_PAT": secret["seat"], "SSO_DEFAULT_USER_PASSWORD": secret["sso"], "PROXY_BASE_URL": "http://proxy:3000"}, volumes=[mount("mock-services.mjs")])
        services[f"sso{i}"] = service("sso", {net: {"aliases": ["sso"]}}, working_dir="/app/src/sso", command=["node", "dist/index.js"],
            environment={**auth, "PORT": "7001", "DB_PATH": "/data/sso.sqlite", "BASE_URL": "http://sso:7001", "PROXY_BASE_URL": "http://proxy:3000", "SESSION_SECRET": secret["session"], "SSO_DEFAULT_USER_PASSWORD": secret["sso"], "SSO_USER_EVENTS_LOG": "/data/events.log", "ENTERPRISE_SLUG": "local-test", "ENTERPRISE_SHORTCODE": "test", "GITHUB_API_BASE_URL": "http://mock:8002", "GITHUB_COPILOT_SEAT_PAT": secret["seat"], "SCIM_BASE_URL": "http://mock:8002/scim/v2/enterprises/local-test", "SCIM_TOKEN": secret["scim"], "SP_ENTITY_ID": "http://mock:8002/saml", "SP_ACS_URL": "http://mock:8002/saml/acs", "CERT_DIR": "/certs"},
            volumes=[mount("certs", "/certs")], tmpfs=["/data:rw,size=64m,mode=1777"])
        services[f"pool{i}"] = service("proxy", {net: {"aliases": ["proxy"]}, "router": {"aliases": [f"pool{i}"]}}, working_dir="/app/src/proxy", command=["node", "dist/index.js"],
            environment={**auth, "PORT": "3000", "STORAGE_DRIVER": "mysql", "MYSQL_URL": f"mysql://fixture:{secret['mysql']}@mysql:3306/pool{i}", "MYSQL_CONNECTION_LIMIT": "10", "MYSQL_SSL_MODE": "disabled", "API_KEY": secret["api"], "ACCOUNT_ROUTING_MODE": "caller-lease", "POOL_ACCOUNT_EMAIL_DOMAIN": f"pool{i}.nginx.example.test", "POOL_WARMUP_MODEL": "claude-opus-5-2", "READY_IDLE_TARGET": "0", "POOL_MAX_ACCOUNTS": "4", "CALLER_LEASE_TTL_SECONDS": "3600", "PROVISIONAL_LEASE_TTL_SECONDS": "60", "PREWARM_POLL_SECONDS": "1", "PREWARM_CONCURRENCY": "2", "POOL_REQUEST_TIMEOUT_SECONDS": "30", "SSO_BASE_URL": "http://sso:7001", "LOGIN_BASE_URL": "http://mock:8002", "COPILOT_API_BASE_URL": "http://mock:8002", "ENTERPRISE_SHORTCODE": "test", "PROXY_ERROR_DIAGNOSTICS_ENABLED": "false", "PROXY_ERROR_DIAGNOSTICS_REDACT": "true"})
    return {"services": services, "networks": networks}


def self_check():
    for name in ("run.py", "probe.py"):
        text = (HERE / name).read_text(encoding="utf-8")
        ast.parse(text)
        compile(text, name, "exec")
    doc = compose_document(Path("/opt/ghcp-nginx-e2e-selfcheck"), "172.29.250.0/24", {k: "synthetic" for k in ("internal", "mysql", "postgres", "master", "salt", "api", "scim", "seat", "sso", "session")})
    assert len(doc["services"]) == 20
    assert all(n["internal"] for n in doc["networks"].values())
    assert all(not any(k in s for k in ("ports", "build", "container_name", "privileged")) for s in doc["services"].values())
    for i in range(1, 6):
        assert list(doc["services"][f"mock{i}"]["networks"]) == [f"pool{i}"]
        assert list(doc["services"][f"sso{i}"]["networks"]) == [f"pool{i}"]
    print("PASS syntax_and_isolation_self_check (no Docker invoked)")


class Runner:
    def __init__(self, args):
        self.args = args
        self.root = Path(tempfile.mkdtemp(prefix="ghcp-nginx-e2e-", dir="/opt"))
        self.root.chmod(0o711)  # Container UID can traverse; private files remain 0600.
        self.project = self.root.name
        self.deadline = time.monotonic() + 780  # Reserve two minutes for teardown, total <=15 min.
        self.report = {"project": self.project, "status": "FAIL", "checks": [], "secrets": "omitted; raw logs private"}
        self.compose = ["docker", "compose", "--project-name", self.project, "--project-directory", str(self.root), "-f", str(self.root / "compose.json")]
        self.cleanup_mode = False

    def command(self, args, name, timeout=60, check=True):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise RuntimeError("overall_deadline")
        path = self.root / (name + ".private.log")
        with path.open("ab") as log:
            path.chmod(0o600)
            result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=min(timeout, left), check=False)
        if check and result.returncode:
            raise RuntimeError(name + "_failed")
        return result.returncode

    def capture(self, args):
        return subprocess.check_output(args, timeout=min(30, max(1, self.deadline - time.monotonic())), stderr=subprocess.DEVNULL).decode()

    def check(self, label, result):
        self.report["checks"].append({"check": label, "passed": result})

    def setup(self):
        source = self.args.source_dir.resolve(strict=True)
        for output, names in {"user_pool_hook.py": ["user_pool_hook.py", "hook.py"], "user_pool_canary_hook.py": ["user_pool_canary_hook.py", "canary.py"], "render.py": ["render.py"], "nginx.conf.template": ["nginx.conf.template"], "mock-services.mjs": ["mock-services.mjs"]}.items():
            origin = next((source / n for n in names if (source / n).is_file()), None)
            if not origin:
                raise RuntimeError("missing_source_" + output)
            shutil.copyfile(origin, self.root / output)
        shutil.copyfile(HERE / "probe.py", self.root / "probe.py")
        secret = {k: secrets.token_hex(24) for k in ("internal", "mysql", "postgres", "master", "salt", "api", "scim", "seat", "sso", "session")}
        secret["master"] = "sk-" + secret["master"]
        dump(self.root / "secrets.json", secret)
        for key, image in IMAGES.items():
            data = json.loads(self.capture(["docker", "image", "inspect", image]))[0]
            if key == "proxy" and not data["Id"].startswith("sha256:552d81e93870"):
                raise RuntimeError("proxy_image_id_mismatch")
            self.report.setdefault("images", {})[key] = {"ref": image, "id": data["Id"]}
        network_ids = self.capture(["docker", "network", "ls", "-q"]).split()
        used = []
        if network_ids:
            for item in json.loads(self.capture(["docker", "network", "inspect", *network_ids])):
                used.extend(ipaddress.ip_network(c["Subnet"]) for c in (item.get("IPAM", {}).get("Config") or []) if c.get("Subnet"))
        subnet = next((f"172.29.{n}.0/24" for n in range(240, 10, -1) if all(not ipaddress.ip_network(f"172.29.{n}.0/24").overlaps(u) for u in used if u.version == 4)), None)
        if not subnet:
            raise RuntimeError("no_unused_test_subnet")
        spec = importlib.util.spec_from_file_location("fixture_render", self.root / "render.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = module.render({"backends": [f"pool{i}:3000" for i in range(1, 6)], "trustedCidrs": [str(ipaddress.ip_network(subnet).network_address + 10) + "/32"]})
        (self.root / "nginx.conf").write_text(config)
        (self.root / "nginx.conf").chmod(0o644)
        (self.root / "fixture_hook.py").write_text('from user_pool_canary_hook import UserPoolCanaryHook\nproxy_handler_instance = UserPoolCanaryHook(["http://nginx:8080"], prefixes="047ad")\n')
        dump(self.root / "litellm.json", {"model_list": [{"model_name": "claude-opus-5-2", "litellm_params": {"model": "anthropic/claude-opus-5-2", "api_base": "http://nginx:8080", "api_key": "os.environ/GHCP_PROXY_API_KEY", "max_retries": 0}}], "litellm_settings": {"callbacks": ["fixture_hook.proxy_handler_instance"], "cache": False, "telemetry": False, "set_verbose": False, "turn_off_message_logging": True, "num_retries": 0, "request_timeout": 30}, "router_settings": {"num_retries": 0, "fallbacks": [], "context_window_fallbacks": [], "content_policy_fallbacks": [], "disable_cooldowns": True}, "general_settings": {"master_key": "os.environ/LITELLM_MASTER_KEY", "database_url": "os.environ/DATABASE_URL", "background_health_checks": False, "disable_spend_logs": True}})
        (self.root / "mysql-init.sql").write_text(f"CREATE USER 'fixture'@'%' IDENTIFIED BY '{secret['mysql']}';\n" + "\n".join(f"CREATE DATABASE pool{i} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin; GRANT ALL ON pool{i}.* TO 'fixture'@'%';" for i in range(1, 6)))
        (self.root / "mysql-init.sql").chmod(0o644)
        certs = self.root / "certs"
        certs.mkdir(mode=0o755)
        certs.chmod(0o755)
        self.command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(certs / "idp-key.pem"), "-out", str(certs / "idp-cert.pem"), "-days", "1", "-subj", "/CN=synthetic.pool.example.test"], "certificate")
        (certs / "idp-key.pem").chmod(0o644)  # Disposable test cert, readable by the SSO image user.
        (certs / "idp-cert.pem").chmod(0o644)
        for name in ("user_pool_hook.py", "user_pool_canary_hook.py", "fixture_hook.py", "litellm.json", "mock-services.mjs"):
            (self.root / name).chmod(0o644)
        dump(self.root / "compose.json", compose_document(self.root, subnet, secret))
        tests = [n for n in ("test_user_pool_runtime.py", "test_user_pool_canary_runtime.py") if (source / n).is_file()]
        if self.args.runtime_tests:
            if len(tests) != 2:
                raise RuntimeError("both_runtime_test_sources_required")
            for n in tests:
                shutil.copyfile(source / n, self.root / n)
            code = self.command(["docker", "run", "--rm", "--pull=never", "--network", "none", "--name", self.project + "-runtime", "--label", "ghcp.fixture=" + self.project, "--cpus", "2", "--memory", "2g", "--pids-limit", "160", "-e", "LITELLM_LOCAL_MODEL_COST_MAP=True", "-e", "LITELLM_TELEMETRY=False", "-e", "GHCP_POOL_API_BASES=http://proxy.test:3000", "-e", "GHCP_POOL_TEST_LITELLM_VERSION=1.99.1", "-e", "PYTHONPATH=/fixtures", "-v", str(self.root) + ":/fixtures:ro", "--workdir", "/fixtures", "--entrypoint", "python", IMAGES["litellm"], "-m", "unittest", "-v", *[n[:-3] for n in tests]], "runtime-tests", timeout=120, check=False)
            self.check("real_litellm_1_99_1_runtime_tests_network_none", code == 0)
        else:
            self.report["runtime_tests"] = "NOT_RUN (enable --runtime-tests)"

    def up(self, *services):
        self.command(self.compose + ["up", "-d", "--no-deps", "--pull", "never", *services], "compose-up", timeout=100)

    def probe(self, *args, timeout=100):
        self.command(self.compose + ["exec", "-T", "tester", "python", "/fixtures/probe.py", *args], "probe-" + args[0], timeout=timeout)

    def run(self):
        self.previous_containers = set(self.capture(["docker", "ps", "-aq"]).split())
        self.previous_volumes = set(self.capture(["docker", "volume", "ls", "-q"]).split())
        self.setup()
        self.up("mysql", "postgres", "tester", *[f"mock{i}" for i in range(1, 6)], *[f"sso{i}" for i in range(1, 6)])
        # DB entrypoint can answer connections while initialization is in progress.
        for _ in range(90):
            rc = self.command(self.compose + ["exec", "-T", "mysql", "sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=tcp -h127.0.0.1 -uroot -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name REGEXP \'^pool[1-5]$\'" | tr -d "\\r\\n" | test "$(cat)" = 5'], "mysql-ready", timeout=5, check=False)
            if rc == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("mysql_not_ready")
        for i in range(1, 6):  # v5 uses a global MySQL migration lock: strictly sequential boots.
            self.probe("wait-sso", str(i), timeout=65)
            self.up(f"pool{i}")
            self.probe("wait-pool", str(i), timeout=70)
        self.up("nginx", "litellm")
        cid = self.capture(self.compose + ["ps", "-q", "litellm"]).strip()
        container = json.loads(self.capture(["docker", "inspect", cid]))[0]
        expected = json.loads((self.root / "compose.json").read_text())["services"]["litellm"]["networks"]["router"]["ipv4_address"]
        actual = container["NetworkSettings"]["Networks"][self.project + "_router"]["IPAddress"]
        if actual != expected:
            raise RuntimeError("litellm_trusted_ip_mismatch")
        self.check("exact_litellm_trusted_ip", True)
        self.probe("wait-gateway", timeout=150)
        self.command(self.compose + ["exec", "-T", "litellm", "python", "-c", 'import importlib.metadata; assert importlib.metadata.version("litellm") == "1.99.1"'], "litellm-version")
        self.check("real_litellm_version", True)
        # E2E including prewarm, key creation, requests, independent inspection/revoke <=10 min.
        e2e_rc = self.command(self.compose + ["exec", "-T", "tester", "python", "/fixtures/probe.py", "e2e"], "probe-e2e", timeout=min(600, max(1, self.deadline - time.monotonic())), check=False)
        for line in (self.root / "probe-e2e.private.log").read_text(errors="replace").splitlines():
            if line.startswith("CHECK "):
                self.report["checks"].append(json.loads(line[6:]))
        if e2e_rc:
            raise RuntimeError("e2e_probe_failed")
        self.report["status"] = "PASS" if all(x["passed"] for x in self.report["checks"]) else "FAIL"

    def teardown(self):
        self.deadline = time.monotonic() + 110
        self.command(self.compose + ["logs", "--no-color", "--tail", "2000"], "services", timeout=30, check=False)
        self.command(["docker", "rm", "-f", self.project + "-runtime"], "runtime-cleanup", timeout=10, check=False)
        rc = self.command(self.compose + ["down", "--volumes", "--remove-orphans", "--timeout", "5"], "teardown", timeout=65, check=False)
        self.check("test_owned_teardown", rc == 0)
        remaining = self.capture(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + self.project]).strip()
        networks = self.capture(["docker", "network", "ls", "-q", "--filter", "label=com.docker.compose.project=" + self.project]).strip()
        preserved = self.previous_containers.issubset(set(self.capture(["docker", "ps", "-aq"]).split())) and self.previous_volumes.issubset(set(self.capture(["docker", "volume", "ls", "-q"]).split()))
        self.check("owned_resources_removed_and_previous_resources_preserved", not remaining and not networks and preserved)
        if rc or remaining or networks or not preserved:
            self.report["status"] = "FAIL"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-dir", type=Path, help="Flat source inputs supplied by coordinator")
    p.add_argument("--execute-isolated-test", action="store_true", help="Explicit opt-in: create and tear down only this fresh test project")
    p.add_argument("--runtime-tests", action="store_true", help="Run both optional genuine LiteLLM runtime suites with network none; failures remain failures")
    p.add_argument("--self-check", action="store_true", help="Parse scripts/check isolation invariants, no Docker or filesystem writes")
    args = p.parse_args()
    if args.self_check:
        self_check()
        return 0
    if not args.execute_isolated_test or not args.source_dir:
        p.error("requires --source-dir and --execute-isolated-test; no action performed")
    if sys.platform != "linux":
        p.error("execution requires a Linux host; no action performed")
    os.umask(0o077)
    runner = Runner(args)
    def interrupted(signum, frame):
        raise RuntimeError("interrupted")
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        runner.run()
    except Exception as exc:
        import traceback
        trace = runner.root / "failure.private.log"
        trace.write_text(traceback.format_exc())
        trace.chmod(0o600)
        runner.report["failure"] = str(exc) if isinstance(exc, RuntimeError) and str(exc).replace("_", "").replace(".", "").isalnum() else type(exc).__name__
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        try:
            runner.teardown()
        except Exception:
            runner.report["status"] = "FAIL"
            runner.report["teardown"] = "INCOMPLETE; inspect private logs; only remove resources labelled with this project"
        dump(runner.root / "report.json", runner.report)
    print(json.dumps({"status": runner.report["status"], "report": str(runner.root / "report.json"), "private_logs": str(runner.root)}))
    return 0 if runner.report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
