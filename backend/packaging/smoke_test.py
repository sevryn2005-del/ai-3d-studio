"""묶음 엔진(사이드카) 스모크 테스트: 실행 → 상태 확인 → 기준 판 계산 → STL 내보내기 →
공유 픽스처 전체(헬릭스·스플라인·영역·필렛·STEP 가져오기 …)를 묶인 엔진으로 계산해 부피 대조 →
도면(숨은선·단면)·위상·간섭 API → 부모 종료 시 함께 종료.
묶음(PyInstaller)이 새로 쓰는 OCCT 모듈을 빠뜨리면 여기서 드러난다 (개발 환경 pytest 로는 알 수 없음).

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


def stl_volume(stl: bytes) -> float:
    count = struct.unpack_from("<I", stl, 80)[0]
    vol = 0.0
    for i in range(count):
        a, b, c = (struct.unpack_from("<3f", stl, 84 + i * 50 + 12 + v * 12) for v in range(3))
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    return vol


def shared_cases(base: str) -> None:
    """공유 픽스처: 묶인 엔진의 STL 부피가 해석값과 같은지 (tests/test_features.py 와 같은 기준 3e-3)"""
    cases = json.loads((ROOT / "shared/schemas/examples/feature-cases.json").read_text(encoding="utf-8"))
    bad = []
    t0 = time.time()
    for name, case in cases.items():
        try:
            status, stl, _ = request(f"{base}/api/export/stl", case["model"])
            vol = stl_volume(stl)
            if status != 200 or abs(vol - case["volume"]) / case["volume"] > 3e-3:
                bad.append(f"{name}: 부피 {vol:.3f} ≠ {case['volume']:.3f}")
        except Exception as e:  # noqa: BLE001 — 실패 목록으로 모아 한 번에 보여 준다
            bad.append(f"{name}: {e}")
    assert not bad, "공유 픽스처 실패:\n" + "\n".join(bad)
    print(f"공유 픽스처 {len(cases)}가지 ✓ {time.time() - t0:.1f}초")

    drawings = json.loads((ROOT / "shared/schemas/examples/drawing-cases.json").read_text(encoding="utf-8"))
    for name, case in drawings.items():
        names = [n for n in case["views"] if not n.startswith("aux")]  # 보조 투상도는 aux 방향으로 따로 요청
        body = {"model": case["model"], "views": names, **({"section": case["section"]} if "section" in case else {}), **({"aux": case["aux"]} if "aux" in case else {})}
        _, data, _ = request(f"{base}/api/model/drawing", body)
        r = json.loads(data)
        assert r["ok"] and len(r["views"]) == len(case["views"]), (name, r.get("issues"))
        for v in r["views"]:
            exp = case["views"][v["name"]]["bounds"]
            assert all(abs(a - b) < 1e-3 for a, b in zip(v["bounds"], exp)), (name, v["name"], v["bounds"], exp)
    print(f"도면 {len(drawings)}가지 ✓ (숨은선·단면·보조 투상도)")

    model = cases["fillet-box-all"]["model"]  # 정밀 피처(필렛)의 B-rep 면·모서리
    oid = model["objects"][-1]["id"]
    _, data, _ = request(f"{base}/api/model/topology", {"model": model, "id": oid})
    topo = json.loads(data)
    assert topo["ok"] and topo["faces"] and topo["edges"], topo.get("issues")
    assembly = json.loads((ROOT / "shared/schemas/examples/model-assembly.json").read_text(encoding="utf-8"))
    _, data, _ = request(f"{base}/api/model/interference", assembly)
    assert json.loads(data)["ok"]
    print(f"위상({len(topo['faces'])}면·{len(topo['edges'])}모서리)·간섭 ✓")


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

        shared_cases(base)

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
