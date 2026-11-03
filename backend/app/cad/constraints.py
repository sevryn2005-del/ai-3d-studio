"""스케치 구속 검사 (frontend/src/cad/solver.ts 와 같은 참조 규칙·같은 잔차 식).

해석(풀기)은 편집할 때 프론트엔드가 한다. 설계 원본에는 풀린 좌표가 저장되므로, 백엔드는
저장된 좌표가 구속을 만족하는지(잔차 ≤ CHECK_TOLERANCE)와 다각형이 꼬이지 않았는지만 확인한다.
"""

from __future__ import annotations

import math

from app.cad.commands import Sketch, SketchConstraint

CHECK_TOLERANCE = 1e-4

LABEL = {
    "fix": "고정", "coincident": "일치", "concentric": "동심", "horizontal": "수평", "vertical": "수직", "parallel": "평행",
    "perpendicular": "직교", "equal": "같은 길이", "length": "길이", "distance": "거리", "tangent": "접선",
}

# 구속 종류별 참조 형식 (solver.ts CONSTRAINT_ARITY 와 같음)
ARITY: dict[str, tuple[list[tuple[str, ...]], bool]] = {
    "fix": ([("point",)], False),
    "coincident": ([("point", "point")], False),
    "concentric": ([("circle", "circle")], False),
    "horizontal": ([("edge",), ("point", "point")], False),
    "vertical": ([("edge",), ("point", "point")], False),
    "parallel": ([("edge", "edge")], False),
    "perpendicular": ([("edge", "edge")], False),
    "equal": ([("edge", "edge")], False),
    "length": ([("edge",)], True),
    "distance": ([("point", "point")], True),
    "tangent": ([("edge", "circle")], False),
}


def sketch_points(sk: Sketch) -> dict[str, tuple[float, float]]:
    pts: dict[str, tuple[float, float]] = {}
    for e in sk.entities:
        if e.type == "polygon":
            for k, p in enumerate(e.points):
                pts[f"{e.id}.p{k}"] = (p[0], p[1])
        else:
            pts[f"{e.id}.center"] = (e.center[0], e.center[1])
    return pts


def ref_kind(sk: Sketch, ref: str) -> str | None:
    eid, _, part = ref.partition(".")
    e = next((x for x in sk.entities if x.id == eid), None)
    if e is None:
        return None
    if not part:
        return "circle" if e.type == "circle" else None
    if part == "center":
        return None if e.type == "polygon" else "point"
    if e.type != "polygon" or int(part[1:]) >= len(e.points):
        return None
    return "point" if part[0] == "p" else "edge"


def constraint_error(sk: Sketch, c: SketchConstraint) -> str | None:
    forms, needs_value = ARITY[c.type]
    kinds = [ref_kind(sk, r) for r in c.refs]
    for r, k in zip(c.refs, kinds):
        if k is None:
            return f"없는 점·변·원을 참조합니다: {r}"
    if tuple(kinds) not in forms:
        return f"{LABEL[c.type]} 구속의 참조 형식이 맞지 않습니다"
    if needs_value and c.value is None:
        return f"{LABEL[c.type]} 구속에는 값(mm)이 필요합니다"
    if not needs_value and c.value is not None:
        return f"{LABEL[c.type]} 구속에는 값을 넣지 않습니다"
    if len(c.refs) == 2 and c.refs[0] == c.refs[1]:
        return "같은 대상을 두 번 참조할 수 없습니다"
    return None


def _edge(sk: Sketch, pts: dict, ref: str):
    eid, _, part = ref.partition(".")
    n = len(next(e for e in sk.entities if e.id == eid).points)
    k = int(part[1:])
    return pts[f"{eid}.p{k}"], pts[f"{eid}.p{(k + 1) % n}"]


def residuals(sk: Sketch, c: SketchConstraint) -> list[float]:
    pts = sketch_points(sk)

    def P(ref: str):
        return pts[ref if (ref.endswith(".center") or ".p" in ref) else f"{ref}.center"]

    def d(edge: str):
        a, b = _edge(sk, pts, edge)
        return (b[0] - a[0], b[1] - a[1])

    def pair():
        return _edge(sk, pts, c.refs[0]) if ref_kind(sk, c.refs[0]) == "edge" else (P(c.refs[0]), P(c.refs[1]))

    t = c.type
    if t == "fix":
        return []
    if t in ("coincident", "concentric"):
        a, b = P(c.refs[0]), P(c.refs[1])
        return [b[0] - a[0], b[1] - a[1]]
    if t == "horizontal":
        a, b = pair()
        return [b[1] - a[1]]
    if t == "vertical":
        a, b = pair()
        return [b[0] - a[0]]
    if t in ("parallel", "perpendicular"):
        u, v = d(c.refs[0]), d(c.refs[1])
        n = max(math.hypot(*u) * math.hypot(*v), 1e-12)
        return [(u[0] * v[1] - u[1] * v[0]) / n if t == "parallel" else (u[0] * v[0] + u[1] * v[1]) / n]
    if t == "equal":
        return [math.hypot(*d(c.refs[0])) - math.hypot(*d(c.refs[1]))]
    if t == "length":
        return [math.hypot(*d(c.refs[0])) - c.value]
    if t == "distance":
        a, b = P(c.refs[0]), P(c.refs[1])
        return [math.hypot(b[0] - a[0], b[1] - a[1]) - c.value]
    if t == "tangent":
        a, b = _edge(sk, pts, c.refs[0])
        o = P(c.refs[1])
        dx, dy = b[0] - a[0], b[1] - a[1]
        dist = abs(dx * (o[1] - a[1]) - dy * (o[0] - a[0])) / max(math.hypot(dx, dy), 1e-12)
        r = next((x.value for x in sk.dimensions if x.entity == c.refs[1] and x.kind == "diameter"), 0) / 2
        return [dist - r]
    return []


def signed_area(points) -> float:
    return sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1]
               for i in range(len(points))) / 2


def _cross(p1, p2, p3, p4) -> bool:
    def o(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1, d2, d3, d4 = o(p3, p4, p1), o(p3, p4, p2), o(p1, p2, p3), o(p1, p2, p4)
    eps = 1e-12
    return ((d1 > eps and d2 < -eps) or (d1 < -eps and d2 > eps)) and ((d3 > eps and d4 < -eps) or (d3 < -eps and d4 > eps))


def polygon_error(points) -> str | None:
    n = len(points)
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        if math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6:
            return f"변 e{i} 의 길이가 0 입니다"
        for j in range(i + 1, n):
            if (j + 1) % n == i or (i + 1) % n == j:
                continue
            if _cross(a, b, points[j], points[(j + 1) % n]):
                return f"변 e{i} 와 e{j} 가 교차합니다 (꼬인 다각형)"
    if abs(signed_area(points)) < 1e-6:
        return "다각형의 넓이가 0 입니다"
    return None


def constraint_errors(sk: Sketch) -> list[str]:
    """스케치의 다각형·구속 문제 목록 (validation.sketch_errors 에서 사용)."""
    errors: list[str] = []
    for e in sk.entities:
        if e.type == "polygon" and (err := polygon_error(e.points)):
            errors.append(f"{sk.id}: {e.id} {err}")
    seen: set[str] = set()
    for c in sk.constraints:
        if c.id in seen:
            errors.append(f"{sk.id}: 구속 ID 가 중복되었습니다: {c.id}")
        seen.add(c.id)
        if err := constraint_error(sk, c):
            errors.append(f"{sk.id}: 구속 {c.id}: {err}")
            continue
        worst = max((abs(v) for v in residuals(sk, c)), default=0.0)
        if worst > CHECK_TOLERANCE:
            errors.append(f"{sk.id}: 구속 {c.id} 을(를) 만족하지 않습니다 (오차 {worst:.1e})")
    return errors
