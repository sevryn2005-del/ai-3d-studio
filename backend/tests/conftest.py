import json
import os
import tempfile
from pathlib import Path

# 테스트가 사용자의 실제 AI 설정·사용량 파일을 건드리지 않도록 임시 데이터 폴더를 쓴다
os.environ["AI3D_DATA_DIR"] = tempfile.mkdtemp(prefix="ai3d-test-")

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "shared" / "schemas"


def load_json(name: str):
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def client():
    """실제 CadQuery 워커를 사용하는 앱. 워커 시작(수 초)을 세션 동안 한 번만 한다."""
    with TestClient(create_app(static_dir=""), base_url="http://localhost") as c:
        yield c


@pytest.fixture
def default_model() -> dict:
    return {
        "schemaVersion": 24,
        "units": "mm",
        "sketches": [],
        "objects": [
            {
                "id": "box_1",
                "name": "큐브",
                "kind": "box",
                "params": {"width": 20, "depth": 20, "height": 20},
                "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]},
            }
        ],
    }
