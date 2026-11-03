import base64

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.cad.worker_pool import WorkerPool
from app.main import create_app


def decode_mesh(mesh: dict) -> tuple[np.ndarray, np.ndarray]:
    v = np.frombuffer(base64.b64decode(mesh["positions"]), dtype="<f4").reshape(-1, 3)
    t = np.frombuffer(base64.b64decode(mesh["indices"]), dtype="<u4").reshape(-1, 3)
    assert len(v) == mesh["vertexCount"] and len(t) == mesh["triangleCount"]
    return v, t


def test_health(client, default_model):
    client.post("/api/model/evaluate", json=default_model)  # 워커 준비 대기
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["cadEngine"].startswith("cadquery 2.")


class TestValidateCommand:
    def test_valid_command_is_normalized(self, client):
        r = client.post(
            "/api/commands/validate",
            json={"type": "rename_object", "target": "box_1", "name": "  뚜껑  "},
        )
        body = r.json()
        assert r.status_code == 200
        assert body == {
            "ok": True,
            "issues": [],
            "command": {"type": "rename_object", "target": "box_1", "name": "뚜껑"},
        }

    def test_height_50(self, client):
        r = client.post(
            "/api/commands/validate",
            json={"type": "set_params", "target": "box_1", "params": {"height": 50}},
        )
        assert r.json()["command"] == {"type": "set_params", "target": "box_1", "params": {"height": 50}}

    def test_out_of_range_returns_korean_issue_with_path(self, client):
        r = client.post(
            "/api/commands/validate",
            json={"type": "set_params", "target": "box_1", "params": {"height": -3}},
        )
        body = r.json()
        assert r.status_code == 200
        assert body["ok"] is False
        assert body["issues"] == [
            {"path": "params.height", "message": "0.1 이상이어야 합니다", "severity": "error"}
        ]

    def test_unknown_command(self, client):
        body = client.post("/api/commands/validate", json={"type": "exec_python", "code": "x"}).json()
        assert body["ok"] is False
        assert "알 수 없는 유형" in body["issues"][0]["message"]

    def test_non_object_body(self, client):
        body = client.post("/api/commands/validate", json=[1, 2, 3]).json()
        assert body["ok"] is False


class TestEvaluateModel:
    def test_ok_returns_mesh(self, client, default_model):
        body = client.post("/api/model/evaluate", json=default_model).json()
        assert body["ok"] is True and body["issues"] == [] and body["objectCount"] == 1
        assert [m["objectId"] for m in body["meshes"]] == ["box_1"]
        v, t = decode_mesh(body["meshes"][0])
        assert len(t) == 12  # 박스 = 6면 × 삼각형 2개
        assert t.max() < len(v)

    def test_height_50_reaches_real_geometry(self, client, default_model):
        """첫 번째 목표의 백엔드 절반: 높이 50 → CadQuery 메시의 실제 높이가 50mm."""
        default_model["objects"][0]["params"]["height"] = 50
        body = client.post("/api/model/evaluate", json=default_model).json()
        v, _ = decode_mesh(body["meshes"][0])
        np.testing.assert_allclose(v.min(axis=0), [-10, -10, 0], atol=1e-4)
        np.testing.assert_allclose(v.max(axis=0), [10, 10, 50], atol=1e-4)

    def test_mesh_is_in_local_coordinates(self, client, default_model):
        """메시는 객체 로컬 좌표 → 이동/회전은 화면에서 적용 (서버 재계산 불필요)."""
        default_model["objects"][0]["transform"] = {"position": [100, 0, 0], "rotation": [0, 0, 45]}
        v, _ = decode_mesh(client.post("/api/model/evaluate", json=default_model).json()["meshes"][0])
        np.testing.assert_allclose(v.min(axis=0), [-10, -10, 0], atol=1e-4)

    @pytest.mark.parametrize(
        "kind,params,top",
        [
            ("cylinder", {"radius": 5, "height": 30}, 30),
            ("sphere", {"radius": 10}, 20),
            ("cone", {"radiusBottom": 10, "radiusTop": 0, "height": 20}, 20),
        ],
    )
    def test_curved_primitives(self, client, default_model, kind, params, top):
        default_model["objects"][0].update(kind=kind, params=params, id=f"{kind}_1")
        body = client.post("/api/model/evaluate", json=default_model).json()
        assert body["ok"], body["issues"]
        v, _ = decode_mesh(body["meshes"][0])
        assert v[:, 2].min() == pytest.approx(0, abs=1e-4)
        assert v[:, 2].max() == pytest.approx(top, abs=0.06)  # 표시용 허용 오차 0.05mm

    def test_duplicate_ids(self, client, default_model):
        default_model["objects"].append(default_model["objects"][0])
        body = client.post("/api/model/evaluate", json=default_model).json()
        assert body["ok"] is False
        assert [i["path"] for i in body["issues"]] == ["objects.0.id", "objects.1.id"]

    def test_schema_error_path(self, client, default_model):
        default_model["objects"][0]["params"]["width"] = 0
        body = client.post("/api/model/evaluate", json=default_model).json()
        assert body["ok"] is False
        assert body["issues"][0]["path"] == "objects.0.params.width"

    def test_too_many_objects(self, client, default_model):
        obj = default_model["objects"][0]
        default_model["objects"] = [{**obj, "id": f"box_{i}"} for i in range(1001)]
        body = client.post("/api/model/evaluate", json=default_model).json()
        assert body["ok"] is False
        assert "1000개 이하" in body["issues"][0]["message"]


def test_body_size_limit(client):
    r = client.post(
        "/api/model/evaluate",
        content=b"{" + b" " * 1_100_000 + b"}",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413
    assert "너무 큽니다" in r.json()["detail"]


def test_body_size_limit_without_content_length(client):
    def chunks():
        for _ in range(20):
            yield b" " * 100_000

    r = client.post("/api/model/evaluate", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_engine_timeout_is_reported_as_issue(default_model):
    """CAD 연산이 멈춰도 API 는 응답하고, 다음 요청은 새 워커로 처리된다."""
    pool = WorkerPool("tests.fake_cad_jobs", size=1, job_timeout=0.5)
    with TestClient(create_app(pool, static_dir=""), base_url="http://localhost") as c:
        default_model["objects"][0]["name"] = "hang"
        body = c.post("/api/model/evaluate", json=default_model).json()
        assert body["ok"] is False
        assert "제한 시간" in body["issues"][0]["message"]

        default_model["objects"][0]["name"] = "ok"
        assert c.post("/api/model/evaluate", json=default_model).json()["ok"] is True
