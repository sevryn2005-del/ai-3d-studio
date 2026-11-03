# AI 3D Studio — 개발 지침

이 파일은 이 저장소에서 작업하는 모든 개발(사람과 AI 코딩 도구 모두)이 따라야 하는 원칙이다.
상세 근거: `docs/local-first.md`, `docs/architecture.md`, 진행 상황: `docs/development-plan.md`.

## 1. 로컬 우선 · 비용 최소화 (필수)

사용자가 직접 사용할 때 **AI API 비용 외에 별도 사용료가 발생하지 않아야 한다.**
클라우드 서버 없이 개인 PC에서 독립 실행되는 **로컬 모드**는 반드시 동작해야 한다.

1. CAD 엔진(CadQuery/OCCT)은 사용자 PC에서 로컬 실행한다. 형상 계산을 원격 서비스에 의존하지 않는다.
2. 기본 모델링과 직접 편집은 AI API 없이 작동해야 한다. AI 는 부가 기능이며, AI 가 꺼져 있어도 모든 편집 기능이 동작한다.
3. AI 는 사용자가 명시적으로 요청할 때만 API 를 호출한다. 백그라운드 호출, 자동 제안, 주기적 호출 금지.
4. 프로젝트 저장·불러오기는 로컬 파일로 지원한다. 계정·클라우드 저장은 선택 사항일 뿐 필수가 아니다.
5. STL, 3MF, STEP, GLB 등 파일 내보내기는 로컬에서 처리한다.
6. 인터넷 연결이 끊겨도 기본 모델링 기능은 사용할 수 있어야 한다.
   - 프론트엔드는 외부 CDN·원격 폰트·원격 에셋을 로드하지 않는다 (모든 리소스 번들 포함).
   - 원격 리소스를 로드하는 라이브러리 기능(예: drei `Environment` 프리셋, 원격 폰트)은 사용하지 않는다.
   - 오프라인 E2E 테스트(`frontend/e2e/offline.spec.ts`)가 이를 강제한다.
7. AI API 사용량과 예상 비용을 사용자가 확인할 수 있어야 한다 (요청별·누적 토큰, 예상 금액, 로컬 기록).
8. 웹 버전과 Windows 버전을 모두 지원한다. 같은 프론트엔드 + 같은 로컬 백엔드를 사용하고,
   Windows 버전은 이 로컬 모드를 데스크톱 셸(Tauri 예정)로 감싼다.

AI API 키는 사용자 소유(BYOK)다. 키는 로컬 백엔드에만 저장하고 브라우저·로그·저장 파일에 노출하지 않는다.

## 2. 웹 · Windows 통합 지원 (필수)

최종적으로 웹 브라우저와 Windows 프로그램 모두에서 사용한다. **기존 구조를 유지하며 확장하고, 불필요하게 재작성하지 않는다.**
상세: `docs/platforms.md`.

1. React + TypeScript 공통 프론트엔드 하나를 유지한다 (플랫폼별 분기 최소화).
2. Three.js 3D 뷰포트는 웹·Windows 공통.
3. CAD 명령(`commandTypes.ts`)과 프로젝트 데이터(`.ai3d`)는 공통.
4. 웹: 클라우드 CAD 엔진(서버) 또는 브라우저 로컬 CAD 엔진(WASM)을 사용한다.
5. Windows: 로컬 CAD 엔진(CadQuery 백엔드)을 실행한다.
6. 기본 모델링·직접 편집은 AI API 없이 동작한다.
7. 웹에서도 STL·3MF·GLB 를 다운로드할 수 있다 (백엔드가 없어도 브라우저 엔진으로).
8. Windows 독립 실행 프로그램은 Tauri 로 패키징한다 (로컬 모드 백엔드를 사이드카로 실행).

구현 규칙
- 플랫폼 차이는 인터페이스 뒤에 둔다: CAD 엔진(`features/engine/`), 파일 저장(`features/projects/projectStorage.ts`),
  API 주소(`api/config.ts`). 컴포넌트는 플랫폼을 직접 확인하지 않는다.
- CAD 엔진 구현은 같은 설계 원본을 같은 규칙(원점·회전·불리언)으로 해석해야 하며, 공유 픽스처로 서로 검증한다.
- 메시는 객체 로컬 좌표 + 형상 키 캐시라는 기존 계약을 모든 엔진이 따른다.

## 3. CAD 규칙

- 단위 mm, 각도 degree, Z-up 오른손 좌표계.
- 모든 기본 도형의 원점 = 바운딩 박스 바닥면 중심. 원통·원뿔 축 = 로컬 Z.
- 불리언 자식의 transform 은 부모 기준 (`world = parent ∘ child`).
- 모델 변경은 오직 CAD 명령(`sceneStore.dispatch`)으로만. AI 수정과 직접 수정은 같은 명령 경로를 쓴다.
- AI 가 임의 코드를 실행하는 경로를 만들지 않는다. 등록된 명령·작업만 실행한다.

## 4. 계약(스키마) 규칙

- 단일 출처: `frontend/src/cad/commandTypes.ts` (Zod).
- 변경 순서: Zod 수정 → `npm run schema:export` → 백엔드 Pydantic 수정 → 양쪽 테스트.
- `shared/schemas/` 는 생성물이다. 직접 수정하지 않는다.

## 5. 작업 방식

- 기능 단위로 구현 → 테스트 → 다음 단계. 임시방편보다 유지보수 가능한 해결책.
- 테스트와 문서를 코드와 함께 갱신한다.
- 검증 명령:
  - 백엔드: `cd backend && uv run pytest`
  - 프론트엔드: `cd frontend && npx tsc -b && npm test && npm run test:e2e`
  - AI 평가: `cd backend && uv run python -m evals.run --replay` (실제 API 실행 `--live --yes` 는 비용이 들므로 사용자 동의 후에만)
