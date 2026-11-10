"""형식 v10 곡선 규칙 (curves.py ↔ frontend curves.ts) + 검증·AI 검사. 형상 부피는 공유 픽스처(test_features.py)."""

from __future__ import annotations

import math

import pytest

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
    return ModelDefinition.model_validate({"schemaVersion": 38, "units": "mm", "sketches": sketches, "objects": list(objects)})


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


# ---- 형식 v15: 영역 단면 -------------------------------------------------------------------------


def test_region_rules_and_ai_validator():
    from app.cad.commands import resolve_profile

    def sk(items):
        return model([{"id": "s", "name": "s", "plane": XY, "constraints": [], "entities": [
            {"id": "r", "type": "rectangle", "center": [0, 0]},
            {"id": "c", "type": "circle", "center": [5, 0]},
            {"id": "pa", "type": "path", "points": [[0, 0], [10, 0]]},
            {"id": "g", "type": "region", "items": items}],
            "dimensions": [{"id": "r.width", "entity": "r", "kind": "width", "value": 20},
                           {"id": "r.height", "entity": "r", "kind": "height", "value": 10},
                           {"id": "c.diameter", "entity": "c", "kind": "diameter", "value": 4}]}])
    good = sk([{"entity": "r", "op": "add"}, {"entity": "c", "op": "subtract"}])
    assert check_model(good) == []
    p = resolve_profile(good.sketches[0], "g")
    assert p["type"] == "region" and p["width"] == 20 and [it["op"] for it in p["items"]] == ["add", "subtract"]
    for items, msg in [([{"entity": "c", "op": "subtract"}], "첫 요소"), ([{"entity": "r", "op": "add"}, {"entity": "pa", "op": "add"}], "닫힌 요소"),
                       ([{"entity": "r", "op": "add"}, {"entity": "r", "op": "subtract"}], "두 번"), ([{"entity": "g", "op": "add"}], "자기 자신"),
                       ([{"entity": "x", "op": "add"}], "없습니다")]:
        assert any(msg in i.message for i in check_model(sk(items))), msg
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_rectangle", "sketch": "s", "id": "r", "center": [0, 0], "width": 40, "height": 20},
        {"type": "add_circle", "sketch": "s", "id": "c", "center": [10, 0], "diameter": 6},
        {"type": "add_region", "sketch": "s", "id": "g", "items": [{"entity": "r", "op": "add"}, {"entity": "c", "op": "subtract"}]},
        {"type": "extrude", "sketch": "s", "profile": "g", "distance": 5},
    ], model([]))
    assert errs == []
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_rectangle", "sketch": "s", "id": "r", "center": [0, 0], "width": 40, "height": 20},
        {"type": "add_region", "sketch": "s", "id": "g", "items": [{"entity": "r", "op": "subtract"}, {"entity": "zz", "op": "add"}]},
        {"type": "helix", "sketch": "s", "profile": "g", "pitch": 5, "turns": 2},
    ], model([]))
    assert any("must be op 'add'" in e for e in errs)
    assert any("'zz' is not a closed element" in e for e in errs)
    assert any("regions only work" in e for e in errs)


# ---- 형식 v16: 스플라인 (frontend curves.test.ts 와 같은 값) ----------------------------------------


def test_spline_segments_pass_through_points_and_errors():
    from app.cad.curves import bezier_point, spline_segments

    pts = [(0, 0), (20, 10), (40, 0)]
    segs = spline_segments(pts, False)
    assert len(segs) == 2 and segs[0][1] == (0, 0) and segs[1][2] == (40, 0)
    # 첫 구간 조절점: c1 = P0 + (P1 − (2P0 − P1))/6 = (20/3, 10/3)
    assert segs[0][3] == pytest.approx((20 / 3, 10 / 3))
    assert bezier_point(segs[0], 1) == pytest.approx((20, 10))
    assert len(spline_segments(SQUARE, True)) == 4
    assert "스플라인" in corner_error(SQUARE, [{"k": 0, "type": "fillet", "size": 1}], True, None, True)
    assert corner_error(SQUARE, None, True, None, True) is None
    closed = rounded_points(SQUARE, None, True, None, True)
    assert len(closed) == 4 * 24 and area(closed) == pytest.approx(546.3196, abs=1e-3)  # 꼭짓점을 지나며 바깥으로 부푼다 (TS 와 같은 값)


def test_ai_validator_v16():
    m = model([])
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_path", "sketch": "s", "id": "pa", "points": [[0, 0], [10, 5], [20, 0]]},
        {"type": "set_spline", "sketch": "s", "entity": "pa", "spline": True},
        {"type": "add_circle", "sketch": "s", "id": "c", "center": [0, 0], "diameter": 4},
        {"type": "set_spline", "sketch": "s", "entity": "c", "spline": True},
    ], m)
    assert len(errs) == 1 and "'c' is not a polygon or path" in errs[0]


# ---- 형식 v18: 타원 -----------------------------------------------------------------------------


def test_ellipse_exact_revolve_and_validator():
    from app.cad.primitives import build_solid

    m = model([{"id": "s", "name": "s", "plane": {"type": "XZ", "offset": 0}, "constraints": [],
                "entities": [{"id": "el", "type": "ellipse", "center": [30, 0], "angle": 0}],
                "dimensions": [{"id": "el.width", "entity": "el", "kind": "width", "value": 8},
                               {"id": "el.height", "entity": "el", "kind": "height", "value": 16}]}],
              [{"id": "v", "name": "v", "kind": "revolve", "params": {"angle": 360}, "revolve": {"sketch": "s", "profile": "el"}, "transform": T0}])
    assert check_model(m) == []
    # 정확한 B-rep 부피 (세로로 긴 타원 → 축을 바꿔 만든다): 파푸스 2π·30·(π·4·8)
    solid = build_solid(m.objects[0], {o.id: o for o in m.objects}, {k.id: k for k in m.sketches})
    assert solid.Volume() == pytest.approx(2 * math.pi * 30 * math.pi * 4 * 8, rel=1e-9)
    _, errs = validate_commands([
        {"type": "create_sketch", "id": "s", "plane": XY},
        {"type": "add_ellipse", "sketch": "s", "id": "e1", "center": [0, 0], "width": 20, "height": 10, "angle": 15},
        {"type": "set_entity_angle", "sketch": "s", "entity": "e1", "angle": 30},
        {"type": "set_dimension", "sketch": "s", "dimension": "e1.height", "value": 12},
        {"type": "extrude", "sketch": "s", "profile": "e1", "distance": 3},
    ], model([]))
    assert errs == []
