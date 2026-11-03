# 제3자 소프트웨어 고지

> 이 문서는 개발 중 확인한 사항을 정리한 것이며 법률 자문이 아닙니다. **상용 배포 전 법률 검토가 필요합니다.**

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
2. 설치 폴더에 LGPL 라이선스 전문과 이 고지 파일을 포함한다.
3. 사용하지 않는 무거운 의존성(vtk, trame 등) 제거 가능성 검토 → 배포 크기 절감 (현재 가상환경 약 1.7GB).

## 프론트엔드

React, Three.js, @react-three/fiber, @react-three/drei, Zustand, Zod, fflate: 모두 MIT.
manifold-3d (브라우저 CAD 엔진, WASM): Apache-2.0.
