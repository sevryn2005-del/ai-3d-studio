"""회전(revolve): 프론트엔드가 만든 픽스처를 CadQuery 가 같은 형상·같은 방향으로 해석하는지.

픽스처: shared/schemas/examples/model-revolve.json (schemaExport.ts 의 REVOLVE_COMMANDS)
브라우저 geometry.test.ts 와 같은 기대값 (컵 360°, 1/4 고리 90° 는 +Y 쪽).
"""

import copy
import math

import cadquery as cq
import pytest

from app.cad.commands import ModelDefinition
from app.cad.exporter import mesh_volume
from app.cad.primitives import apply_transform, build_solid
from app.cad.validation import check_model

from .conftest import load_json
from .test_export import export, is_watertight


def fixture() -> dict:
    return load_json("examples/model-revolve.json")


def world(m: ModelDefinition, oid: str) -> cq.Shape:
    index = {o.id: o for o in m.objects}
    return apply_transform(build_solid(index[oid], index, {s.id: s for s in m.sketches}), index[oid].transform)


def bbox(s):
    b = s.BoundingBox()
    return (b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax)


def test_cup_and_quarter_ring_match_browser_engine():
    m = ModelDefinition.model_validate(fixture())
    assert check_model(m) == []
    cup = world(m, "cup")
    assert bbox(cup) == pytest.approx((-30, 30, -30, 30, 0, 40), abs=1e-6)
    assert cup.Volume() == pytest.approx(math.pi * 9027, rel=1e-6)
    assert not cup.isInside(cq.Vector(0, 0, 20)), "컵 안쪽은 비어 있다"
    assert cup.isInside(cq.Vector(28.5, 0, 20)), "벽"
    ring = world(m, "ring")
    assert bbox(ring) == pytest.approx((80, 100, 0, 20, 0, 5), abs=1e-6), "+u 가 −w(= 월드 +Y) 쪽으로 돈다"
    assert ring.Volume() == pytest.approx(375 * math.pi, rel=1e-6)


def test_profile_crossing_axis_is_rejected():
    data = copy.deepcopy(fixture())
    rect = next(s for s in data["sketches"] if s["id"] == "sk_ring")
    rect["entities"][0]["center"] = [3, 2.5]  # u −2..8 → 축을 넘음
    messages = [i.message for i in check_model(ModelDefinition.model_validate(data))]
    assert any("회전축" in msg for msg in messages)


def test_stl_export(client):
    tris = export(client, fixture())
    assert mesh_volume(tris) == pytest.approx(math.pi * 9027 + 375 * math.pi, rel=2e-3)
    assert is_watertight(tris)
