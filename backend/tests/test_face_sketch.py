"""면 위 스케치 (docs/design-face-sketch.md): 프론트엔드가 만든 픽스처를 CadQuery 가 같은 형상으로 해석하는지.

픽스처: shared/schemas/examples/model-face-sketch.json (frontend/src/cad/schemaExport.ts 의 FACE_SKETCH_COMMANDS)
브라우저 엔진 geometry.test.ts 와 같은 기대값.
"""

import copy
import math

import cadquery as cq
import numpy as np
import pytest

from app.cad.commands import ModelDefinition
from app.cad.exporter import mesh_volume
from app.cad.frames import face_local_matrix, faces_of, plane_matrix, transform_matrix
from app.cad.commands import StandardPlane, Transform
from app.cad.primitives import apply_transform, build_solid
from app.cad.validation import check_model

from .conftest import load_json
from .test_export import export, is_watertight

EXACT = 80 * 40 * 4 - 10 * 6 * 3 + math.pi * 25 * 6 + math.pi * 9 * 5


def fixture() -> dict:
    return load_json("examples/model-face-sketch.json")


def world(m: ModelDefinition, oid: str) -> cq.Shape:
    index = {o.id: o for o in m.objects}
    return apply_transform(build_solid(index[oid], index, {s.id: s for s in m.sketches}), index[oid].transform)


def bbox(s: cq.Shape):
    b = s.BoundingBox()
    return (b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax)


def test_fixture_valid_and_geometry_matches_browser_engine():
    m = ModelDefinition.model_validate(fixture())
    assert check_model(m) == []
    part = world(m, "part")
    assert bbox(part) == pytest.approx((-10, 30, -45, 40, 0, 10), abs=1e-6)
    assert part.Volume() == pytest.approx(EXACT, rel=1e-6)
    inside = lambda p: part.isInside(cq.Vector(*p))  # noqa: E731
    assert not inside((10, 0, 2.5)), "홈 (z 1..4)"
    assert inside((10, 0, 0.5)), "홈 아래 판"
    assert inside((10, 8, 8)), "윗면 기둥"
    assert inside((10, -43, 3)), "옆면 돌기"
    assert inside((0, 30, 2)), "판"


def test_boss_follows_plate_thickness():
    """판 두께 4 → 6: 이름으로 참조한 윗면이 따라 올라가므로 기둥 바닥도 z=6."""
    data = fixture()
    next(o for o in data["objects"] if o["id"] == "plate")["params"]["distance"] = 6
    m = ModelDefinition.model_validate(data)
    b = world(m, "part").BoundingBox()
    assert (b.zmin, b.zmax) == pytest.approx((0, 12), abs=1e-6)


def test_frame_math_matches_frontend_table():
    # 기준 평면
    assert plane_matrix(StandardPlane(type="XZ", offset=3))[:3, 3].tolist() == pytest.approx([0, -3, 0])
    # Three.js Euler XYZ: Z 90° 회전은 (1,0,0) → (0,1,0)
    r = transform_matrix(Transform(position=(10, 0, 0), rotation=(0, 0, 90)))
    assert (r @ np.array([1, 0, 0, 1]))[:3] == pytest.approx([10, 1, 0])
    # 박스 면 (sketchPlane.test.ts 와 같은 표)
    m = ModelDefinition.model_validate({"schemaVersion": 23, "units": "mm", "sketches": [], "objects": [
        {"id": "b", "name": "b", "kind": "box", "params": {"width": 30, "depth": 20, "height": 10},
         "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}}]})
    b = m.objects[0]
    table = {"top": ((0, 0, 10), (0, 0, 1)), "bottom": ((0, 0, 0), (0, 0, -1)), "+X": ((15, 0, 5), (1, 0, 0)),
             "-X": ((-15, 0, 5), (-1, 0, 0)), "+Y": ((0, 10, 5), (0, 1, 0)), "-Y": ((0, -10, 5), (0, -1, 0))}
    for face, (origin, normal) in table.items():
        f = face_local_matrix(m, b, face)
        assert f[:3, 3].tolist() == pytest.approx(origin), face
        assert f[:3, 2].tolist() == pytest.approx(normal), face
        assert np.linalg.det(f) == pytest.approx(1)
    assert faces_of(m, b) == ["top", "bottom", "+X", "-X", "+Y", "-Y"]


class TestValidation:
    def test_cycle(self):
        data = fixture()
        data["sketches"][0]["plane"] = {"type": "face", "object": "plate", "face": "end", "offset": 0}
        assert any("면 참조가 순환합니다" in i.message for i in check_model(ModelDefinition.model_validate(data)))

    def test_missing_face_and_object(self):
        data = fixture()
        data["sketches"][2]["plane"] = {"type": "face", "object": "plate", "face": "top", "offset": 0}  # 돌출에는 top 없음
        data["sketches"][1]["plane"] = {"type": "face", "object": "ghost", "face": "end", "offset": 0}
        messages = [i.message for i in check_model(ModelDefinition.model_validate(data))]
        assert any("'top' 면이 없습니다" in msg for msg in messages)
        assert any("존재하지 않는 객체의 면" in msg for msg in messages)

    def test_older_model_version_is_rejected(self):
        data = copy.deepcopy(fixture())
        data["schemaVersion"] = 4
        with pytest.raises(Exception):
            ModelDefinition.model_validate(data)


def test_stl_export(client):
    tris = export(client, fixture())
    pts = tris.reshape(-1, 3)
    assert pts.min(axis=0) == pytest.approx([-10, -45, 0], abs=1e-5)
    assert pts.max(axis=0) == pytest.approx([30, 40, 10], abs=1e-5)
    assert mesh_volume(tris) == pytest.approx(EXACT, rel=2e-3)
    assert is_watertight(tris)
