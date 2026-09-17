"""灰度准入离线回归；LiteLLM 使用桩，不执行网络或真实模型请求。"""

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

from test_user_pool_hook import StubAuth, StubHTTPException, StubLogger, hook_module

BASE = "http://proxy.test:3000"
OTHER = "https://other.test/v1"
CANARY_HASH = "0" + "a" * 63
OTHER_HASH = "a" * 64


class FilterLogger(StubLogger):
    async def async_filter_deployments(self, *args, **kwargs):
        raise AssertionError("The hook must filter deployments itself")


def load_hook():
    fastapi = types.ModuleType("fastapi")
    fastapi.HTTPException = StubHTTPException
    logger = types.ModuleType("litellm.integrations.custom_logger")
    logger.CustomLogger = FilterLogger
    spec = importlib.util.spec_from_file_location(
        "offline_canary_hook", Path(__file__).with_name("user_pool_canary_hook.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"fastapi": fastapi, "user_pool_hook": hook_module,
                                 "litellm.integrations.custom_logger": logger}), patch.dict(os.environ, {
        "GHCP_POOL_API_BASES": BASE,
    }):
        spec.loader.exec_module(module)
    return module


canary_module = load_hook()


def deployment(base):
    return {"litellm_params": {"api_base": base, "model": "openai/test-model"}}


class CanaryHookTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.hook = canary_module.UserPoolCanaryHook([BASE])
        self.pool = deployment(BASE)
        self.other = deployment(OTHER)
        self.candidates = [self.pool, self.other]

    async def authenticate(self, digest, **data):
        return await self.hook.async_pre_call_hook(
            StubAuth(token=digest), None, {"model": "same-public-model", **data}, "completion")

    async def filtered(self, candidates=None, **request_kwargs):
        return await self.hook.async_filter_deployments(
            "same-public-model", self.candidates if candidates is None else candidates, [], request_kwargs)

    async def deploy(self, base=BASE, **kwargs):
        return await self.hook.async_pre_call_deployment_hook({"api_base": base, **kwargs})

    async def test_zero_prefix_keeps_all_candidates_not_forced_to_ghcp(self):
        await self.authenticate(CANARY_HASH)
        self.assertIs(await self.filtered(), self.candidates)
        self.assertEqual(await self.filtered([self.other]), [self.other])

    async def test_all_fifteen_other_hex_prefixes_remove_ghcp(self):
        for first in "123456789abcdef":
            with self.subTest(first=first):
                await self.authenticate(first + "a" * 63)
                self.assertEqual(await self.filtered(), [self.other])
                with self.assertRaises(StubHTTPException) as raised:
                    await self.deploy()
                self.assertEqual(raised.exception.detail, "ghcp_canary_not_allowed")

    async def test_ghcp_only_nonmember_gets_403_before_dispatch(self):
        await self.authenticate(OTHER_HASH)
        with self.assertRaises(StubHTTPException) as raised:
            await self.filtered([self.pool])
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(raised.exception.detail, "ghcp_canary_not_allowed")

    async def test_empty_healthy_candidates_remain_empty(self):
        for digest in (CANARY_HASH, OTHER_HASH):
            await self.authenticate(digest)
            self.assertEqual(await self.filtered([]), [])

    async def test_unrelated_models_and_providers_remain_unchanged(self):
        candidates = [self.other, deployment("https://another.test/v1")]
        for digest in (CANARY_HASH, OTHER_HASH):
            await self.authenticate(digest, model="other-public-model")
            self.assertEqual(await self.filtered(candidates), candidates)
            source = {"api_base": OTHER, "extra_headers": {"X-User-Identity": "provider-contract"}}
            self.assertIs(await self.hook.async_pre_call_deployment_hook(source), source)

    async def test_header_is_injected_only_for_enrolled_ghcp(self):
        await self.authenticate(CANARY_HASH)
        result = await self.deploy(extra_headers={"x-user-identity": "forged"})
        self.assertEqual(result["headers"]["X-User-Identity"], "sha256:" + CANARY_HASH)
        self.assertEqual(result["extra_headers"], {"X-User-Identity": "sha256:" + CANARY_HASH})
        self.assertEqual(await self.deploy(OTHER), {"api_base": OTHER})

    async def test_forged_headers_and_metadata_cannot_enroll(self):
        forged = {"extra_headers": {"X-User-Identity": "sha256:" + CANARY_HASH},
                  "metadata": {"token": CANARY_HASH, "ghcp_identity": CANARY_HASH,
                               "user_api_key_metadata": {"token": CANARY_HASH}}}
        await self.authenticate(OTHER_HASH, **forged)
        self.assertEqual(await self.filtered(**forged), [self.other])
        with self.assertRaises(StubHTTPException):
            await self.deploy(**forged)

    async def test_untrusted_master_session_and_malformed_hash_stay_denied(self):
        invalid = [None, {"token": CANARY_HASH}, StubAuth(),
                   StubAuth(token=CANARY_HASH, via_virtual_key=False),
                   StubAuth(token=CANARY_HASH, is_session_token=True),
                   StubAuth(token=CANARY_HASH, hashed_token=OTHER_HASH),
                   StubAuth(token=CANARY_HASH.upper()), StubAuth(token="sha256:" + CANARY_HASH),
                   StubAuth(token=CANARY_HASH + "\n"), StubAuth(token=CANARY_HASH, api_key="master-key")]
        for auth in invalid:
            with self.subTest(auth_type=type(auth).__name__):
                await self.hook.async_pre_call_hook(auth, None, {}, "completion")
                self.assertEqual(await self.filtered(), [self.other])
                for operation in (lambda: self.filtered([self.pool]), self.deploy):
                    with self.assertRaises(StubHTTPException) as raised:
                        await operation()
                    self.assertEqual(raised.exception.status_code, 403)
                    self.assertEqual(raised.exception.detail, "ghcp_pool_trusted_identity_required")

    async def test_no_early_hook_or_missing_next_auth_cannot_reuse_identity(self):
        with self.assertRaises(StubHTTPException):
            await self.deploy()
        await self.authenticate(CANARY_HASH)
        await self.deploy()
        await self.hook.async_pre_call_hook(None, None, {}, "completion")
        self.assertEqual(await self.filtered(), [self.other])
        with self.assertRaises(StubHTTPException):
            await self.deploy()

    async def test_raw_key_normalization_and_hashed_token_variant(self):
        raw = next(f"sk-synthetic-canary-{i}" for i in range(1000)
                   if hashlib.sha256(f"sk-synthetic-canary-{i}".encode()).hexdigest().startswith("0"))
        digest = hashlib.sha256(raw.encode()).hexdigest()
        for auth in (StubAuth(api_key=raw), StubAuth(hashed_token=digest)):
            await self.hook.async_pre_call_hook(auth, None, {}, "completion")
            self.assertIs(await self.filtered(), self.candidates)
            self.assertEqual((await self.deploy())["headers"]["X-User-Identity"], "sha256:" + digest)

    async def test_alias_rename_cannot_change_group(self):
        for digest in (CANARY_HASH, OTHER_HASH):
            for alias in ("first", "renamed", None):
                await self.hook.async_pre_call_hook(StubAuth(token=digest, key_alias=alias), None, {}, "completion")
                self.assertEqual(await self.filtered(), self.candidates if digest == CANARY_HASH else [self.other])

    async def test_fallback_or_direct_deployment_cannot_bypass_nonmember_gate(self):
        await self.authenticate(OTHER_HASH)
        await self.deploy(OTHER)
        with self.assertRaises(StubHTTPException):
            await asyncio.create_task(self.deploy(model="fallback-model"))
        self.assertEqual(await self.deploy(OTHER), {"api_base": OTHER})

    async def test_enrolled_key_keeps_existing_nonpool_fallback_behavior(self):
        await self.authenticate(CANARY_HASH)
        await self.deploy()
        self.assertEqual(await self.deploy(OTHER), {"api_base": OTHER})
        await self.deploy()

    async def test_url_matching_and_effective_alias_are_inherited(self):
        await self.authenticate(OTHER_HASH)
        for url in (BASE, BASE + "/", "http://PROXY.TEST:3000/"):
            with self.assertRaises(StubHTTPException):
                await self.deploy(url)
        allowed = {"litellm_params": {"api_base": BASE, "base_url": OTHER}}
        denied = {"litellm_params": {"api_base": OTHER, "base_url": BASE}}
        self.assertEqual(await self.filtered([allowed, denied]), [allowed])
        self.assertEqual(await self.deploy(BASE, base_url=OTHER), {"api_base": BASE, "base_url": OTHER})
        with self.assertRaises(StubHTTPException):
            await self.deploy(OTHER, base_url=BASE)
        for url in (BASE + "-evil", BASE + "/other", BASE + "?x=1", "http://proxy.test.evil:3000"):
            self.assertEqual(await self.deploy(url), {"api_base": url})

    async def test_candidates_request_data_and_cached_clients_not_mutated(self):
        before = copy.deepcopy(self.candidates)
        data = {"extra_headers": {"x-user-identity": "forged"}, "messages": [{"content": "unchanged"}]}
        original = copy.deepcopy(data)
        await self.authenticate(CANARY_HASH, **data)
        await self.filtered()
        client = object()
        result = await self.deploy(client=client, **data)
        self.assertIsNone(result["client"])
        self.assertEqual(self.candidates, before)
        self.assertEqual(data, original)
        await self.authenticate(OTHER_HASH)
        await self.filtered()
        self.assertEqual(self.candidates, before)

    async def test_concurrent_requests_and_child_tasks_keep_their_group(self):
        async def request(index):
            digest = CANARY_HASH if index % 2 == 0 else OTHER_HASH
            await self.authenticate(digest)
            await asyncio.sleep(0)
            result = await asyncio.create_task(self.filtered())
            return result
        results = await asyncio.gather(*(request(i) for i in range(40)))
        self.assertEqual(results, [self.candidates if i % 2 == 0 else [self.other] for i in range(40)])

    async def test_each_configured_pool_endpoint_is_gated(self):
        self.hook = canary_module.UserPoolCanaryHook([BASE, "http://replica.test:3000"])
        second = deployment("http://replica.test:3000")
        await self.authenticate(OTHER_HASH)
        self.assertEqual(await self.filtered([self.pool, second, self.other]), [self.other])
        with self.assertRaises(StubHTTPException):
            await self.deploy("http://replica.test:3000")

    def test_configuration_retains_explicit_allowlist_requirement(self):
        for bases in ([], ["proxy.test"], ["https://user:password@proxy.test"], [BASE + "?x=1"]):
            with self.assertRaises(ValueError):
                canary_module.UserPoolCanaryHook(bases)

    async def test_multiple_empty_and_all_prefixes(self):
        for prefixes in ("012", "", "0123456789abcdef", "00"):
            self.hook = canary_module.UserPoolCanaryHook([BASE], prefixes=prefixes)
            for first in "0123456789abcdef":
                await self.authenticate(first + "a" * 63)
                self.assertEqual(await self.filtered(), self.candidates if first in prefixes else [self.other])

    def test_invalid_prefix_configuration_fails_closed(self):
        for prefixes in ("0-2", "0,1,2", "A", "g", " 0", "0\n", 123):
            with self.subTest(prefixes=prefixes), self.assertRaises(ValueError):
                canary_module.UserPoolCanaryHook([BASE], prefixes=prefixes)

    async def test_default_prefixes_are_read_from_module_constant(self):
        with patch.object(canary_module, "ALLOWED_HASH_PREFIXES", "012"):
            self.hook = canary_module.UserPoolCanaryHook([BASE])
        await self.authenticate("2" + "a" * 63)
        self.assertIs(await self.filtered(), self.candidates)

    def test_missing_litellm_filter_contract_fails_startup(self):
        with patch.object(canary_module.CustomLogger, "async_filter_deployments", None):
            with self.assertRaises(RuntimeError):
                canary_module.UserPoolCanaryHook([BASE])


if __name__ == "__main__":
    unittest.main()
