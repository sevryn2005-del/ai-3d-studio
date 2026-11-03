"""구속 해석기 결과 검사 (app/cad/constraints.py ↔ frontend/src/cad/solver.ts 같은 잔차 식).

픽스처: shared/schemas/examples/model-constraint-bracket.json (schemaExport.ts 의 CONSTRAINT_BRACKET_COMMANDS)
— 프론트엔드 해석기가 대충 그린 6각형을 구속으로 푼 L 브래킷. 브라우저 geometry.test.ts 와 같은 기대값.
"""

import copy
import math

import cadquery as cq
import pytest

from app.cad.commands import ModelDefinition
from app.cad.constraints import polygon_error, residuals
from app.cad.exporter import mesh_volume
from app.cad.primitives import apply_transform, build_solid
from app.cad.validation import check_model

from .conftest import load_json
from .test_export import export, is_watertight

EXACT = (60 * 15 + 20 * 25) * 5 - math.pi * 9 * 5


def fixture() -> dict:
    return load_json("examples/model-constraint-bracket.json")


def world(m: ModelDefinition, oid: str) -> cq.Shape:
    index = {o.id: o for o in m.objects}
    return apply_transform(build_solid(index[oid], index, {s.id: s for s in m.sketches}), index[oid].transform)


def test_solved_coordinates_satisfy_every_constraint():
    m = ModelDefinition.model_validate(fixture())
    assert check_model(m) == []
    sk = m.sketches[0]
    assert [tuple(p) for p in sk.entities[0].points] == [(0, 0), (60, 0), (60, 15), (20, 15), (20, 40), (0, 40)]
    assert len(sk.constraints) == 11
    for c in sk.constraints:
        assert max((abs(v) for v in residuals(sk, c)), default=0) < 1e-6, c.id


def test_geometry_matches_browser_engine():
    s = world(ModelDefinition.model_validate(fixture()), "bracket_holed")
    b = s.BoundingBox()
    assert (b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax) == pytest.approx((0, 60, 0, 40, 0, 5), abs=1e-6)
    assert s.Volume() == pytest.approx(EXACT, rel=1e-6)
    assert not s.isInside(cq.Vector(40, 7.5, 2.5)), "구멍"
    assert not s.isInside(cq.Vector(40, 30, 2.5)), "L 의 빈 모서리"
    assert s.isInside(cq.Vector(10, 30, 2.5))


def test_tampered_coordinates_are_rejected():
    """저장 파일의 좌표를 손으로 바꾸면 구속 위반으로 거부 (해석기를 거친 값만 유효)."""
    data = copy.deepcopy(fixture())
    data["sketches"][0]["entities"][0]["points"][1] = [61, 0]
    messages = [i.message for i in check_model(ModelDefinition.model_validate(data))]
    assert any("만족하지 않습니다" in msg for msg in messages)


def test_bad_references_and_twisted_polygon():
    data = copy.deepcopy(fixture())
    data["sketches"][0]["constraints"].append({"id": "kx", "type": "length", "refs": ["l.p0"], "value": 3})
    data["sketches"][0]["constraints"].append({"id": "ky", "type": "horizontal", "refs": ["l.e9"]})
    messages = [i.message for i in check_model(ModelDefinition.model_validate(data))]
    assert any("구속 kx" in msg and "참조 형식" in msg for msg in messages)
    assert any("구속 ky" in msg and "없는 점" in msg for msg in messages)
    assert "교차" in polygon_error([(0, 0), (10, 10), (10, 0), (0, 10)])


def test_stl_export(client):
    tris = export(client, fixture())
    assert mesh_volume(tris) == pytest.approx(EXACT, rel=2e-3)
    assert is_watertight(tris)
