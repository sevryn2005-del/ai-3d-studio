"""판금 (형식 v45) — 프론트 cad/sheetMetal.ts 와 같은 규칙.

바닥 판 + 네 변 90° 플랜지 (바깥 치수 width×depth, 플랜지 바깥 높이, 안쪽 굽힘 반지름 r, 두께 t).
바닥 평판은 플랜지 있는 변에서 a = r + t 안쪽까지, 플랜지는 바닥 평판 길이만큼 (모서리는 열린 릴리프).
"""

from __future__ import annotations

import math
from typing import Any

SIDES = ("PX", "NX", "PY", "NY")


def _flange(p: Any, side: str) -> float:
    return float(getattr(p, f"flange{side}"))


def sheet_base(p: Any) -> tuple[float, float, float, float]:
    a = p.bendRadius + p.thickness
    return (
        -p.width / 2 + (a if p.flangeNX > 0 else 0),
        p.width / 2 - (a if p.flangePX > 0 else 0),
        -p.depth / 2 + (a if p.flangeNY > 0 else 0),
        p.depth / 2 - (a if p.flangePY > 0 else 0),
    )


def sheet_error(p: Any) -> str | None:
    """sheetMetal.ts sheetError 와 같은 검사·메시지"""
    a = p.bendRadius + p.thickness
    for s in SIDES:
        h = _flange(p, s)
        if 0 < h <= a + 0.01:
            return f"플랜지 높이는 0(없음)이거나 굽힘 바깥 반지름({round(a, 3):g}mm)보다 커야 합니다"
    x0, x1, y0, y1 = sheet_base(p)
    if x1 - x0 < 0.1 or y1 - y0 < 0.1:
        return "바닥 평판이 남지 않습니다 (폭·깊이를 늘리거나 굽힘 반지름을 줄이세요)"
    return None


def flange_frames(p: Any) -> list[dict]:
    """변마다 (원점, u = 바깥쪽, s = 길이 방향 = u × Z, 길이) — sheetMetal.ts flangeFrames 와 같음"""
    x0, x1, y0, y1 = sheet_base(p)
    out = []
    if p.flangePX > 0:
        out.append({"side": "PX", "origin": (x1, y1, 0), "u": (1, 0, 0), "s": (0, -1, 0), "length": y1 - y0})
    if p.flangeNX > 0:
        out.append({"side": "NX", "origin": (x0, y0, 0), "u": (-1, 0, 0), "s": (0, 1, 0), "length": y1 - y0})
    if p.flangePY > 0:
        out.append({"side": "PY", "origin": (x0, y1, 0), "u": (0, 1, 0), "s": (1, 0, 0), "length": x1 - x0})
    if p.flangeNY > 0:
        out.append({"side": "NY", "origin": (x1, y0, 0), "u": (0, -1, 0), "s": (-1, 0, 0), "length": x1 - x0})
    return out


def sheet_volume(p: Any) -> float:
    x0, x1, y0, y1 = sheet_base(p)
    r, t = p.bendRadius, p.thickness
    a = r + t
    v = (x1 - x0) * (y1 - y0) * t
    for f in flange_frames(p):
        v += f["length"] * (math.pi / 4 * (a * a - r * r) + t * (_flange(p, f["side"]) - a))
    return v
