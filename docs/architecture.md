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
| ModelDefinition | `cad/commandTypes.ts` | 설계 원본 (형식 v2). 스케치(`sketches`)·객체·파라미터·변환. 프로젝트 파일에 저장되는 것. |
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

## 스케치와 돌출·회전 (형식 v2~v5, `cad/sketch.ts`, `cad/sketchCommands.ts`, `cad/sketchPlane.ts`)

- `model.sketches[]`: 평면 위 사각형·원 + **치수**(이름 붙은 값 `요소ID.width|height|diameter`). 구속 해석기는 없다 (고정 치수만).
- 평면 `plane: {type, offset}` — CadQuery 이름 평면과 같은 규약 (원점 = 법선 × offset, 돌출 방향 = 법선):

  | type | u | v | 법선(돌출) |
  |------|---|---|-----------|
  | XY | X | Y | +Z |
  | XZ | X | Z | −Y |
  | YZ | Y | Z | +X |

  프론트 `planeMatrix`(Three.js, 브라우저 엔진·미리보기·윤곽·그리기 공용), 서버 `cq.Plane.named`. 두 엔진의 일치는 공유 픽스처
  `model-sketch-planes.json`(XZ 사각형, YZ 원, 이동·회전한 돌출)으로 `test_sketch_extrude.py`·`geometry.test.ts` 가 같은 기대값으로 검사.
- `kind: "extrude"` 객체: `extrude: {sketch, profile}` 로 스케치 요소를 **참조**하고 `params.distance` 만큼 법선 방향으로 돌출.
  치수·중심·평면을 바꾸면 참조하는 돌출이 모두 다시 계산된다.
- 명령: `create_sketch`, `add_rectangle`, `add_circle`, `set_dimension`, `set_entity_center`, `delete_sketch_entity`, `set_sketch_plane`,
  `rename_sketch`, `delete_sketch`, `extrude` (+ `set_params {distance}`). 객체와 스케치는 ID 이름공간을 공유한다.
  돌출이 쓰는 요소·스케치는 삭제를 거부한다 (먼저 돌출 객체를 삭제).
- 형상 키에 참조 프로파일(종류·치수·중심·평면)을 넣는다 → 관련 값이 바뀔 때만 재계산 (`renderMesh.geometryKey`).
- 관통 구멍(`cad/sketchActions.throughHoleCommands`): 판 스케치와 같은 평면에서 법선 반대로 1mm, 두께 +2mm 돌출, 판의 월드 변환을
  그대로 받아 최상위 객체에서 `cut`. 가장자리에서 0.5mm 이상 안쪽이어야 한다. 한 묶음(실행 취소 1번).
- 뷰포트 그리기(`Viewport/SketchDrawTool.tsx`, 단축키 R·C, Esc 로 끝): 선택한 스케치의 평면(돌출이 있으면 그 월드 변환 위)에,
  없으면 바닥 XY 에 새 스케치로. 드래그 중에는 미리보기만, 놓으면 명령 1건(`drawShapeCommands`). 0.5mm 미만은 무시. 스냅 1mm.
- **면 위 스케치 (형식 v3)**: `plane: {type: 'face', object, face, offset}` — 객체의 이름 있는 면(박스 top·bottom·±X·±Y, 원통·원뿔 top·bottom,
  돌출 end·start·(사각형) ±u·±v, 불리언은 기준 객체 면)에 붙는다. 면 좌표계는 피처 정의·월드 변환만으로 계산하므로 필렛·구멍·치수 변경·이동에도
  같은 면을 가리킨다 (`cad/sketchPlane.ts` ↔ `app/cad/frames.py`, 공유 픽스처 `model-face-sketch.json`). 상세: `docs/design-face-sketch.md`.
- 돌출 거리는 음수 가능 (= 법선 반대쪽, 면 안쪽으로 홈·구멍). 의존 순환(돌출 → 스케치 → 붙은 객체 → …)과 스케치가 붙은 객체의 삭제는 거부.
- **구속 (형식 v4)**: 다각형(`polygon`) + `sketch.constraints`. 해석기(`cad/solver.ts`)는 편집 명령을 실행할 때만 돌고 **풀린 좌표를 저장**한다
  → CAD 엔진은 좌표만 읽고, 백엔드는 같은 잔차 식(`app/cad/constraints.py`)으로 만족 여부만 검사. 상세: `docs/review-constraint-solver.md` 7장.
- **회전 (형식 v5)**: `kind: "revolve"` — 스케치 프로파일을 스케치 v 축(u = 0) 둘레로 `params.angle`° (+u 점이 −w 쪽, CadQuery 오른손 규칙).
  프로파일은 u ≥ 0 쪽만 (`revolveProfileError`). 브라우저 manifold `CrossSection.revolve` 결과를 `MANIFOLD_REVOLVE_TO_PLANE` 로, 서버는 CadQuery
  `revolve(angle, (0,0,0), (0,1,0))` — 공유 픽스처 `model-revolve.json`(컵 360°, 1/4 고리 90° 방향)으로 교차 검증. 회전 결과의 이름 있는 면은 아직 없다.
- 기존 `box` 는 그대로 유지한다 (v1 파일 호환). v1~v4 파일은 열 때 v5 로 마이그레이션 (v1 은 `sketches: []`, v3 이하 스케치는 `constraints: []` 추가), 저장은 항상 v5.

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

## 모서리 처리 (필렛·모따기)

- 박스의 `edgeFeature: {type: fillet|chamfer, size, edges: all|vertical}`. 명령 `fillet` / `chamfer` (크기 0 = 제거).
- 크기 < 관련 면의 가장 짧은 변의 절반 (`cad/edgeFeature.ts`, 백엔드 `max_edge_size`). 박스를 줄여 들어가지 않으면 거부.
- 서버: OCCT `fillet` / `chamfer`. 브라우저: 볼록 껍질 — 필렛 전체 = 구 8개, 필렛 세로 = 원통 4개,
  모따기 = 줄인 상자 3개(전체)·2개(세로)의 hull. 두 방식이 같은 형상임을 부피로 확인했다
  (30×20×10, 크기 2: 5804.70 / 5965.66 / 5562.67 / 5920.00 mm³, OCCT 모따기 꼭짓점은 삼각형 면으로 hull 과 일치).
  `test_primitives.py::test_edge_features` 와 `geometry.test.ts` 가 같은 값으로 각각 검사한다.
- 현재 박스만 지원. 원통 윗면 둥글게 등은 이후 확장.

## 출력 전 형상 검사 (`cad/printCheck.ts`)

- 입력: 설계 원본 + 최상위 객체별 월드 바운딩 박스. 박스는 CAD 엔진 메시 정점을 객체 변환으로 옮겨 구한다
  (회전·불리언 결과까지 정확, 메시가 없으면 꼭짓점 근사) — `features/print/worldBoxes.ts`.
- 오류: 바닥 아래로 내려감. 경고: 떠 있음(다른 객체와도 닿지 않음), 출력 범위(220×220×250mm) 초과, 0.8mm 미만 치수.
- "바닥에 놓기"는 일반 `translate` 명령 → 실행 취소 가능, AI 와 같은 명령 경로.
- 내보내기 시 오류가 있으면 확인 창. 경고는 막지 않는다.

## 명령 봉투와 리비전 (`cad/commandEnvelope.ts`, `sceneStore.submit`)

- 봉투 `{commandId, baseRevision, command}`. 대상 ID·입력 파라미터는 `command` 안에 있다.
- 처리 순서: 이미 적용한 `commandId` → `duplicate`(무시) · `baseRevision ≠ 현재` → `stale`(거부) · 실행기 검증 실패 → `rejected` · 적용 → 이력 1건 + 새 리비전.
- 리비전은 커밋마다 새 번호(재사용 안 함). 실행 취소하면 이전 항목의 번호로 돌아간다. 적용한 명령 ID 는 실행 취소와 무관하게 남는다.
- 세션 메모리에만 있다 (프로젝트 파일에 저장하지 않음).
- 적용 경로: **이동·회전 기즈모** (드래그 시작 때 ID·기준 리비전 결정, 드래그 중에는 화면만 움직이고, 놓을 때 submit),
  속성 패널의 모든 단일 편집(치수·위치·회전·이름·복제·삭제·모서리·불리언·스케치)과 Delete 키
  (`submitNow`: 확정 순간의 리비전을 기준으로 봉투 제출).
  여러 명령 묶음(툴바 도형 추가, 그리기, 관통 구멍, AI)은 `dispatchBatch` 를 쓰며, 리비전은 함께 올라간다.
- AI 응답: 요청을 보낼 때의 설계 원본과 응답 도착 시점의 원본이 다르면(직접 편집·실행 취소·다른 파일 열기) 명령을 적용하지 않고 다시 요청하라고 안내한다 (`aiStore.STALE_RESPONSE`).
- 오래된 계산 결과: `runEvaluation` 은 취소된 요청의 결과·오류를 버리고, 메시는 보낸 모델의 형상 키로만 저장한다 (설계 원본은 바꾸지 않음).
- 저장 실패: 쓰기 실패 시 `writable.abort()` 로 임시 사본을 버려 기존 파일이 그대로 남는다.
