"""가져온 메시 데이터 (형식 v8): base64 Float32/Uint32 리틀엔디안 해석·검사.

CadQuery 를 쓰지 않는다 → API 프로세스(검증)에서도 import 할 수 있다. 솔리드 변환은 mesh_import.py (워커 전용).
"""

from __future__ import annotations

import base64

import numpy as np


def decode(positions: str, indices: str) -> tuple[np.ndarray, np.ndarray]:
    v = np.frombuffer(base64.b64decode(positions), dtype="<f4").astype(np.float64).reshape(-1, 3)
    t = np.frombuffer(base64.b64decode(indices), dtype="<u4").astype(np.int64).reshape(-1, 3)
    return v, t


def mesh_error(positions: str, indices: str, max_triangles: int) -> str | None:
    try:
        v, t = decode(positions, indices)
    except Exception:
        return "메시 데이터가 올바르지 않습니다"
    if len(t) < 4:
        return "메시 삼각형이 4개 이상이어야 합니다"
    if len(t) > max_triangles:
        return f"메시 삼각형은 최대 {max_triangles:,}개까지 가능합니다"
    if t.size and t.max() >= len(v):
        return "메시 삼각형이 없는 정점을 가리킵니다"
    if not np.isfinite(v).all() or np.abs(v).max() > 10_000:
        return "메시 좌표가 허용 범위를 벗어납니다"
    return None


def polymesh_error(verts: list, faces: list[list[int]]) -> str | None:
    """편집 메시 (형식 v20) 검사 — 프론트 cad/polymesh.ts polyMeshError 와 같은 규칙"""
    n = len(verts)
    for fi, f in enumerate(faces):
        if len(f) < 3:
            return f"면 {fi} 의 점이 3개보다 적습니다"
        if len(set(f)) != len(f):
            return f"면 {fi} 에 같은 점이 두 번 있습니다"
        if any(v < 0 or v >= n for v in f):
            return f"면 {fi} 가 없는 점을 가리킵니다"
    return None
