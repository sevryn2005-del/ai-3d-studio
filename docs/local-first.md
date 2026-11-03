# 로컬 우선 설계 (Local-first)

요구사항 원문은 `CLAUDE.md` 1장. 이 문서는 각 요구사항이 **어떻게** 충족되는지와 검증 방법을 기록한다.

## 실행 형태

| 형태 | 구성 | 대상 |
|------|------|------|
| **로컬 모드** (기본) | 사용자 PC 의 백엔드 1개 프로세스가 API + 빌드된 프론트엔드를 `127.0.0.1` 에서 제공 | 개인 사용, 오프라인 |
| 개발 모드 | Vite(5173) + 백엔드(8000), Vite 가 `/api` 프록시 | 개발 |
| Windows 앱 (예정) | Tauri 셸 + 로컬 모드 백엔드를 사이드카 프로세스로 실행 | 설치형 배포 |
| 웹 버전 (예정) | 같은 프론트엔드. CAD 백엔드는 사용자 PC 의 로컬 모드 또는 선택적 호스팅 | 브라우저 |

로컬 모드는 `127.0.0.1` 에만 바인딩한다 (같은 네트워크의 다른 기기에서 접근 불가).

## 로컬 서버 보호 (`backend/app/core_security.py`)

사용자가 방문한 다른 웹사이트가 로컬 서버를 호출하는 공격을 막는다. AI 엔드포인트는 사용자 API 키로
비용을 발생시키므로 필수다.

| 공격 | 방어 | 테스트 |
|------|------|--------|
| DNS rebinding (악성 도메인 → 127.0.0.1) | Host 헤더가 루프백 이름이 아니면 421 | `test_dns_rebinding_host_rejected` |
| 교차 출처 요청 | Origin 이 루프백이 아니거나 `null` 이면 403 | `test_cross_site_origin_rejected` |
| CORS 사전 요청을 피하는 단순 요청(form, text/plain) | `/api` POST 는 `application/json` 만 허용 (415) | `test_non_json_post_rejected` |

## 프로젝트 파일 (`.ai3d`)

```json
{ "format": "ai3d-project", "formatVersion": 1, "app": {"name": "AI 3D Studio", "version": "0.1.0"},
  "name": "받침대", "savedAt": "2026-11-03T00:00:00.000Z", "model": { ...ModelDefinition } }
```
- 설계 원본만 저장 (메시는 재계산). 불러올 때 스키마 + 그래프 규칙 검증, 더 새 형식 버전은 거부.
- 저장 방식: Chromium 은 File System Access API(같은 파일에 덮어쓰기), 그 외는 다운로드/파일 선택.
  Windows 앱(Tauri)은 `projectStorage.ts` 인터페이스에 네이티브 구현을 추가할 예정.
- 자동 임시 저장: 브라우저 저장소에 1초 디바운스, 시작 시 복원.

## 요구사항별 설계와 검증

| # | 요구사항 | 설계 | 검증 |
|---|----------|------|------|
| 1 | CAD 로컬 실행 | CadQuery/OCCT 를 로컬 백엔드의 격리 워커에서 실행. `run-local.sh` / `run-local.ps1` 로 한 번에 실행 ✅ | `backend/tests/test_local_mode.py` |
| 2 | AI 없이 모델링 | 모든 편집은 CAD 명령 → 로컬 실행기. AI 는 명령을 "제안"하는 입력 경로 중 하나일 뿐 | 전체 E2E (AI 미설정 상태로 실행) |
| 3 | 요청 시에만 AI 호출 | AI 호출은 채팅 전송 버튼/Enter 에서만, 요청 중 재전송 차단 ✅ | `aiStore.test.ts`, `e2e/ai-chat.spec.ts` |
| 4 | 로컬 저장 | `.ai3d` 프로젝트 파일 (JSON) 저장/열기 + 브라우저 자동 임시 저장 ✅ | `e2e/project.spec.ts`, `projectFile.test.ts` |
| 5 | 로컬 내보내기 | STL·3MF·STEP·GLB 모두 로컬 백엔드에서 생성 ✅ | `backend/tests/test_export.py` (형식별 재읽기 검증), `e2e/export.spec.ts` |
| 6 | 오프라인 | 외부 리소스 0개. 서버가 꺼져도 편집 가능(미리보기 도형) ✅ | `e2e/offline.spec.ts` — 개발 모드와 로컬 모드 빌드본 모두에서 실행 |
| 7 | 사용량·비용 | 요청별 토큰·예상 비용을 로컬 `ai-usage.jsonl` 에 기록, 채팅·설정 창에 표시, 가격표 수정 가능 ✅ | `test_ai_api.py`, `e2e/ai-chat.spec.ts` |
| 8 | 웹 + Windows | 프론트엔드·백엔드 공용. 플랫폼 차이는 파일 저장 방식 정도로 한정 | — |

## 비용 원칙

- 앱 자체는 서버 비용이 들지 않는다 (사용자 PC 에서 실행).
- AI 는 사용자 API 키(BYOK)로 호출 → 사용자는 자신이 쓴 만큼만 API 제공자에게 지불.
- AI 호출 시 보내는 내용은 최소화 (현재 모델 요약 + 대화). 형상 메시·파일은 보내지 않는다.
