"""STL 내보내기: 출력 파일이 CAD 형상과 같은지 (치수, 부피, 닫힌 메시, 법선 방향)."""

import math

import numpy as np
import pytest

from app.cad.exporter import EXPORT_LINEAR_TOLERANCE, mesh_volume, parse_binary_stl

from .conftest import load_json


def export(client, model) -> np.ndarray:
    r = client.post("/api/export/stl", json=model)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "model/stl"
    assert "model.stl" in r.headers["content-disposition"]
    return parse_binary_stl(r.content)


def is_watertight(tris: np.ndarray) -> bool:
    """모든 모서리가 정확히 두 삼각형에 공유되면 닫힌(새지 않는) 메시."""
    from collections import Counter

    q = np.round(tris, 4)
    edges = Counter()
    for t in q:
        for i in range(3):
            a, b = tuple(t[i]), tuple(t[(i + 1) % 3])
            edges[(min(a, b), max(a, b))] += 1
    return all(c == 2 for c in edges.values())


def test_height_50_box_exports_exact_dimensions(client, default_model):
    """첫 번째 목표의 끝: 높이 50mm 박스 → STL 파일의 높이가 정확히 50mm."""
    default_model["objects"][0]["params"]["height"] = 50
    default_model["objects"][0]["transform"]["position"] = [30, 0, 0]
    tris = export(client, default_model)
    pts = tris.reshape(-1, 3)
    np.testing.assert_allclose(pts.min(axis=0), [20, -10, 0], atol=1e-5)  # 월드 좌표
    np.testing.assert_allclose(pts.max(axis=0), [40, 10, 50], atol=1e-5)
    assert mesh_volume(tris) == pytest.approx(20 * 20 * 50, rel=1e-6)
    assert is_watertight(tris)


def test_cylinder_volume_within_print_tolerance(client, default_model):
    default_model["objects"][0].update(id="c", kind="cylinder", params={"radius": 10, "height": 10})
    tris = export(client, default_model)
    exact = math.pi * 100 * 10
    vol = mesh_volume(tris)
    assert vol > 0, "법선이 바깥을 향해야 한다"
    assert vol == pytest.approx(exact, rel=2e-3)  # 현의 오차 0.01mm 수준
    assert is_watertight(tris)


def test_boolean_hole_exports_watertight(client):
    tris = export(client, load_json("examples/model-cut-rotated.json"))
    assert mesh_volume(tris) == pytest.approx(40 * 20 * 5 - math.pi * 9 * 5, rel=2e-3)
    assert is_watertight(tris)


def test_invalid_model_returns_issues(client, default_model):
    default_model["objects"][0]["params"]["width"] = -1
    r = client.post("/api/export/stl", json=default_model)
    assert r.status_code == 422
    assert r.json()["issues"][0]["path"] == "objects.0.params.width"


def test_empty_model(client):
    r = client.post("/api/export/stl", json={"schemaVersion": 26, "units": "mm", "sketches": [], "objects": []})
    assert r.status_code == 422
    assert "내보낼 객체가 없습니다" in r.json()["issues"][0]["message"]


# ---- 3MF / STEP / GLB -------------------------------------------------------------

import io  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import struct  # noqa: E402
import tempfile  # noqa: E402
import xml.etree.ElementTree as ET  # noqa: E402
import zipfile  # noqa: E402
from collections import Counter  # noqa: E402

import cadquery as cq  # noqa: E402

NS = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}


def two_objects(default_model):
    """높이 50 박스(x=30) + 반지름 10 원통(x=-30)"""
    default_model["objects"][0]["params"]["height"] = 50
    default_model["objects"][0]["transform"]["position"] = [30, 0, 0]
    default_model["objects"].append({
        "id": "cylinder_1", "name": "원통 <1> & \"따옴표\"", "kind": "cylinder",
        "params": {"radius": 10, "height": 10},
        "transform": {"position": [-30, 0, 0], "rotation": [0, 0, 0]},
    })
    return default_model


def fetch(client, fmt, model) -> bytes:
    r = client.post(f"/api/export/{fmt}", json=model)
    assert r.status_code == 200, r.text
    assert f"model.{fmt}" in r.headers["content-disposition"]
    return r.content


def test_3mf_spec_and_manifold(client, default_model):
    data = fetch(client, "3mf", two_objects(default_model))
    z = zipfile.ZipFile(io.BytesIO(data))
    assert {"[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"} <= set(z.namelist())
    root = ET.fromstring(z.read("3D/3dmodel.model"))
    assert root.get("unit") == "millimeter"

    objects = root.findall("m:resources/m:object", NS)
    assert [o.get("id") for o in objects] == ["1", "2"]  # 양의 정수 (CadQuery 내장은 0)
    assert [o.get("name") for o in objects] == ["큐브", '원통 <1> & "따옴표"']  # XML 이스케이프
    assert [i.get("objectid") for i in root.findall("m:build/m:item", NS)] == ["1", "2"]

    expected = {"1": (20 * 20 * 50, [20, -10, 0], [40, 10, 50]), "2": (math.pi * 100 * 10, [-40, -10, 0], [-20, 10, 10])}
    for o in objects:
        v = np.array([[float(x.get(k)) for k in "xyz"] for x in o.findall("m:mesh/m:vertices/m:vertex", NS)])
        t = np.array([[int(x.get(k)) for k in ("v1", "v2", "v3")] for x in o.findall("m:mesh/m:triangles/m:triangle", NS)])
        assert t.min() >= 0 and t.max() < len(v)
        # 매니폴드 + 면 방향 일관성: 모든 방향 모서리 (a→b) 는 정확히 한 번, 반대 방향 (b→a) 도 정확히 한 번
        directed = Counter((int(a), int(b)) for tri in t for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])))
        assert all(c == 1 for c in directed.values())
        assert all(directed[(b, a)] == 1 for (a, b) in directed)
        vol, lo, hi = expected[o.get("id")]
        assert mesh_volume(v[t]) == pytest.approx(vol, rel=2e-3)
        # 곡면은 다각형 근사 → 정점이 정확히 극값에 오지 않을 수 있다. 출력 허용 오차(현의 오차) 이내면 정상.
        np.testing.assert_allclose(v.min(axis=0), lo, atol=EXPORT_LINEAR_TOLERANCE)
        np.testing.assert_allclose(v.max(axis=0), hi, atol=EXPORT_LINEAR_TOLERANCE)


def test_step_is_exact_brep(client, default_model):
    data = fetch(client, "step", two_objects(default_model))
    assert data.startswith(b"ISO-10303-21")
    fd, path = tempfile.mkstemp(suffix=".step")
    os.write(fd, data)
    os.close(fd)
    try:
        shape = cq.importers.importStep(path).val()
    finally:
        os.remove(path)
    solids = shape.Solids() if hasattr(shape, "Solids") else [shape]
    vols = sorted(s.Volume() for s in solids)
    # B-rep 이므로 원통 부피도 테셀레이션 오차 없이 정확하다
    assert vols == pytest.approx(sorted([math.pi * 100 * 10, 20 * 20 * 50]), rel=1e-9)
    b = shape.BoundingBox()
    assert (b.xmin, b.xmax, b.zmax) == pytest.approx((-40, 40, 50), abs=1e-6)


def _parse_glb(data: bytes):
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    assert (magic, version, total) == (b"glTF", 2, len(data))
    jlen, jtype = struct.unpack_from("<I4s", data, 12)
    assert jtype == b"JSON" and jlen % 4 == 0
    gltf = json.loads(data[20 : 20 + jlen])
    blen, btype = struct.unpack_from("<I4s", data, 20 + jlen)
    assert btype == b"BIN\x00"
    binary = data[28 + jlen : 28 + jlen + blen]
    assert blen == gltf["buffers"][0]["byteLength"]
    return gltf, binary


def _accessor(gltf, binary, i):
    a = gltf["accessors"][i]
    view = gltf["bufferViews"][a["bufferView"]]
    dtype, width = {5126: ("<f4", 3), 5125: ("<u4", 1)}[a["componentType"]]
    arr = np.frombuffer(binary, dtype=dtype, count=a["count"] * width, offset=view["byteOffset"])
    return arr.reshape(-1, width) if width > 1 else arr


def test_glb_structure_and_y_up_meters(client, default_model):
    gltf, binary = _parse_glb(fetch(client, "glb", two_objects(default_model)))
    assert gltf["asset"]["version"] == "2.0"
    assert [n["name"] for n in gltf["nodes"]] == ["큐브", '원통 <1> & "따옴표"']
    for view in gltf["bufferViews"]:
        assert view["byteOffset"] % 4 == 0  # glTF 정렬 규칙

    prim = gltf["meshes"][0]["primitives"][0]
    pos = _accessor(gltf, binary, prim["attributes"]["POSITION"])
    nrm = _accessor(gltf, binary, prim["attributes"]["NORMAL"])
    idx = _accessor(gltf, binary, prim["indices"])
    assert idx.max() < len(pos)
    np.testing.assert_allclose(np.linalg.norm(nrm, axis=1), 1, atol=1e-5)
    # CAD (x, y, z) mm Z-up → glTF (x, z, -y) m Y-up: 높이 50mm 박스 → Y 0~0.05
    np.testing.assert_allclose(pos.min(axis=0), [0.02, 0, -0.01], atol=1e-6)
    np.testing.assert_allclose(pos.max(axis=0), [0.04, 0.05, 0.01], atol=1e-6)
    a = gltf["accessors"][prim["attributes"]["POSITION"]]
    np.testing.assert_allclose(a["min"], pos.min(axis=0), atol=1e-7)  # 뷰어가 쓰는 min/max 일치
    # 축 변환 후에도 면 방향(바깥 법선)이 유지되는지: 부피 > 0
    assert mesh_volume(pos[idx.reshape(-1, 3)].astype(np.float64)) == pytest.approx(20 * 20 * 50 * 1e-9, rel=1e-6)


def test_unknown_format_rejected(client, default_model):
    assert client.post("/api/export/obj", json=default_model).status_code == 422


def test_3mf_object_colors(client, default_model):
    """외관 색 → basematerials (브라우저 exporters.test.ts 와 같은 구조): 색 있는 객체만 pid/pindex"""
    model = two_objects(default_model)
    model["objects"][0]["color"] = "#e5534b"
    with zipfile.ZipFile(io.BytesIO(fetch(client, "3mf", model))) as z:
        xml = z.read("3D/3dmodel.model").decode()
    assert '<basematerials id="3">' in xml and 'displaycolor="#E5534B"' in xml
    assert 'object id="1" type="model" name=' in xml and 'pid="3" pindex="0"' in xml
    assert xml.count("pid=") == 1
