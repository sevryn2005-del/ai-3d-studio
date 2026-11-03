"""테스트용 LLM 대체 클라이언트: 미리 작성한 응답을 순서대로 돌려주고, 받은 요청을 기록한다.
(실제 API 응답을 녹화한 것이 아니라, 테스트 시나리오를 위해 직접 작성한 응답이다.)"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def text(t: str):
    return SimpleNamespace(type="text", text=t)


def tool(name: str, input: dict, id: str = "toolu_1"):
    return SimpleNamespace(type="tool_use", name=name, input=input, id=id)


def response(*blocks, stop_reason: str | None = None, input_tokens=1000, output_tokens=100, cache_read=0, cache_write=0,
             model="claude-opus-5-5"):
    has_tool = any(b.type == "tool_use" for b in blocks)
    return SimpleNamespace(
        content=list(blocks),
        stop_reason=stop_reason or ("tool_use" if has_tool else "end_turn"),
        model=model,
        usage=SimpleNamespace(
            input_tokens=input_tokens, output_tokens=output_tokens,
            cache_read_input_tokens=cache_read, cache_creation_input_tokens=cache_write,
        ),
    )


class ScriptedClient:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    def create(self, **params):
        self.requests.append(params)
        if not self.responses:
            raise AssertionError("예상보다 많은 API 호출")
        return self.responses.pop(0)
