"""형식 v10 곡선 규칙 (curves.py ↔ frontend curves.ts) + 검증·AI 검사. 형상 부피는 공유 픽스처(test_features.py)."""

from __future__ import annotations

import math

from app.ai.validator import validate_commands
from app.cad.commands import ModelDefinition
from app.cad.constraints import residuals
from app.cad.curves import (
    bulge_arc,
    corner_error,
    corner_segments,
    rounded_points,
    sweep_error,
    thin_polygon,
)
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
    return ModelDefinition.model_validate({"schemaVersion": 14, "units": "mm", "sketches": sketches, "objects": list(objects)})


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


# ---- 형식 v13: 호 변·대칭 구속 (frontend curves.test.ts 와 같은 값) -------------------------------


def test_bulge_arc_half_circle_and_inward():
    _, _, _, c, r, ccw, sweep, mid = bulge_arc((10, -10), (10, 10), 1)
    assert math.isclose(r, 10) and ccw and math.isclose(sweep, math.pi)
    assert math.isclose(c[0], 10) and math.isclose(mid[0], 20) and abs(mid[1]) < 1e-12
    _, _, _, _, r2, ccw2, _, mid2 = bulge_arc((10, -10), (10, 10), -math.tan(math.pi / 8))
    assert not ccw2 and math.isclose(r2, math.sqrt(2) * 10) and mid2[0] < 10


def test_arc_edge_area_and_errors():
    pts = rounded_points(SQUARE, None, True, [{"k": 1, "bulge": 1}])
    assert math.isclose(area(pts), 400 + 50 * math.pi, rel_tol=1e-2)
    assert [s[0] for s in corner_segments(SQUARE, None, True, [{"k": 1, "bulge": 1}])] == ["line", "arc", "line", "line"]
    assert "e4" in corner_error(SQUARE, None, True, [{"k": 4, "bulge": 1}])
    assert "e2" in corner_error([(0, 0), (10, 0), (10, 10)], None, False, [{"k": 2, "bulge": 1}])
    assert "호 변" in corner_error(SQUARE, [{"k": 2, "type": "fillet", "size": 1}], True, [{"k": 1, "bulge": 1}])
    assert corner_error(SQUARE, [{"k": 3, "type": "fillet", "size": 1}], True, [{"k": 1, "bulge": 1}]) is None


def test_symmetric_residual_and_check():
    def sk(p1, constraints):
        return model([{"id": "s", "name": "s", "plane": XY, "dimensions": [], "constraints": constraints, "entities": [
            {"id": "q", "type": "polygon", "points": [[0, 0], p1, [5, 10]]},
            {"id": "ax", "type": "line", "points": [[5, -5], [5, 30]]}]}])
    sym = {"id": "k1", "type": "symmetric", "refs": ["q.p0", "q.p1", "ax.e0"]}
    good = sk([10, 0], [sym])
    assert max(abs(v) for v in residuals(good.sketches[0], good.sketches[0].constraints[0])) < 1e-12
    assert check_model(good) == []
    bad = sk([11, 1], [sym])
    assert any("대칭" in i.message or "k1" in i.message for i in check_model(bad))
    dup = sk([10, 0], [{"id": "k1", "type": "symmetric", "refs": ["q.p0", "q.p0", "ax.e0"]}])
    assert any("두 번" in i.message for i in check_model(dup))


def test_ai_validator_v13():
    m = model([])
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_rectangle", "sketch": "s", "id": "r", "center": [0, 0], "width": 20, "height": 10},
        {"type": "convert_to_polygon", "sketch": "s", "entity": "r"},
        {"type": "set_arc", "sketch": "s", "entity": "r", "edge": 1, "bulge": 0.5},
        {"type": "add_line", "sketch": "s", "id": "ax", "points": [[0, -10], [0, 10]]},
        {"type": "add_constraint", "sketch": "s", "constraint": "symmetric", "refs": ["r.p0", "r.p1", "ax.e0"]},
    ], m)
    assert errs == []
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_rectangle", "sketch": "s", "id": "r", "center": [0, 0], "width": 20, "height": 10},
        {"type": "set_arc", "sketch": "s", "entity": "r", "edge": 1, "bulge": 0.5},
        {"type": "add_polygon", "sketch": "s", "id": "p", "points": [[0, 0], [10, 0], [0, 10]]},
        {"type": "set_arc", "sketch": "s", "entity": "p", "edge": 3, "bulge": 0.5},
        {"type": "convert_to_polygon", "sketch": "s", "entity": "p"},
    ], m)
    assert any("convert_to_polygon" in e for e in errs)
    assert any("e0..e2" in e for e in errs)
    assert any("is not a rectangle" in e for e in errs)
