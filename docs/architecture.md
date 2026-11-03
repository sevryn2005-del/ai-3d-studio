# 아키텍처

## 데이터 흐름

```
사용자(채팅/마우스/숫자 입력)
   │
   ▼
CAD 명령(JSON) ── AI 출력도 동일한 형식 ──┐
   │                                     │
   ▼                                     ▼
[검증] Zod (프론트)            [검증] Pydantic (백엔드, 최종 권한)
   │                                     │
   ▼                                     ▼
ModelDefinition 갱신            CadQuery/OCCT 형상 계산 (격리 워커, 타임아웃)
   │                                     │
   ├── FeatureHistory(명령 로그)          ▼
   │                            형상 검사 → RenderMesh(glTF/버퍼) 반환
   ▼                                     │
Three.js 뷰포트 ◀───────────────────────┘
```

## 세 가지 데이터의 분리

| 데이터 | 위치 | 설명 |
|--------|------|------|
| ModelDefinition | `cad/commandTypes.ts` | 설계 원본. 객체·파라미터·변환. 프로젝트 파일에 저장되는 것. |
| FeatureHistory | `cad/history.ts` | 실행된 명령 목록 + 스냅샷. undo/redo, 설계 재생성의 근거. |
| RenderMesh | 백엔드 `app/cad/mesh.py` → 프론트 `features/backend/` | 화면 표시용 삼각형 메시 (객체 로컬 좌표). **저장하지 않고 언제든 재계산 가능.** 형상 키(종류+치수, 불리언은 하위 트리 포함)로 캐시. |

## 규칙

- 모델 변경은 **오직 `sceneStore.dispatch(command)`** 로만 한다. UI가 상태를 직접 수정하지 않는다.
- `executeCommand`는 순수 함수다. 실패 시 원본 모델을 그대로 두고 에러를 반환한다.
- 명령 입력은 `unknown`으로 받아 스키마 검증부터 한다. 알 수 없는 `type`은 거부된다 → 임의 코드 실행 경로 없음.
- 단위: mm / degree. 좌표계: Z-up. 모든 기본 도형의 원점: 바운딩 박스 바닥면 중심. 원통·원뿔 축: 로컬 Z.
- 스키마 단일 출처: `frontend/src/cad/commandTypes.ts`(Zod) → `npm run schema:export` → `shared/schemas/`. 백엔드는 이 JSON Schema 와 `examples/` 픽스처로 계약 테스트를 한다.
- 새 도형 추가 절차: `commandTypes.ts`(파라미터·명령 스키마) → `objectKinds.ts`(표시 이름·파라미터·크기) → `commandExecutor.ts`(create 분기) → `CadObjectMesh.tsx`(미리보기) → 스키마 재생성.
- 범위: 치수 0.1–1000mm, 반지름 0.05–500mm(원뿔은 0 허용), 좌표 ±10000mm, 회전 ±360°.
- 명령 객체는 strict: 정의되지 않은 필드가 있으면 거부.

## 불리언 트리

- `cut` / `union` / `intersect` 명령은 `kind: "boolean"` 객체를 만들고, 피연산자를 `boolean.base` / `boolean.tools` 로 참조한다.
- 피연산자는 삭제되지 않는다 → 구멍(원통)의 반지름·위치를 나중에 바꾸면 결과가 다시 계산된다 (파라메트릭).
- 불리언의 좌표계 = 생성 시 기준(base) 객체의 변환. 자식의 transform 은 **부모 기준**이며 `world = parent ∘ child`.
  - 프론트: `cad/transformMath.ts` (Three.js 행렬), 백엔드: `primitives.build_solid` (자식 변환 적용 후 부모 변환).
  - 두 구현의 일치는 `shared/schemas/examples/model-cut-rotated.json` (프론트 실행기가 생성) 으로 백엔드에서 검증한다.
- 규칙: 피연산자는 최상위 객체여야 함, 한 객체는 한 불리언에만 속함, 순환 금지, 중첩 최대 8단계.
- 삭제: 불리언 삭제 = 하위 트리 전체 삭제. 자식 단독 삭제·복제는 거부.

## CAD 엔진 격리 (`app/cad/worker_pool.py`)

- 워커 프로세스를 미리 띄워 둔다 (CadQuery import 약 5초). 기본 2개 (`CAD_WORKERS`).
- 작업마다 타임아웃 → 초과 시 해당 워커를 강제 종료하고 새 워커로 교체. 크래시도 감지·교체.
- 워커는 `app/cad/jobs.py` 의 `JOBS` 에 등록된 함수만 실행한다. API 프로세스는 CadQuery 를 로드하지 않는다.
- 미구현: 워커 메모리 상한 (Linux `RLIMIT_AS` 는 OCCT/VTK 의 큰 가상 메모리 때문에 별도 검증 필요).
