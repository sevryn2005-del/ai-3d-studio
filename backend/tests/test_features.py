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


def test_shared_mesh_cache_reuses_and_invalidates(client):
    """API 공유 메시 캐시: 같은 객체·스케치면 재사용, 최상위 위치만 바뀌면 재사용, 치수가 바뀌면 다시 계산"""
    from app.api import modeling

    cache = modeling.mesh_cache(client.app.state.cad_pool)
    cache._data.clear()
    model = _first("hole-counterbore")
    first = client.post("/api/model/evaluate", json=model).json()
    assert first["ok"] and len(cache) == 1
    root = next(o for o in model["objects"] if o["kind"] == "boolean")
    root["transform"]["position"] = [50, 0, 0]
    again = client.post("/api/model/evaluate", json=model).json()
    assert again["meshes"] == first["meshes"] and len(cache) == 1
    box = next(o for o in model["objects"] if o["kind"] == "box")
    box["params"]["width"] = 50
    changed = client.post("/api/model/evaluate", json=model).json()
    assert changed["meshes"] != first["meshes"] and len(cache) == 2


def test_api_process_does_not_load_cadquery():
    """CadQuery(OCCT)는 격리 워커에서만 — API 프로세스의 검증·캐시 모듈은 불러오지 않는다"""
    import subprocess
    import sys

    code = "import sys, app.api.modeling, app.cad.validation; print('cadquery' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"


def test_mesh_cache_claims_dedupe_concurrent_work():
    """같은 키를 두 요청이 동시에 맡지 않는다: 두 번째는 기다릴 이벤트를 받고, 끝나면 깨어난다"""
    from app.cad.mesh_cache import MeshCache

    c = MeshCache()
    mine, waits = c.claim(["a", "b"])
    assert mine == ["a", "b"] and waits == []
    mine2, waits2 = c.claim(["a", "c"])
    assert mine2 == ["c"] and len(waits2) == 1 and not waits2[0].is_set()
    c.put("a", {"m": 1})
    c.release(["a", "b"])
    assert waits2[0].is_set()
    assert c.claim(["a"]) == ([], [])


def test_curve_matrices_match_frontend():
    """형식 v35: 곡선 따라 패턴 행렬 — 프론트 references.test.ts 와 같은 값"""
    import numpy as np

    from app.cad.features import curve_matrices

    pts = [(0, 0), (40, 0), (40, 40)]

    def at(m, x, y):
        return [round(float(v), 9) + 0.0 for v in (m @ np.array([x, y, 0, 1.0]))[:3]]

    assert [at(m, 1, 0) for m in curve_matrices(pts, np.eye(4), 3, False)] == [[1, 0, 0], [41, 0, 0], [41, 40, 0]]
    assert [at(m, 1, 0) for m in curve_matrices(pts, np.eye(4), 3, True)] == [[1, 0, 0], [41, 0, 0], [40, 41, 0]]
