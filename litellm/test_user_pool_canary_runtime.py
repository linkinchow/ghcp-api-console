"""可选的真实 LiteLLM Router 灰度测试；输出为 mock，禁止外部 HTTP。"""

import asyncio
import importlib.metadata
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
os.environ.setdefault("GHCP_POOL_API_BASES", "http://proxy.test:3000")
try:
    importlib.metadata.version("litellm")
    AVAILABLE = True
except importlib.metadata.PackageNotFoundError:
    AVAILABLE = False

if AVAILABLE:
    import litellm
    from litellm import Router
    from litellm.integrations.custom_logger import CustomLogger
    from litellm.proxy._types import UserAPIKeyAuth
    from litellm.proxy.utils import ProxyLogging
    from user_pool_canary_hook import UserPoolCanaryHook

BASE = "http://proxy.test:3000"
STABLE = "http://stable.test/v1"
MODEL = "shared-model"
CANARY_HASH = "0" + "a" * 63
STABLE_HASH = "a" * 64


@unittest.skipUnless(AVAILABLE, "Missing LiteLLM: not a real Router validation pass")
class CanaryRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        expected = os.environ.get("GHCP_POOL_TEST_LITELLM_VERSION", "1.99.1")
        self.assertEqual(importlib.metadata.version("litellm"), expected)
        self.previous_callbacks = litellm.callbacks
        self.hook = UserPoolCanaryHook([BASE], prefixes="0")
        self.attempts = []
        self.filtered_bases = []
        self.fail_url = None
        test = self

        class Recorder(CustomLogger):
            async def async_pre_call_deployment_hook(self, kwargs, call_type):
                base = kwargs.get("base_url") or kwargs.get("api_base")
                test.attempts.append((base, dict(kwargs.get("extra_headers") or {})))
                if base == test.fail_url:
                    raise litellm.InternalServerError(
                        message="synthetic failure", model="gpt-4o-mini", llm_provider="openai")
                return kwargs

        original_filter = self.hook.async_filter_deployments

        async def record_filter(*args, **kwargs):
            result = await original_filter(*args, **kwargs)
            test.filtered_bases.append([entry["litellm_params"].get("api_base") for entry in result])
            return result

        self.hook.async_filter_deployments = record_filter
        litellm.callbacks = [self.hook, Recorder()]
        self.logging = ProxyLogging(user_api_key_cache=None)
        self.http_patch = patch("httpx.AsyncClient.send", side_effect=AssertionError("unexpected outbound HTTP"))
        self.http_patch.start()

    async def asyncTearDown(self):
        self.http_patch.stop()
        litellm.callbacks = self.previous_callbacks

    async def request(self, digest, *, primary=None, fallback=None, model=MODEL):
        bases = [BASE, STABLE] if primary is None else primary
        entries = [(model, base) for base in bases]
        if fallback:
            entries.append(("fallback-model", fallback))
        router = Router(model_list=[{
            "model_name": group,
            "litellm_params": {"model": "openai/gpt-4o-mini", "api_base": base,
                               "api_key": "synthetic-only", "mock_response": "mock output",
                               "max_retries": 0},
        } for group, base in entries], num_retries=0,
            fallbacks=[{model: ["fallback-model"]}] if fallback else [])
        auth = UserAPIKeyAuth(token=digest)
        auth.via_virtual_key = True
        data = {"model": model, "messages": [{"role": "user", "content": "mock"}]}
        data = await self.logging.pre_call_hook(user_api_key_dict=auth, data=data, call_type="completion")
        return await asyncio.create_task(router.acompletion(**data))

    async def test_same_public_model_keeps_both_candidates_for_zero_prefix(self):
        await self.request(CANARY_HASH)
        self.assertTrue(self.filtered_bases, "Router must invoke deployment filtering")
        self.assertTrue(all(set(bases) == {BASE, STABLE} for bases in self.filtered_bases))
        self.assertEqual(len(self.attempts), 1)
        base, headers = self.attempts[0]
        self.assertIn(base, (BASE, STABLE))
        self.assertEqual(headers, {"X-User-Identity": "sha256:" + CANARY_HASH} if base == BASE else {})

    async def test_zero_prefix_ghcp_only_injects_identity_without_metadata(self):
        await self.request(CANARY_HASH, primary=[BASE])
        self.assertEqual(self.attempts, [(BASE, {"X-User-Identity": "sha256:" + CANARY_HASH})])

    async def test_same_public_model_selects_stable_for_other_prefix(self):
        await self.request(STABLE_HASH)
        self.assertTrue(self.filtered_bases, "Router must invoke deployment filtering")
        self.assertTrue(all(bases == [STABLE] for bases in self.filtered_bases))
        self.assertEqual(self.attempts, [(STABLE, {})])

    async def test_nonmember_ghcp_only_is_403_without_dispatch(self):
        with self.assertRaises(Exception) as raised:
            await self.request(STABLE_HASH, primary=[BASE])
        self.assertEqual(getattr(raised.exception, "status_code", None), 403)
        self.assertEqual(self.attempts, [])

    async def test_member_preserves_existing_fallback_out_of_ghcp(self):
        self.fail_url = BASE
        await self.request(CANARY_HASH, primary=[BASE], fallback=STABLE)
        self.assertEqual([base for base, _ in self.attempts], [BASE, STABLE])
        self.assertEqual(self.attempts[-1][1], {})

    async def test_nonmember_cannot_fallback_into_ghcp(self):
        self.fail_url = STABLE
        with self.assertRaises(Exception):
            await self.request(STABLE_HASH, primary=[STABLE], fallback=BASE)
        self.assertEqual([base for base, _ in self.attempts], [STABLE])

    async def test_unrelated_model_keeps_stable_route(self):
        await self.request(CANARY_HASH, primary=[STABLE], model="other-model")
        self.assertEqual(self.attempts, [(STABLE, {})])


if __name__ == "__main__":
    unittest.main()
