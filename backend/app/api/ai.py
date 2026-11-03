"""AI API. 모든 호출은 사용자가 채팅에서 보낼 때만 일어난다 (자동·주기 호출 없음).

AI 키·모델·가격은 이 로컬 서버에만 저장된다. 브라우저에는 키의 끝 4자리만 보인다.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import anthropic
from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, Field, ValidationError

from app.ai.chat import ChatTurn, run_chat
from app.ai.config_store import MODELS, ConfigStore, Price, estimate_cost
from app.ai.usage_log import UsageLog
from app.cad.commands import ModelDefinition
from app.cad.validation import check_model, issues_from_validation_error

router = APIRouter(prefix="/ai", tags=["ai"])


def get_store(request: Request) -> ConfigStore:
    return request.app.state.ai_store


def get_usage(request: Request) -> UsageLog:
    return request.app.state.ai_usage


Store = Annotated[ConfigStore, Depends(get_store)]
Usage = Annotated[UsageLog, Depends(get_usage)]


@router.get("/settings")
def read_settings(store: Store) -> dict[str, Any]:
    return store.public_view(store.load())


class SettingsUpdate(BaseModel):
    model_config = {"extra": "forbid"}
    apiKey: str | None = Field(default=None, min_length=8, max_length=500)
    clearKey: bool = False
    model: str | None = None
    enabled: bool | None = None
    prices: dict[str, Price] | None = None


@router.put("/settings")
def update_settings(store: Store, update: SettingsUpdate) -> dict[str, Any]:
    s = store.load()
    if update.clearKey:
        s.apiKey = None
    if update.apiKey is not None:
        s.apiKey = update.apiKey.strip()
    if update.model is not None:
        if update.model not in MODELS:
            return {"ok": False, "error": f"지원하지 않는 모델입니다: {update.model}"}
        s.model = update.model
    if update.enabled is not None:
        s.enabled = update.enabled
    if update.prices is not None:
        s.prices.update({k: v for k, v in update.prices.items() if k in MODELS})
    store.save(s)
    return {"ok": True, **store.public_view(s)}


@router.get("/usage")
def read_usage(usage: Usage) -> dict[str, Any]:
    return usage.summary()


class ChatHistoryItem(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=20_000)


class ChatRequest(BaseModel):
    model: Any
    selectedId: str | None = None
    history: list[ChatHistoryItem] = Field(default_factory=list, max_length=100)
    message: str = Field(min_length=1, max_length=4000)


def _fail(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"kind": "error", "code": code, "message": message, "commands": [], "options": [], "issues": [], **extra}


@router.post("/chat")
def chat(request: Request, store: Store, usage_log: Usage, body: ChatRequest = Body(...)) -> dict[str, Any]:
    s = store.load()
    if not s.enabled:
        return _fail("ai_disabled", "AI 기능이 꺼져 있습니다. AI 설정에서 켤 수 있습니다.")
    key, _ = store.effective_key(s)
    if not key:
        return _fail("no_api_key", "AI 를 쓰려면 AI 설정에서 Anthropic API 키를 입력하세요.")

    try:
        model = ModelDefinition.model_validate(body.model)
    except ValidationError as e:
        return _fail("invalid_model", "설계 데이터가 올바르지 않습니다.", issues=[i.message for i in issues_from_validation_error(e)])
    if issues := check_model(model):
        return _fail("invalid_model", "설계 데이터가 올바르지 않습니다.", issues=[i.message for i in issues])

    client = request.app.state.llm_factory(key)
    try:
        result = run_chat(
            client,
            model_name=s.model,
            model=model,
            selected_id=body.selectedId,
            history=[ChatTurn(h.role, h.text) for h in body.history],
            user_text=body.message,
        )
    except anthropic.AuthenticationError:
        return _fail("auth", "API 키가 올바르지 않습니다. AI 설정에서 확인하세요.")
    except anthropic.PermissionDeniedError:
        return _fail("permission", "이 API 키로는 선택한 모델을 사용할 수 없습니다.")
    except anthropic.RateLimitError:
        return _fail("rate_limited", "요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도하세요.")
    except anthropic.APIConnectionError:
        return _fail("offline", "AI 서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요. (모델링은 계속할 수 있습니다)")
    except anthropic.APIStatusError as e:
        return _fail("api_error", f"AI 서버 오류가 발생했습니다 ({e.status_code}). 잠시 후 다시 시도하세요.")

    u = result.usage
    cost = estimate_cost(
        store.price_for(s, s.model),
        input_tokens=u.input_tokens, output_tokens=u.output_tokens,
        cache_read=u.cache_read_input_tokens, cache_write=u.cache_creation_input_tokens,
    )
    record = usage_log.append({
        "model": s.model,
        "servedModels": sorted({m for m in u.models if m}),
        "kind": result.kind,
        "requests": u.requests,
        "inputTokens": u.input_tokens,
        "outputTokens": u.output_tokens,
        "cacheReadTokens": u.cache_read_input_tokens,
        "cacheWriteTokens": u.cache_creation_input_tokens,
        "costUsd": round(cost, 6),
    })
    return {
        "kind": result.kind,
        "message": result.message,
        "commands": result.commands,
        "options": result.options,
        "issues": result.issues,
        "usage": record,
        "month": usage_log.summary()["month"],
    }
