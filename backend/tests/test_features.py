"""형식 v6 피처 (쉘·구멍·패턴·대칭·억제) — 서버(CadQuery) 엔진.

공유 픽스처 shared/schemas/examples/feature-cases.json (schemaExport.ts FEATURE_CASES).
브라우저 엔진 features.test.ts 와 같은 기대값: 해석적 부피, 닫힌 메시, 계산되는 최상위 객체 수.
"""

import copy

import pytest

from app.cad.commands import ModelDefinition
from app.cad.exporter import EXPORT_LINEAR_TOLERANCE, mesh_volume
from app.cad.validation import active_top_level_ids, check_model

from .conftest import load_json
from .test_export import export, is_watertight
from .test_issue_survey import outward

CASES = load_json("examples/feature-cases.json")


@pytest.mark.parametrize("name", list(CASES))
def test_feature_cases_match_browser_engine(client, name):
    case = CASES[name]
    model = ModelDefinition.model_validate(case["model"])
    assert check_model(model) == []
    assert len(active_top_level_ids(model)) == case["roots"]
    tris = export(client, case["model"])
    assert is_watertight(tris)
    assert outward(tris)
    assert mesh_volume(tris) == pytest.approx(case["volume"], rel=3e-3)
    if "bbox" in case:
        pts = tris.reshape(-1, 3)
        assert pts.min(axis=0).tolist() == pytest.approx(case["bbox"][0], abs=EXPORT_LINEAR_TOLERANCE)
        assert pts.max(axis=0).tolist() == pytest.approx(case["bbox"][1], abs=EXPORT_LINEAR_TOLERANCE)


def _first(name: str) -> dict:
    return copy.deepcopy(CASES[name]["model"])


def test_shell_too_thick_is_reported():
    data = _first("shell-box-open-top")
    data["objects"][0]["shell"]["thickness"] = 10
    msgs = [i.message for i in check_model(ModelDefinition.model_validate(data))]
    assert any("10mm 보다 작아야" in m for m in msgs)


def test_pattern_rules_match_frontend():
    data = _first("pattern-linear-2d")
    pat = next(o for o in data["objects"] if o["kind"] == "pattern")
    pat["pattern"]["axis2"] = pat["pattern"]["axis"]
    msgs = [i.message for i in check_model(ModelDefinition.model_validate(data))]
    assert any("다른 축" in m for m in msgs)


def test_hole_param_rules():
    data = _first("hole-counterbore")
    hole = next(o for o in data["objects"] if o["kind"] == "hole")
    hole["params"]["cboreDiameter"] = 5
    with pytest.raises(ValueError, match="카운터보어 지름"):
        ModelDefinition.model_validate(data)


def test_all_suppressed_export_is_rejected(client):
    data = _first("suppressed-tool-and-root")
    for o in data["objects"]:
        o["suppressed"] = True
    r = client.post("/api/export/stl", json=data)
    assert r.status_code != 200


def test_worker_mesh_cache_reuses_and_invalidates():
    """서버 객체별 메시 캐시: 같은 객체·스케치면 재사용, 치수·자식 위치가 바뀌면 다시 계산, 최상위 위치만 바뀌면 재사용"""
    from app.cad import jobs

    jobs._MESH_CACHE.clear()
    model = _first("hole-counterbore")
    first = jobs.evaluate(model)
    assert len(jobs._MESH_CACHE) == 1
    root = next(o for o in model["objects"] if o["kind"] == "boolean")
    root["transform"]["position"] = [50, 0, 0]
    assert jobs.evaluate(model)["meshes"] == first["meshes"]  # 위치만 바뀜 → 캐시
    assert len(jobs._MESH_CACHE) == 1
    box = next(o for o in model["objects"] if o["kind"] == "box")
    box["params"]["width"] = 50
    changed = jobs.evaluate(model)
    assert changed["meshes"] != first["meshes"] and len(jobs._MESH_CACHE) == 2
