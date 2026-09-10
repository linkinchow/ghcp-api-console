"""Offline security tests. LiteLLM imports are stubbed, never provider services.

The optional real-runtime suite is test_user_pool_runtime.py; do not mistake
these unit tests for a running LiteLLM Proxy or real SAML/SCIM acceptance.
"""
import asyncio
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class StubAuth:
    """Only models the pinned UserAPIKeyAuth token normalization for unit tests."""
    def __init__(self, **values):
        if isinstance(values.get("api_key"), str) and values["api_key"].startswith("sk-"):
            values["token"] = hashlib.sha256(values["api_key"].encode()).hexdigest()
        self.__dict__.update(values)
        self.via_virtual_key = values.get("via_virtual_key", True)
        if isinstance(values.get("api_key"), str) and values["api_key"].startswith("sk-"):
            self.api_key = values["token"]


class StubLogger:
    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        return kwargs


class StubHTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail
        super().__init__(detail)


def load_offline_hook():
    modules = {name: types.ModuleType(name) for name in (
        "fastapi", "litellm", "litellm.integrations", "litellm.integrations.custom_logger",
        "litellm.proxy", "litellm.proxy._types")}
    modules["fastapi"].HTTPException = StubHTTPException
    modules["litellm.integrations.custom_logger"].CustomLogger = StubLogger
    modules["litellm.proxy._types"].UserAPIKeyAuth = StubAuth
    spec = importlib.util.spec_from_file_location("offline_pool_hook", Path(__file__).with_name("user_pool_hook.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules), patch.dict(os.environ, {"GHCP_POOL_API_BASES": "http://proxy.test:3000"}):
        spec.loader.exec_module(module)
    return module


hook_module = load_offline_hook()
BASE = "http://proxy.test:3000"
OTHER = "https://other.example.com/v1"
HASH = "a" * 64
IDENTITY = "sha256:" + HASH


class PoolHookTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.hook = hook_module.UserPoolIdentityHook([BASE])

    async def authenticate(self, auth=None, data=None):
        return await self.hook.async_pre_call_hook(
            auth if auth is not None else StubAuth(token=HASH), None, data or {}, "completion")

    async def deploy(self, **kwargs):
        return await self.hook.async_pre_call_deployment_hook({"api_base": BASE, **kwargs}, "acompletion")

    async def test_db_token_hash_not_rehashed(self):
        await self.authenticate()
        self.assertEqual((await self.deploy())["extra_headers"]["X-User-Identity"], IDENTITY)

    async def test_server_hashed_token_variant(self):
        await self.authenticate(StubAuth(hashed_token=HASH))
        self.assertEqual((await self.deploy())["extra_headers"]["X-User-Identity"], IDENTITY)

    async def test_normalized_auth_api_key_uses_token_field(self):
        raw = "sk-unit-test-only-not-a-credential"
        auth = StubAuth(api_key=raw)
        await self.authenticate(auth)
        result = await self.deploy()
        self.assertEqual(result["extra_headers"]["X-User-Identity"], "sha256:" + hashlib.sha256(raw.encode()).hexdigest())
        self.assertNotIn(raw, repr(result))

    async def test_same_alias_different_keys_are_different_callers(self):
        values = []
        for digest in (HASH, "b" * 64):
            await self.authenticate(StubAuth(token=digest, key_alias="person@example.com"))
            values.append((await self.deploy())["headers"]["X-User-Identity"])
        self.assertNotEqual(*values)

    async def test_alias_rename_preserves_identity(self):
        for alias in (None, "first@example.com", "renamed@example.com"):
            await self.authenticate(StubAuth(token=HASH, key_alias=alias))
            self.assertEqual((await self.deploy())["headers"]["X-User-Identity"], IDENTITY)

    async def test_invalid_or_untrusted_auth_fails_closed(self):
        bad_auth = [None, {"token": HASH}, types.SimpleNamespace(token=HASH),
                    StubAuth(), StubAuth(key_alias="person@example.com"),
                    StubAuth(metadata={"token": HASH, "hashed_token": HASH}),
                    StubAuth(token="sk-raw-test-key"), StubAuth(token=HASH.upper()),
                    StubAuth(token="sha256:" + HASH), StubAuth(token=HASH + "\n"),
                    StubAuth(token=" " + HASH), StubAuth(token=123),
                    StubAuth(token=""), StubAuth(token=HASH, hashed_token="b" * 64),
                    StubAuth(token="invalid", hashed_token=HASH),
                    StubAuth(token=HASH, via_virtual_key=False),
                    StubAuth(token=HASH, is_session_token=True),
                    StubAuth(token=HASH, api_key='litellm-proxy-master-key'),
                    StubAuth(token=HASH, api_key='b' * 64)]
        for auth in bad_auth:
            with self.subTest(auth_type=type(auth).__name__):
                await self.hook.async_pre_call_hook(auth, None, {}, "completion")
                with self.assertRaises(StubHTTPException) as raised:
                    await self.deploy(metadata={"user_api_key": HASH, "user_api_key_auth": {"token": HASH}},
                                      user_api_key_auth={"token": HASH}, extra_headers={"X-User-Identity": IDENTITY})
                self.assertEqual(raised.exception.status_code, 403)
                self.assertEqual(raised.exception.detail, "ghcp_pool_trusted_identity_required")

    async def test_missing_early_hook_is_403(self):
        with self.assertRaises(StubHTTPException):
            await self.deploy()

    async def test_missing_next_auth_does_not_reuse_previous_request(self):
        await self.authenticate()
        await self.deploy()
        await self.hook.async_pre_call_hook(None, None, {}, "completion")
        with self.assertRaises(StubHTTPException):
            await self.deploy()

    async def test_all_override_locations_are_cleaned_without_shared_mutation(self):
        headers = {"x-user-identity": "forged", "X-USER-IDENTITY": "forged2", "traceparent": "preserved"}
        source = {"api_base": BASE, "headers": headers, "extra_headers": headers,
                  "default_headers": headers, "X-User-Identity": "forged",
                  "provider_specific_header": {"custom_llm_provider": "openai", "extra_headers": headers},
                  "extra_body": {"extra_headers": headers, "headers": headers},
                  "litellm_params": {"extra_body": {"headers": headers}},
                  "optional_params": {"extra_headers": headers},
                  "metadata": {"headers": headers, "other": "keep"},
                  "litellm_metadata": {"extra_headers": headers},
                  "proxy_server_request": {"headers": headers, "body": {"extra_headers": headers}},
                  "messages": [{"role": "user", "content": "X-User-Identity must remain in this prompt"}],
                  "client": object()}
        before = copy.deepcopy({k: v for k, v in source.items() if k != "client"})
        await self.authenticate()
        result = await self.hook.async_pre_call_deployment_hook(source)
        self.assertNotIn("forged", repr(result))
        self.assertEqual(result["headers"]["X-User-Identity"], IDENTITY)
        self.assertEqual(result["extra_headers"]["X-User-Identity"], IDENTITY)
        self.assertEqual(result["headers"]["traceparent"], "preserved")
        self.assertEqual(result["messages"], source["messages"])
        self.assertIsNone(result["client"])
        self.assertIsNotNone(source["client"])
        self.assertEqual({k: v for k, v in source.items() if k != "client"}, before)

    async def test_non_mapping_headers_fail_closed(self):
        await self.authenticate()
        for value in ("X-User-Identity: forged", [["X-User-Identity", "forged"]], 4):
            with self.assertRaises(StubHTTPException):
                await self.deploy(extra_body={"extra_headers": value})

    async def test_other_provider_is_unchanged_even_without_auth(self):
        original = {"api_base": OTHER, "extra_headers": {"x-user-identity": "other-provider-contract"},
                    "metadata": {"token": HASH}, "client": object()}
        self.assertIs(await self.hook.async_pre_call_deployment_hook(original), original)

    async def test_url_matching_exact_origin_path_and_effective_alias(self):
        await self.authenticate()
        for url in (BASE, BASE + "/", "http://PROXY.TEST:3000/"):
            self.assertIn("X-User-Identity", (await self.deploy(api_base=url))["headers"])
        for url in (OTHER, BASE + "-evil", BASE + "/chat/completions", BASE + "?x=y",
                    BASE + "#fragment", "http://proxy.test.evil.test:3000/v1",
                    "http://proxy.test:3001/v1", "https://proxy.test:3000/v1", "http://name@proxy.test:3000/v1"):
            source = {"api_base": url, "metadata": {"api_base": BASE}}
            self.assertIs(await self.hook.async_pre_call_deployment_hook(source), source)
        source = {"api_base": BASE, "base_url": OTHER}
        self.assertIs(await self.hook.async_pre_call_deployment_hook(source), source)
        self.assertEqual((await self.deploy(api_base=OTHER, base_url=BASE))["headers"]["X-User-Identity"], IDENTITY)

    async def test_deployment_fallback_both_directions_do_not_leak(self):
        request = {"model": "model-alias", "extra_headers": {"x-user-identity": "original"}}
        await self.authenticate(data=request)
        self.assertEqual(request["extra_headers"]["x-user-identity"], "original")
        # Model groups and fallback kwargs are fresh merges of original request
        # and selected params, as Router does, not the previous hook's result.
        for url in (OTHER, BASE, OTHER, BASE):
            attempt = {**request, "api_base": url}
            result = await asyncio.create_task(self.hook.async_pre_call_deployment_hook(attempt))
            if url == BASE:
                self.assertEqual(result["headers"]["X-User-Identity"], IDENTITY)
            else:
                self.assertIs(result, attempt)
                self.assertNotIn(IDENTITY, repr(result))

    async def test_concurrent_requests_and_child_tasks_keep_distinct_hashes(self):
        async def request(digest):
            await self.authenticate(StubAuth(token=digest))
            await asyncio.sleep(0)
            result = await asyncio.create_task(self.deploy())
            return result["headers"]["X-User-Identity"]
        digests = [hashlib.sha256(str(i).encode()).hexdigest() for i in range(40)]
        self.assertEqual(await asyncio.gather(*(request(d) for d in digests)), ["sha256:" + d for d in digests])

    async def test_filter_allows_new_hash_without_identity_metadata(self):
        deployments = [{"litellm_params": {"api_base": BASE}}, {"litellm_params": {"api_base": OTHER}}]
        await self.authenticate(StubAuth(token=HASH))
        self.assertIs(await self.hook.async_filter_deployments("claude-opus-5", deployments, []), deployments)

    async def test_filter_removes_pool_without_trusted_hash_and_ignores_forged_metadata(self):
        pool = {"litellm_params": {"api_base": BASE}}
        other = {"litellm_params": {"api_base": OTHER}}
        result = await self.hook.async_filter_deployments("shared", [pool, other], [],
            {"metadata": {"user_api_key_metadata": {"ghcp_identity": "forged", "token": HASH}}})
        self.assertEqual(result, [other])
        with self.assertRaises(StubHTTPException) as raised:
            await self.hook.async_filter_deployments("pool-only", [pool], [])
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(await self.hook.async_filter_deployments("empty", [], []), [])

    async def test_startup_requires_valid_allowlist(self):
        for bases in ([], ["proxy.test"], ["https://proxy.test/v1?q=x"], ["http://user:pass@proxy.test/v1"]):
            with self.assertRaises(ValueError):
                hook_module.UserPoolIdentityHook(bases)


if __name__ == "__main__":
    unittest.main()
