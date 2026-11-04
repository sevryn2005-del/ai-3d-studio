"""형식 v10 곡선 규칙 — frontend/src/cad/curves.ts 와 같은 계산·같은 점.

꼭짓점 처리(corners: 필렛 = 접하는 호, 모따기 = 자른 직선), 경로(열린 꺾은선), 얇은 단면(리브), 스윕 고리(마이터 이음).
"""

from __future__ import annotations

import math

OUTLINE_STEP = math.pi / 32

Pt = tuple[float, float]


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def _len(a) -> float:
    return math.hypot(a[0], a[1])


def _unit(a):
    n = _len(a)
    return (a[0] / n, a[1] / n)


def _at(p, d, s):
    return (p[0] + d[0] * s, p[1] + d[1] * s)


def _corner_type(c):
    return c["type"] if isinstance(c, dict) else c.type


def _corner_size(c):
    return c["size"] if isinstance(c, dict) else c.size


def _corner_k(c):
    return c["k"] if isinstance(c, dict) else c.k


def _cut_corner(prev, v, nxt, corner):
    """(a, b, cut, seg) — seg: None | ('line', a, b) | ('arc', a, b, c, r, ccw, sweep, mid)"""
    plain = (v, v, 0.0, None)
    if corner is None or _corner_size(corner) <= 0:
        return plain
    d1 = _unit(_sub(prev, v))
    d2 = _unit(_sub(nxt, v))
    cos = max(-1.0, min(1.0, d1[0] * d2[0] + d1[1] * d2[1]))
    theta = math.acos(cos)
    if theta > math.pi - 1e-9 or theta < 1e-9:
        return plain
    size = _corner_size(corner)
    if _corner_type(corner) == "chamfer":
        a, b = _at(v, d1, size), _at(v, d2, size)
        return a, b, size, ("line", a, b)
    r = size
    t = r / math.tan(theta / 2)
    a, b = _at(v, d1, t), _at(v, d2, t)
    bis = _unit((d1[0] + d2[0], d1[1] + d2[1]))
    c = _at(v, bis, r / math.sin(theta / 2))
    ca, cb = _sub(a, c), _sub(b, c)
    ccw = ca[0] * cb[1] - ca[1] * cb[0] > 0
    mid = _at(c, _unit(_sub(v, c)), r)
    return a, b, t, ("arc", a, b, c, r, ccw, math.pi - theta, mid)


def corner_segments(points, corners, closed: bool) -> list[tuple]:
    pts = [tuple(p) for p in points]
    n = len(pts)
    by_k = {_corner_k(c): c for c in (corners or [])}
    cuts = []
    for k, v in enumerate(pts):
        if not closed and (k == 0 or k == n - 1):
            cuts.append((v, v, 0.0, None))
        else:
            cuts.append(_cut_corner(pts[(k - 1) % n], v, pts[(k + 1) % n], by_k.get(k)))
    segs = []
    last = n if closed else n - 1
    for k in range(last):
        frm, to = cuts[k], cuts[(k + 1) % n]
        if _len(_sub(to[0], frm[1])) > 1e-12:
            segs.append(("line", frm[1], to[0]))
        if to[3] is not None and (closed or k + 1 < n - 1):
            segs.append(to[3])
    return segs


def corner_error(points, corners, closed: bool) -> str | None:
    if not corners:
        return None
    pts = [tuple(p) for p in points]
    n = len(pts)
    seen = set()
    for c in corners:
        k = _corner_k(c)
        if k >= n or (not closed and k in (0, n - 1)):
            return f"꼭짓점 p{k} 에는 모서리 처리를 할 수 없습니다" + ("" if closed else " (경로의 양 끝점)")
        if k in seen:
            return f"꼭짓점 p{k} 의 모서리 처리가 중복되었습니다"
        seen.add(k)
    by_k = {_corner_k(c): c for c in corners}
    cut = [0.0 if (not closed and k in (0, n - 1)) else _cut_corner(pts[(k - 1) % n], v, pts[(k + 1) % n], by_k.get(k))[2]
           for k, v in enumerate(pts)]
    for k in range(n if closed else n - 1):
        edge = _len(_sub(pts[(k + 1) % n], pts[k]))
        if cut[k] + cut[(k + 1) % n] > edge + 1e-9:
            return f"모서리 처리(p{k}·p{(k + 1) % n})가 변 길이 {round(edge, 3):g}mm 보다 큽니다. 크기를 줄이세요"
    return None


def arc_divisions(sweep: float, step: float) -> int:
    return max(2, math.ceil(sweep / step - 1e-9))


def sample_segments(segs, closed: bool, step: float = OUTLINE_STEP) -> list[Pt]:
    out: list[Pt] = []
    for s in segs:
        out.append(s[1])
        if s[0] == "arc":
            _, a, _b, c, r, ccw, sweep, _mid = s
            n = arc_divisions(sweep, step)
            a0 = math.atan2(a[1] - c[1], a[0] - c[0])
            d = 1 if ccw else -1
            for i in range(1, n):
                t = a0 + d * sweep * i / n
                out.append((c[0] + r * math.cos(t), c[1] + r * math.sin(t)))
    if not closed and segs:
        out.append(segs[-1][2])
    return out


def rounded_points(points, corners, closed: bool) -> list[Pt]:
    if not corners:
        return [(p[0], p[1]) for p in points]
    return sample_segments(corner_segments(points, corners, closed), closed)


def thin_polygon(pts, t: float) -> list[Pt]:
    h = t / 2
    normals = []
    for i in range(1, len(pts)):
        d = _unit(_sub(pts[i], pts[i - 1]))
        normals.append((-d[1], d[0]))

    def side(s):
        out = []
        for i, p in enumerate(pts):
            if i == 0:
                out.append(_at(p, normals[0], s * h))
            elif i == len(pts) - 1:
                out.append(_at(p, normals[-1], s * h))
            else:
                n1, n2 = normals[i - 1], normals[i]
                m = _unit((n1[0] + n2[0], n1[1] + n2[1]))
                out.append(_at(p, m, s * h / (m[0] * n2[0] + m[1] * n2[1])))
        return out

    return side(1) + side(-1)[::-1]


def open_path_error(pts) -> str | None:
    for i in range(1, len(pts)):
        if _len(_sub(pts[i], pts[i - 1])) < 1e-6:
            return f"p{i - 1}·p{i} 가 같은 점입니다"
    for i in range(1, len(pts) - 1):
        d1 = _unit(_sub(pts[i], pts[i - 1]))
        d2 = _unit(_sub(pts[i + 1], pts[i]))
        if d1[0] * d2[0] + d1[1] * d2[1] < -1 + 1e-6:
            return f"p{i} 에서 경로가 되돌아갑니다"
    return None


def _norm3(a):
    n = math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2)
    return (a[0] / n, a[1] / n, a[2] / n)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def sweep_rings(profile, path, B):
    """단면(중심 기준 u·v)을 경로(로컬 3D)를 따라 — curves.ts sweepRings 와 같음"""
    T = [_norm3((path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2])) for i in range(len(path) - 1)]
    N = [_cross(B, t) for t in T]
    rings = []
    for i, p in enumerate(path):
        s = 1.0
        if i == 0:
            m = N[0]
        elif i == len(path) - 1:
            m = N[-1]
        else:
            m = _norm3(tuple(N[i - 1][k] + N[i][k] for k in range(3)))
            s = 1 / sum(m[k] * N[i][k] for k in range(3))
        rings.append([tuple(p[k] + m[k] * u * s + B[k] * v for k in range(3)) for u, v in profile])
    return rings


def sweep_error(profile, path) -> str | None:
    if len(path) < 2:
        return "경로에 점이 2개 이상 있어야 합니다"
    e = max(abs(q[0]) for q in profile)
    use = []
    for i, p in enumerate(path):
        if i == 0 or i == len(path) - 1:
            use.append(0.0)
            continue
        d1 = _unit(_sub(p, path[i - 1]))
        d2 = _unit(_sub(path[i + 1], p))
        turn = math.acos(max(-1.0, min(1.0, d1[0] * d2[0] + d1[1] * d2[1])))
        use.append(e * math.tan(turn / 2))
    for i in range(len(path) - 1):
        if use[i] + use[i + 1] > _len(_sub(path[i + 1], path[i])) + 1e-6:
            return f"경로가 단면에 비해 너무 급하게 꺾입니다 (꺾이는 곳의 둥글기 반지름을 단면 반폭 {round(e, 3):g}mm 보다 크게 하세요)"
    return None
