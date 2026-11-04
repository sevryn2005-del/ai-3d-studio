"""불리언 연산 형상 테스트 + 프론트엔드가 만든 모델의 언어 간 계약 테스트."""

import math

import cadquery as cq
import pytest

from app.cad.commands import ModelDefinition
from app.cad.primitives import GeometryError, apply_transform, build_solid
from app.cad.validation import check_model, top_level_ids

from .conftest import load_json


def obj(oid, kind, params=None, position=(0, 0, 0), rotation=(0, 0, 0), boolean=None):
    o = {"id": oid, "name": oid, "kind": kind, "transform": {"position": list(position), "rotation": list(rotation)}}
    if boolean:
        o["boolean"] = boolean
    else:
        o["params"] = params
    return o


def model(*objects):
    return ModelDefinition.model_validate({"schemaVersion": 7, "units": "mm", "sketches": [], "objects": list(objects)})


def world_solid(m: ModelDefinition, oid: str) -> cq.Shape:
    index = {o.id: o for o in m.objects}
    return apply_transform(build_solid(index[oid], index), index[oid].transform)


def inside(shape: cq.Shape, p) -> bool:
    return shape.isInside(cq.Vector(*p))


PLATE = obj("plate", "box", {"width": 40, "depth": 20, "height": 5})
PIN = obj("pin", "cylinder", {"radius": 3, "height": 10}, position=(0, 0, -1))


def test_cut_makes_through_hole():
    m = model(PLATE, PIN, obj("c", "boolean", boolean={"operation": "cut", "base": "plate", "tools": ["pin"]}))
    s = world_solid(m, "c")
    assert s.Volume() == pytest.approx(40 * 20 * 5 - math.pi * 9 * 5, rel=1e-6)
    assert not inside(s, (0, 0, 2.5))  # 구멍
    assert inside(s, (10, 0, 2.5))  # 판


def test_union_and_intersect_volumes():
    a = obj("a", "box", {"width": 10, "depth": 10, "height": 10})
    b = obj("b", "box", {"width": 10, "depth": 10, "height": 10}, position=(5, 0, 0))
    u = world_solid(model(a, b, obj("u", "boolean", boolean={"operation": "union", "base": "a", "tools": ["b"]})), "u")
    i = world_solid(model(a, b, obj("i", "boolean", boolean={"operation": "intersect", "base": "a", "tools": ["b"]})), "i")
    assert u.Volume() == pytest.approx(1500, rel=1e-6)
    assert len(u.Solids()) == 1
    assert len(u.Faces()) == 6  # clean(): 합쳐진 면의 경계선 제거
    assert i.Volume() == pytest.approx(500, rel=1e-6)


def test_empty_intersection_is_user_error():
    a = obj("a", "box", {"width": 10, "depth": 10, "height": 10})
    b = obj("b", "box", {"width": 10, "depth": 10, "height": 10}, position=(100, 0, 0))
    m = model(a, b, obj("i", "boolean", boolean={"operation": "intersect", "base": "a", "tools": ["b"]}))
    with pytest.raises(GeometryError, match="비어 있습니다"):
        world_solid(m, "i")


def test_nested_boolean():
    rib = obj("rib", "box", {"width": 2, "depth": 20, "height": 10}, position=(15, 0, 0))
    m = model(
        PLATE,
        PIN,
        rib,
        obj("c", "boolean", boolean={"operation": "cut", "base": "plate", "tools": ["pin"]}),
        obj("u", "boolean", boolean={"operation": "union", "base": "c", "tools": ["rib"]}),
    )
    assert top_level_ids(m) == ["u"]
    s = world_solid(m, "u")
    assert not inside(s, (0, 0, 2.5))
    assert inside(s, (15, 0, 8))  # 리브 윗부분


def test_frontend_fixture_hole_is_at_world_position():
    """프론트엔드(Three.js) 실행기가 만든 '부모 기준 변환'을 백엔드가 같은 의미로 해석한다.

    판은 (50,0) 에서 45° 회전, 구멍은 월드 (60,0) 에 만들어졌다 (frontend/src/cad/schemaExport.ts).
    """
    m = ModelDefinition.model_validate(load_json("examples/model-cut-rotated.json"))
    assert check_model(m) == []
    s = world_solid(m, "cut_1")
    assert not inside(s, (60, 0, 2.5)), "구멍이 월드 (60, 0) 에 있어야 한다"
    assert not inside(s, (60, 2.9, 2.5))
    assert inside(s, (60, 3.5, 2.5)), "구멍 반지름 3mm 바깥은 판이어야 한다"
    assert inside(s, (50, 0, 2.5))
    b = s.BoundingBox()
    assert (b.zmin, b.zmax) == pytest.approx((0, 5), abs=1e-6)  # 구멍이 판 높이 밖으로 튀어나오지 않음


class TestGraphValidation:
    def test_missing_reference(self):
        m = model(PLATE, obj("c", "boolean", boolean={"operation": "cut", "base": "plate", "tools": ["ghost"]}))
        assert any("존재하지 않는 객체" in i.message for i in check_model(m))

    def test_shared_child(self):
        m = model(
            PLATE,
            PIN,
            obj("c1", "boolean", boolean={"operation": "cut", "base": "plate", "tools": ["pin"]}),
            obj("c2", "boolean", boolean={"operation": "cut", "base": "pin", "tools": ["plate"]}),
        )
        assert any("두 개 이상의 불리언" in i.message for i in check_model(m))

    def test_cycle(self):
        m = model(
            obj("x", "boolean", boolean={"operation": "union", "base": "y", "tools": ["z"]}),
            obj("y", "boolean", boolean={"operation": "union", "base": "x", "tools": ["z2"]}),
            obj("z", "box", {"width": 1, "depth": 1, "height": 1}),
            obj("z2", "box", {"width": 1, "depth": 1, "height": 1}),
        )
        assert any("순환" in i.message for i in check_model(m))


def test_api_returns_single_mesh_for_boolean(client):
    body = client.post("/api/model/evaluate", json=load_json("examples/model-cut-rotated.json")).json()
    assert body["ok"], body["issues"]
    assert [m["objectId"] for m in body["meshes"]] == ["cut_1"]


def test_edge_feature_too_large_is_reported():
    m = model(obj("b", "box", {"width": 30, "depth": 20, "height": 10}))
    bad = m.model_dump(mode="json")
    bad["objects"][0]["edgeFeature"] = {"type": "fillet", "size": 5, "edges": "all"}
    issues = check_model(ModelDefinition.model_validate(bad))
    assert issues and "너무 큽니다" in issues[0].message
