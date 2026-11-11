"""스마트 UV 펼치기 (형식 v46) — 프론트 cad/smartUv.ts 와 같은 계산 (정렬·기준 축·배치 순서까지 같게).

넓은 삼각형부터 씨앗 → 모서리를 공유하고 법선이 씨앗과 angle_limit 이내인 이웃으로 차트 → 씨앗 법선 평면에 mm 투영
→ 차트 상자 선반 배치 → 0~1 (glTF: v 는 1 − v).
"""

from __future__ import annotations

import math

import numpy as np

SMART_UV_ANGLE = 66.0
SMART_UV_MARGIN = 0.01


def _key(x: float, y: float, z: float) -> tuple[int, int, int]:
    # JS Math.round 와 같게 (반올림 .5 는 +∞ 쪽)
    return (math.floor(x * 1e4 + 0.5), math.floor(y * 1e4 + 0.5), math.floor(z * 1e4 + 0.5))


def _basis(n: tuple[float, float, float]) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    ax, ay, az = abs(n[0]), abs(n[1]), abs(n[2])
    a = (1.0, 0.0, 0.0) if ax <= ay and ax <= az else (0.0, 1.0, 0.0) if ay <= az else (0.0, 0.0, 1.0)
    u = (n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0])
    lu = math.hypot(*u)
    uu = (u[0] / lu, u[1] / lu, u[2] / lu)
    v = (n[1] * uu[2] - n[2] * uu[1], n[2] * uu[0] - n[0] * uu[2], n[0] * uu[1] - n[1] * uu[0])
    return uu, v


def smart_uv(pos: np.ndarray, angle_limit: float = SMART_UV_ANGLE, margin: float = SMART_UV_MARGIN) -> tuple[np.ndarray, int]:
    """pos = (삼각형 수 × 3, 3) 인덱스 없는 꼭짓점 (mm). 반환: (꼭짓점마다 uv (N×3, 2), 차트 수)"""
    p = np.asarray(pos, dtype=np.float64).reshape(-1, 3)
    n = len(p) // 3
    uv = np.zeros((n * 3, 2), dtype=np.float64)
    if n == 0:
        return uv, 0
    tri = p.reshape(n, 3, 3)
    normals: list[tuple[float, float, float]] = []
    areas: list[float] = []
    for t in range(n):
        a, b, c = tri[t]
        e1 = b - a
        e2 = c - a
        cr = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
        length = math.hypot(*cr)
        areas.append(length / 2)
        normals.append((cr[0] / length, cr[1] / length, cr[2] / length) if length > 1e-12 else (0.0, 0.0, 1.0))
    keys = [[_key(*tri[t][k]) for k in range(3)] for t in range(n)]
    edge_tris: dict[tuple, list[int]] = {}
    edges_of: list[list[tuple]] = []
    for t in range(n):
        es = []
        for k in range(3):
            a, b = keys[t][k], keys[t][(k + 1) % 3]
            # TS 는 문자열 비교로 순서를 정하지만 키 쌍은 순서 무관 집합이라 결과는 같다
            e = (a, b) if a < b else (b, a)
            es.append(e)
            edge_tris.setdefault(e, []).append(t)
        edges_of.append(es)
    # 정렬 키는 1e-6 으로 반올림 (smartUv.ts 와 같은 순서)
    def r6(v: float) -> int:
        return math.floor(v * 1e6 + 0.5)

    order = sorted(range(n), key=lambda i: (-r6(areas[i]), i))
    chart_of = [-1] * n
    cos_limit = math.cos(math.radians(angle_limit))
    charts: list[tuple[tuple[float, float, float], list[int]]] = []
    for seed in order:
        if chart_of[seed] != -1:
            continue
        cn = normals[seed]
        cid = len(charts)
        tris = [seed]
        chart_of[seed] = cid
        q = 0
        while q < len(tris):
            t = tris[q]
            q += 1
            for e in edges_of[t]:
                for o in edge_tris[e]:
                    if chart_of[o] != -1:
                        continue
                    m = normals[o]
                    if m[0] * cn[0] + m[1] * cn[1] + m[2] * cn[2] < cos_limit:
                        continue
                    chart_of[o] = cid
                    tris.append(o)
        charts.append((cn, tris))
    local = np.zeros((n * 3, 2), dtype=np.float64)
    boxes = []
    for cid, (cn, tris) in enumerate(charts):
        bu, bv = _basis(cn)
        mu = mv = math.inf
        xu = xv = -math.inf
        for t in tris:
            for k in range(3):
                x, y, z = tri[t][k]
                u = x * bu[0] + y * bu[1] + z * bu[2]
                v = x * bv[0] + y * bv[1] + z * bv[2]
                local[t * 3 + k] = (u, v)
                mu, mv, xu, xv = min(mu, u), min(mv, v), max(xu, u), max(xv, v)
        boxes.append({"id": cid, "minU": mu, "minV": mv, "w": xu - mu, "h": xv - mv, "x": 0.0, "y": 0.0})
    total = sum(b["w"] * b["h"] for b in boxes)
    longest = max(max(b["w"], b["h"]) for b in boxes)
    gap = max(longest, math.sqrt(total)) * margin
    limit = max(longest + gap, math.sqrt(total) * 1.15)
    x = y = gap
    row = width = 0.0
    for b in sorted(boxes, key=lambda b: (-r6(b["h"]), b["id"])):
        if x + b["w"] + gap > limit and x > gap:
            x = gap
            y += row + gap
            row = 0.0
        b["x"], b["y"] = x, y
        x += b["w"] + gap
        row = max(row, b["h"])
        width = max(width, x)
    size = max(width, y + row + gap)
    for cid, (_, tris) in enumerate(charts):
        b = boxes[cid]
        for t in tris:
            for k in range(3):
                lu, lv = local[t * 3 + k]
                uv[t * 3 + k] = ((lu - b["minU"] + b["x"]) / size, 1 - (lv - b["minV"] + b["y"]) / size)
    return uv, len(charts)
