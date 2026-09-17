"""Render Compose only; never starts containers or contacts a tenant."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("docker"), "Docker Compose is not available")
class ComposeConfigTests(unittest.TestCase):
    def render(self, *, pool=False, mysql_pool=False, **overrides):
        env = dict(os.environ)
        # Ignore live shell settings; use the public template and synthetic values.
        for line in (ROOT / ".env.example").read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                env.pop(line.split("=", 1)[0], None)
        env.pop("POOL_INFERENCE_TIMEOUT_SECONDS", None)
        env.update(overrides)
        command = ["docker", "compose", "--env-file", str(ROOT / ".env.example"),
                   "-f", str(ROOT / "docker-compose.yml")]
        if pool:
            command.extend(["-f", str(ROOT / "docker-compose.user-pool.yml")])
        if mysql_pool:
            command.extend(["-f", str(ROOT / "docker-compose.user-pool-mysql.yml")])
        return subprocess.run(command + ["config", "--format", "json"], env=env,
                              capture_output=True, text=True, timeout=30)

    def test_default_remains_direct(self):
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        env = json.loads(result.stdout)["services"]["proxy"]["environment"]
        self.assertEqual(env["ACCOUNT_ROUTING_MODE"], "direct")
        self.assertNotIn("POOL_CALLER_EMAIL_DOMAIN", env)

    def test_explicit_pool_overlay_forces_safe_contract(self):
        result = self.render(pool=True, POOL_ACCOUNT_EMAIL_DOMAIN="pool.example.com", POOL_WARMUP_MODEL="gpt-4o",
                             STORAGE_DRIVER="mysql", ACCOUNT_ROUTING_MODE="direct",
                             SSO_DEFAULT_USER_PASSWORD="local-test-password-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        proxy = json.loads(result.stdout)["services"]["proxy"]
        env = proxy["environment"]
        self.assertEqual(env["ACCOUNT_ROUTING_MODE"], "caller-lease")
        self.assertEqual(env["STORAGE_DRIVER"], "sqlite")
        self.assertEqual(env["IDENTITY_HEADER"], "X-User-Identity")
        self.assertEqual(env["PROXY_ERROR_DIAGNOSTICS_ENABLED"], "false")
        self.assertEqual(proxy["deploy"]["replicas"], 1)
        self.assertEqual(len(proxy["ports"]), 1)
        self.assertEqual(proxy["ports"][0]["host_ip"], "127.0.0.1")
        self.assertNotIn("POOL_CALLER_EMAIL_DOMAIN", env)
        for name, value in {"READY_IDLE_TARGET": "10", "POOL_MAX_ACCOUNTS": "100",
                            "CALLER_LEASE_TTL_SECONDS": "172800", "PROVISIONAL_LEASE_TTL_SECONDS": "300",
                            "PREWARM_POLL_SECONDS": "5", "POOL_EXHAUSTED_RETRY_AFTER_SECONDS": "30",
                            "POOL_REQUEST_TIMEOUT_SECONDS": "120"}.items():
            self.assertEqual(env[name], value)

    def test_mysql_pool_uses_shared_database_without_shared_sqlite_or_host_port(self):
        result = self.render(mysql_pool=True, POOL_ACCOUNT_EMAIL_DOMAIN="pool.example.test",
                             POOL_WARMUP_MODEL="test-model", SSO_DEFAULT_USER_PASSWORD="local-test-password-only",
                             MYSQL_URL="mysql://test:test@db.test/pool", PROXY_CLUSTER_BASE_URL="http://lb.test:8081")
        self.assertEqual(result.returncode, 0, result.stderr)
        services = json.loads(result.stdout)["services"]
        proxy = services["proxy"]
        self.assertEqual(proxy["environment"]["STORAGE_DRIVER"], "mysql")
        self.assertEqual(proxy["environment"]["ACCOUNT_ROUTING_MODE"], "caller-lease")
        self.assertEqual(proxy["environment"]["POOL_LOGIN_MAX_PENDING"], "5")
        self.assertEqual(proxy["deploy"]["replicas"], 2)
        self.assertFalse(proxy.get("ports"))
        self.assertFalse(proxy.get("volumes"))
        for name in ["sso", "login", "console"]:
            self.assertEqual(services[name]["environment"]["PROXY_BASE_URL"], "http://lb.test:8081")
            self.assertTrue(services[name]["volumes"])

    def test_inference_override_is_separate_and_defaults_to_legacy_budget(self):
        for legacy, override, expected in (("120", None, "120"), ("300", None, "300"), ("120", "600", "600")):
            values = {"POOL_REQUEST_TIMEOUT_SECONDS": legacy}
            if override is not None:
                values["POOL_INFERENCE_TIMEOUT_SECONDS"] = override
            with self.subTest(legacy=legacy, override=override):
                result = self.render(**values)
                self.assertEqual(result.returncode, 0, result.stderr)
                services = json.loads(result.stdout)["services"]
                self.assertEqual(services["proxy"]["environment"]["POOL_REQUEST_TIMEOUT_SECONDS"], legacy)
                self.assertEqual(services["proxy"]["environment"]["POOL_INFERENCE_TIMEOUT_SECONDS"], expected)
                for name in ("sso", "login", "console"):
                    self.assertNotIn("POOL_INFERENCE_TIMEOUT_SECONDS", services[name]["environment"])

    def test_mysql_pool_requires_database_and_internal_load_balancer(self):
        self.assertNotEqual(self.render(mysql_pool=True, POOL_ACCOUNT_EMAIL_DOMAIN="pool.example.test",
                                       POOL_WARMUP_MODEL="test-model", SSO_DEFAULT_USER_PASSWORD="local-test-password-only").returncode, 0)

    def test_pool_overlay_requires_explicit_sso_password(self):
        self.assertNotEqual(self.render(pool=True, POOL_ACCOUNT_EMAIL_DOMAIN="pool.example.com",
                                       POOL_WARMUP_MODEL="gpt-4o").returncode, 0)

    def test_pool_overlay_requires_domain_and_warmup_model(self):
        self.assertNotEqual(self.render(pool=True).returncode, 0)
        self.assertNotEqual(self.render(pool=True, POOL_ACCOUNT_EMAIL_DOMAIN="pool.example.com").returncode, 0)
        self.assertNotEqual(self.render(pool=True, POOL_WARMUP_MODEL="gpt-4o").returncode, 0)


if __name__ == "__main__":
    unittest.main()
