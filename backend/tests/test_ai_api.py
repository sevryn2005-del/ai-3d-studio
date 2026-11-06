"""AI API: BYOK 키 보관, 사용량·비용 기록, 오류 처리, 로컬 서버 보호."""

import json
import os
import stat

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient

from app.ai.prompt_builder import APPLY_TOOL
from app.cad.worker_pool import WorkerPool
from app.main import create_app

from .fake_llm import ScriptedClient, response, tool

KEY = "sk-ant-api03-TESTKEY-abcdef1234"
MODEL = {"schemaVersion": 25, "units": "mm", "sketches": [], "objects": [
    {"id": "box_1", "name": "큐브", "kind": "box", "params": {"width": 20, "depth": 20, "height": 20},
     "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}}]}
SET_HEIGHT = {"message": "높이를 50mm로 바꿨습니다.", "commands": [{"type": "set_params", "target": "box_1", "params": {"height": 50}}]}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    calls = {"keys": [], "client": None}

    def factory(key):
        calls["keys"].append(key)
        return calls["client"]

    pool = WorkerPool("tests.fake_jobs", size=1)
    app = create_app(pool, static_dir="", data_dir=tmp_path, llm_factory=factory)
    with TestClient(app, base_url="http://localhost") as c:
        yield c, calls, tmp_path


def chat(c, message="높이를 50mm로 바꿔줘", **extra):
    return c.post("/api/ai/chat", json={"model": MODEL, "selectedId": "box_1", "history": [], "message": message, **extra}).json()


def test_no_key_means_no_api_call(env):
    c, calls, _ = env
    assert c.get("/api/ai/settings").json()["keyConfigured"] is False
    r = chat(c)
    assert r["kind"] == "error" and r["code"] == "no_api_key"
    assert calls["keys"] == []  # 키가 없으면 API 를 부르지 않는다


def test_key_is_stored_privately_and_never_returned(env):
    c, _, data_dir = env
    r = c.put("/api/ai/settings", json={"apiKey": KEY})
    assert r.json()["keyHint"] == "…1234"
    for body in (r.text, c.get("/api/ai/settings").text):
        assert KEY not in body and "TESTKEY" not in body
    path = data_dir / "ai-settings.json"
    assert json.loads(path.read_text())["apiKey"] == KEY
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    # 키 삭제
    assert c.put("/api/ai/settings", json={"clearKey": True}).json()["keyConfigured"] is False


def test_environment_key_is_used_when_not_saved(env, monkeypatch):
    c, _, _ = env
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-env-key-9999")
    view = c.get("/api/ai/settings").json()
    assert (view["keyConfigured"], view["keySource"], view["keyHint"]) == (True, "environment", "…9999")


def test_chat_returns_commands_and_records_cost(env):
    c, calls, data_dir = env
    c.put("/api/ai/settings", json={"apiKey": KEY})
    calls["client"] = ScriptedClient(response(tool(APPLY_TOOL, SET_HEIGHT), input_tokens=2000, output_tokens=300, cache_read=5000))
    r = chat(c)
    assert calls["keys"] == [KEY]
    assert r["kind"] == "commands"
    assert r["commands"] == [{"type": "set_params", "target": "box_1", "params": {"height": 50}}]
    # Opus 5.5: 입력 $4, 출력 $20, 캐시 읽기 $0.20 / 100만 토큰
    expected = (2000 * 4 + 300 * 20 + 5000 * 0.20) / 1e6
    assert r["usage"]["costUsd"] == pytest.approx(expected)
    assert (r["usage"]["inputTokens"], r["usage"]["outputTokens"], r["usage"]["cacheReadTokens"]) == (2000, 300, 5000)
    usage = c.get("/api/ai/usage").json()
    assert usage["month"]["requests"] == 1 and usage["today"]["costUsd"] == pytest.approx(expected)
    assert usage["recent"][0]["kind"] == "commands"
    assert KEY not in (data_dir / "ai-usage.jsonl").read_text()  # 사용량 기록에도 키 없음


def test_user_prices_change_estimate(env):
    c, calls, _ = env
    c.put("/api/ai/settings", json={"apiKey": KEY, "prices": {"claude-opus-5-5": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0}}})
    calls["client"] = ScriptedClient(response(tool(APPLY_TOOL, SET_HEIGHT), input_tokens=1_000_000, output_tokens=1_000_000))
    assert chat(c)["usage"]["costUsd"] == pytest.approx(2.0)


def test_model_choice(env):
    c, calls, _ = env
    assert c.put("/api/ai/settings", json={"model": "gpt-9"}).json()["ok"] is False
    c.put("/api/ai/settings", json={"apiKey": KEY, "model": "claude-haiku-5-5"})
    calls["client"] = ScriptedClient(response(tool(APPLY_TOOL, SET_HEIGHT)))
    chat(c)
    assert calls["client"].requests[0]["model"] == "claude-haiku-5-5"


def test_disabled(env):
    c, calls, _ = env
    c.put("/api/ai/settings", json={"apiKey": KEY, "enabled": False})
    assert chat(c)["code"] == "ai_disabled" and calls["keys"] == []


@pytest.mark.parametrize(
    "exc,code",
    [
        (lambda: anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com")), "offline"),
        (lambda: anthropic.AuthenticationError("bad key", response=httpx2.Response(401, request=httpx2.Request("POST", "https://x")), body=None), "auth"),
        (lambda: anthropic.RateLimitError("slow", response=httpx2.Response(429, request=httpx2.Request("POST", "https://x")), body=None), "rate_limited"),
    ],
)
def test_api_errors_are_explained(env, exc, code):
    c, calls, _ = env
    c.put("/api/ai/settings", json={"apiKey": KEY})

    class Failing:
        def create(self, **_):
            raise exc()

    calls["client"] = Failing()
    r = chat(c)
    assert r["kind"] == "error" and r["code"] == code


def test_invalid_model_rejected_before_api_call(env):
    c, calls, _ = env
    c.put("/api/ai/settings", json={"apiKey": KEY})
    bad = {**MODEL, "objects": [{**MODEL["objects"][0], "params": {"width": -1, "depth": 1, "height": 1}}]}
    assert chat(c, model=bad)["code"] == "invalid_model"
    assert calls["keys"] == []


def test_other_websites_cannot_spend_the_users_key(env):
    """다른 사이트의 페이지가 사용자의 로컬 서버로 AI 요청을 보내 요금을 발생시킬 수 없다."""
    c, calls, _ = env
    c.put("/api/ai/settings", json={"apiKey": KEY})
    body = {"model": MODEL, "message": "x"}
    assert c.post("/api/ai/chat", json=body, headers={"origin": "https://evil.example"}).status_code == 403
    assert c.post("/api/ai/chat", content=json.dumps(body), headers={"content-type": "text/plain"}).status_code == 415
    assert calls["keys"] == []
