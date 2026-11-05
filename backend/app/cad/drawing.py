"""도면 투상 (숨은선 제거, OCCT HLRBRep_Algo) — 브라우저 occt/occtDrawing.ts 와 같은 호출·같은 규칙.

보기 방향 표(VIEWS)는 frontend/src/features/drawing/views.ts 와 같다 (toward = 보는 사람 쪽, right = 보기 오른쪽).
결과: 보기마다 보이는 선·숨은선 꺾은선 [x0, y0, x1, y1, …] (보기 평면 mm), 정면으로 보이는 원, 보이는 선 범위.
숨은선은 보이는 선·앞서 남긴 숨은선과 같은 직선 위에서 겹치는 부분을 지운다 (clean_hidden ↔ features/drawing/clean.ts).
"""

from __future__ import annotations

import math
from typing import Any

from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepLib import BRepLib
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Line
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

S2 = math.sqrt(0.5)
S3 = 1 / math.sqrt(3)
VIEWS: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]] = {
    "front": ((0, -1, 0), (1, 0, 0)),
    "top": ((0, 0, 1), (1, 0, 0)),
    "right": ((1, 0, 0), (0, 1, 0)),
    "iso": ((S3, -S3, S3), (S2, S2, 0)),
}
ARC_STEP = math.pi / 48
SPLINE_SEGMENTS = 64


def _round(v: float) -> float:
    return round(v, 6) + 0.0


def _polylines(s, circles: list | None, visible: bool) -> list[list[float]]:
    if s is None or s.IsNull():
        return []
    BRepLib.BuildCurves3d_s(s)
    out = []
    ex = TopExp_Explorer(s, TopAbs_EDGE)
    while ex.More():
        e = TopoDS.Edge_s(ex.Current())
        ex.Next()
        a = BRepAdaptor_Curve(e)
        t = a.GetType()
        u0, u1 = a.FirstParameter(), a.LastParameter()
        n = 1 if t == GeomAbs_Line else max(4, math.ceil(abs(u1 - u0) / ARC_STEP)) if t == GeomAbs_Circle else SPLINE_SEGMENTS
        pts: list[float] = []
        for i in range(n + 1):
            p = a.Value(u0 + (u1 - u0) * i / n)
            pts += [_round(p.X()), _round(p.Y())]
        if len(pts) >= 4 and math.hypot(pts[-2] - pts[0], pts[-1] - pts[1]) + abs(u1 - u0) > 1e-9:
            out.append(pts)
        if circles is not None and t == GeomAbs_Circle:
            c = a.Circle()
            o = c.Location()
            circles.append({"center": [_round(o.X()), _round(o.Y())], "radius": _round(c.Radius()),
                            "full": abs(abs(u1 - u0) - 2 * math.pi) < 1e-6, "visible": visible})
    return out


CLEAN_TOLERANCE = 1e-3


def _segments(lines):
    return [(line[i - 2], line[i - 1], line[i], line[i + 1]) for line in lines for i in range(2, len(line) - 1, 2)]


def _uncovered(s, cover, tol):
    px, py, qx, qy = s
    length = math.hypot(qx - px, qy - py)
    if length < tol:
        return []
    dx, dy = (qx - px) / length, (qy - py) / length
    iv = []
    for ax, ay, bx, by in cover:
        if max(ax, bx) < min(px, qx) - tol or min(ax, bx) > max(px, qx) + tol:
            continue
        if max(ay, by) < min(py, qy) - tol or min(ay, by) > max(py, qy) + tol:
            continue
        if abs((ax - px) * dy - (ay - py) * dx) > tol or abs((bx - px) * dy - (by - py) * dx) > tol:
            continue
        ta = (ax - px) * dx + (ay - py) * dy
        tb = (bx - px) * dx + (by - py) * dy
        lo, hi = max(0.0, min(ta, tb)), min(length, max(ta, tb))
        if hi - lo > tol:
            iv.append((lo, hi))
    iv.sort()
    out, at = [], 0.0
    for lo, hi in iv:
        if lo - at > tol:
            out.append((at, lo))
        at = max(at, hi)
    if length - at > tol:
        out.append((at, length))
    return out


def clean_hidden(visible, hidden, tol: float = CLEAN_TOLERANCE) -> list[list[float]]:
    cover = _segments(visible)
    out: list[list[float]] = []
    for line in hidden:
        start = len(out)
        cur = None
        for i in range(2, len(line) - 1, 2):
            s = (line[i - 2], line[i - 1], line[i], line[i + 1])
            length = math.hypot(s[2] - s[0], s[3] - s[1])
            keep = _uncovered(s, cover, tol)
            for t0, t1 in keep:
                ax, ay = s[0] + (s[2] - s[0]) * t0 / length, s[1] + (s[3] - s[1]) * t0 / length
                bx, by = s[0] + (s[2] - s[0]) * t1 / length, s[1] + (s[3] - s[1]) * t1 / length
                if cur and math.hypot(cur[-2] - ax, cur[-1] - ay) < tol:
                    cur += [bx, by]
                else:
                    if cur:
                        out.append(cur)
                    cur = [ax, ay, bx, by]
            if not keep or keep[-1][1] < length - tol:
                if cur:
                    out.append(cur)
                cur = None
        if cur:
            out.append(cur)
        cover += _segments(out[start:])
    return [[_round(v) for v in line] for line in out]


def bounds_of(lines: list[list[float]]) -> list[float]:
    xs = [v for line in lines for v in line[0::2]]
    ys = [v for line in lines for v in line[1::2]]
    return [min(xs), min(ys), max(xs), max(ys)] if xs else [0.0, 0.0, 0.0, 0.0]


def dedupe_circles(cs: list[dict]) -> list[dict]:
    """같은 원이 여러 조각으로 나오면 하나로 (occtDrawing.ts dedupeCircles 와 같음)"""
    out: list[dict] = []
    for c in cs:
        same = next((o for o in out if math.hypot(o["center"][0] - c["center"][0], o["center"][1] - c["center"][1]) < 1e-4
                     and abs(o["radius"] - c["radius"]) < 1e-4), None)
        if same is None:
            out.append({**c, "_arcs": 1})
        else:
            same["_arcs"] += 1
            same["visible"] = same["visible"] or c["visible"]
            same["full"] = same["full"] or c["full"] or same["_arcs"] >= 2
    return [{k: v for k, v in c.items() if k != "_arcs"} for c in out]


def project(shapes: list, views: list[str]) -> list[dict[str, Any]]:
    """월드 형상들 → 보기마다 투상 (서로 가리는 선도 숨은선으로)"""
    result = []
    for name in views:
        toward, right = VIEWS[name]
        algo = HLRBRep_Algo()
        for s in shapes:
            algo.Add(s, 0)
        algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*toward), gp_Dir(*right))))
        algo.Update()
        algo.Hide()
        res = HLRBRep_HLRToShape(algo)
        circles: list[dict] = []
        visible = _polylines(res.VCompound(), circles, True) + _polylines(res.OutLineVCompound(), circles, True)
        hidden = _polylines(res.HCompound(), circles, False) + _polylines(res.OutLineHCompound(), circles, False)
        result.append({"name": name, "visible": visible, "hidden": clean_hidden(visible, hidden), "circles": dedupe_circles(circles), "bounds": bounds_of(visible)})
    return result
