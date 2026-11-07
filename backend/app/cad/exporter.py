"""파일 내보내기 (모두 로컬에서 처리, CLAUDE.md 1장 #5).

| 형식 | 용도 | 좌표/단위 | 구현 |
|------|------|-----------|------|
| STL  | 3D 프린팅 (범용) | 월드, mm, Z-up | 직접 작성 (바이너리) |
| 3MF  | 3D 프린팅 (권장: 단위·객체 정보 포함) | 월드, mm, Z-up | 직접 작성 (정점 병합된 매니폴드 메시) |
| STEP | 다른 CAD 와 교환 (정확한 곡면) | 월드, mm | CadQuery/OCCT |
| GLB  | 웹·뷰어·렌더링 | **Y-up, 미터** (glTF 규칙) | 직접 작성 |

CadQuery 내장 3MF 는 객체 id 가 0 으로 출력되는데, 3MF 코어 사양의 리소스 ID 는 양의 정수여야 하므로 직접 작성한다.
"""

from __future__ import annotations

import io
import json
import os
import struct
import tempfile
import zipfile
from dataclasses import dataclass
from xml.sax.saxutils import quoteattr

import cadquery as cq
import numpy as np

from app.cad.mesh import tessellate

EXPORT_LINEAR_TOLERANCE = 0.01  # mm
EXPORT_ANGULAR_TOLERANCE = 0.1  # rad (~5.7°)
_STL_HEADER = b"AI 3D Studio STL (units: mm, Z-up)"


@dataclass(frozen=True)
class NamedShape:
    name: str
    shape: cq.Shape  # 월드 좌표 (mm)
    color: str | None = None  # 외관 색 #rrggbb (3MF basematerials)
    material: dict | None = None  # PBR 재질 {metallic, roughness} (형식 v29, GLB 만)


def _fine_mesh(shape: cq.Shape) -> tuple[np.ndarray, np.ndarray]:
    return tessellate(shape, EXPORT_LINEAR_TOLERANCE, EXPORT_ANGULAR_TOLERANCE)


def weld(vertices: np.ndarray, triangles: np.ndarray, decimals: int = 6) -> tuple[np.ndarray, np.ndarray]:
    """같은 위치의 정점을 병합한다 (면마다 분리된 정점 → 모서리를 공유하는 매니폴드 메시)."""
    key = np.round(vertices.astype(np.float64), decimals)
    unique, inverse = np.unique(key, axis=0, return_inverse=True)
    tri = inverse.reshape(-1)[triangles]
    keep = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])  # 퇴화 삼각형 제거
    return unique, tri[keep]


# ---- STL ------------------------------------------------------------------------


def to_binary_stl(shapes: list[cq.Shape]) -> bytes:
    # 3MF 와 같이 정점 병합 + 넓이 0 삼각형 제거: 원뿔 꼭짓점·회전축 위 점에서 OCCT 가 만드는 퇴화 삼각형은
    # 슬라이서가 "degenerate facet / 열린 모서리" 로 경고한다 (docs/issue-survey.md 7-3)
    tris = [v[t] for v, t in (weld(*_fine_mesh(s)) for s in shapes)]
    triangles = np.concatenate(tris).astype("<f4") if tris else np.zeros((0, 3, 3), "<f4")
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    record = np.zeros(len(triangles), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    record["n"] = normals
    record["v"] = triangles
    return _STL_HEADER.ljust(80, b" ") + struct.pack("<I", len(triangles)) + record.tobytes()


def parse_binary_stl(data: bytes) -> np.ndarray:
    """(M, 3, 3) 삼각형 배열. 테스트·검증용."""
    (count,) = struct.unpack_from("<I", data, 80)
    if len(data) != 84 + count * 50:
        raise ValueError("STL 크기가 삼각형 수와 맞지 않습니다")
    rec = np.frombuffer(data, offset=84, count=count, dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    return rec["v"].astype(np.float64)


def mesh_volume(triangles: np.ndarray) -> float:
    """닫힌 메시의 부피 (발산 정리). 법선이 바깥을 향하면 양수."""
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


# ---- 3MF ------------------------------------------------------------------------

_3MF_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"""

_3MF_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""


def to_3mf(objects: list[NamedShape]) -> bytes:
    """3MF 코어 사양: 단위 mm, 객체 ID 1부터, 객체별 매니폴드 메시, 빌드 항목."""
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="ko-KR" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
        '<metadata name="Application">AI 3D Studio</metadata>\n<resources>\n'
    ]
    # 색이 있으면 basematerials 하나(id = 객체 수 + 1) — 브라우저 exporters.ts to3mf 와 같은 구조
    colors = list(dict.fromkeys(o.color for o in objects if o.color))
    mat_id = len(objects) + 1
    if colors:
        parts.append(f'<basematerials id="{mat_id}">\n')
        parts.extend(f'<base name="{c}" displaycolor="{c.upper()}"/>\n' for c in colors)
        parts.append("</basematerials>\n")
    for i, obj in enumerate(objects, start=1):
        v, t = weld(*_fine_mesh(obj.shape))
        mat = f' pid="{mat_id}" pindex="{colors.index(obj.color)}"' if obj.color else ""
        parts.append(f'<object id="{i}" type="model" name={quoteattr(obj.name)}{mat}><mesh><vertices>\n')
        parts.extend(f'<vertex x="{x:.6g}" y="{y:.6g}" z="{z:.6g}"/>\n' for x, y, z in v)
        parts.append("</vertices><triangles>\n")
        parts.extend(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>\n' for a, b, c in t)
        parts.append("</triangles></mesh></object>\n")
    parts.append("</resources>\n<build>\n")
    parts.extend(f'<item objectid="{i}"/>\n' for i in range(1, len(objects) + 1))
    parts.append("</build>\n</model>\n")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _3MF_CONTENT_TYPES)
        z.writestr("_rels/.rels", _3MF_RELS)
        z.writestr("3D/3dmodel.model", "".join(parts))
    return buf.getvalue()


# ---- STEP -----------------------------------------------------------------------


def to_step(shapes: list[cq.Shape]) -> bytes:
    """정확한 B-rep (곡면 그대로). OCCT 의 STEP 작성기가 파일 경로만 받으므로 임시 파일을 거친다."""
    compound = cq.Compound.makeCompound(shapes)
    fd, path = tempfile.mkstemp(suffix=".step")
    os.close(fd)
    try:
        cq.exporters.export(compound, path, exportType="STEP")
        with open(path, "rb") as f:
            return f.read()
    finally:
        os.remove(path)


# ---- GLB (glTF 2.0 binary) --------------------------------------------------------

# glTF 는 Y-up, 미터. CAD (x, y, z) mm Z-up → glTF (x, z, -y) m
_Z_UP_MM_TO_GLTF = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64) * 0.001


def _vertex_normals(v: np.ndarray, t: np.ndarray) -> np.ndarray:
    """면적 가중 정점 법선. 정점이 면마다 분리되어 있으므로 곡면은 부드럽게, 모서리는 날카롭게 보인다."""
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    n = np.zeros_like(v, dtype=np.float64)
    for k in range(3):
        np.add.at(n, t[:, k], fn)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    return np.divide(n, length, out=np.zeros_like(n), where=length > 0)


def box_uv(v: np.ndarray, n: np.ndarray) -> np.ndarray:
    """박스 투영 UV (브라우저 exporters.ts boxUv 와 같은 규칙): 점 법선의 가장 큰 축으로 면을 고르고 나머지 두 좌표(m).
    CAD 좌표(Z-up, mm) — X 면: u = ±y, Y 면: u = ∓x, Z 면: u = x, v = ±y; glTF 이미지 좌표라 v 는 뒤집는다. 1 UV = 1 m"""
    a = np.abs(n)
    x, y, z = v[:, 0], v[:, 1], v[:, 2]
    use_x = (a[:, 0] >= a[:, 1]) & (a[:, 0] >= a[:, 2])
    use_y = ~use_x & (a[:, 1] >= a[:, 2])
    u = np.where(use_x, np.where(n[:, 0] >= 0, y, -y), np.where(use_y, np.where(n[:, 1] >= 0, -x, x), x))
    w = np.where(use_x | use_y, z, np.where(n[:, 2] >= 0, y, -y))
    return np.stack([u * 0.001, -w * 0.001], axis=1)


_GLB_DEFAULT_BASE = [0.64, 0.68, 0.73, 1.0]


def _linear_rgba(hex_color: str) -> list[float]:
    """sRGB #rrggbb → glTF baseColorFactor (선형, 소수 6자리) — 브라우저 exporters.ts linearRgba 와 같은 식"""
    out = []
    for i in (1, 3, 5):
        v = int(hex_color[i : i + 2], 16) / 255
        out.append(round(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4, 6))
    return [*out, 1.0]


def _glb_material(color: str | None, m: dict | None) -> dict:
    """객체별 glTF 재질 (같은 색·재질은 하나로) — 브라우저 glbMaterial 과 같은 규칙"""
    metal = m["metallic"] if m else 0.05
    rough = m["roughness"] if m else 0.55
    return {"name": f"{color or 'default'} m{_num_str(metal)} r{_num_str(rough)}", "pbrMetallicRoughness": {
        "baseColorFactor": _linear_rgba(color) if color else _GLB_DEFAULT_BASE, "metallicFactor": metal, "roughnessFactor": rough}}


def _num_str(v: float) -> str:
    """JS 의 숫자 → 글자와 같게 (1.0 → "1", 0.5 → "0.5")"""
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def to_glb(objects: list[NamedShape]) -> bytes:
    bin_chunks: list[bytes] = []
    offset = 0
    buffer_views, accessors, meshes, nodes = [], [], [], []
    materials: list[dict] = []

    def material_index(obj: NamedShape) -> int:
        mat = _glb_material(obj.color, obj.material)
        for k, x in enumerate(materials):
            if x["name"] == mat["name"]:
                return k
        materials.append(mat)
        return len(materials) - 1

    def add_view(data: bytes, target: int) -> int:
        nonlocal offset
        pad = (-len(data)) % 4
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})
        bin_chunks.append(data + b"\x00" * pad)
        offset += len(data) + pad
        return len(buffer_views) - 1

    for obj in objects:
        v, t = _fine_mesh(obj.shape)
        pos = (v.astype(np.float64) @ _Z_UP_MM_TO_GLTF.T).astype("<f4")
        n_cad = _vertex_normals(v.astype(np.float64), t)
        nrm = (n_cad @ (_Z_UP_MM_TO_GLTF.T / 0.001)).astype("<f4")
        uv = box_uv(v.astype(np.float64), n_cad).astype("<f4")
        idx = t.astype("<u4").reshape(-1)

        pv = add_view(pos.tobytes(), 34962)  # ARRAY_BUFFER
        accessors.append({"bufferView": pv, "componentType": 5126, "count": len(pos), "type": "VEC3",
                          "min": pos.min(axis=0).tolist(), "max": pos.max(axis=0).tolist()})
        a_pos = len(accessors) - 1
        nv = add_view(nrm.tobytes(), 34962)
        accessors.append({"bufferView": nv, "componentType": 5126, "count": len(nrm), "type": "VEC3"})
        a_nrm = len(accessors) - 1
        tv = add_view(uv.tobytes(), 34962)
        accessors.append({"bufferView": tv, "componentType": 5126, "count": len(uv), "type": "VEC2"})
        a_uv = len(accessors) - 1
        iv = add_view(idx.tobytes(), 34963)  # ELEMENT_ARRAY_BUFFER
        accessors.append({"bufferView": iv, "componentType": 5125, "count": len(idx), "type": "SCALAR"})
        a_idx = len(accessors) - 1

        meshes.append({"name": obj.name, "primitives": [
            {"attributes": {"POSITION": a_pos, "NORMAL": a_nrm, "TEXCOORD_0": a_uv}, "indices": a_idx, "material": material_index(obj)}]})
        nodes.append({"name": obj.name, "mesh": len(meshes) - 1})

    binary = b"".join(bin_chunks)
    gltf = {
        "asset": {"version": "2.0", "generator": "AI 3D Studio"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials or [_glb_material(None, None)],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(binary)}],
    }
    json_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    return b"".join([
        struct.pack("<4sII", b"glTF", 2, total),
        struct.pack("<I4s", len(json_bytes), b"JSON"), json_bytes,
        struct.pack("<I4s", len(binary), b"BIN\x00"), binary,
    ])


# ---- 형식 레지스트리 ------------------------------------------------------------------

FORMATS: dict[str, dict] = {
    "stl": {"media_type": "model/stl", "label": "STL"},
    "3mf": {"media_type": "model/3mf", "label": "3MF"},
    "step": {"media_type": "model/step", "label": "STEP"},
    "glb": {"media_type": "model/gltf-binary", "label": "GLB"},
}


def export_shapes(fmt: str, objects: list[NamedShape]) -> bytes:
    shapes = [o.shape for o in objects]
    if fmt == "stl":
        return to_binary_stl(shapes)
    if fmt == "3mf":
        return to_3mf(objects)
    if fmt == "step":
        return to_step(shapes)
    if fmt == "glb":
        return to_glb(objects)
    raise ValueError(f"지원하지 않는 형식입니다: {fmt}")
