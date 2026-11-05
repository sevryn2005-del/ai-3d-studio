"""도면 투상 (숨은선 제거, OCCT HLRBRep_Algo) — 브라우저 occt/occtDrawing.ts 와 같은 호출·같은 규칙.

보기 방향 표(VIEWS)는 frontend/src/features/drawing/views.ts 와 같다 (toward = 보는 사람 쪽, right = 보기 오른쪽).
결과: 보기마다 보이는 선·숨은선 꺾은선 [x0, y0, x1, y1, …] (보기 평면 mm), 정면으로 보이는 원, 원통 축선, 보이는 선 범위.
단면도 (형식 v14): 정면 = 평면 y = offset 앞쪽을, 우측면 = 평면 x = offset 오른쪽을 걷어내고 투상, 숨은선 없음,
잘린 면(절단 평면 위의 평면) 경계를 section 으로 (해칭은 프론트엔드 시트).
숨은선은 보이는 선·앞서 남긴 숨은선과 같은 직선 위에서 겹치는 부분을 지운다 (clean_hidden ↔ features/drawing/clean.ts).
"""

from __future__ import annotations

import math
from typing import Any

from OCP.Bnd import Bnd_Box
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepLib import BRepLib
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Line, GeomAbs_Plane
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.GProp import GProp_GProps
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
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


def _explore(s, kind):
    ex = TopExp_Explorer(s, kind)
    while ex.More():
        yield TopoDS.Edge_s(ex.Current()) if kind == TopAbs_EDGE else TopoDS.Face_s(ex.Current())
        ex.Next()


def _samples(e):
    """모서리 위 점 (occtDrawing.ts edgeSamples 와 같은 표본) → (점, 종류, 어댑터)"""
    a = BRepAdaptor_Curve(e)
    t = a.GetType()
    u0, u1 = a.FirstParameter(), a.LastParameter()
    n = 1 if t == GeomAbs_Line else max(4, math.ceil(abs(u1 - u0) / ARC_STEP)) if t == GeomAbs_Circle else SPLINE_SEGMENTS
    pts = []
    for i in range(n + 1):
        p = a.Value(u0 + (u1 - u0) * i / n)
        pts.append((p.X(), p.Y(), p.Z()))
    return pts, t, a


def _polylines(s, circles: list | None, visible: bool) -> list[list[float]]:
    if s is None or s.IsNull():
        return []
    BRepLib.BuildCurves3d_s(s)
    out = []
    for e in _explore(s, TopAbs_EDGE):
        raw, t, a = _samples(e)
        u0, u1 = a.FirstParameter(), a.LastParameter()
        pts: list[float] = [v for p in raw for v in (_round(p[0]), _round(p[1]))]
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


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _bounds(shapes) -> list[float]:
    b = Bnd_Box()
    for s in shapes:
        BRepBndLib.AddOptimal_s(s, b, False, False)
    return list(b.Get())


def _volume(s) -> float:
    p = GProp_GProps()
    BRepGProp.VolumeProperties_s(s, p)
    return p.Mass()


def _section_box(bounds, sec):
    """걷어낼 쪽 상자 (모델 범위보다 1mm 크게). 걷어낼 것이 없으면 None (occtDrawing.ts sectionBox)"""
    x0, y0, z0, x1, y1, z1 = bounds[0] - 1, bounds[1] - 1, bounds[2] - 1, bounds[3] + 1, bounds[4] + 1, bounds[5] + 1
    lo, hi = ((x0, y0, z0), (x1, sec["offset"], z1)) if sec["view"] == "front" else ((sec["offset"], y0, z0), (x1, y1, z1))
    if hi[0] - lo[0] < 1e-9 or hi[1] - lo[1] < 1e-9:
        return None
    return BRepPrimAPI_MakeBox(gp_Pnt(*lo), gp_Pnt(*hi)).Shape()


def _section_lines(s, sec, proj) -> list[list[float]]:
    axis = (0, 1, 0) if sec["view"] == "front" else (1, 0, 0)
    out = []
    for f in _explore(s, TopAbs_FACE):
        a = BRepAdaptor_Surface(f, True)
        if a.GetType() != GeomAbs_Plane:
            continue
        ax = a.Plane().Axis()
        d, o = ax.Direction(), ax.Location()
        if abs(_dot((d.X(), d.Y(), d.Z()), axis)) < 1 - 1e-9 or abs(_dot((o.X(), o.Y(), o.Z()), axis) - sec["offset"]) > 1e-6:
            continue
        for e in _explore(f, TopAbs_EDGE):
            out.append([_round(v) for p in _samples(e)[0] for v in proj(p)])
    return out


def _cylinder_axes(shapes, toward, proj) -> list[list[float]]:
    out: list[list[float]] = []
    for s in shapes:
        for f in _explore(s, TopAbs_FACE):
            a = BRepAdaptor_Surface(f, True)
            if a.GetType() != GeomAbs_Cylinder:
                continue
            ax = a.Cylinder().Axis()
            d = (ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z())
            o = (ax.Location().X(), ax.Location().Y(), ax.Location().Z())
            if abs(_dot(d, toward)) > 0.999:
                continue
            ts = [_dot((p[0] - o[0], p[1] - o[1], p[2] - o[2]), d) for e in _explore(f, TopAbs_EDGE) for p in _samples(e)[0]]
            if not ts or max(ts) - min(ts) <= 1e-6:
                continue
            t0, t1 = min(ts), max(ts)
            seg = [_round(v) for v in (*proj(tuple(o[k] + d[k] * t0 for k in range(3))), *proj(tuple(o[k] + d[k] * t1 for k in range(3))))]
            if math.hypot(seg[2] - seg[0], seg[3] - seg[1]) < 1e-6:
                continue

            def same(q, seg=seg):
                fwd = math.hypot(q[0] - seg[0], q[1] - seg[1]) < 1e-4 and math.hypot(q[2] - seg[2], q[3] - seg[3]) < 1e-4
                rev = math.hypot(q[0] - seg[2], q[1] - seg[3]) < 1e-4 and math.hypot(q[2] - seg[0], q[3] - seg[1]) < 1e-4
                return fwd or rev

            if not any(same(q) for q in out):
                out.append(seg)
    return out


def project(shapes: list, views: list[str], section: dict | None = None) -> list[dict[str, Any]]:
    """월드 형상들 → 보기마다 투상 (서로 가리는 선도 숨은선으로)"""
    from app.cad.primitives import GeometryError

    bounds = _bounds(shapes)
    result = []
    for name in views:
        toward, right = VIEWS[name]
        up = _cross(toward, right)

        def proj(p, right=right, up=up):
            return (_dot(p, right), _dot(p, up))

        sec = section if section and section["view"] == name else None
        view_shapes = shapes
        if sec:
            box = _section_box(bounds, sec)
            if box is not None:
                view_shapes = [r for r in (BRepAlgoAPI_Cut(s, box).Shape() for s in shapes) if _volume(r) > 1e-9]
            if not view_shapes:
                raise GeometryError("단면 위치가 형상 밖입니다 (자른 뒤 남는 것이 없음)")
        algo = HLRBRep_Algo()
        for s in view_shapes:
            algo.Add(s, 0)
        algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*toward), gp_Dir(*right))))
        algo.Update()
        algo.Hide()
        res = HLRBRep_HLRToShape(algo)
        circles: list[dict] = []
        visible = clean_hidden([], _polylines(res.VCompound(), circles, True) + _polylines(res.OutLineVCompound(), circles, True))
        hidden_raw = _polylines(res.HCompound(), circles, False) + _polylines(res.OutLineHCompound(), circles, False)
        view = {
            "name": name,
            "visible": visible,
            "hidden": [] if sec else clean_hidden(visible, hidden_raw),
            "circles": dedupe_circles([c for c in circles if c["visible"]] if sec else circles),
            "axes": _cylinder_axes(view_shapes, toward, proj),
            "bounds": bounds_of(visible),
        }
        if sec:
            view["section"] = [line for s in view_shapes for line in _section_lines(s, sec, proj)]
        result.append(view)
    return result
