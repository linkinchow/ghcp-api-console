"""Real LiteLLM Proxy auth hook/Router -> actual Docker Proxy HTTP wire checks.

Run inside the local LiteLLM image on the isolated smoke network. This does not
exercise LiteLLM's API-key database or authenticate an inbound HTTP key.
"""
import asyncio
import hashlib
import json
import os
import urllib.request
from urllib.parse import urlsplit

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
os.environ.setdefault("GHCP_POOL_API_BASES", "http://proxy:3000")
import litellm
from litellm import Router
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.utils import ProxyLogging
from user_pool_hook import UserPoolIdentityHook

BASE = os.environ.get("POOL_SMOKE_PROXY_URL", "http://proxy:3000")
parsed_base = urlsplit(BASE)
if (parsed_base.scheme != "http" or parsed_base.hostname not in ("proxy", "localhost", "127.0.0.1")
        or parsed_base.username or parsed_base.password or parsed_base.query or parsed_base.fragment
        or parsed_base.path not in ("", "/")):
    raise RuntimeError("Wire smoke requires a local disposable Proxy origin")
INTERNAL = "local-pool-internal-test-only"
API_KEY = "local-pool-proxy-test-only"


def admin(path, body=None):
    request = urllib.request.Request(BASE + "/api/user-pool" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"X-Internal-Token": INTERNAL, "Content-Type": "application/json"},
        method="GET" if body is None else "POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


async def main():
    hook = UserPoolIdentityHook([BASE])
    litellm.callbacks = [hook]
    logging = ProxyLogging(user_api_key_cache=None)
    router = Router(model_list=[{
        "model_name": "pool-chat", "litellm_params": {
            "model": "openai/claude-opus-5-2", "api_base": BASE,
            "api_key": API_KEY, "max_retries": 0,
        },
    }], num_retries=0)
    digest = hashlib.sha256(b"local-litellm-wire-user").hexdigest()
    auth = UserAPIKeyAuth(token=digest)
    auth.via_virtual_key = True
    try:
        for stream in (False, True):
            data = {"model": "pool-chat", "messages": [{"role": "user", "content": "wire hello"}],
                    "max_tokens": 8, "stream": stream,
                    "extra_headers": {"x-user-identity": "forged-caller"}}
            data = await logging.pre_call_hook(user_api_key_dict=auth, data=data, call_type="completion")
            response = await asyncio.create_task(router.acompletion(**data))
            if stream:
                chunks = [chunk async for chunk in response]
                assert chunks, "no stream chunks"
            else:
                assert response.choices[0].message.content, "no completion content"
            snapshot = admin("")
            lease = next(row for row in snapshot["leases"] if row["callerKeyHash"] == "sha256:" + digest)
            assert lease["phase"] == "active", lease
            print("PASS real LiteLLM -> Docker Proxy", "stream" if stream else "JSON", lease["memberIdentity"])
    finally:
        snapshot = admin("")
        for lease in snapshot["leases"]:
            if lease["callerKeyHash"] == "sha256:" + digest:
                admin("/leases/" + lease["leaseId"] + "/release", {"confirm": True})
    print("PASS trusted hash reached Proxy; forged identity was replaced")


if __name__ == "__main__":
    asyncio.run(main())
