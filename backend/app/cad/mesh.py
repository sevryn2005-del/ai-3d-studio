"""솔리드 → 화면 표시용 RenderMesh (삼각형 메시).

RenderMesh 는 저장하지 않으며 설계 원본에서 언제든 다시 계산할 수 있다.
버퍼는 little-endian Float32(정점) / Uint32(인덱스)를 base64 로 인코딩한다.
"""

from __future__ import annotations

import base64

import cadquery as cq
import numpy as np

# 화면 표시용 정밀도. STL 출력은 별도의 더 높은 정밀도를 사용한다.
DISPLAY_LINEAR_TOLERANCE = 0.05  # mm
DISPLAY_ANGULAR_TOLERANCE = 0.2  # rad (~11°)


def tessellate(
    shape: cq.Shape,
    tolerance: float = DISPLAY_LINEAR_TOLERANCE,
    angular_tolerance: float = DISPLAY_ANGULAR_TOLERANCE,
) -> tuple[np.ndarray, np.ndarray]:
    """(정점 N×3 float32, 삼각형 M×3 uint32). 면마다 정점이 분리되어 모서리가 날카롭게 보인다."""
    vertices, triangles = shape.tessellate(tolerance, angular_tolerance)
    v = np.array([p.toTuple() for p in vertices], dtype="<f4").reshape(-1, 3)
    t = np.array(triangles, dtype="<u4").reshape(-1, 3)
    return v, t


def encode_mesh(vertices: np.ndarray, triangles: np.ndarray) -> dict:
    return {
        "positions": base64.b64encode(vertices.astype("<f4").tobytes()).decode("ascii"),
        "indices": base64.b64encode(triangles.astype("<u4").tobytes()).decode("ascii"),
        "vertexCount": int(len(vertices)),
        "triangleCount": int(len(triangles)),
    }
