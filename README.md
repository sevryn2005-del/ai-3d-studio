# AI 3D Studio

대화와 직접 편집으로 3D 프린팅용 모델을 설계하는 AI 기반 CAD.

## 현재 상태 (4주 차 진행 중)

개발 원칙: [CLAUDE.md](CLAUDE.md) — 로컬 우선 · 비용 최소화

- 웹 편집기 골격: AI 채팅 패널(UI) · 3D 뷰포트 · 속성 패널 · 툴바 · 상태바
- CAD 명령 시스템(Zod 검증), 실행기, 실행 취소/다시 실행
- 뷰포트 이동/회전 기즈모, 1mm·15° 스냅, 화면 맞춤
- 기본 도형: 박스, 원통, 구, 원뿔
- 공유 명령 스키마: `shared/schemas/` (JSON Schema, 자동 생성)
- FastAPI 백엔드: 상태 확인, 명령/모델 검증, 프론트엔드 상태바에 서버 검증 결과 표시
- CadQuery CAD 엔진 (격리 워커): 화면에 서버가 계산한 실제 형상 표시
- 불리언(빼기/합치기/교차) — 파라메트릭: 구멍의 크기·위치를 나중에 수정 가능
- 모서리 둥글게(필렛) · 모따기 (박스)
- 출력 전 형상 검사: 바닥 아래·떠 있음·크기 초과·얇은 부분, "바닥에 놓기"
- 내보내기: STL · 3MF · STEP · GLB (모두 로컬 처리)
- 프로젝트 저장/열기 (`.ai3d`), 자동 임시 저장
- 로컬 모드: 서버 1개 프로세스, 오프라인 동작, 로컬 서버 보호
- 웹·Windows 공통: CAD 엔진 2종 (CadQuery 서버 / 브라우저 WASM), 서버가 없으면 자동 전환
- AI 자연어 명령: 사용자 API 키(BYOK), 요청할 때만 호출, 정보 부족 시 질문, AI 변경도 실행 취소 1번, 사용량·예상 비용 표시 → [docs/ai.md](docs/ai.md)

## 로컬 모드로 실행 (권장)

클라우드 서버 없이 이 PC 에서만 실행됩니다. 인터넷이 끊겨도 모델링·저장·내보내기가 동작합니다.
필요: [uv](https://docs.astral.sh/uv/), 처음 한 번 프론트엔드 빌드에 Node.js.

```bash
./run-local.sh            # macOS / Linux
```

```powershell
powershell -ExecutionPolicy Bypass -File .\run-local.ps1   # Windows
```

브라우저가 `http://127.0.0.1:8765` 로 열립니다. 처음 실행 시 CadQuery 설치(약 1.7GB)와 프론트엔드 빌드가 진행됩니다.

## Windows 앱 (설치 프로그램)

GitHub Actions 의 `windows` 워크플로가 Windows 에서 테스트·엔진 스모크 테스트·설치·실행 확인 후
설치 파일(MSI·NSIS `*-setup.exe`)을 산출물 `ai-3d-studio-windows` 로 올린다. 아직 코드 서명이 없어 처음 실행 시 SmartScreen 경고가 뜬다.
구성과 직접 빌드 방법: `docs/platforms.md` 의 "Windows 데스크톱 앱".

## 웹 버전 (정적 호스팅, 서버 불필요)

```bash
cd frontend
VITE_CAD_ENGINE=browser npm run build   # → dist/ 를 아무 정적 호스팅에 업로드
```

브라우저 안의 CAD 엔진(manifold-3d WASM)으로 동작합니다. STL·3MF·GLB 내보내기 가능 (STEP 은 로컬 CAD 서버 필요).
플랫폼별 구성: [docs/platforms.md](docs/platforms.md)

## 개발 모드

```bash
# 1) 백엔드
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

```bash
# 2) 프론트엔드 (http://localhost:5173)
cd frontend
npm install
npm run dev
```

## 테스트

```bash
cd backend
uv run pytest      # API + 계약 + AI(대체 클라이언트) 테스트
uv run python -m evals.run --replay   # AI 평가 (녹화 재생, 비용 없음)
```

```bash
cd frontend
npm test           # 단위 테스트 (vitest)
npm run typecheck  # 타입 검사
npm run build      # 프로덕션 빌드
npx playwright install chromium   # 최초 1회
npm run test:e2e   # 브라우저 E2E 테스트 (백엔드도 자동 실행)
# 로컬 모드 빌드본 대상: E2E_BASE_URL=http://127.0.0.1:8765 npx playwright test e2e/offline.spec.ts
# 정적 웹 빌드본 대상:   E2E_WEB_STATIC=http://127.0.0.1:4180 npx playwright test e2e/web-static.spec.ts
npm run schema:export  # 명령 스키마 변경 후 shared/schemas 재생성
```

## 단축키

| 키 | 동작 |
|----|------|
| W / E | 이동 / 회전 기즈모 |
| S | 스냅 켜기·끄기 (1mm, 15°) |
| F | 화면 맞춤 |
| Ctrl+Z / Ctrl+Shift+Z | 실행 취소 / 다시 실행 |
| Ctrl+S / Ctrl+Shift+S | 저장 / 다른 이름으로 저장 |
| Ctrl+O | 열기 |
| Delete | 선택 객체 삭제 |
| Esc | 선택 해제 |

문서: [docs/development-plan.md](docs/development-plan.md), [docs/architecture.md](docs/architecture.md), [docs/api.md](docs/api.md)

라이선스 고지: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — Open CASCADE(LGPL) 등 포함. 프로젝트 라이선스는 맨 아래 "라이선스" 절.

## 라이선스

**GNU General Public License v3.0 이상 (GPL-3.0-or-later)** — 전문은 `LICENSE`.
누구나 무료로 쓰고, 고치고, 다시 배포할 수 있습니다. 고친 프로그램을 배포할 때는 같은 라이선스로 소스를 공개해야 합니다.
함께 들어가는 다른 오픈소스(OCCT, CadQuery 등)의 라이선스와 고지는 `THIRD_PARTY_NOTICES.md`, `licenses/`.

