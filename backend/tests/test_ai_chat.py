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
    return ModelDefinition.model_validate({"schemaVersion": 14, "units": "mm", "sketches": [], "objects": base + list(objs)})


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

    def test_sketch_plate_batch(self):
        cmds, errors = validate_commands([
            {"type": "create_sketch", "id": "sk_plate"},
            {"type": "add_rectangle", "sketch": "sk_plate", "id": "r1", "width": 60, "height": 40},
            {"type": "extrude", "id": "plate", "sketch": "sk_plate", "profile": "r1", "distance": 4},
            {"type": "set_dimension", "sketch": "sk_plate", "dimension": "r1.width", "value": 80},
            {"type": "set_params", "target": "plate", "params": {"distance": 5}},
        ], model_with())
        assert errors == [] and len(cmds) == 5

    def test_sketch_reference_errors(self):
        _, errors = validate_commands([
            {"type": "create_sketch", "id": "box_1"},
            {"type": "add_circle", "sketch": "ghost", "diameter": 3},
            {"type": "create_sketch", "id": "sk"},
            {"type": "add_circle", "sketch": "sk", "diameter": 3},
            {"type": "set_dimension", "sketch": "sk", "dimension": "circle1.width", "value": 3},
            {"type": "extrude", "sketch": "sk", "profile": "r1", "distance": 2},
            {"type": "set_params", "target": "box_1", "params": {"distance": 2}},
        ], model_with())
        assert errors == [
            "commands[0].id: id 'box_1' is already used",
            "commands[1].sketch: sketch 'ghost' does not exist (existing: box_1)",
            "commands[4].dimension: sketch 'sk' has no dimension 'circle1.width' (existing: circle1.diameter)",
            "commands[5].profile: sketch 'sk' has no element 'r1' (existing: circle1)",
            "commands[6].params: box 'box_1' has no parameter distance (allowed: depth, height, width)",
        ]

    def test_sketch_management(self):
        plate = model_with()
        data = plate.model_dump(mode="json")
        data["sketches"] = [{"id": "sk", "name": "판", "plane": {"type": "XY", "offset": 0},
                             "entities": [{"id": "r1", "type": "rectangle", "center": [0, 0]}, {"id": "c1", "type": "circle", "center": [5, 0]}],
                             "dimensions": [{"id": "r1.width", "entity": "r1", "kind": "width", "value": 60},
                                            {"id": "r1.height", "entity": "r1", "kind": "height", "value": 40},
                                            {"id": "c1.diameter", "entity": "c1", "kind": "diameter", "value": 3}],
                             "constraints": []}]
        data["objects"].append({"id": "plate", "name": "판", "kind": "extrude", "params": {"distance": 4},
                                "extrude": {"sketch": "sk", "profile": "r1"}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}})
        m = ModelDefinition.model_validate(data)
        _, errors = validate_commands([
            {"type": "set_entity_center", "sketch": "sk", "entity": "c1", "center": [10, 0]},
            {"type": "delete_sketch_entity", "sketch": "sk", "entity": "c1"},
            {"type": "set_entity_center", "sketch": "sk", "entity": "c1", "center": [0, 0]},
            {"type": "delete_sketch_entity", "sketch": "sk", "entity": "r1"},
            {"type": "delete_sketch", "sketch": "sk"},
            {"type": "rename_sketch", "sketch": "sk", "name": "윤곽"},
        ], m)
        assert errors == [
            "commands[2].entity: sketch 'sk' has no element 'c1' (existing: r1)",
            "commands[3].entity: 'r1' is used by extrude plate; delete those objects first",
            "commands[4].sketch: sketch 'sk' is used by extrude plate; delete those objects first",
        ]
        cmds, errors = validate_commands([
            {"type": "cut", "id": "holed", "base": "plate", "tools": ["box_1"]},
            {"type": "delete_object", "target": "holed"},
            {"type": "delete_sketch", "sketch": "sk"},
        ], m)
        assert errors == [] and len(cmds) == 3

    def test_face_sketch(self):
        cmds, errors = validate_commands([
            {"type": "create_sketch", "id": "sk_plate"},
            {"type": "add_rectangle", "sketch": "sk_plate", "id": "r1", "width": 60, "height": 40},
            {"type": "extrude", "id": "plate", "sketch": "sk_plate", "profile": "r1", "distance": 4},
            {"type": "create_sketch", "id": "sk_top", "plane": {"type": "face", "object": "plate", "face": "end", "offset": 0}},
            {"type": "add_circle", "sketch": "sk_top", "id": "c1", "diameter": 6},
            {"type": "extrude", "id": "hole", "sketch": "sk_top", "profile": "c1", "distance": -6},
            {"type": "cut", "id": "holed", "base": "plate", "tools": ["hole"]},
            {"type": "create_sketch", "id": "sk_side", "plane": {"type": "face", "object": "holed", "face": "+u", "offset": 0}},
            {"type": "create_sketch", "id": "sk_box", "plane": {"type": "face", "object": "box_1", "face": "-Y", "offset": 0}},
        ], model_with())
        assert errors == [] and len(cmds) == 9

    def test_face_sketch_errors(self):
        _, errors = validate_commands([
            {"type": "create_sphere", "id": "ball", "radius": 5},
            {"type": "create_sketch", "id": "a", "plane": {"type": "face", "object": "ball", "face": "top", "offset": 0}},
            {"type": "create_sketch", "id": "b", "plane": {"type": "face", "object": "box_1", "face": "end", "offset": 0}},
            {"type": "create_sketch", "id": "c", "plane": {"type": "face", "object": "box_1", "face": "top", "offset": 0}},
            {"type": "delete_object", "target": "box_1"},
        ], model_with())
        assert errors == [
            "commands[1].plane.face: sphere 'ball' has no face 'top' (faces: none)",
            "commands[2].plane.face: box 'box_1' has no face 'end' (faces: top, bottom, +X, -X, +Y, -Y)",
            "commands[4].target: sketch c is attached to a face of 'box_1'; delete or move those sketches first",
        ]

    def test_constraint_commands(self):
        cmds, errors = validate_commands([
            {"type": "create_sketch", "id": "sk"},
            {"type": "add_polygon", "sketch": "sk", "id": "l", "points": [[0, 0], [60, 0], [60, 15], [20, 15], [20, 40], [0, 40]]},
            {"type": "add_circle", "sketch": "sk", "id": "c1", "center": [40, 7], "diameter": 6},
            {"type": "add_constraint", "sketch": "sk", "id": "k1", "constraint": "fix", "refs": ["l.p0"]},
            {"type": "add_constraint", "sketch": "sk", "constraint": "horizontal", "refs": ["l.e0"]},
            {"type": "add_constraint", "sketch": "sk", "id": "k3", "constraint": "length", "refs": ["l.e0"], "value": 60},
            {"type": "add_constraint", "sketch": "sk", "constraint": "distance", "refs": ["l.p1", "c1.center"], "value": 21},
            {"type": "add_constraint", "sketch": "sk", "constraint": "tangent", "refs": ["l.e1", "c1"]},
            {"type": "set_constraint", "sketch": "sk", "constraint": "k3", "value": 70},
            {"type": "move_point", "sketch": "sk", "point": "l.p2", "to": [70, 15]},
            {"type": "delete_constraint", "sketch": "sk", "constraint": "k1"},
            {"type": "extrude", "id": "bracket", "sketch": "sk", "profile": "l", "distance": 5},
        ], model_with())
        assert errors == [] and len(cmds) == 12

    def test_constraint_command_errors(self):
        _, errors = validate_commands([
            {"type": "create_sketch", "id": "sk"},
            {"type": "add_polygon", "sketch": "sk", "id": "bad", "points": [[0, 0], [10, 10], [10, 0], [0, 10]]},
            {"type": "add_polygon", "sketch": "sk", "id": "t", "points": [[0, 0], [10, 0], [5, 8]]},
            {"type": "add_constraint", "sketch": "sk", "constraint": "length", "refs": ["t.p0"], "value": 3},
            {"type": "add_constraint", "sketch": "sk", "constraint": "horizontal", "refs": ["t.e5"]},
            {"type": "add_constraint", "sketch": "sk", "constraint": "length", "refs": ["t.e0"]},
            {"type": "move_point", "sketch": "sk", "point": "t.e0", "to": [1, 1]},
            {"type": "set_constraint", "sketch": "sk", "constraint": "k9", "value": 3},
        ], model_with())
        assert errors[0] == "commands[1].points: 변 e0 와 e2 가 교차합니다 (꼬인 다각형)"
        assert errors[1] == "commands[3].refs: length needs edge, got point"
        assert errors[2].startswith("commands[4].refs: sketch 'sk' has no point/edge/circle 't.e5'")
        assert errors[3] == "commands[5].value: length needs a value in mm"
        assert errors[4].startswith("commands[6].point: 't.e0' is not a point")
        assert errors[5] == "commands[7].constraint: sketch 'sk' has no constraint 'k9' (existing: k1, k2, k3)"

    @pytest.mark.parametrize("raw", [None, [], "x", [{"type": "exec_python"}]])
    def test_malformed(self, raw):
        assert validate_commands(raw, model_with())[1]
