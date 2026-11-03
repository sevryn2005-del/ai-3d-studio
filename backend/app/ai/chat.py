"""AI 채팅 한 번(사용자 메시지 1개)의 처리.

1. 시스템 프롬프트(고정, 캐시) + 이전 대화(텍스트) + 현재 모델 상태 + 사용자 메시지로 요청
2. AI 응답이
   - apply_cad_commands → 서버 검증. 실패하면 오류를 tool_result 로 돌려줘 AI 가 고치게 한다 (최대 MAX_ATTEMPTS)
   - ask_user           → 질문을 사용자에게 전달
   - 텍스트만             → 일반 답변
   - refusal            → 처리할 수 없음 안내
3. 모든 시도의 토큰 사용량을 합산해 돌려준다 (비용 기록용)

명령은 여기서 실행하지 않는다. 프론트엔드가 같은 명령 실행기로 한 번에(실행 취소 1단계) 적용한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.ai.llm_client import LlmClient
from app.ai.prompt_builder import APPLY_TOOL, ASK_TOOL, SYSTEM_PROMPT, model_context, tools
from app.ai.validator import validate_commands
from app.cad.commands import ModelDefinition

MAX_ATTEMPTS = 3
MAX_TOKENS = 16000
MAX_HISTORY_MESSAGES = 20
EFFORT = "medium"


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    requests: int = 0
    models: list[str] = field(default_factory=list)

    def add(self, response: Any) -> None:
        u = getattr(response, "usage", None)
        self.requests += 1
        self.models.append(getattr(response, "model", "") or "")
        if u is None:
            return
        self.input_tokens += getattr(u, "input_tokens", 0) or 0
        self.output_tokens += getattr(u, "output_tokens", 0) or 0
        self.cache_creation_input_tokens += getattr(u, "cache_creation_input_tokens", 0) or 0
        self.cache_read_input_tokens += getattr(u, "cache_read_input_tokens", 0) or 0


@dataclass
class ChatTurn:
    role: Literal["user", "assistant"]
    text: str


@dataclass
class ChatResult:
    kind: Literal["commands", "question", "message", "refused", "error"]
    message: str
    usage: Usage
    commands: list[dict[str, Any]] = field(default_factory=list)
    options: list[str] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)


def _history(turns: list[ChatTurn]) -> list[dict[str, Any]]:
    """이전 대화를 텍스트 메시지로. 연속된 같은 역할은 API 가 합치고, 첫 메시지는 user 여야 한다."""
    msgs = [{"role": t.role, "content": t.text} for t in turns[-MAX_HISTORY_MESSAGES:] if t.text.strip()]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


def _text(content: list[Any]) -> str:
    return "\n".join(b.text for b in content if getattr(b, "type", None) == "text" and b.text).strip()


def run_chat(
    client: LlmClient,
    *,
    model_name: str,
    model: ModelDefinition,
    selected_id: str | None,
    history: list[ChatTurn],
    user_text: str,
) -> ChatResult:
    usage = Usage()
    messages: list[dict[str, Any]] = [
        *_history(history),
        {
            "role": "user",
            "content": [
                {"type": "text", "text": model_context(model, selected_id)},
                {"type": "text", "text": user_text},
            ],
        },
    ]
    last_issues: list[str] = []

    for _ in range(MAX_ATTEMPTS):
        response = client.create(
            model=model_name,
            max_tokens=MAX_TOKENS,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            tools=tools(),
            output_config={"effort": EFFORT},
            messages=messages,
        )
        usage.add(response)

        # 거절은 내용보다 먼저 확인한다
        if response.stop_reason == "refusal":
            return ChatResult("refused", "이 요청은 처리할 수 없습니다. 다르게 표현해 보세요.", usage)
        if response.stop_reason == "max_tokens":
            return ChatResult("error", "응답이 너무 길어 중단되었습니다. 요청을 나눠서 보내 주세요.", usage)

        content = list(response.content)
        tool_uses = [b for b in content if getattr(b, "type", None) == "tool_use"]
        text = _text(content)

        if not tool_uses:
            return ChatResult("message", text or "(빈 응답)", usage)

        ask = next((b for b in tool_uses if b.name == ASK_TOOL), None)
        if ask is not None:
            q = ask.input.get("question") if isinstance(ask.input, dict) else None
            opts = ask.input.get("options") if isinstance(ask.input, dict) else None
            if isinstance(q, str) and q.strip():
                options = [o for o in (opts or []) if isinstance(o, str) and o.strip()][:4]
                return ChatResult("question", q.strip(), usage, options=options)

        apply = next((b for b in tool_uses if b.name == APPLY_TOOL), None)
        results = []
        if apply is not None:
            raw = apply.input.get("commands") if isinstance(apply.input, dict) else None
            commands, issues = validate_commands(raw, model)
            if not issues:
                msg = apply.input.get("message") if isinstance(apply.input, dict) else None
                return ChatResult("commands", (msg or text or "변경했습니다.").strip(), usage, commands=commands)
            last_issues = issues

        # 고칠 기회: 모든 tool_use 에 결과를 돌려준다 (하나라도 빠지면 API 오류)
        for b in tool_uses:
            if b is apply:
                body = "Validation failed. Nothing was applied. Fix these and call apply_cad_commands again:\n" + "\n".join(
                    f"- {i}" for i in last_issues
                )
            else:
                body = "Invalid tool call. Use apply_cad_commands or ask_user with the documented fields."
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": body, "is_error": True})
        messages.append({"role": "assistant", "content": content})
        messages.append({"role": "user", "content": results})

    return ChatResult(
        "error",
        "AI 가 올바른 명령을 만들지 못했습니다. 요청을 조금 더 구체적으로 적어 주세요.",
        usage,
        issues=last_issues,
    )
