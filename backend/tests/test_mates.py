"""조립 메이트 (형식 v11): 프론트엔드가 푼 공유 픽스처를 같은 잔차 규칙(mates.py)으로 검사."""

from __future__ import annotations

import copy

from app.cad.commands import ModelDefinition
from app.cad.mates import mate_errors, residuals
from app.cad.validation import check_model
from .conftest import load_json

FIXTURE = load_json("examples/model-assembly.json")


def test_frontend_solved_assembly_satisfies_mates():
    model = ModelDefinition.model_validate(FIXTURE)
    assert check_model(model) == []
    assert len(model.mates) == 7  # 고른 면 참조(v12) 포함
    for m in model.mates:
        assert max((abs(v) for v in residuals(model, m)), default=0) < 1e-5


def test_moved_part_breaks_mate():
    raw = copy.deepcopy(FIXTURE)
    next(o for o in raw["objects"] if o["id"] == "lid")["transform"]["position"][2] += 1
    errs = mate_errors(ModelDefinition.model_validate(raw))
    assert [mid for mid, _ in errs] == ["m_lid"]


def test_bad_refs_are_reported():
    raw = copy.deepcopy(FIXTURE)
    raw["mates"].append({"id": "bad", "type": "concentric", "refs": ["base.top", "lid.axis"]})
    raw["mates"].append({"id": "bad2", "type": "coincident", "refs": ["base.top", "ghost.bottom"]})
    msgs = dict(mate_errors(ModelDefinition.model_validate(raw)))
    assert "축끼리" in msgs["bad"]
    assert "ghost" in msgs["bad2"]


def test_ai_validator_mates():
    from app.ai.validator import validate_commands

    model = ModelDefinition.model_validate(FIXTURE)
    _, ok = validate_commands([
        {"type": "add_mate", "id": "m_new", "mate": "distance", "refs": ["base.+X", "lid.-X"], "value": 5},
        {"type": "set_mate", "mate": "m_new", "value": 6},
        {"type": "delete_mate", "mate": "m_gap"},
    ], model)
    assert ok == []
    _, errs = validate_commands([
        {"type": "add_mate", "mate": "coincident", "refs": ["base.start", "lid.bottom"]},
        {"type": "add_mate", "mate": "fix", "refs": ["base", "lid"]},
        {"type": "set_mate", "mate": "ghost", "value": 1},
        {"type": "insert_part", "name": "x", "part": {"sketches": [], "objects": [FIXTURE["objects"][0]]}},
    ], model)
    assert any("no face 'start'" in e for e in errs)
    assert any("needs 1 reference" in e for e in errs)
    assert any("no mate 'ghost'" in e for e in errs)
    assert any("insert_part" in e for e in errs)


def test_interference_api(client):
    t = lambda x: {"position": [x, 0, 0], "rotation": [0, 0, 0]}  # noqa: E731
    box = lambda i, x: {"id": i, "name": i, "kind": "box", "params": {"width": 10, "depth": 10, "height": 10}, "transform": t(x)}  # noqa: E731
    model = {"schemaVersion": 35, "units": "mm", "sketches": [], "objects": [box("a", 0), box("b", 7), box("c", 10), box("d", 30)]}
    r = client.post("/api/model/interference", json=model).json()
    assert r["ok"] is True
    # a∩b = 3×10×10, b∩c = 7×10×10, a·c 는 맞닿기만 (5 + 5 = 10), d 는 떨어짐
    assert sorted((p["a"], p["b"], round(p["volume"], 3)) for p in r["pairs"]) == [("a", "b", 300.0), ("b", "c", 700.0)]
