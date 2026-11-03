"""AI 채팅 루프: 대체 클라이언트로 실제 API 비용 없이 검증."""

import pytest

from app.ai.chat import MAX_ATTEMPTS, ChatTurn, run_chat
from app.ai.prompt_builder import APPLY_TOOL, ASK_TOOL
from app.ai.validator import validate_commands
from app.cad.commands import ModelDefinition

from .fake_llm import ScriptedClient, response, text, tool


def model_with(*objs) -> ModelDefinition:
    base = [
        {"id": "box_1", "name": "큐브", "kind": "box", "params": {"width": 20, "depth": 20, "height": 20},
         "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}},
    ]
    return ModelDefinition.model_validate({"schemaVersion": 1, "units": "mm", "objects": base + list(objs)})


def chat(client, text_in="높이를 50mm로 바꿔줘", selected="box_1", history=(), model=None):
    return run_chat(client, model_name="claude-opus-5-5", model=model or model_with(), selected_id=selected,
                    history=list(history), user_text=text_in)


SET_HEIGHT = {"message": "높이를 50mm로 바꿨습니다.", "commands": [{"type": "set_params", "target": "box_1", "params": {"height": 50}}]}


def test_height_50_becomes_set_params_command():
    """첫 번째 목표: '높이를 50mm로 바꿔줘' → set_params 명령."""
    client = ScriptedClient(response(tool(APPLY_TOOL, SET_HEIGHT)))
    r = chat(client)
    assert r.kind == "commands"
    assert r.commands == [{"type": "set_params", "target": "box_1", "params": {"height": 50}}]
    assert r.message == "높이를 50mm로 바꿨습니다."
    assert r.usage.requests == 1 and r.usage.input_tokens == 1000


def test_request_shape_caching_and_context():
    client = ScriptedClient(response(tool(APPLY_TOOL, SET_HEIGHT)))
    chat(client, history=[ChatTurn("user", "박스 만들어줘"), ChatTurn("assistant", "만들었습니다.")])
    req = client.requests[0]
    assert req["model"] == "claude-opus-5-5"
    assert req["output_config"] == {"effort": "medium"}
    assert "thinking" not in req and "tool_choice" not in req  # Opus 5.5: 강제 도구 호출 금지, thinking 기본값
    assert req["system"][0]["cache_control"] == {"type": "ephemeral"}  # 고정 프롬프트 캐시
    assert [t["name"] for t in req["tools"]] == [APPLY_TOOL, ASK_TOOL]
    msgs = req["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    last = msgs[-1]["content"]
    assert '"id":"box_1"' in last[0]["text"] and "<selected_object>box_1</selected_object>" in last[0]["text"]
    assert last[1]["text"] == "높이를 50mm로 바꿔줘"


def test_invalid_command_is_sent_back_and_fixed():
    bad = {"message": "x", "commands": [{"type": "set_params", "target": "box_9", "params": {"height": 50}}]}
    client = ScriptedClient(
        response(tool(APPLY_TOOL, bad, id="toolu_a")),
        response(tool(APPLY_TOOL, SET_HEIGHT, id="toolu_b")),
    )
    r = chat(client)
    assert r.kind == "commands" and r.usage.requests == 2 and r.usage.input_tokens == 2000
    retry = client.requests[1]["messages"]
    assert retry[-2]["role"] == "assistant"
    result = retry[-1]["content"][0]
    assert result["type"] == "tool_result" and result["tool_use_id"] == "toolu_a" and result["is_error"] is True
    assert "box_9" in result["content"] and "does not exist" in result["content"]


def test_gives_up_after_max_attempts():
    bad = {"message": "x", "commands": [{"type": "create_box", "width": -5, "depth": 1, "height": 1}]}
    client = ScriptedClient(*[response(tool(APPLY_TOOL, bad, id=f"t{i}")) for i in range(MAX_ATTEMPTS)])
    r = chat(client)
    assert r.kind == "error" and r.usage.requests == MAX_ATTEMPTS
    assert any("0.1 이상" in i for i in r.issues)


def test_ask_user_question_with_options():
    client = ScriptedClient(response(tool(ASK_TOOL, {"question": "컵의 지름과 높이는 얼마로 할까요?", "options": ["지름 80mm, 높이 100mm", "지름 70mm, 높이 90mm"]})))
    r = chat(client, "컵 만들어줘")
    assert r.kind == "question"
    assert r.message == "컵의 지름과 높이는 얼마로 할까요?"
    assert r.options == ["지름 80mm, 높이 100mm", "지름 70mm, 높이 90mm"]


def test_text_only_answer():
    r = chat(ScriptedClient(response(text("3D 프린팅에는 3MF 형식을 권장합니다."))), "어떤 형식으로 저장해?")
    assert r.kind == "message" and "3MF" in r.message


def test_refusal_is_checked_before_content():
    r = chat(ScriptedClient(response(text("partial"), stop_reason="refusal")))
    assert r.kind == "refused" and "partial" not in r.message


def test_usage_includes_cache_tokens():
    client = ScriptedClient(response(tool(APPLY_TOOL, SET_HEIGHT), cache_read=3000, cache_write=0))
    assert chat(client).usage.cache_read_input_tokens == 3000


def test_history_must_start_with_user():
    client = ScriptedClient(response(tool(APPLY_TOOL, SET_HEIGHT)))
    chat(client, history=[ChatTurn("assistant", "안녕하세요!"), ChatTurn("user", "박스"), ChatTurn("assistant", "네")])
    assert client.requests[0]["messages"][0]["role"] == "user"


class TestValidator:
    def test_through_hole_batch_with_explicit_ids(self):
        cmds, errors = validate_commands([
            {"type": "create_box", "id": "plate", "width": 60, "depth": 40, "height": 5},
            {"type": "create_cylinder", "id": "hole", "radius": 3, "height": 7, "position": [0, 0, -1]},
            {"type": "cut", "id": "plate_holed", "base": "plate", "tools": ["hole"]},
            {"type": "translate", "target": "hole", "offset": [10, 0, 0]},
        ], model_with())
        assert errors == [] and len(cmds) == 4

    def test_param_not_on_kind(self):
        _, errors = validate_commands([
            {"type": "create_cylinder", "id": "pin", "radius": 3, "height": 7},
            {"type": "set_params", "target": "pin", "params": {"width": 5}},
        ], model_with())
        assert errors == ["commands[1].params: cylinder 'pin' has no parameter width (allowed: height, radius)"]

    def test_operand_already_in_boolean(self):
        _, errors = validate_commands([
            {"type": "create_cylinder", "id": "a", "radius": 1, "height": 1},
            {"type": "create_cylinder", "id": "b", "radius": 1, "height": 1},
            {"type": "cut", "id": "c", "base": "box_1", "tools": ["a"]},
            {"type": "union", "base": "b", "tools": ["a"]},
        ], model_with())
        assert any("already inside boolean 'c'" in e for e in errors)

    def test_duplicate_id_and_deleted_reference(self):
        _, errors = validate_commands([
            {"type": "create_box", "id": "box_1", "width": 1, "depth": 1, "height": 1},
            {"type": "delete_object", "target": "box_1"},
            {"type": "translate", "target": "box_1", "offset": [1, 0, 0]},
        ], model_with())
        assert any("already used" in e for e in errors)
        assert any("does not exist" in e for e in errors)

    def test_fillet_only_on_box(self):
        _, errors = validate_commands([
            {"type": "create_sphere", "id": "s", "radius": 5},
            {"type": "fillet", "target": "s", "radius": 1},
            {"type": "chamfer", "target": "box_1", "distance": 1, "edges": "vertical"},
        ], model_with())
        assert errors == ["commands[1].target: fillet/chamfer only works on boxes; 's' is a sphere"]

    @pytest.mark.parametrize("raw", [None, [], "x", [{"type": "exec_python"}]])
    def test_malformed(self, raw):
        assert validate_commands(raw, model_with())[1]
