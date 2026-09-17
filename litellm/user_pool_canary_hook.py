"""GHCP 灰度准入：按已认证 virtual-key hash 首位放行。"""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

from user_pool_hook import UserPoolIdentityHook


ALLOWED_HASH_PREFIXES = "0"


def _not_enrolled() -> HTTPException:
    return HTTPException(status_code=403, detail="ghcp_canary_not_allowed")


class UserPoolCanaryHook(UserPoolIdentityHook):
    def __init__(self, api_bases: list[str] | None = None, prefixes: str | None = None):
        super().__init__(api_bases)
        if not callable(getattr(CustomLogger, "async_filter_deployments", None)):
            raise RuntimeError("LiteLLM async deployment filtering is required for GHCP canary routing")
        if prefixes is None:
            prefixes = ALLOWED_HASH_PREFIXES
        if not isinstance(prefixes, str) or any(char not in "0123456789abcdef" for char in prefixes):
            raise ValueError("Allowed hash prefixes must contain only lowercase hexadecimal digits")
        self._prefixes = frozenset(prefixes)

    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type):
        # LiteLLM discovers this callback on the concrete class, not inherited methods.
        return await super().async_pre_call_hook(user_api_key_dict, cache, data, call_type)

    def _is_enrolled(self) -> bool:
        identity = self._identity.get()
        return identity is not None and identity[len("sha256:")] in self._prefixes

    async def async_filter_deployments(self, model, healthy_deployments, messages,
                                       request_kwargs=None, parent_otel_span=None):
        if self._identity.get() is None:
            return await super().async_filter_deployments(
                model, healthy_deployments, messages, request_kwargs, parent_otel_span)
        if self._is_enrolled():
            return healthy_deployments
        remaining = [deployment for deployment in healthy_deployments
                     if not self._is_pool_deployment(deployment.get("litellm_params")
                         if isinstance(deployment, Mapping) else None)]
        if not remaining and healthy_deployments:
            raise _not_enrolled()
        return remaining

    async def async_pre_call_deployment_hook(self, kwargs: dict, call_type=None):
        # Direct deployment selection and retries may bypass candidate filtering.
        if self._is_pool_deployment(kwargs) and self._identity.get() is not None and not self._is_enrolled():
            raise _not_enrolled()
        return await super().async_pre_call_deployment_hook(kwargs, call_type)


proxy_handler_instance = UserPoolCanaryHook()
