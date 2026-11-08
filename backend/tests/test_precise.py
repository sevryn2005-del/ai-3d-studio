"""형식 v9 정밀 피처 (서버 CadQuery): 규칙 선택·오류 메시지·AI 검증. 부피·형상은 공유 픽스처(test_features.py)가 브라우저 OCCT 엔진과 함께 검사한다."""

from __future__ import annotations

import base64

import cadquery as cq
import pytest

from app.ai.validator import validate_commands
from app.cad.commands import ModelDefinition
from app.cad.precise import draft_faces, read_step, select_edges
from app.cad.primitives import GeometryError, build_solid


def model(*objects) -> ModelDefinition:
    return ModelDefinition.model_validate({"schemaVersion": 30, "units": "mm", "sketches": [], "objects": list(objects)})


T0 = {"position": [0, 0, 0], "rotation": [0, 0, 0]}


@pytest.mark.parametrize(("rule", "count"), [("all", 12), ("vertical", 4), ("top", 4), ("bottom", 4)])
def test_box_edge_rules(rule, count):
    assert len(select_edges(cq.Solid.makeBox(10, 10, 10).wrapped, rule)) == count


def test_cylinder_seam_is_never_selected():
    cyl = cq.Solid.makeCylinder(5, 10).wrapped
    assert len(select_edges(cyl, "all")) == 2  # 위·아래 원 (이음선 제외)
    assert select_edges(cyl, "vertical") == []
    assert len(draft_faces(cyl)) == 1


def test_too_large_fillet_has_user_message():
    m = model(
        {"id": "b", "name": "상자", "kind": "box", "params": {"width": 10, "depth": 10, "height": 10}, "transform": T0},
        {"id": "f", "name": "필렛 1", "kind": "fillet", "fillet": {"source": "b", "type": "fillet", "size": 6, "edges": "all"}, "transform": T0},
    )
    index = {o.id: o for o in m.objects}
    with pytest.raises(GeometryError, match="크기를 줄여 보세요"):
        build_solid(index["f"], index)


def test_broken_step_has_user_message():
    with pytest.raises(GeometryError, match="STEP 파일을 읽을 수 없습니다"):
        read_step(base64.b64encode(b"not a step file").decode(), "깨진 파일")


def test_ai_validator_knows_wrappers():
    m = model({"id": "b", "name": "상자", "kind": "box", "params": {"width": 10, "depth": 10, "height": 10}, "transform": T0})
    _, ok = validate_commands([
        {"type": "edge_feature", "id": "f", "target": "b", "feature": "fillet", "size": 1, "edges": "top"},
        {"type": "set_edge_feature", "target": "f", "size": 2},
    ], m)
    assert ok == []
    _, errs = validate_commands([
        {"type": "edge_feature", "id": "f", "target": "b", "feature": "fillet", "size": 1, "edges": "top"},
        {"type": "draft", "target": "b", "angle": 3},
        {"type": "set_draft", "target": "f", "angle": 3},
    ], m)
    assert any("already inside 'f'" in e for e in errs)
    assert any("is not a draft feature" in e for e in errs)


def test_topology_api_and_picked_edges(client):
    t0 = {"position": [0, 0, 0], "rotation": [0, 0, 0]}
    model = {"schemaVersion": 30, "units": "mm", "sketches": [], "objects": [
        {"id": "c", "name": "원통", "kind": "cylinder", "params": {"radius": 4, "height": 9}, "transform": t0}]}
    r = client.post("/api/model/topology", json={"model": model, "id": "c"}).json()
    assert r["ok"] is True
    assert sorted(f["kind"] for f in r["faces"]) == ["cylinder", "plane", "plane"]
    circles = [e for e in r["edges"] if e["kind"] == "circle"]
    assert sorted(round(e["center"][2], 6) for e in circles) == [0, 9]
    top = next(e for e in circles if abs(e["center"][2] - 9) < 1e-6)
    # 중간점으로 모서리를 고르면 엔진이 같은 모서리를 찾는다
    model["objects"].append({"id": "f", "name": "모따기", "kind": "fillet",
                             "fillet": {"source": "c", "type": "chamfer", "size": 1, "edges": {"at": [top["mid"]]}}, "transform": t0})
    ok = client.post("/api/model/evaluate", json=model).json()
    assert ok["ok"] is True
    model["objects"][1]["fillet"]["edges"] = {"at": [[50, 50, 50]]}
    bad = client.post("/api/model/evaluate", json=model).json()
    assert bad["ok"] is False and "다시 고르세요" in bad["issues"][0]["message"]
