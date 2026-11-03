"""다른 CAD·블렌더에서 실제로 보고된 문제가 서버(OCCT) 엔진에서도 생기지 않는지 (docs/issue-survey.md).

브라우저 엔진 쪽: frontend/src/features/engine/browser/issueSurvey.test.ts — 같은 공유 픽스처, 같은 기대값.
"""

import copy

import numpy as np
import pytest

from app.cad.commands import ModelDefinition
from app.cad.exporter import mesh_volume
from app.cad.validation import check_model

from .conftest import load_json
from .test_export import export, is_watertight

SURVEY = load_json("examples/survey-cases.json")


def outward(tris: np.ndarray) -> bool:
    """방향 있는 모서리 a→b 마다 반대 방향 b→a 가 정확히 한 번 → 법선이 일관되게 바깥을 향함 (부피 > 0 과 함께)."""
    from collections import Counter

    q = np.round(tris, 4)
    directed = Counter()
    for t in q:
        for i in range(3):
            directed[(tuple(t[i]), tuple(t[(i + 1) % 3]))] += 1
    return all(c == 1 and directed.get((b, a)) == 1 for (a, b), c in directed.items())


@pytest.mark.parametrize("name", list(SURVEY))
def test_survey_cases_watertight_and_positive(client, name):
    """4-3 · 4-5 · 7-3 · 7-4: 맞닿은 면 합치기, 같은 평면 관통 컷, 접하는 컷, 축 위 회전, 음수 돌출."""
    case = SURVEY[name]
    assert check_model(ModelDefinition.model_validate(case["model"])) == []
    tris = export(client, case["model"])
    assert is_watertight(tris)
    assert outward(tris)
    v = mesh_volume(tris)
    assert v > 0
    assert v == pytest.approx(case["volume"], rel=3e-3)


def _box_model(height: float, fillet: float) -> dict:
    model = copy.deepcopy(load_json("examples/model-cut-rotated.json"))
    box = {
        "id": "b", "name": "박스", "kind": "box",
        "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]},
        "params": {"width": 10, "depth": 20, "height": height},
        "edgeFeature": {"type": "fillet", "size": fillet, "edges": "all"},
    }
    model["objects"] = [box]
    model["sketches"] = []
    return model


@pytest.mark.parametrize(("size", "ok"), [(4.99, True), (5.0, False), (5.01, False)])
def test_fillet_boundary_matches_browser(size, ok):
    """4-1: 가장 짧은 변(10mm)의 절반 경계 — 브라우저 실행기와 같은 경계, 실패 시 최대값을 알려 준다."""
    issues = check_model(ModelDefinition.model_validate(_box_model(30, size)))
    assert (issues == []) is ok
    if not ok:
        assert "5mm 보다 작아야" in issues[0].message


def test_fillet_after_shrinking_dimension_is_reported():
    """3-2: 필렛 R4 박스 높이를 6 으로 → 조용히 깨지지 않고 이유와 함께 거부."""
    issues = check_model(ModelDefinition.model_validate(_box_model(6, 4)))
    assert issues and "너무 큽니다" in issues[0].message


def test_near_closed_polygon_is_rejected():
    """2-4 · 4-6: 첫 점과 끝 점이 1e-5mm (보이지 않는 틈) → 손으로 고친 파일도 거부."""
    model = copy.deepcopy(load_json("examples/model-constraint-bracket.json"))
    poly = next(e for s in model["sketches"] for e in s["entities"] if e["type"] == "polygon")
    poly["points"].append([poly["points"][0][0], poly["points"][0][1] + 1e-5])
    poly_sketch = next(s for s in model["sketches"] if poly in s["entities"])
    poly_sketch["constraints"] = []
    messages = [i.message for i in check_model(ModelDefinition.model_validate(model))]
    assert any("너무 짧습니다" in m for m in messages)
