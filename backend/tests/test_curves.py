"""형식 v10 곡선 규칙 (curves.py ↔ frontend curves.ts) + 검증·AI 검사. 형상 부피는 공유 픽스처(test_features.py)."""

from __future__ import annotations

import math

from app.ai.validator import validate_commands
from app.cad.commands import ModelDefinition
from app.cad.curves import corner_error, rounded_points, sweep_error, thin_polygon
from app.cad.validation import check_model

SQUARE = [(-10, -10), (10, -10), (10, 10), (-10, 10)]


def area(pts) -> float:
    return abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))) / 2


def test_fillet_and_chamfer_areas():
    fillet = rounded_points(SQUARE, [{"k": k, "type": "fillet", "size": 3} for k in range(4)], True)
    assert math.isclose(area(fillet), 400 - (4 - math.pi) * 9, rel_tol=2e-3)
    chamfer = rounded_points(SQUARE, [{"k": 0, "type": "chamfer", "size": 3}], True)
    assert math.isclose(area(chamfer), 400 - 4.5)


def test_corner_too_big_and_path_ends():
    assert corner_error(SQUARE, [{"k": 0, "type": "fillet", "size": 15}], True) is None  # 한 꼭짓점만: 변 20 안에 들어감
    assert "변 길이" in corner_error(SQUARE, [{"k": k, "type": "fillet", "size": 11} for k in range(4)], True)
    assert "양 끝점" in corner_error([(0, 0), (10, 0), (10, 10)], [{"k": 0, "type": "fillet", "size": 1}], False)


def test_thin_polygon_area_equals_thickness_times_length():
    assert math.isclose(area(thin_polygon([(0, 0), (20, 0), (20, 10)], 2)), 60)


def test_sweep_bend_too_sharp():
    prof = [(3, 0), (0, 3), (-3, 0), (0, -3)]
    assert sweep_error(prof, [(0, 0), (2, 0), (2, 10)]) is not None
    assert sweep_error(prof, [(0, 0), (20, 0), (20, 10)]) is None


def model(sketches, objects=()):
    return ModelDefinition.model_validate({"schemaVersion": 12, "units": "mm", "sketches": sketches, "objects": list(objects)})


T0 = {"position": [0, 0, 0], "rotation": [0, 0, 0]}
XY = {"type": "XY", "offset": 0}


def test_check_model_rejects_bad_corner_and_open_line_extrude():
    bad = model([{"id": "s", "name": "s", "plane": XY, "constraints": [], "dimensions": [], "entities": [
        {"id": "p", "type": "polygon", "points": [list(q) for q in SQUARE], "corners": [{"k": k, "type": "fillet", "size": 11} for k in range(4)]}]}])
    assert any("변 길이" in i.message for i in check_model(bad))
    line_extrude = model([{"id": "s", "name": "s", "plane": XY, "constraints": [], "dimensions": [], "entities": [
        {"id": "pa", "type": "path", "points": [[0, 0], [10, 0]]}]}],
        [{"id": "e", "name": "e", "kind": "extrude", "params": {"distance": 5}, "extrude": {"sketch": "s", "profile": "pa"}, "transform": T0}])
    assert any("pa" in i.message for i in check_model(line_extrude))


def test_ai_validator_v10():
    m = model([])
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_path", "sketch": "s", "id": "pa", "points": [[0, 0], [10, 0], [10, 10]]},
        {"type": "set_corner", "sketch": "s", "entity": "pa", "corner": "fillet", "size": 3},
        {"type": "extrude", "sketch": "s", "profile": "pa", "distance": 5, "thin": 2},
        {"type": "add_constraint", "sketch": "s", "constraint": "horizontal", "refs": ["pa.e0"]},
    ], m)
    assert errs == []
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_path", "sketch": "s", "id": "pa", "points": [[0, 0], [10, 0]]},
        {"type": "extrude", "sketch": "s", "profile": "pa", "distance": 5},
        {"type": "add_constraint", "sketch": "s", "constraint": "horizontal", "refs": ["pa.e1"]},
        {"type": "sweep", "sketch": "s", "profile": "pa", "pathSketch": "s", "path": "pa"},
    ], m)
    assert any("give thin" in e for e in errs)
    assert any("pa.e1" in e for e in errs)
    assert any("no closed profile" in e for e in errs)
