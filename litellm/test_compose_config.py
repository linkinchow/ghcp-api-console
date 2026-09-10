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
    def render(self, *, pool=False, **overrides):
        env = dict(os.environ)
        # Ignore live shell settings; use the public template and synthetic values.
        for line in (ROOT / ".env.example").read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                env.pop(line.split("=", 1)[0], None)
        env.update(overrides)
        command = ["docker", "compose", "--env-file", str(ROOT / ".env.example"),
                   "-f", str(ROOT / "docker-compose.yml")]
        if pool:
            command.extend(["-f", str(ROOT / "docker-compose.user-pool.yml")])
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

    def test_pool_overlay_requires_explicit_sso_password(self):
        self.assertNotEqual(self.render(pool=True, POOL_ACCOUNT_EMAIL_DOMAIN="pool.example.com",
                                       POOL_WARMUP_MODEL="gpt-4o").returncode, 0)

    def test_pool_overlay_requires_domain_and_warmup_model(self):
        self.assertNotEqual(self.render(pool=True).returncode, 0)
        self.assertNotEqual(self.render(pool=True, POOL_ACCOUNT_EMAIL_DOMAIN="pool.example.com").returncode, 0)
        self.assertNotEqual(self.render(pool=True, POOL_WARMUP_MODEL="gpt-4o").returncode, 0)


if __name__ == "__main__":
    unittest.main()
