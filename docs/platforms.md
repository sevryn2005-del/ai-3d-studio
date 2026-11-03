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
| **Windows 앱 (Tauri, 예정)** | 로컬 CadQuery (사이드카). 실패 시 브라우저 엔진으로 자동 전환 | 아래 Tauri 절 | STL·3MF·STEP·GLB |
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

## Tauri 패키징 계획 (Windows)

현재 코드 변경 없이 가능한 구성을 기본으로 한다.

```
AI 3D Studio.exe (Tauri)
 ├─ 시작 시 사이드카 실행: ai3d-engine\ai3d-engine.exe --port <빈 포트> --no-browser
 │    (= backend 의 app.local 을 PyInstaller --onedir 로 묶은 것. LGPL 라이브러리는 별도 DLL 유지)
 ├─ /api/health 가 응답하면 창을 http://127.0.0.1:<포트>/ 로 연다
 │    → 프론트엔드·API 가 같은 출처이므로 추가 설정 불필요 (로컬 모드와 동일)
 └─ 종료 시 사이드카 종료
```

- 사이드카가 시작되지 않는 경우: 번들된 프론트엔드를 직접 띄우고 `window.__AI3D_CONFIG__ = { cadEngine: 'browser' }`
  를 주입하면 브라우저 엔진으로 동작한다 (WebView2 는 WASM·Web Worker 지원).
- 로컬 서버 보호(`core_security.py`)는 Host `127.0.0.1` 을 허용하므로 그대로 동작한다.
- 남은 작업: Tauri 프로젝트 생성(`src-tauri`), 사이드카 빌드 스크립트(PyInstaller), 네이티브 파일 대화상자,
  설치 프로그램(MSI/NSIS), 코드 서명, 실제 Windows PC 검증. Rust 툴체인과 Windows 환경이 필요하다.

## 클라우드 CAD 서버 (선택 사항, 미구현)

`VITE_API_BASE` 로 원격 서버를 가리킬 수 있지만, 현재 백엔드는 로컬 전용 보호(Host/Origin 검사)가
켜져 있어 그대로 공개하면 안 된다. 공개 서버로 쓰려면 인증, CORS 허용 목록, 요청 수 제한, 사용자별 작업
격리가 필요하다. 로컬 우선 원칙(CLAUDE.md 1장)에 따라 이것은 필수가 아닌 선택 기능이다.
