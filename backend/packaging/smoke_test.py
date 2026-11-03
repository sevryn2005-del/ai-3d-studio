"""묶음 엔진(사이드카) 스모크 테스트: 실행 → 상태 확인 → 기준 판 계산 → STL 내보내기 → 부모 종료 시 함께 종료.

  python packaging/smoke_test.py <ai3d-engine 실행 파일 경로>

표준 라이브러리만 사용한다 (CI 에서 묶음과 별개로 실행).
"""

from __future__ import annotations

import json
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def request(url: str, body: dict | None = None, timeout: float = 120) -> tuple[int, bytes, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(), dict(r.headers)


def main(exe: str) -> int:
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    # 부모 역할을 할 짧게 사는 프로세스 → 엔진이 함께 종료되는지 확인
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    t0 = time.time()
    engine = subprocess.Popen([exe, "--port", str(port), "--no-browser", "--parent-pid", str(parent.pid)])
    try:
        while True:
            try:
                status, body, _ = request(f"{base}/api/health", timeout=2)
                health = json.loads(body)
                break  # API 응답 (CAD 워커는 첫 계산 때 준비를 기다린다)
            except OSError:
                pass
            if engine.poll() is not None:
                raise SystemExit(f"엔진이 종료됨 (코드 {engine.returncode})")
            if time.time() - t0 > 180:
                raise SystemExit("엔진 준비 시간 초과 (180초)")
            time.sleep(1)
        print(f"준비됨 {time.time() - t0:.1f}초: {health}")

        _, html, _ = request(f"{base}/")
        assert b"<div id=\"root\">" in html or b"id=\"root\"" in html, "프론트엔드가 제공되지 않음"

        model = json.loads((ROOT / "shared/schemas/examples/model-sketch-plate.json").read_text(encoding="utf-8"))
        _, body, _ = request(f"{base}/api/model/evaluate", model)
        result = json.loads(body)
        assert result["ok"], result
        assert [m["objectId"] for m in result["meshes"]] == ["plate_holed"]
        print(f"계산 ✓ {result['computeMs']}ms, 삼각형 {result['meshes'][0]['triangleCount']}")

        _, stl, headers = request(f"{base}/api/export/stl", model)
        count = struct.unpack_from("<I", stl, 80)[0]
        assert len(stl) == 84 + count * 50
        zs = [struct.unpack_from("<f", stl, 84 + i * 50 + 12 + v * 12 + 8)[0] for i in range(count) for v in range(3)]
        xs = [struct.unpack_from("<f", stl, 84 + i * 50 + 12 + v * 12)[0] for i in range(count) for v in range(3)]
        assert abs(min(zs)) < 1e-4 and abs(max(zs) - 4) < 1e-4 and abs(min(xs) + 40) < 1e-4 and abs(max(xs) - 40) < 1e-4
        print(f"STL ✓ 삼각형 {count}, 80×40×4")

        for fmt in ("3mf", "step", "glb"):
            status, data, _ = request(f"{base}/api/export/{fmt}", model)
            assert status == 200 and len(data) > 100, fmt
        print("3MF·STEP·GLB ✓")

        parent.kill()
        parent.wait()
        engine.wait(timeout=15)
        print("부모 종료 → 엔진 종료 ✓")
        return 0
    finally:
        parent.kill()
        if engine.poll() is None:
            engine.kill()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
