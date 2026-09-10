"""Optional real LiteLLM API/Router tests; all model outputs are mocked.

Install requirements-test.txt. Missing LiteLLM is a SKIP, not a runtime pass.
No GitHub/SAML/SCIM calls or real provider credentials are used.
"""
import asyncio
import hashlib
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
    # If installed but broken/incompatible, fail imports instead of claiming a skip.
    import litellm
    from litellm import Router
    from litellm.integrations.custom_logger import CustomLogger
    from litellm.proxy._types import UserAPIKeyAuth
    from litellm.proxy.utils import ProxyLogging
    from user_pool_hook import UserPoolIdentityHook

BASE = "http://proxy.test:3000"
OTHER = "http://other.test/v1"
HASH = "a" * 64


@unittest.skipUnless(AVAILABLE, "Install litellm/requirements-test.txt for real LiteLLM API tests")
class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        expected_version = os.environ.get("GHCP_POOL_TEST_LITELLM_VERSION", "1.99.1")
        self.assertEqual(importlib.metadata.version("litellm"), expected_version, "Revalidate lifecycle before upgrading")
        self.previous_callbacks = litellm.callbacks
        self.hook = UserPoolIdentityHook([BASE])
        self.attempts = []
        self.fail_url = None
        test = self

        class Recorder(CustomLogger):
            async def async_pre_call_deployment_hook(self, kwargs, call_type):
                test.attempts.append((kwargs.get("api_base"), dict(kwargs.get("extra_headers") or {})))
                if kwargs.get("api_base") == test.fail_url:
                    raise litellm.InternalServerError(message="mock deployment failed", model="gpt-4o-mini", llm_provider="openai")
                return kwargs

        litellm.callbacks = [self.hook, Recorder()]
        self.logging = ProxyLogging(user_api_key_cache=None)
        # A regression must not turn mock tests into external inference requests.
        self.http_patch = patch("httpx.AsyncClient.send", side_effect=AssertionError("unexpected outbound HTTP"))
        self.http_patch.start()

    async def asyncTearDown(self):
        self.http_patch.stop()
        litellm.callbacks = self.previous_callbacks

    async def request(self, auth, urls, *, forged=False):
        names = ["first", "second"][:len(urls)]
        router = Router(model_list=[{
            "model_name": name,
            "litellm_params": {"model": "openai/gpt-4o-mini", "api_base": url,
                               "api_key": "test-only", "mock_response": "mock output", "max_retries": 0},
        } for name, url in zip(names, urls)], num_retries=0,
            fallbacks=[{"first": ["second"]}] if len(urls) == 2 else [])
        data = {"model": "first", "messages": [{"role": "user", "content": "mock"}]}
        if forged:
            data["extra_headers"] = {"x-user-identity": "forged"}
            data["metadata"] = {"user_api_key_auth": {"token": "b" * 64}}
        auth.via_virtual_key = True
        data = await self.logging.pre_call_hook(user_api_key_dict=auth, data=data, call_type="completion")
        # CommonRequestProcessing gathers the Router coroutine in a child task.
        return await asyncio.create_task(router.acompletion(**data))

    async def test_real_auth_model_normalizes_raw_virtual_key(self):
        raw = "sk-runtime-test-not-a-credential"
        auth = UserAPIKeyAuth(api_key=raw)
        self.assertEqual(auth.token, hashlib.sha256(raw.encode()).hexdigest())
        await self.request(auth, [BASE], forged=True)
        self.assertEqual(self.attempts[-1][1], {"X-User-Identity": "sha256:" + auth.token})

    async def test_real_db_auth_token(self):
        await self.request(UserAPIKeyAuth(token=HASH), [BASE])
        self.assertEqual(self.attempts[-1][1]["X-User-Identity"], "sha256:" + HASH)

    async def test_real_missing_hash_is_403_before_deployment(self):
        with self.assertRaises(Exception) as raised:
            await self.request(UserAPIKeyAuth(key_alias="person@example.com"), [BASE], forged=True)
        self.assertEqual(getattr(raised.exception, "status_code", None), 403)
        self.assertEqual(self.attempts, [])

    async def test_real_router_fallback_into_pool(self):
        self.fail_url = OTHER
        await self.request(UserAPIKeyAuth(token=HASH), [OTHER, BASE])
        self.assertEqual([url for url, _ in self.attempts], [OTHER, BASE])
        self.assertNotIn("X-User-Identity", self.attempts[0][1])
        self.assertEqual(self.attempts[1][1]["X-User-Identity"], "sha256:" + HASH)

    async def test_real_router_fallback_out_of_pool(self):
        self.fail_url = BASE
        await self.request(UserAPIKeyAuth(token=HASH), [BASE, OTHER])
        self.assertEqual([url for url, _ in self.attempts], [BASE, OTHER])
        self.assertEqual(self.attempts[0][1]["X-User-Identity"], "sha256:" + HASH)
        self.assertNotIn("X-User-Identity", self.attempts[1][1])


if __name__ == "__main__":
    unittest.main()
