"""LLM 클라이언트 경계.

채팅 루프는 이 Protocol 에만 의존한다 → 테스트·평가에서 실제 API 없이(비용 없이) 대체 클라이언트를 쓸 수 있다.
실제 구현은 Anthropic Python SDK. API 키는 이 로컬 백엔드에만 있다.
"""

from __future__ import annotations

from typing import Any, Protocol

import anthropic

DEFAULT_MODEL = "claude-opus-5-5"

# 서버 측 거절 대체(fallbacks: "default")를 지원하는 모델. Haiku 는 지원하지 않는다.
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
_FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LlmClient(Protocol):
    def create(self, **params: Any) -> Any:
        """Messages API 응답과 같은 형태(content, stop_reason, usage, model)를 돌려준다."""
        ...


class AnthropicClient:
    def __init__(self, api_key: str | None) -> None:
        # 키가 없으면 SDK 기본 자격 증명(ANTHROPIC_API_KEY 등)을 사용한다
        self._client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    def create(self, **params: Any) -> Any:
        if params.get("model") in _FALLBACK_MODELS:
            # 안전 분류기가 요청을 거절하면 서버가 권장 모델로 다시 실행한다
            return self._client.beta.messages.create(betas=[_FALLBACK_BETA], fallbacks="default", **params)
        return self._client.beta.messages.create(**params)
