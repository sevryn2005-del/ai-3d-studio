"""스케치 + 돌출: 프론트엔드가 만든 기준 판 픽스처를 백엔드(CadQuery)가 같은 형상으로 해석하는지.

픽스처: shared/schemas/examples/model-sketch-plate.json (frontend/src/cad/schemaExport.ts 의 SKETCH_PLATE_COMMANDS)
  사각형 60×40 → 4mm 돌출 → 폭 80 으로 수정 → 원 Ø6 (중심 18,0, 평면 z=-1) → 6mm 돌출 → 관통 구멍 cut
"""

import copy
import math

import cadquery as cq
import pytest

from app.cad.commands import ModelDefinition
from app.cad.exporter import mesh_volume
from app.cad.primitives import GeometryError, apply_transform, build_solid
from app.cad.validation import check_model

from .conftest import load_json
from .test_export import export, is_watertight

PLATE_VOLUME = 80 * 40 * 4 - math.pi * 9 * 4


def plate_model() -> dict:
    return load_json("examples/model-sketch-plate.json")


def world(m: ModelDefinition, oid: str) -> cq.Shape:
    index = {o.id: o for o in m.objects}
    sketches = {s.id: s for s in m.sketches}
    return apply_transform(build_solid(index[oid], index, sketches), index[oid].transform)


def test_fixture_is_valid():
    assert check_model(ModelDefinition.model_validate(plate_model())) == []


def test_plate_with_hole_geometry():
    m = ModelDefinition.model_validate(plate_model())
    s = world(m, "plate_holed")
    b = s.BoundingBox()
    assert (b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax) == pytest.approx((-40, 40, -20, 20, 0, 4), abs=1e-6)
    assert s.Volume() == pytest.approx(PLATE_VOLUME, rel=1e-6)
    assert not s.isInside(cq.Vector(18, 0, 2)), "구멍 중심 (18,0)"
    assert s.isInside(cq.Vector(18, 3.5, 2)), "구멍 반지름 3mm 바깥은 판"
    assert s.isInside(cq.Vector(-18, 0, 2))


def test_dimension_change_recomputes():
    """원본 치수(r1.width)만 바꾸면 돌출 결과가 따라온다."""
    data = plate_model()
    data["sketches"][0]["dimensions"][0]["value"] = 90
    b = world(ModelDefinition.model_validate(data), "plate").BoundingBox()
    assert (b.xmin, b.xmax, b.zmax) == pytest.approx((-45, 45, 4), abs=1e-6)


def test_sketch_plane_offset_and_object_transform():
    data = plate_model()
    data["objects"][0]["transform"]["position"] = [10, 0, 5]
    m = ModelDefinition.model_validate(data)
    b = world(m, "plate").BoundingBox()
    assert (b.xmin, b.xmax, b.zmin, b.zmax) == pytest.approx((-30, 50, 5, 9), abs=1e-6)
    hb = world(m, "hole").BoundingBox()  # 평면 offset -1 에서 시작
    assert (hb.zmin, hb.zmax) == pytest.approx((-1, 5), abs=1e-6)


class TestValidation:
    def test_missing_sketch(self):
        data = plate_model()
        data["objects"][0]["extrude"]["sketch"] = "ghost"
        issues = check_model(ModelDefinition.model_validate(data))
        assert any("존재하지 않는 스케치" in i.message for i in issues)

    def test_missing_dimension(self):
        data = plate_model()
        data["sketches"][0]["dimensions"].pop()  # r1.height 제거
        assert check_model(ModelDefinition.model_validate(data))

    def test_sketch_id_clashes_with_object(self):
        data = plate_model()
        data["sketches"][0]["id"] = "plate"
        data["objects"][0]["extrude"]["sketch"] = "plate"
        assert check_model(ModelDefinition.model_validate(data))

    def test_build_without_sketch_is_geometry_error(self):
        m = ModelDefinition.model_validate(plate_model())
        index = {o.id: o for o in m.objects}
        with pytest.raises(GeometryError):
            build_solid(index["plate"], index, {})

    def test_v1_model_rejected_by_v2_schema(self):
        data = copy.deepcopy(plate_model())
        data["schemaVersion"] = 1
        with pytest.raises(Exception):
            ModelDefinition.model_validate(data)


def test_api_evaluate_single_mesh(client):
    body = client.post("/api/model/evaluate", json=plate_model()).json()
    assert body["ok"], body["issues"]
    assert [m["objectId"] for m in body["meshes"]] == ["plate_holed"]


def test_stl_export_of_plate_with_hole(client):
    """STL 출력 검사: 치수 80×40×4, 닫힌 메시, 부피 = 판 − 구멍."""
    tris = export(client, plate_model())
    pts = tris.reshape(-1, 3)
    assert pts.min(axis=0) == pytest.approx([-40, -20, 0], abs=1e-5)
    assert pts.max(axis=0) == pytest.approx([40, 20, 4], abs=1e-5)
    assert mesh_volume(tris) == pytest.approx(PLATE_VOLUME, rel=2e-3)
    assert is_watertight(tris)


def bbox(s: cq.Shape):
    b = s.BoundingBox()
    return (b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax)


def test_planes_fixture_matches_named_plane_convention():
    """XZ(법선 −Y)·YZ(법선 +X) 평면 — 프론트엔드가 만든 픽스처, 브라우저 geometry.test.ts 와 같은 기대값."""
    m = ModelDefinition.model_validate(load_json("examples/model-sketch-planes.json"))
    assert check_model(m) == []
    assert bbox(world(m, "front")) == pytest.approx((-10, 20, -7, -3, 0, 20), abs=1e-6)
    assert bbox(world(m, "side")) == pytest.approx((-2, 4, -3, 7, 3, 13), abs=1e-3)
    assert bbox(world(m, "front_moved")) == pytest.approx((3, 7, -10, 20, 5, 25), abs=1e-6)
    assert world(m, "side").Volume() == pytest.approx(math.pi * 25 * 6, rel=1e-6)
