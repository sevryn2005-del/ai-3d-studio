# 웹 · Windows 통합 지원

원칙은 `CLAUDE.md` 2장. 이 문서는 플랫폼별 구성과 확장 방법을 기록한다.

## 공통 부분 (모든 플랫폼이 그대로 공유)

| 영역 | 위치 |
|------|------|
| UI (React + TypeScript) | `frontend/src/components`, `App.tsx` |
| 3D 뷰포트 (Three.js / R3F) | `frontend/src/components/Viewport` |
| CAD 명령·설계 원본 | `frontend/src/cad` (Zod, 단일 출처) → `shared/schemas` |
| 프로젝트 파일 `.ai3d` | `frontend/src/features/projects/projectFile.ts` |
| 실행 취소·편집·불리언 트리 | `frontend/src/cad` |

## 플랫폼 차이를 감추는 인터페이스

| 인터페이스 | 구현 | 선택 기준 |
|------------|------|-----------|
| CAD 엔진 `features/engine/types.ts` | `serverEngine` (CadQuery), `browser/browserEngine` (manifold-3d WASM) | `api/config.ts` 의 `cadEngine` + 서버 연결 상태 |
| 파일 저장 `features/projects/projectStorage.ts` | File System Access API / 다운로드·파일 선택 | 브라우저 지원 여부. Tauri 네이티브 대화상자는 추가 예정 |
| API 주소 `api/config.ts` | 같은 출처 `/api` / 빌드 변수 / 런타임 주입 | 배포 형태 |

## 배포 형태

| 형태 | CAD 엔진 | 빌드·실행 | 내보내기 |
|------|----------|-----------|----------|
| **Windows 앱 (Tauri)** | 로컬 CadQuery (사이드카) | 아래 Windows 데스크톱 앱 절 | STL·3MF·STEP·GLB |
| **로컬 모드** (현재) | 로컬 CadQuery, 서버가 꺼지면 브라우저 엔진 | `run-local.sh` / `run-local.ps1` | STL·3MF·STEP·GLB |
| **웹 (정적 호스팅)** | 브라우저 엔진 (manifold-3d WASM) | `VITE_CAD_ENGINE=browser npm run build` → 정적 파일 업로드 | STL·3MF·GLB |
| **웹 + 클라우드 CAD** (선택) | 원격 CadQuery 서버 | `VITE_API_BASE=https://…/api npm run build` | STL·3MF·STEP·GLB |

### 엔진 선택 (`features/engine/engines.ts`)

| 모드 | 서버 연결됨 | 서버 없음 | 연결 확인 중 |
|------|-------------|-----------|--------------|
| `auto` (기본) | 서버 | 브라우저 | 대기 (중복 계산 방지) |
| `server` | 서버 | 계산 안 함 | 대기 |
| `browser` | 브라우저 | 브라우저 | 브라우저 (서버 요청 자체를 하지 않음) |

### 두 CAD 엔진의 차이

| | 서버 (CadQuery/OCCT) | 브라우저 (manifold-3d) |
|--|--|--|
| 형상 표현 | 정확한 곡면 (B-rep) | 다각형 메시 (표면 편차 ≤ 0.01mm로 분할) |
| STEP | 지원 | 미지원 (메뉴에서 비활성 + 안내) |
| 결과 메시 | 면마다 정점 분리 | 정점 공유 (화면은 30° 기준 법선 분리) |
| 격리 | 프로세스 워커 + 타임아웃 | Web Worker + 타임아웃 (초과 시 워커 재생성) |
| 크기 | 설치 약 1.7GB | WASM 0.5MB + 워커 0.27MB |

두 엔진이 같은 해석을 하는지는 공유 픽스처 `shared/schemas/examples/model-cut-rotated.json`
(45° 회전한 판의 구멍이 월드 (60, 0) 에 있어야 함)으로 백엔드(`test_boolean.py`)와
브라우저 엔진(`geometry.test.ts`)이 각각 검사한다.

## Windows 데스크톱 앱 (Tauri) — `desktop/`

```
AI 3D Studio.exe (Tauri 2, desktop/src-tauri/src/main.rs)
 ├─ 시작: 설치 폴더 resources/engine/ai3d-engine.exe --port <빈 포트> --no-browser --parent-pid <셸 PID>
 │    (= backend 의 app.local 을 PyInstaller --onedir 로 묶은 것: backend/packaging/ai3d-engine.spec.
 │     프론트엔드 빌드는 묶음의 web/, LGPL 라이브러리는 별도 DLL 그대로)
 ├─ 준비 화면(desktop/splash) → /api/health 200 이면 창을 http://127.0.0.1:<포트>/ 로 이동
 │    → 프론트엔드·API 가 같은 출처이므로 로컬 모드와 완전히 같은 코드 경로
 ├─ 실패 시 준비 화면에 이유 + 엔진 기록 파일 경로 (%LOCALAPPDATA%\com.ai3dstudio.desktop\logs\engine.log)
 └─ 종료: 엔진 종료. 셸이 강제 종료돼도 엔진이 --parent-pid 감시(app/parent_watch.py)로 스스로 끝나고,
      CAD 워커는 파이프가 닫혀 함께 끝난다
```

- 화면은 Tauri API 를 쓰지 않는다. `capabilities/default.json` 권한 없음 → 원격(127.0.0.1) 페이지에 IPC 없음.
- 데이터(AI 설정·사용량)는 로컬 모드와 같은 `%APPDATA%\AI3DStudio`. 키는 엔진에만 있고 화면·기록에 노출되지 않는다.
- 엔진 출력은 UTF-8 로 고정 (`packaging/desktop_entry.py`): Windows 기본 인코딩으로 한글 기록이 실패하지 않게.
- 크기: 엔진 묶음 약 1.6GB (CadQuery/OCCT·VTK) → 설치 파일 NSIS 197MB, MSI 304MB (2026-11-03 CI).
- 설치 프로그램 언어: 한국어 (MSI `ko-KR`, NSIS `Korean`). 라이선스 화면은 프로젝트 라이선스 전문(`LICENSE`, GPL-3.0). 제3자 고지는 엔진 폴더의 `THIRD_PARTY_NOTICES.md`·`licenses/`.
  (MSI 는 코드 페이지 949 에 없는 문자(— 등)가 라이선스 파일에 있으면 빌드가 실패한다.)
- NSIS 는 사용자 단위 설치 (`%LOCALAPPDATA%\AI 3D Studio`, 관리자 권한 불필요).

### 빌드·검증 (GitHub Actions `.github/workflows/windows.yml`, windows-latest)

| 작업 | 내용 |
|------|------|
| `tests` | Windows 에서 백엔드 pytest(CadQuery 포함) + 프론트엔드 tsc·vitest |
| `desktop` | 프론트 빌드 → PyInstaller → `packaging/smoke_test.py`(계산·STL 치수·3MF·STEP·GLB·부모 종료) → `tauri build`(MSI·NSIS) → `desktop/scripts/verify-install.ps1`(NSIS 조용히 설치 → 앱 실행 → 엔진 기록의 주소로 health·기준 판 계산·화면 → 앱 강제 종료 후 엔진이 남지 않는지) → 설치 파일 업로드 |

로컬에서 직접 빌드 (Windows, Rust·Node·uv 필요):

```
cd frontend && npm ci && npm run build
cd ../backend && uv sync --group packaging && uv run pyinstaller packaging/ai3d-engine.spec --noconfirm
uv run python packaging/smoke_test.py dist/ai3d-engine/ai3d-engine.exe
cd ../desktop && npm ci && npx tauri build      # → src-tauri/target/release/bundle/{msi,nsis}
```

개발 중 셸만 실행: `AI3D_ENGINE_PATH=<묶은 엔진 실행 파일> cargo run` (desktop/src-tauri).

### Windows 검증 결과 (GitHub Actions run 41629683200, windows-latest, 2026-11-03)

| 항목 | 결과 |
|------|------|
| 백엔드 pytest (CadQuery 포함) · 프론트 tsc·vitest | 통과 |
| 묶은 엔진: 시작 10.7초, 기준 판 계산 32.7ms, STL 80×40×4, 3MF·STEP·GLB, 부모 종료 → 엔진 종료 | 통과 |
| NSIS 조용히 설치 → 앱 실행 → 엔진 응답·기준 판 계산·화면 제공 → 앱 강제 종료 → 엔진 정리 | 통과 |

확인하지 못한 것: 사람이 보는 화면 조작(창 안에서 마우스로 편집), MSI 설치 경로, 한국어 Windows(cp949)에서의 실행,
WebView2 의 저장 대화상자 동작. 실제 PC 에서 설치 파일로 한 번 확인이 필요하다.

### 남은 것
- **코드 서명**: 서명하지 않은 설치 파일은 Windows SmartScreen 경고가 뜬다 (인증서 비용 — 결정 필요).
- 네이티브 파일 대화상자: 현재는 WebView2 의 File System Access API / 다운로드를 그대로 쓴다.
- 엔진이 시작되지 않을 때 브라우저 엔진으로 계속하는 대체 경로 (묶음에 정적 프론트엔드를 따로 넣어야 함).
- 자동 업데이트, 설치 파일 크기 줄이기(사용하지 않는 VTK 모듈 제외 등).

## 클라우드 CAD 서버 (선택 사항, 미구현)

`VITE_API_BASE` 로 원격 서버를 가리킬 수 있지만, 현재 백엔드는 로컬 전용 보호(Host/Origin 검사)가
켜져 있어 그대로 공개하면 안 된다. 공개 서버로 쓰려면 인증, CORS 허용 목록, 요청 수 제한, 사용자별 작업
격리가 필요하다. 로컬 우선 원칙(CLAUDE.md 1장)에 따라 이것은 필수가 아닌 선택 기능이다.
