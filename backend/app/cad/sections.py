"""로프트·헬릭스의 단면 점 (형식 v8) — frontend/src/cad/sections.ts 와 같은 규칙·같은 점.

outline: 프로파일 윤곽 (반시계). 원 = 정밀 다각형 256, 슬롯 = 반원당 64.
resample: 둘레 n 등분, 시작 = 바운딩 박스 중심에서 +u 반직선과 윤곽이 처음 만나는 점.
"""

from __future__ import annotations

import math

from app.cad.commands import ellipse_half_extent, slot_half_extent
from app.cad.curves import rounded_points


def slot_outline(p: dict, segs: int = 16) -> list[tuple[float, float]]:
    a = math.radians(p["angle"])
    r = p["width"] / 2
    cx, cy = p["center"]
    out = []
    for end, start in ((p["length"] / 2, -math.pi / 2), (-p["length"] / 2, math.pi / 2)):
        for i in range(segs + 1):
            t = start + i / segs * math.pi
            lx, ly = end + r * math.cos(t), r * math.sin(t)
            out.append((cx + lx * math.cos(a) - ly * math.sin(a), cy + lx * math.sin(a) + ly * math.cos(a)))
    return out


def signed_area(pts) -> float:
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2


REGION_UNSUPPORTED = "영역 단면은 돌출·회전에만 쓸 수 있습니다 (로프트·헬릭스·스윕은 사각형·원·다각형·슬롯 하나로)"


def outline(p: dict) -> list[tuple[float, float]]:
    t = p["type"]
    if t == "region":
        from app.cad.primitives import GeometryError

        raise GeometryError(REGION_UNSUPPORTED)
    if t == "polygon":
        pts = rounded_points(p["points"], p.get("corners"), True, p.get("arcs"), bool(p.get("spline")))
    elif t == "rectangle":
        cx, cy = p["center"]
        w, h = p["width"] / 2, p["height"] / 2
        pts = [(cx - w, cy - h), (cx + w, cy - h), (cx + w, cy + h), (cx - w, cy + h)]
    elif t == "slot":
        pts = slot_outline(p, 64)
    elif t == "ellipse":
        pts = ellipse_outline(p, 256)
    else:
        r = p["diameter"] / 2
        cx, cy = p["center"]
        pts = [(cx + r * math.cos(2 * math.pi * k / 256), cy + r * math.sin(2 * math.pi * k / 256)) for k in range(256)]
    return pts[::-1] if signed_area(pts) < 0 else pts


def ellipse_outline(p: dict, n: int) -> list[tuple[float, float]]:
    """타원 윤곽 n 점 (반시계, 첫 점 = 방향 축 끝) — sketch.ts ellipseOutline"""
    t = math.radians(p["angle"])
    a, b = p["width"] / 2, p["height"] / 2
    cx, cy = p["center"]
    out = []
    for k in range(n):
        s = 2 * math.pi * k / n
        x, y = a * math.cos(s), b * math.sin(s)
        out.append((cx + x * math.cos(t) - y * math.sin(t), cy + x * math.sin(t) + y * math.cos(t)))
    return out


def bounds(p: dict) -> tuple[tuple[float, float], float, float]:
    """(중심, 폭 u, 높이 v) — sketch.ts profileBounds 와 같음"""
    if p["type"] == "circle":
        return tuple(p["center"]), p["diameter"], p["diameter"]
    if p["type"] in ("slot", "ellipse"):
        hu, hv = slot_half_extent(p) if p["type"] == "slot" else ellipse_half_extent(p)
        return tuple(p["center"]), 2 * hu, 2 * hv
    return tuple(p["center"]), p["width"], p["height"]


def resample(pts, n: int, center) -> list[tuple[float, float]]:
    start = (0, 0.0, math.inf)
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        dy = b[1] - a[1]
        if abs(dy) < 1e-12:
            continue
        t = (center[1] - a[1]) / dy
        if t < 0 or t >= 1:
            continue
        d = a[0] + t * (b[0] - a[0]) - center[0]
        if 1e-12 < d < start[2]:
            start = (i, t, d)
    e, t, _ = start
    s0, s1 = pts[e], pts[(e + 1) % len(pts)]
    sp = (s0[0] + t * (s1[0] - s0[0]), s0[1] + t * (s1[1] - s0[1]))
    ring = [sp] + [pts[(e + k) % len(pts)] for k in range(1, len(pts) + 1)] + [sp]
    seg = [math.dist(ring[i], ring[i + 1]) for i in range(len(ring) - 1)]
    total = sum(seg)
    out, i, acc = [], 0, 0.0
    for k in range(n):
        target = total * k / n
        while i < len(seg) - 1 and acc + seg[i] < target - 1e-12:
            acc += seg[i]
            i += 1
        u = (target - acc) / seg[i] if seg[i] > 0 else 0
        a, b = ring[i], ring[i + 1]
        out.append((a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])))
    return out


def loft_segments(profiles: list[dict], tol: float) -> int:
    r = max(math.hypot(w, h) / 2 for _, w, h in (bounds(p) for p in profiles))
    n = 32 if r <= tol else math.ceil(math.pi / math.acos(1 - tol / r))
    return min(256, max(32, math.ceil(n / 8) * 8))


def section_points(p: dict, n: int):
    return resample(outline(p), n, bounds(p)[0])


def helix_profile_points(p: dict, tol: float):
    if p["type"] in ("polygon", "rectangle"):
        return outline(p)
    return section_points(p, loft_segments([p], tol))


def helix_error(pts, pitch: float) -> str | None:
    if min(q[0] for q in pts) <= 1e-9:
        return "헬릭스 프로파일은 회전축(u = 0)에 닿지 않게 한쪽(u > 0)에 있어야 합니다"
    h = max(q[1] for q in pts) - min(q[1] for q in pts)
    if pitch <= h + 1e-9:
        return f"피치({round(pitch, 3):g}mm)가 프로파일 높이({round(h, 3):g}mm)보다 커야 바퀴끼리 겹치지 않습니다"
    return None


def sweep_profile_points(p: dict, tol: float):
    """스윕 단면 점: 헬릭스와 같은 점을 바운딩 박스 중심 기준으로 (sections.ts sweepProfilePoints)"""
    (cx, cy), _, _ = bounds(p)
    return [(u - cx, v - cy) for u, v in helix_profile_points(p, tol)]
