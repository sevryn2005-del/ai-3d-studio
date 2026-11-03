"""형식 v6 피처의 공통 규칙 (frontend/src/cad/features.ts 와 같은 규칙·메시지):
억제 판정, 패턴·대칭 사본 행렬, 쉘·패턴 검사.
"""

from __future__ import annotations

import math

import numpy as np

from app.cad.commands import (
    BooleanObject,
    BoxObject,
    CylinderObject,
    ExtrudeObject,
    Limits,
    ModelDefinition,
    PatternObject,
    resolve_profile,
    sketch_feature_ref,
)

_AXIS = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}


def is_suppressed(obj, index: dict, depth: int = 0) -> bool:
    """자신이 억제됐거나, 불리언의 기준·패턴의 원본이 억제됐으면 억제 (도구 억제는 그 연산에서만 빠짐)."""
    if obj.suppressed:
        return True
    if depth > 32:
        return False
    inner = obj.boolean.base if isinstance(obj, BooleanObject) else obj.pattern.source if isinstance(obj, PatternObject) else None
    child = index.get(inner) if inner else None
    return is_suppressed(child, index, depth + 1) if child is not None else False


def pattern_copy_count(p) -> int:
    if p.type == "mirror":
        return 2
    if p.type == "circular":
        return p.count
    return p.count * ((p.count2 or 1) if p.axis2 else 1)


def _rotation(axis: str, deg: float) -> np.ndarray:
    x, y, z = _AXIS[axis]
    a = math.radians(deg)
    c, s, C = math.cos(a), math.sin(a), 1 - math.cos(a)
    m = np.eye(4)
    m[:3, :3] = [
        [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
        [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
        [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
    ]
    return m


def pattern_matrices(p) -> list[np.ndarray]:
    """패턴 좌표계에서 원본에 곱할 사본 행렬 (첫 번째 = 단위 = 원본)."""
    if p.type == "mirror":
        n = np.array({"XY": _AXIS["z"], "XZ": _AXIS["y"], "YZ": _AXIS["x"]}[p.plane])
        m = np.eye(4)
        m[:3, :3] = np.eye(3) - 2 * np.outer(n, n)
        m[:3, 3] = 2 * p.offset * n  # T(o·n)·R·T(−o·n) 의 이동 성분
        return [np.eye(4), m]
    if p.type == "circular":
        step = 360 / p.count if p.angle >= 360 else (p.angle / (p.count - 1) if p.count > 1 else 0)
        return [_rotation(p.axis, k * step) for k in range(p.count)]
    out = []
    a = np.array(_AXIS[p.axis]) * p.spacing
    b = np.array(_AXIS[p.axis2]) * (p.spacing2 or 0) if p.axis2 else np.zeros(3)
    n2 = (p.count2 or 1) if p.axis2 else 1
    for j in range(n2):
        for i in range(p.count):
            m = np.eye(4)
            m[:3, 3] = a * i + b * j
            out.append(m)
    return out


def pattern_error(p) -> str | None:
    if p.type == "linear":
        if p.count < 2 and not (p.axis2 and (p.count2 or 1) >= 2):
            return "선형 패턴은 개수가 2 이상이어야 합니다"
        if abs(p.spacing) < Limits.MIN_DIMENSION:
            return f"간격은 {Limits.MIN_DIMENSION:g}mm 이상이어야 합니다"
        if p.axis2:
            if p.axis2 == p.axis:
                return "두 번째 방향은 첫 번째와 다른 축이어야 합니다"
            if p.count2 is None or p.spacing2 is None:
                return "두 번째 방향에는 개수와 간격이 필요합니다"
            if abs(p.spacing2) < Limits.MIN_DIMENSION:
                return f"간격은 {Limits.MIN_DIMENSION:g}mm 이상이어야 합니다"
        elif p.count2 is not None or p.spacing2 is not None:
            return "두 번째 방향 축(axis2)이 없습니다"
    if p.type == "circular" and p.count < 2:
        return "원형 패턴은 개수가 2 이상이어야 합니다"
    if pattern_copy_count(p) > Limits.MAX_PATTERN_TOTAL:
        return f"패턴 사본은 최대 {Limits.MAX_PATTERN_TOTAL}개까지 가능합니다"
    return None


def shell_faces(obj) -> list[str]:
    if isinstance(obj, BoxObject):
        return ["top", "bottom", "+X", "-X", "+Y", "-Y"]
    if isinstance(obj, CylinderObject):
        return ["top", "bottom"]
    if isinstance(obj, ExtrudeObject):
        return ["end", "start"]
    return []


def _fmt(v: float) -> str:
    return f"{round(v, 3):g}"


def shell_error(obj, shell, model: ModelDefinition) -> str | None:
    t = shell.thickness
    faces = shell_faces(obj)
    if not faces:
        return "쉘은 박스·원통·돌출에만 할 수 있습니다"
    if bad := [f for f in shell.open if f not in faces]:
        return f"열 수 없는 면입니다: {', '.join(bad)} (가능: {', '.join(faces)})"
    if len(set(shell.open)) != len(shell.open):
        return "같은 면이 두 번 지정되었습니다"
    limit = math.inf
    if isinstance(obj, BoxObject):
        if obj.edgeFeature:
            return "모서리 처리(필렛·모따기)한 박스에는 아직 쉘을 할 수 없습니다"
        if len(shell.open) >= 6:
            return "모든 면을 열 수는 없습니다"
        limit = min(obj.params.width, obj.params.depth, obj.params.height) / 2
    elif isinstance(obj, CylinderObject):
        limit = min(obj.params.radius, obj.params.height / 2)
    elif isinstance(obj, ExtrudeObject):
        ref = sketch_feature_ref(obj)
        sk = next((s for s in model.sketches if s.id == ref.sketch), None)
        p = resolve_profile(sk, ref.profile) if sk else None
        limit = abs(obj.params.distance) / 2
        if p and p["type"] == "rectangle":
            limit = min(limit, p["width"] / 2, p["height"] / 2)
        elif p and p["type"] == "circle":
            limit = min(limit, p["diameter"] / 2)
        elif p and p["type"] == "polygon":
            pts = p["points"]
            area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
            perim = sum(math.dist(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts)))
            limit = min(limit, abs(area) / perim)
    if t >= limit:
        return f"쉘 두께 {_fmt(t)}mm 가 너무 큽니다 ({_fmt(limit)}mm 보다 작아야 합니다)"
    return None
