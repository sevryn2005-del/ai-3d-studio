# 0단계 기준선 (커밋 `71d9743`, 2026-11-03)

확장 작업(파라메트릭 스케치·CAD, 메시 편집, 자연어·이미지 제작) 전에 현재 무엇이 동작하는지를 실제 파일과 실행 결과로 기록한다.
비교용 실행 로그는 작업 세션에서 보관했고, 요약은 아래 표와 같다.

## 1. 저장소 상태

| 항목 | 값 |
|------|-----|
| 브랜치 | `feature/mvp-prototype` (원격과 동일, 커밋하지 않은 변경 없음, 원격에 별도 사용자 변경 없음) |
| 지침 | `CLAUDE.md` (로컬 우선·비용, 웹/Windows 공통, CAD 규칙, 스키마 단일 출처) |
| 진입점 | 로컬 모드 `run-local.sh` / `run-local.ps1` → `backend/app/local.py`; 개발 `backend/app/main.py` + `frontend/src/main.tsx` |
| 프론트 | React 19 + TS + Vite, three / R3F / drei, zustand, zod, manifold-3d, fflate (`frontend/package.json`) |
| 백엔드 | Python 3.12, FastAPI, Pydantic, CadQuery 2.8, anthropic (`backend/pyproject.toml`, `uv.lock`) |
| 문서 | `docs/` architecture · api · ai · local-first · platforms · development-plan |

## 2. 동작하는 기능과 근거

| 기능 | 근거 파일 | 검증 |
|------|-----------|------|
| CAD 명령 + 실행기 (Zod, 원자적 일괄 실행) | `frontend/src/cad/commandTypes.ts`, `commandExecutor.ts`, `sceneStore.ts` | `commandExecutor.test.ts`, `batch.test.ts` |
| 실행 취소/다시 실행 (스냅샷) | `frontend/src/cad/history.ts` | `history.test.ts` |
| 기본 도형 생성 (툴바 `+ 박스` 등) | `components/Toolbar/Toolbar.tsx` → `create_*` | `e2e/editor.spec.ts` |
| 이동·회전 (기즈모 드래그 → 마우스 놓을 때 `set_transform` 1회) | `components/Viewport/SelectionGizmo.tsx` | `e2e/editor.spec.ts` (드래그 1회 = 이력 1단계) |
| 숫자 편집 (속성 패널) | `components/PropertyPanel/*` | `e2e/editor.spec.ts`, `primitives` |
| 파라메트릭 불리언·필렛·모따기 | `commandExecutor.ts`, `modelGraph.ts`, `edgeFeature.ts` | `boolean.test.ts`, `edgeFeature.test.ts`, `e2e/boolean`, `e2e/edge-feature` |
| CAD 엔진 2종 (서버 CadQuery / 브라우저 manifold) | `backend/app/cad/*`, `frontend/src/features/engine/*` | 공유 픽스처 `shared/schemas/examples/model-cut-rotated.json` 양쪽 검사 |
| 내보내기 STL·3MF·GLB(두 엔진), STEP(서버) | `backend/app/cad/exporter.py`, `features/engine/browser/exporters.ts` | `test_export.py`, `exporters.test.ts`, `e2e/export.spec.ts` |
| 프로젝트 저장/열기 `.ai3d` v1, 자동 임시 저장 | `features/projects/projectFile.ts`, `projectActions.ts`, `draft.ts` | `projectFile.test.ts`, `e2e/project.spec.ts` |
| 출력 전 형상 검사 | `cad/printCheck.ts`, `features/print/*` | `printCheck.test.ts`, `e2e/print-check.spec.ts` |
| AI 자연어 명령 (BYOK, 요청 시에만) | `backend/app/ai/*`, `frontend/src/features/ai/*` | `test_ai_*.py`, `e2e/ai-chat.spec.ts` (대체 응답) |
| 로컬 모드·오프라인·정적 웹 | `backend/app/local.py`, `core_security.py`, `api/config.ts` | `e2e/offline.spec.ts`, `e2e/web-static.spec.ts` |

### 저장 형식
- 파일: `{format: "ai3d-project", formatVersion: 1, app, name, savedAt, model}` (`projectFile.ts`)
- 설계 원본: `model.schemaVersion = 1` (`commandTypes.ts`). 메시는 저장하지 않음.
- 리비전·명령 ID: **없음** (코드 전체에서 사용처 0). 이력은 메모리 스냅샷만.

## 3. 미구현

| 영역 | 상태 |
|------|------|
| 파라메트릭 스케치 (2D 요소·구속·치수), 돌출·회전 피처 | 없음 (`sketch`/`extrude` 코드 0) |
| 피처 트리 / 재계산 그래프 | 객체 단위 파라미터 + 불리언 트리만 |
| 수동 메시 편집 (정점·엣지·면, 하프엣지 등) | 없음 |
| 이미지 기반 제작 | 없음 |
| 명령 ID·기준 리비전·중복 방지 | 없음 → 이번 첫 구현 대상 |
| Windows 실행 파일 패키징 | 설계만 (`docs/platforms.md`), PyInstaller·Tauri 의존성 없음 |
| AI 평가 실제 실행 | 녹화 없음 (사용자 키 필요) |

## 4. 기준선 실행 결과 (변경 전)

| 검사 | 명령 | 결과 |
|------|------|------|
| 백엔드 | `cd backend && uv run pytest` | 173 통과 |
| 타입 | `cd frontend && npx tsc -b` | 통과 |
| 단위 | `npx vitest run` | 206 통과 |
| 빌드 | `npx vite build` | 성공 (번들 500KB 초과 경고 1건 — 기존) |
| E2E (개발) | `npx playwright test` | 31 통과, 1 건너뜀(`web-static`, 환경 변수 필요 — 의도된 동작) |
| E2E (로컬 모드 빌드본) | `E2E_BASE_URL=http://127.0.0.1:8765 … offline/project/export` | 8 통과 |
| E2E (정적 웹 빌드본) | `E2E_WEB_STATIC=… web-static.spec.ts` | 1 통과 |
| 구버전 프로젝트 열기·저장·재열기 | `e2e/legacy-project.spec.ts` (샘플 복사본 사용) | 2 통과 |
| AI 평가 재생 | `uv run python -m evals.run --replay` | **종료 코드 1 (기존 문제)**: 녹화가 없어 11건 모두 건너뜀인데 건너뜀을 실패로 셈 |

### 기존 실패/경고 (이번 작업과 무관, 분리 기록)
1. `evals.run --replay` 가 녹화 없음(건너뜀)을 실패로 처리해 종료 코드 1 → 별도 수정 대상.
2. 프론트 번들 500KB 초과 경고 (three·manifold 포함) → 코드 분할은 별도 판단.

## 5. 구버전 프로젝트 샘플

`shared/samples/project-v1-e0ac5e7.ai3d` — 커밋 `e0ac5e7` 의 코드를 git worktree 로 꺼내 그 `serializeProject` 로 생성
(기준 판 60×40×8 − 지름 6 관통 구멍, 30° 회전 구). 현재 UI 에서 복사본으로 열기 → 그대로 저장(설계 원본 동일) →
다시 열기, 편집(이동) → 저장 → 다시 열기 모두 통과. 원본 샘플은 변경되지 않음을 테스트가 확인한다.

## 6. Windows 런타임 번들 소규모 검증

- `uv export --frozen --no-dev` (67개) → `uv pip install --dry-run --python-platform x86_64-pc-windows-msvc --python-version 3.12 --only-binary :all:` **해석 성공** (소스 빌드 0).
- 핵심 바이너리: `cadquery-ocp 7.9.3.1.1 (cp312 win_amd64)`, `vtk 9.6.2 (cp312 win_amd64)`, `casadi 3.8.2 (cp311-abi3 win_amd64)`, `numpy 2.5.4`, `nlopt 2.11.0`.
- 결론: **기존 의존성은 Windows 에 설치 가능.** 단, 실행 파일로 묶는 도구(PyInstaller, Tauri)는 의존성에 없어 실제 번들 생성·실행은 Windows 환경에서 별도 단계로 검증해야 한다.

## 7. 재사용 가능한 부분 (확장 시)

- 명령 실행기·이력·스키마 단일 출처·계약 테스트 → 스케치/피처 명령도 같은 경로로 추가
- CAD 엔진 인터페이스(`features/engine/types.ts`)와 형상 키 캐시 → 새 피처의 메시 경로
- 프로젝트 파일 검증(`parseProject`)·샘플 기반 호환성 테스트 → 형식 버전 2 마이그레이션 검증
- AI 도구 스키마가 공유 JSON Schema 를 그대로 쓰므로 새 명령이 자동으로 AI 에 노출됨
