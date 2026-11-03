"""로컬 모드: 단일 프로세스 제공 + 로컬 서버 보호."""

import pytest
from fastapi.testclient import TestClient

from app.cad.worker_pool import WorkerPool
from app.main import create_app


@pytest.fixture
def local_client(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>AI 3D Studio</title>", encoding="utf-8")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    pool = WorkerPool("tests.fake_jobs", size=1)
    with TestClient(create_app(pool, static_dir=str(tmp_path)), base_url="http://127.0.0.1:8765") as c:
        yield c


def test_serves_frontend_and_api_from_one_process(local_client):
    assert "AI 3D Studio" in local_client.get("/").text
    assert local_client.get("/assets/app.js").status_code == 200
    assert local_client.get("/api/health").json()["status"] == "ok"


def test_unknown_api_path_is_404_not_index_html(local_client):
    r = local_client.get("/api/nope")
    assert r.status_code == 404
    assert "AI 3D Studio" not in r.text


def test_missing_build_fails_fast(tmp_path):
    with pytest.raises(RuntimeError, match="빌드를 찾을 수 없습니다"):
        create_app(static_dir=str(tmp_path))


class TestLocalOnlyProtection:
    def test_dns_rebinding_host_rejected(self, local_client):
        r = local_client.get("/api/health", headers={"host": "evil.example.com"})
        assert r.status_code == 421

    def test_cross_site_origin_rejected(self, local_client):
        r = local_client.post("/api/commands/validate", json={"type": "delete_object", "target": "a"},
                              headers={"origin": "https://evil.example.com"})
        assert r.status_code == 403

    def test_null_origin_rejected(self, local_client):
        r = local_client.get("/api/health", headers={"origin": "null"})
        assert r.status_code == 403

    def test_same_origin_allowed(self, local_client):
        r = local_client.post("/api/commands/validate", json={"type": "delete_object", "target": "a"},
                              headers={"origin": "http://127.0.0.1:8765"})
        assert r.status_code == 200

    def test_non_json_post_rejected(self, local_client):
        """text/plain·form 은 CORS 사전 요청 없이 다른 사이트에서 보낼 수 있으므로 거부."""
        r = local_client.post("/api/commands/validate", content=b'{"type":"x"}', headers={"content-type": "text/plain"})
        assert r.status_code == 415

    @pytest.mark.parametrize("host", ["localhost:8765", "127.0.0.1", "[::1]:8765"])
    def test_loopback_hosts_allowed(self, local_client, host):
        assert local_client.get("/api/health", headers={"host": host}).status_code == 200
