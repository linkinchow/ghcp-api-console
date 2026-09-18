"""只验证配置契约，不启动 NGINX 或访问网络。"""

import copy
import importlib.util
import re
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("hash_router_render", Path(__file__).with_name("render.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.config = {"backends": [f"proxy.pool{i}.svc.cluster.local:3000" for i in range(1, 6)],
                       "trustedCidrs": ["127.0.0.1/32", "::1/128"]}

    def test_every_nibble_has_exactly_one_requested_destination(self):
        text = module.render(self.config)
        rules = re.findall(r'"~([^"\n]+)" (ghcp_pool_\d);', text)
        expected = "1111222333444555"
        for nibble, pool in zip("0123456789abcdef", expected):
            matches = [name for pattern, name in rules if re.fullmatch(pattern, "sha256:" + nibble + "a" * 63)]
            self.assertEqual(matches, ["ghcp_pool_" + pool])

    def test_invalid_identity_has_no_destination(self):
        text = module.render(self.config)
        rules = re.findall(r'"~([^"\n]+)" ghcp_pool_\d;', text)
        for identity in ("", "0" * 64, "sha256:" + "0" * 63, "sha256:" + "0" * 65,
                         "sha256:" + "A" * 64, "SHA256:" + "0" * 64,
                         "sha256:" + "0" * 63 + "g", "sha256:" + "0" * 64 + ",sha256:" + "a" * 64):
            self.assertFalse(any(re.fullmatch(pattern, identity) for pattern in rules))

    def test_distinct_backends_and_source_controls_required(self):
        variants = [None, {}, {**self.config, "extra": 1}, {**self.config, "backends": []},
                    {**self.config, "backends": self.config["backends"][:4]},
                    {**self.config, "backends": ["proxy:3000"] * 5},
                    {**self.config, "trustedCidrs": []},
                    {**self.config, "trustedCidrs": ["0.0.0.0/0"]},
                    {**self.config, "trustedCidrs": ["::/0"]},
                    {**self.config, "trustedCidrs": ["all"]},
                    {**self.config, "trustedCidrs": ["127.0.0.1/32; allow all;"]}]
        for config in variants:
            with self.subTest(config=config), self.assertRaises(ValueError):
                module.render(config)

    def test_endpoint_injection_and_unknown_protocol_are_rejected(self):
        for host in ("http://proxy:3000", "proxy:3000/path", "proxy:3000;server bad:80", "proxy:0",
                     "proxy:65536", "proxy:3000\n", "proxy:3000 backup", "user@proxy:3000",
                     "-proxy:3000", "proxy..test:3000", "999.1.1.1:3000", "$name:3000"):
            config = copy.deepcopy(self.config)
            config["backends"][0] = host
            with self.subTest(host=host), self.assertRaises(ValueError):
                module.render(config)

    def test_dns_ipv4_ipv6_and_config_preservation(self):
        original = copy.deepcopy(self.config)
        self.assertEqual(module.endpoint("PROXY.test:3000"), "proxy.test:3000")
        self.assertEqual(module.endpoint("127.0.0.1:80"), "127.0.0.1:80")
        self.assertEqual(module.endpoint("[::1]:3000"), "[::1]:3000")
        text = module.render(self.config)
        self.assertNotIn("REPLACE_", text)
        self.assertIn("allow 127.0.0.1/32;", text)
        self.assertIn("deny all;", text)
        self.assertEqual(self.config, original)

    def test_proxy_stream_auth_and_no_replay_contract(self):
        text = module.render(self.config)
        for directive in ("proxy_pass http://$ghcp_pool;", "proxy_next_upstream off;",
                          "proxy_intercept_errors off;", "proxy_buffering off;", "proxy_cache off;",
                          "proxy_ignore_client_abort off;", "proxy_set_header X-User-Identity $http_x_user_identity;",
                          "proxy_set_header Authorization $http_authorization;",
                          "proxy_set_header X-API-Key $http_x_api_key;",
                          'proxy_set_header X-Internal-Token "";', "access_log off;"):
            self.assertIn(directive, text)
        self.assertNotIn(" backup", text)
        self.assertNotIn("error_page", text)
        self.assertNotIn("proxy_hide_header Retry-After", text)
        self.assertNotIn("real_ip_header", text)

    def test_method_and_route_allowlist(self):
        text = module.render(self.config)
        rules = re.findall(r'"~([^"\n]+)" 1;', text)
        accepted = ["GET:/v1/models", "HEAD:/v1/models", "POST:/v1/messages",
                    "POST:/chat/completions", "POST:/responses", "POST:/v1/messages/count_tokens"]
        rejected = ["GET:/api/accounts", "POST:/internal/accounts", "GET:/v1/messages",
                    "DELETE:/v1/models", "POST:/v1/chat/completions", "POST:/v1/responses"]
        for value in accepted:
            self.assertTrue(any(re.fullmatch(pattern, value) for pattern in rules), value)
        for value in rejected:
            self.assertFalse(any(re.fullmatch(pattern, value) for pattern in rules), value)


if __name__ == "__main__":
    unittest.main()
