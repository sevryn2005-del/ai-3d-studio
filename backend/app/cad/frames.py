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
    SheetObject,
    CylinderObject,
    ExtrudeObject,
    RevolveObject,
    sketch_feature_ref,
    sketch_refs,
    FacePlane,
    ModelDefinition,
    Sketch,
    SphereObject,
    StandardPlane,
    Transform,
    PatternObject,
    profile_of,
    FilletObject,
    DraftObject,
    HelixObject,
    HoleObject,
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


def plane_matrix(plane) -> np.ndarray:
    """기준 평면 / 각도 평면 (= 기준(offset 0) · R(u 또는 v 축, angle) · T(0, 0, offset)) / 고른 면 평면 → 객체 로컬"""
    if plane.type == "frame":  # sketchPlane.ts planeMatrix 와 같음: u = xDir 를 법선에 수직으로, v = 법선 × u
        n = np.asarray(plane.normal, float)
        n = n / np.linalg.norm(n)
        x = np.asarray(plane.xDir, float)
        x = x - n * (x @ n)
        x = x / np.linalg.norm(x)
        m = np.eye(4)
        m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, np.cross(n, x), n, np.asarray(plane.origin, float) + n * plane.offset
        return m
    if plane.type == "angled":
        u, v, n = (np.asarray(x, float) for x in _BASES[plane.base])
        base = np.eye(4)
        base[:3, 0], base[:3, 1], base[:3, 2] = u, v, n
        a = math.radians(plane.angle)
        c, s = math.cos(a), math.sin(a)
        rot = np.eye(4)
        if plane.axis == "u":
            rot[1:3, 1:3] = [[c, -s], [s, c]]
        else:
            rot[0, 0], rot[0, 2], rot[2, 0], rot[2, 2] = c, s, -s, c
        return base @ rot @ translation(0, 0, plane.offset)
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
    return profile_of(sk, ref) if sk else None


def faces_of(model: ModelDefinition, obj: CadObject, depth: int = 0) -> list[str]:
    if depth > MAX_DEPTH:
        return []
    match obj:
        case BoxObject():
            return ["top", "bottom", "+X", "-X", "+Y", "-Y"]
        case CylinderObject() | ConeObject() | SheetObject():
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
            if obj.pattern.type == "scale":  # 크기 조정은 면 위치가 바뀌므로 아직 면 없음
                return []
            src = next((o for o in model.objects if o.id == obj.pattern.source), None)
            return faces_of(model, src, depth + 1) if src else []
        case FilletObject():  # 모서리 처리 뒤에도 평면은 같은 자리 → 원본의 면 (sketchPlane.ts 와 같음)
            src = next((o for o in model.objects if o.id == obj.fillet.source), None)
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
        case SheetObject(params=p):  # 판금: 바닥 판 안쪽 윗면·바깥 아랫면 (sketchPlane.ts 와 같음)
            return _frame((0, 0, p.thickness), (0, 0, 1), (1, 0, 0)) if face == "top" else _frame((0, 0, 0), (0, 0, -1), (1, 0, 0))
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
        case FilletObject():
            src = next((o for o in model.objects if o.id == obj.fillet.source), None)
            f = face_local_matrix(model, src, face, depth + 1) if src else None
            return transform_matrix(src.transform) @ f if src is not None and f is not None else None
    return None


def axis_local(model: ModelDefinition, obj: CadObject, depth: int = 0) -> tuple[np.ndarray, np.ndarray] | None:
    """객체 로컬 축 (원점, 방향) — frontend mates.ts axisLocal 과 같은 규칙"""
    if depth > MAX_DEPTH:
        return None

    def via(cid: str):
        child = next((o for o in model.objects if o.id == cid), None)
        f = axis_local(model, child, depth + 1) if child is not None else None
        if child is None or f is None:
            return None
        m = transform_matrix(child.transform)
        return (m @ np.append(f[0], 1.0))[:3], m[:3, :3] @ f[1]

    match obj:
        case CylinderObject() | ConeObject() | HoleObject():
            return np.zeros(3), np.array([0.0, 0.0, 1.0])
        case ExtrudeObject():
            p = _profile(model, obj)
            m = extrude_local_matrix(model, obj, depth + 1)
            if p is None or m is None or p["type"] not in ("circle", "slot"):
                return None
            return (m @ np.array([p["center"][0], p["center"][1], 0.0, 1.0]))[:3], m[:3, :3] @ np.array([0.0, 0.0, 1.0])
        case RevolveObject() | HelixObject():
            m = extrude_local_matrix(model, obj, depth + 1)
            return (m[:3, 3].copy(), m[:3, :3] @ np.array([0.0, 1.0, 0.0])) if m is not None else None
        case BooleanObject():
            return via(obj.boolean.base)
        case PatternObject():
            return None if obj.pattern.type == "scale" else via(obj.pattern.source)
        case FilletObject():
            return via(obj.fillet.source)
        case DraftObject():
            return via(obj.draft.source)
    return None


def _face_world_matrix(model: ModelDefinition, plane: FacePlane, depth: int) -> np.ndarray | None:
    anchor = next((o for o in model.objects if o.id == plane.object), None)
    f = face_local_matrix(model, anchor, plane.face, depth + 1) if anchor else None
    if anchor is None or f is None:
        return None
    return object_world_matrix(model, anchor.id) @ f @ translation(0, 0, plane.offset)


def extrude_local_matrix(model: ModelDefinition, obj, depth: int = 0) -> np.ndarray | None:
    """스케치 평면 좌표 → 돌출(회전·헬릭스) 객체 로컬. 참조가 깨졌거나 순환이면 None."""
    return sketch_local_matrix(model, obj.id, sketch_feature_ref(obj).sketch, depth)


def sketch_local_matrix(model: ModelDefinition, object_id: str, sketch_id: str, depth: int = 0) -> np.ndarray | None:
    """스케치 평면 좌표 → 객체 로컬 (로프트처럼 한 객체가 여러 스케치를 쓸 때)"""
    if depth > MAX_DEPTH:
        return None
    sk: Sketch | None = next((s for s in model.sketches if s.id == sketch_id), None)
    if sk is None:
        return None
    if not isinstance(sk.plane, FacePlane):
        return plane_matrix(sk.plane)
    world = _face_world_matrix(model, sk.plane, depth)
    return None if world is None else np.linalg.inv(object_world_matrix(model, object_id)) @ world


def dependency_cycle(model: ModelDefinition) -> str | None:
    """돌출 → 스케치, 스케치(면 평면) → 붙은 객체, 불리언 → 자식 의존에 순환이 있으면 사용자 메시지."""
    edges: dict[str, list[str]] = {}
    for o in model.objects:
        for ref in sketch_refs(o):
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
