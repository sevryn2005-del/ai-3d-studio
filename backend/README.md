# Backend

FastAPI + Pydantic + CadQuery (Python 3.12).

## 실행

[uv](https://docs.astral.sh/uv/) 설치 후:

```bash
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

API 문서: http://localhost:8000/docs

## 테스트

```bash
uv run pytest
```

## 구조

| 경로 | 역할 |
|------|------|
| `app/main.py` | 앱 생성, 라우터·미들웨어 등록 |
| `app/api/health.py` | `GET /api/health` |
| `app/api/modeling.py` | 명령/모델 검증 API |
| `app/cad/commands.py` | CAD 명령·설계 원본 Pydantic 모델 (Zod 와 동일 계약) |
| `app/cad/validation.py` | 의미 검증(중복 ID, 불리언 그래프), 오류 메시지 한국어화 |
| `app/cad/primitives.py` | 설계 원본 → CadQuery 솔리드 (원점 규칙, 회전, 불리언) |
| `app/cad/mesh.py` | 솔리드 → RenderMesh (테셀레이션, base64 버퍼) |
| `app/cad/exporter.py` | 바이너리 STL 작성, 부피 계산 |
| `app/cad/jobs.py` | CAD 워커에서 실행되는 작업 레지스트리 (`evaluate`, `export_stl`) |
| `app/cad/worker_pool.py` | 격리 워커 풀 (타임아웃, 크래시 복구) |
| `app/api/export.py` | `POST /api/export/stl` |
| `app/settings.py` | 환경 변수: `CAD_WORKERS`(기본 2), `CAD_JOB_TIMEOUT_S`(기본 20) |
| `app/core_limits.py` | 요청 크기 제한 (1MB) |
| `app/ai/` | 3주 차: LLM 클라이언트, 프롬프트 (API 키는 여기서만 사용) |
| `tests/test_contract.py` | `shared/schemas` 와의 계약 테스트 |
| `tests/test_api.py` | API 테스트 (실제 CadQuery 메시 검증 포함) |
| `tests/test_primitives.py`, `test_boolean.py` | 치수·부피·회전·불리언 형상 검증 |
| `tests/test_export.py` | STL 치수·부피·닫힌 메시 검증 |
| `tests/test_worker_pool.py` | 타임아웃·크래시 격리 |

계약의 원본은 `frontend/src/cad/commandTypes.ts` 이다. 명령을 바꿀 때는
Zod 수정 → `npm run schema:export` → 이 디렉터리의 Pydantic 모델 수정 → `uv run pytest` 순서로 진행한다.
