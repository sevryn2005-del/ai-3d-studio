"""AI 명령 평가 실행기.

  uv run python -m evals.run --replay                  # 녹화된 응답으로 채점 (비용 없음)
  uv run python -m evals.run --live --record --yes     # 실제 API 호출 + 녹화 (비용 발생, 사용자 키 필요)
  uv run python -m evals.run --live --yes --case hole-6mm

실제 API 는 --live 와 --yes 가 모두 있을 때만 호출한다. 키는 AI 설정 파일 또는 ANTHROPIC_API_KEY.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from app.ai.chat import ChatResult, run_chat
from app.ai.config_store import ConfigStore, default_data_dir, estimate_cost
from app.ai.llm_client import AnthropicClient
from app.cad.commands import ModelDefinition

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT.parents[1] / "shared" / "schemas" / "examples"
DEFAULT_OBJECTS = [{"id": "box_1", "name": "큐브", "kind": "box", "params": {"width": 20, "depth": 20, "height": 20},
                    "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}}]
NUM_TOL = 1e-6


# ---- 케이스 ----------------------------------------------------------------------

def load_cases(path: Path = ROOT / "cases.json") -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def case_model(case: dict[str, Any]) -> ModelDefinition:
    objs = case.get("objects", "default")
    if objs == "default":
        objs = DEFAULT_OBJECTS
    elif objs == "empty":
        objs = []
    elif isinstance(objs, str) and objs.startswith("fixture:"):
        return ModelDefinition.model_validate(json.loads((FIXTURES / objs.removeprefix("fixture:")).read_text(encoding="utf-8")))
    return ModelDefinition.model_validate({"schemaVersion": 44, "units": "mm", "sketches": [], "objects": objs})


# ---- 채점 ------------------------------------------------------------------------

def matches(actual: Any, expected: Any) -> bool:
    """expected 가 actual 의 부분 집합인지 (숫자는 허용 오차, 리스트는 같은 길이)."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and matches(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(matches(a, e) for a, e in zip(actual, expected))
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(actual, (int, float)) and abs(actual - expected) <= NUM_TOL
    return actual == expected


def grade(result: ChatResult, expect: dict[str, Any]) -> tuple[bool, str]:
    kinds = expect["kind"] if isinstance(expect["kind"], list) else [expect["kind"]]
    if result.kind not in kinds:
        return False, f"kind={result.kind} (기대: {'/'.join(kinds)})"
    if "has" in expect and not all(any(matches(c, e) for c in result.commands) for e in expect["has"]):
        return False, f"필요한 명령 없음: {expect['has']}"
    if "any_of" in expect and not any(all(any(matches(c, e) for c in result.commands) for e in group) for group in expect["any_of"]):
        return False, "허용된 명령 조합과 일치하지 않음"
    return True, "ok"


# ---- 녹화 / 재생 ------------------------------------------------------------------

def _ns(x: Any) -> Any:
    if isinstance(x, dict):
        return SimpleNamespace(**{k: (v if k == "input" else _ns(v)) for k, v in x.items()})
    if isinstance(x, list):
        return [_ns(v) for v in x]
    return x


class RecordingClient:
    def __init__(self, inner: Any, path: Path) -> None:
        self.inner, self.path, self.items = inner, path, []

    def create(self, **params: Any) -> Any:
        r = self.inner.create(**params)
        self.items.append(r.model_dump(mode="json"))
        self.path.write_text(json.dumps(self.items, ensure_ascii=False, indent=1), encoding="utf-8")
        return r


class ReplayClient:
    def __init__(self, path: Path) -> None:
        self.items = json.loads(path.read_text(encoding="utf-8"))

    def create(self, **_: Any) -> Any:
        if not self.items:
            raise RuntimeError("녹화된 응답이 더 없습니다 (프롬프트·검증기가 바뀌어 호출 횟수가 달라졌을 수 있음)")
        return _ns(self.items.pop(0))


# ---- 실행 ------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    cases = [c for c in load_cases() if not args.case or c["id"] in args.case]
    store = ConfigStore(default_data_dir())
    settings = store.load()
    model_name = args.model or settings.model
    rec_dir = Path(args.recordings)

    if args.live:
        key, _ = store.effective_key(settings)
        if not key:
            print("API 키가 없습니다. 앱의 AI 설정에서 저장하거나 ANTHROPIC_API_KEY 를 설정하세요.", file=sys.stderr)
            return 2
        if not args.yes:
            print(f"실제 API 를 {len(cases)}개 케이스로 호출합니다 (모델 {model_name}, 비용 발생). 계속하려면 --yes", file=sys.stderr)
            return 2
        live = AnthropicClient(key)

    price = store.price_for(settings, model_name)
    passed, total_cost, total_in, total_out = 0, 0.0, 0, 0
    print(f"{'케이스':<18} {'결과':<6} {'요청':>4} {'입력':>8} {'출력':>7} {'예상 비용':>10}  비고")
    for case in cases:
        rec = rec_dir / f"{case['id']}.json"
        if args.live:
            client: Any = RecordingClient(live, rec) if args.record else live
        else:
            if not rec.exists():
                print(f"{case['id']:<18} {'건너뜀':<6} (녹화 없음: --live --record 로 먼저 녹화)")
                continue
            client = ReplayClient(rec)
        try:
            result = run_chat(client, model_name=model_name, model=case_model(case), selected_id=case.get("selected"),
                              history=[], user_text=case["prompt"])
            ok, why = grade(result, case["expect"])
            u = result.usage
            cost = estimate_cost(price, input_tokens=u.input_tokens, output_tokens=u.output_tokens,
                                 cache_read=u.cache_read_input_tokens, cache_write=u.cache_creation_input_tokens)
        except Exception as e:  # noqa: BLE001 — 평가 보고서에 기록하고 다음 케이스로
            ok, why, u, cost = False, f"오류: {e}", None, 0.0
        passed += ok
        total_cost += cost
        if u:
            total_in += u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
            total_out += u.output_tokens
        print(f"{case['id']:<18} {'통과' if ok else '실패':<6} {u.requests if u else 0:>4} "
              f"{(u.input_tokens if u else 0):>8} {(u.output_tokens if u else 0):>7} {cost:>10.4f}  {'' if ok else why}")
    print(f"\n통과 {passed}/{len(cases)}  입력 {total_in:,}  출력 {total_out:,}  예상 비용 ${total_cost:.4f} ({model_name})")
    return 0 if passed == len(cases) else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="AI 3D Studio AI 명령 평가")
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--live", action="store_true", help="실제 API 호출 (비용 발생)")
    mode.add_argument("--replay", action="store_true", help="녹화된 응답으로 채점 (비용 없음)")
    p.add_argument("--record", action="store_true", help="--live 응답을 recordings/ 에 저장")
    p.add_argument("--yes", action="store_true", help="실제 API 호출(비용 발생)에 동의")
    p.add_argument("--case", action="append", help="특정 케이스만 (여러 번 지정 가능)")
    p.add_argument("--model", help="모델 (기본: AI 설정의 모델)")
    p.add_argument("--recordings", default=str(ROOT / "recordings"))
    return run(p.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
