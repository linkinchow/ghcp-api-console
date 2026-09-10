"""Exclusive-account identity for the async LiteLLM Proxy/Router lifecycle.

Only the early hook's server-authenticated UserAPIKeyAuth is trusted. The late
hook receives deployment kwargs, NOT an authentication object. See
../docs/user-pool-litellm.md for the pinned API contract and deployment limits.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any
from urllib.parse import urlsplit

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth

if not callable(getattr(CustomLogger, "async_pre_call_deployment_hook", None)):
    raise RuntimeError("LiteLLM async deployment hook API is required for GHCP pool routing")

IDENTITY_HEADER = "X-User-Identity"
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_HEADER_MAPS = frozenset(("headers", "extra_headers", "default_headers"))
_OPTION_CONTAINERS = frozenset(
    ("extra_body", "litellm_params", "optional_params", "proxy_server_request",
     "body", "metadata", "litellm_metadata", "provider_specific_header")
)


def _deny() -> HTTPException:
    # Never interpolate credentials, aliases, request data, or remote errors.
    return HTTPException(status_code=403, detail="ghcp_pool_trusted_identity_required")


def _authenticated_identity(auth: UserAPIKeyAuth) -> str | None:
    if (not isinstance(auth, UserAPIKeyAuth)
            or getattr(auth, "via_virtual_key", False) is not True
            or getattr(auth, "is_session_token", False)):
        return None
    # api_key is inspected only on the server auth object as a type/consistency
    # fence (master-key aliases are not business callers), never as a fallback.
    # Late deployment kwargs.api_key is a provider credential and is never read.
    api_key = getattr(auth, "api_key", None)
    if api_key is not None and (not isinstance(api_key, str) or not _HASH.fullmatch(api_key)):
        return None
    values = [getattr(auth, field, None) for field in ("token", "hashed_token")]
    present = [value for value in values if value is not None]
    if not present or any(not isinstance(v, str) or not _HASH.fullmatch(v) for v in present):
        return None
    if len(set(present)) != 1 or (api_key is not None and api_key != present[0]):
        return None
    return "sha256:" + present[0]


def _url_key(value: Any) -> tuple[str, str, int, str] | None:
    if not isinstance(value, str) or not value or value != value.strip():
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment):
            return None
        # Exact base path, never hostname substrings or model-name guesses.
        return (parsed.scheme, parsed.hostname.lower(),
                parsed.port or (443 if parsed.scheme == "https" else 80),
                parsed.path.rstrip("/"))
    except ValueError:
        return None


def _clean_headers(value: Any) -> dict:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise _deny()
    return {key: val for key, val in value.items()
            if not (isinstance(key, str) and key.lower() == IDENTITY_HEADER.lower())}


def _clean_options(options: dict) -> dict:
    """Copy only option containers, preserving prompts/tools and shared Router state."""
    cleaned = {}
    for key, value in options.items():
        if isinstance(key, str) and key.lower() == IDENTITY_HEADER.lower():
            continue
        if key in _HEADER_MAPS:
            cleaned[key] = _clean_headers(value)
        elif key in _OPTION_CONTAINERS and isinstance(value, dict):
            cleaned[key] = _clean_options(value)
        else:
            cleaned[key] = value
    return cleaned


class UserPoolIdentityHook(CustomLogger):
    def __init__(self, api_bases: list[str] | None = None):
        super().__init__()
        if api_bases is None:
            api_bases = [item.strip() for item in os.environ.get("GHCP_POOL_API_BASES", "").split(",")
                         if item.strip()]
        self._bases = frozenset(_url_key(base) for base in api_bases)
        if not self._bases or None in self._bases:
            raise ValueError("GHCP_POOL_API_BASES must contain explicit HTTP(S) API base URLs")
        # Only a hash lives here. asyncio child tasks inherit request context;
        # per-deployment/fallback kwargs and user metadata are never auth stores.
        self._identity: ContextVar[str | None] = ContextVar("ghcp_pool_identity", default=None)

    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type):
        # Always overwrite, including missing/invalid auth, to prevent reuse in
        # sequential requests. Delay denial until the selected URL is known.
        self._identity.set(_authenticated_identity(user_api_key_dict))
        return data

    def _is_pool_deployment(self, params):
        if not isinstance(params, Mapping):
            return False
        effective_base = params.get("base_url")
        if effective_base is None:
            effective_base = params.get("api_base")
        return _url_key(effective_base) in self._bases

    async def async_filter_deployments(self, model, healthy_deployments, messages,
                                       request_kwargs=None, parent_otel_span=None):
        # Virtual-key model permissions are enforced by LiteLLM authentication.
        # Pool users need a trusted hash, not a pre-existing member/metadata binding.
        if self._identity.get() is not None:
            return healthy_deployments
        remaining = [deployment for deployment in healthy_deployments
                     if not self._is_pool_deployment(deployment.get("litellm_params")
                         if isinstance(deployment, Mapping) else None)]
        if not remaining and healthy_deployments:
            raise _deny()
        return remaining

    async def async_pre_call_deployment_hook(self, kwargs: dict, call_type=None):
        if not self._is_pool_deployment(kwargs):
            return kwargs
        identity = self._identity.get()
        if identity is None:
            raise _deny()

        cleaned = _clean_options(kwargs)
        # Both are relevant: LiteLLM merges headers then extra_headers. Strip
        # case variants at all supported override locations before injection.
        for field in ("headers", "extra_headers"):
            headers = dict(cleaned.get(field) or {})
            headers[IDENTITY_HEADER] = identity
            cleaned[field] = headers
        # Router can supply a cached OpenAI client whose persistent default
        # headers bypass kwargs. Rebuild only GHCP clients from clean options.
        if "client" in cleaned:
            cleaned["client"] = None
        return cleaned


# LiteLLM callback loader expects a module-level instance. A missing allowlist
# fails at configuration load rather than silently installing an inert hook.
proxy_handler_instance = UserPoolIdentityHook()
