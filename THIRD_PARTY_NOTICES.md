# 제3자 소프트웨어 고지

AI 3D Studio 자체는 **GPL-3.0-or-later** 로 배포한다 (`LICENSE`). 아래 구성 요소는 모두 GPL-3.0 과 함께 배포할 수 있는 라이선스다
(MIT·BSD·Apache-2.0·PSF·LGPL — 2026-11-03 설치된 패키지 메타데이터로 확인, `license-check` 절 참고).

> 이 문서는 개발 중 확인한 사항을 정리한 것이며 법률 자문이 아닙니다.

## 백엔드 CAD 엔진 (2주 차 확인, 설치된 패키지 메타데이터 기준)

| 패키지 | 버전 | 라이선스 | 비고 |
|--------|------|----------|------|
| cadquery | 2.8.0 | Apache-2.0 | |
| cadquery-ocp | 7.9.3.x | Apache-2.0 (바인딩) | **내부에 Open CASCADE Technology 포함** |
| Open CASCADE Technology | 7.9.x | **LGPL-2.1 + OCCT 예외** | 동적 링크(공유 라이브러리) 형태로 배포하고, 사용자가 라이브러리를 교체할 수 있어야 함. 라이선스 전문과 소스 입수 방법 고지 |
| casadi | 3.8.x | **LGPL-3.0+** | cadquery 의존성. OCCT 와 동일하게 동적 링크 유지 + 고지 |
| vtk | 9.6.x | BSD-3-Clause | cadquery 뷰어 의존성 (서버에서는 사용하지 않음) |
| numpy | 2.x | BSD-3-Clause 등 | |
| anthropic (Python SDK) | 1.x | MIT | AI 기능 |
| ezdxf | 1.4.x | MIT | |

## 배포 시 확인 사항 (Windows / Tauri)

1. OCCT·casadi 공유 라이브러리를 **정적 링크하거나 하나의 실행 파일로 병합하지 않는다** (PyInstaller `--onefile` 사용 시 주의, `--onedir` 권장).
2. 설치 폴더에 LGPL 라이선스 전문과 이 고지 파일을 포함한다. → `licenses/`, 엔진 묶음의 `_internal/licenses`·`_internal/THIRD_PARTY_NOTICES.md`
   (`backend/packaging/ai3d-engine.spec`). 설치 프로그램은 이 파일을 라이선스 화면으로 보여준다.
3. 사용하지 않는 무거운 의존성(vtk, trame 등) 제거 가능성 검토 → 배포 크기 절감 (현재 가상환경 약 1.7GB).

## Windows 데스크톱 앱 (설치 프로그램)

| 구성 요소 | 라이선스 | 비고 |
|-----------|----------|------|
| Tauri 2 (+ tao, wry 등 Rust 의존성) | MIT / Apache-2.0 | 데스크톱 셸 |
| Microsoft Edge WebView2 Runtime | Microsoft 소프트웨어 라이선스 | 설치 시 없으면 Microsoft 부트스트래퍼로 내려받음 (Windows 10/11 대부분 기본 포함) |
| PyInstaller 부트로더 | GPL-2.0 + 부트로더 예외 | 예외에 따라 묶은 프로그램의 라이선스에 영향 없음 |
| Python 3.12 런타임 | PSF-2.0 | 엔진 묶음에 포함 |

## 프론트엔드

React, Three.js, @react-three/fiber, @react-three/drei, Zustand, Zod, fflate: 모두 MIT.
manifold-3d (브라우저 CAD 엔진, WASM): Apache-2.0.
replicad-opencascadejs 1.1.0 (브라우저 정밀 엔진 = Open CASCADE Technology 의 WASM 빌드, 작성자 Steve Genoud): LGPL-2.1-only.
  - OCCT 를 수정하지 않은 빌드를 그대로 쓰며 번들에는 압축(gzip)만 해서 넣는다 (`frontend/scripts/occtWasm.ts`).
  - LGPL-2.1 은 GPL-3.0 프로젝트와 함께 배포할 수 있다 (LGPL 2.1 3절: GPL 로 바꿔 적용 가능). 원본: https://github.com/sgenoud/replicad ,
    OCCT 원본: https://dev.opencascade.org (사용자는 같은 이름의 WASM 파일을 바꿔 넣어 다른 OCCT 빌드를 쓸 수 있다).
opentype.js 1.3.4 (스케치 텍스트 — 글꼴 윤곽 읽기): MIT.
Noto Sans KR Bold (스케치 텍스트 글꼴, `frontend/src/assets/fonts/`): SIL Open Font License 1.1 — 전문은 `frontend/src/assets/fonts/OFL-NotoSansKR.txt`.
  - Copyright 2014-2021 Adobe (Reserved Font Name 'Source'). 원본에서 영문·숫자·기호와 KS X 1001 한글 2,350자만 남긴 서브셋(fonttools pyftsubset, 힌팅 제거)이며
    글꼴 이름은 바꾸지 않았고 예약 이름 'Source' 를 쓰지 않는다. OFL 은 글꼴을 프로그램과 함께 배포하는 것을 허용한다 (글꼴 자체는 OFL 그대로).

## license-check (GPL-3.0 호환성, 2026-11-03)

- 프론트엔드 런타임 의존성: three·@react-three/*·react·zod·zustand·fflate (MIT), manifold-3d (Apache-2.0 — GPL-3.0 과 호환, GPL-2.0 단독과는 비호환), replicad-opencascadejs (LGPL-2.1-only — GPL-3.0 과 호환), opentype.js (MIT). 글꼴 Noto Sans KR 은 OFL-1.1 (데이터로 함께 배포, 코드와 섞지 않음).
- 백엔드: cadquery·cadquery-ocp (Apache-2.0), OCCT (LGPL-2.1 + 예외), casadi (LGPL-3.0+), FastAPI·Pydantic·uvicorn·anthropic (MIT/BSD).
- 빌드 도구: PyInstaller (GPL-2.0-or-later + 부트로더 예외 — 묶은 프로그램의 라이선스에 영향 없음), Tauri (MIT/Apache-2.0).
- 새 의존성을 추가할 때: GPL-3.0 과 호환되는 라이선스만 (CLAUDE.md 5장).
