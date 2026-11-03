"""스케치 평면 좌표계 (프론트엔드 frontend/src/cad/sketchPlane.ts 와 같은 표·같은 규칙).

스케치 좌표 (u, v) 는 평면 위, w 는 평면 법선(돌출 방향). 4×4 동차 행렬(numpy, 열 = u, v, 법선, 원점).
- 기준 평면 XY·XZ·YZ: CadQuery 이름 평면 규약, 원점 = 법선 × offset. 돌출 객체의 로컬 좌표계에 놓인다.
- 면 평면 {type: face, object, face, offset}: 객체의 "이름 있는 면" (docs/design-face-sketch.md).
  면 번호가 아니라 피처 정의와 월드 변환만으로 계산 → 필렛·구멍·치수 변경에도 같은 면.
  돌출 객체 로컬로는 inverse(돌출 객체 월드) · (면 월드).
공유 픽스처 shared/schemas/examples/model-face-sketch.json 으로 두 구현을 교차 검증한다.
"""

from __future__ import annotations

import math

import numpy as np

from app.cad.commands import (
    BooleanObject,
    BoxObject,
    CadObject,
    ConeObject,
    CylinderObject,
    ExtrudeObject,
    RevolveObject,
    sketch_feature_ref,
    FacePlane,
    ModelDefinition,
    Sketch,
    SphereObject,
    StandardPlane,
    Transform,
    PatternObject,
    resolve_profile,
)

MAX_DEPTH = 16  # 면 참조 재귀 한도 (순환은 validation.check_model 이 따로 거부)

_BASES = {
    "XY": ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
    "XZ": ((1, 0, 0), (0, 0, 1), (0, -1, 0)),
    "YZ": ((0, 1, 0), (0, 0, 1), (1, 0, 0)),
}


def _frame(origin, n, u) -> np.ndarray:
    """원점·바깥 법선·u 축 → 면 좌표계 (v = 법선 × u, 오른손 좌표계)."""
    n, u = np.asarray(n, float), np.asarray(u, float)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = u, np.cross(n, u), n, origin
    return m


def translation(x: float, y: float, z: float) -> np.ndarray:
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


def transform_matrix(t: Transform) -> np.ndarray:
    """T(position) · Rx · Ry · Rz (Three.js Euler 'XYZ', primitives.apply_transform 과 같은 회전)."""
    rx, ry, rz = (math.radians(a) for a in t.rotation)
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    m = np.eye(4)
    m[:3, :3] = Rx @ Ry @ Rz
    m[:3, 3] = t.position
    return m


def plane_matrix(plane: StandardPlane) -> np.ndarray:
    u, v, n = (np.asarray(x, float) for x in _BASES[plane.type])
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = u, v, n, n * plane.offset
    return m


def object_world_matrix(model: ModelDefinition, oid: str) -> np.ndarray:
    index = {o.id: o for o in model.objects}
    parent = {c: o.id for o in model.objects for c in o.child_ids}
    m = np.eye(4)
    cur: str | None = oid
    while cur and cur in index:
        m = transform_matrix(index[cur].transform) @ m
        cur = parent.get(cur)
    return m


def _profile(model: ModelDefinition, obj: ExtrudeObject) -> dict | None:
    ref = sketch_feature_ref(obj)
    sk = next((s for s in model.sketches if s.id == ref.sketch), None)
    return resolve_profile(sk, ref.profile) if sk else None


def faces_of(model: ModelDefinition, obj: CadObject, depth: int = 0) -> list[str]:
    if depth > MAX_DEPTH:
        return []
    match obj:
        case BoxObject():
            return ["top", "bottom", "+X", "-X", "+Y", "-Y"]
        case CylinderObject() | ConeObject():
            return ["top", "bottom"]
        case SphereObject():
            return []
        case ExtrudeObject():
            p = _profile(model, obj)
            return ["end", "start", "+u", "-u", "+v", "-v"] if p and p["type"] == "rectangle" else ["end", "start"]
        case BooleanObject():
            base = next((o for o in model.objects if o.id == obj.boolean.base), None)
            return faces_of(model, base, depth + 1) if base else []
        case PatternObject():
            src = next((o for o in model.objects if o.id == obj.pattern.source), None)
            return faces_of(model, src, depth + 1) if src else []
    return []


def face_local_matrix(model: ModelDefinition, obj: CadObject, face: str, depth: int = 0) -> np.ndarray | None:
    """객체 로컬 좌표계에서 본 면 좌표계 (원점 = 면 중심, z = 바깥 법선, x = u). 없는 면이면 None."""
    if depth > MAX_DEPTH or face not in faces_of(model, obj, depth):
        return None
    match obj:
        case BoxObject(params=p):
            w, d, h = p.width, p.depth, p.height
            return {
                "top": _frame((0, 0, h), (0, 0, 1), (1, 0, 0)),
                "bottom": _frame((0, 0, 0), (0, 0, -1), (1, 0, 0)),
                "+X": _frame((w / 2, 0, h / 2), (1, 0, 0), (0, 1, 0)),
                "-X": _frame((-w / 2, 0, h / 2), (-1, 0, 0), (0, -1, 0)),
                "+Y": _frame((0, d / 2, h / 2), (0, 1, 0), (-1, 0, 0)),
                "-Y": _frame((0, -d / 2, h / 2), (0, -1, 0), (1, 0, 0)),
            }[face]
        case CylinderObject(params=p) | ConeObject(params=p):
            return _frame((0, 0, p.height), (0, 0, 1), (1, 0, 0)) if face == "top" else _frame((0, 0, 0), (0, 0, -1), (1, 0, 0))
        case ExtrudeObject():
            p = _profile(model, obj)
            local = extrude_local_matrix(model, obj, depth + 1)
            if p is None or local is None:
                return None
            dist = obj.params.distance
            s = math.copysign(1.0, dist)
            cx, cy = p["center"]
            hw = p["width"] / 2 if p["type"] == "rectangle" else 0.0
            hh = p["height"] / 2 if p["type"] == "rectangle" else 0.0
            in_plane = {
                "end": _frame((cx, cy, dist), (0, 0, s), (1, 0, 0)),
                "start": _frame((cx, cy, 0), (0, 0, -s), (1, 0, 0)),
                "+u": _frame((cx + hw, cy, dist / 2), (1, 0, 0), (0, 1, 0)),
                "-u": _frame((cx - hw, cy, dist / 2), (-1, 0, 0), (0, -1, 0)),
                "+v": _frame((cx, cy + hh, dist / 2), (0, 1, 0), (-1, 0, 0)),
                "-v": _frame((cx, cy - hh, dist / 2), (0, -1, 0), (1, 0, 0)),
            }
            return local @ in_plane[face]
        case BooleanObject():
            base = next((o for o in model.objects if o.id == obj.boolean.base), None)
            f = face_local_matrix(model, base, face, depth + 1) if base else None
            return transform_matrix(base.transform) @ f if base is not None and f is not None else None
        case PatternObject():
            src = next((o for o in model.objects if o.id == obj.pattern.source), None)
            f = face_local_matrix(model, src, face, depth + 1) if src else None
            return transform_matrix(src.transform) @ f if src is not None and f is not None else None
    return None


def _face_world_matrix(model: ModelDefinition, plane: FacePlane, depth: int) -> np.ndarray | None:
    anchor = next((o for o in model.objects if o.id == plane.object), None)
    f = face_local_matrix(model, anchor, plane.face, depth + 1) if anchor else None
    if anchor is None or f is None:
        return None
    return object_world_matrix(model, anchor.id) @ f @ translation(0, 0, plane.offset)


def extrude_local_matrix(model: ModelDefinition, obj: ExtrudeObject | RevolveObject, depth: int = 0) -> np.ndarray | None:
    """스케치 평면 좌표 → 돌출 객체 로컬. 참조가 깨졌거나 순환이면 None."""
    if depth > MAX_DEPTH:
        return None
    sk: Sketch | None = next((s for s in model.sketches if s.id == sketch_feature_ref(obj).sketch), None)
    if sk is None:
        return None
    if isinstance(sk.plane, StandardPlane):
        return plane_matrix(sk.plane)
    world = _face_world_matrix(model, sk.plane, depth)
    return None if world is None else np.linalg.inv(object_world_matrix(model, obj.id)) @ world


def dependency_cycle(model: ModelDefinition) -> str | None:
    """돌출 → 스케치, 스케치(면 평면) → 붙은 객체, 불리언 → 자식 의존에 순환이 있으면 사용자 메시지."""
    edges: dict[str, list[str]] = {}
    for o in model.objects:
        if ref := sketch_feature_ref(o):
            edges.setdefault(f"o:{o.id}", []).append(f"s:{ref.sketch}")
        if o.child_ids:
            edges.setdefault(f"o:{o.id}", []).extend(f"o:{c}" for c in o.child_ids)
    for sk in model.sketches:
        if isinstance(sk.plane, FacePlane):
            edges.setdefault(f"s:{sk.id}", []).append(f"o:{sk.plane.object}")
    state: dict[str, int] = {}

    def visit(node: str) -> str | None:
        if state.get(node) == 2:
            return None
        if state.get(node) == 1:
            return node
        state[node] = 1
        for nxt in edges.get(node, []):
            if hit := visit(nxt):
                return hit
        state[node] = 2
        return None

    for node in list(edges):
        if hit := visit(node):
            return f"면 참조가 순환합니다: {hit[2:]} (스케치를 자신이 만든 형상의 면에 붙일 수 없습니다)"
    return None
