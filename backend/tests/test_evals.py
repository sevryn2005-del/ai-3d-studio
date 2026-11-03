"""평가 도구 자체의 검증 (실제 API 없이)."""

import json

import pytest

from app.ai.chat import ChatResult, Usage
from evals.run import case_model, grade, load_cases, main, matches


def test_all_cases_have_valid_models_and_expectations():
    cases = load_cases()
    assert len({c["id"] for c in cases}) == len(cases) >= 10
    for c in cases:
        m = case_model(c)
        if c.get("selected"):
            assert any(o.id == c["selected"] for o in m.objects), c["id"]
        assert c["expect"]["kind"]


@pytest.mark.parametrize("actual,expected,ok", [
    ({"type": "set_params", "target": "box_1", "params": {"height": 50.0}}, {"type": "set_params", "params": {"height": 50}}, True),
    ({"type": "set_params", "params": {"height": 49}}, {"params": {"height": 50}}, False),
    ({"offset": [20, 0, 0]}, {"offset": [20, 0, 0]}, True),
    ({"offset": [20, 0]}, {"offset": [20, 0, 0]}, False),
])
def test_matches(actual, expected, ok):
    assert matches(actual, expected) is ok


def test_grade_any_of_and_kind_lists():
    r = ChatResult("commands", "", Usage(), commands=[{"type": "set_transform", "target": "box_1", "position": [20, 0, 0]}])
    expect = {"kind": "commands", "any_of": [[{"type": "translate", "offset": [20, 0, 0]}], [{"type": "set_transform", "position": [20, 0, 0]}]]}
    assert grade(r, expect) == (True, "ok")
    assert grade(ChatResult("message", "", Usage()), {"kind": ["question", "message"]})[0]
    assert not grade(ChatResult("commands", "", Usage()), {"kind": "question"})[0]


def test_replay_scores_a_recording(tmp_path, capsys):
    """녹화 형식(Messages API 응답의 JSON) → 재생 → 채점. 테스트용으로 직접 작성한 녹화다."""
    recording = [{
        "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "stop_reason": "tool_use",
        "content": [{"type": "tool_use", "id": "toolu_1", "name": "apply_cad_commands",
                     "input": {"message": "높이를 50mm로 바꿨습니다.", "commands": [{"type": "set_params", "target": "box_1", "params": {"height": 50}}]}}],
        "usage": {"input_tokens": 2500, "output_tokens": 120, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
    }]
    (tmp_path / "height-50.json").write_text(json.dumps(recording), encoding="utf-8")
    code = main(["--replay", "--case", "height-50", "--recordings", str(tmp_path)])
    out = capsys.readouterr().out
    assert code == 0 and "통과 1/1" in out


def test_live_requires_explicit_consent(capsys, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-0000")
    assert main(["--live", "--case", "height-50"]) == 2
    assert "--yes" in capsys.readouterr().err
