# API

기본 경로: `/api`. 개발 중에는 Vite(5173)가 `/api`를 FastAPI(8000)로 프록시한다.
대화형 문서: 백엔드 실행 후 http://localhost:8000/docs

## 오류 응답 원칙

검증 엔드포인트는 입력이 잘못되어도 **HTTP 200 + `{ ok: false, issues: [...] }`** 로 응답한다.
프론트엔드와 AI 파이프라인이 모든 검증 실패를 같은 형식으로 처리하기 위함이다.

```json
{ "path": "objects.0.params.height", "message": "0.1 이상이어야 합니다", "severity": "error" }
```

HTTP 오류는 프로토콜 수준 문제에만 사용한다: `413` 요청 1MB 초과.
예외: 파일을 반환하는 내보내기 API 는 실패 시 `422` + 같은 `{ ok: false, issues }` JSON 을 반환한다.

## 엔드포인트

### `GET /api/health`
```json
{ "status": "ok", "version": "0.1.0", "cadEngine": "cadquery 2.8.0" }
```
CAD 워커가 아직 시작 중이면 `cadEngine` 은 `"starting"`.

### `POST /api/commands/validate`
CAD 명령 하나의 스키마 검증 (객체 존재 여부는 검사하지 않음). 성공 시 정규화된 명령을 돌려준다.

요청: `{ "type": "set_params", "target": "box_1", "params": { "height": 50 } }`
응답: `{ "ok": true, "issues": [], "command": { ... } }`

### `POST /api/model/evaluate`
ModelDefinition(형식 v2: `schemaVersion: 2`, `sketches`, `objects`) 검증(스키마 + 그래프·스케치 참조 규칙) → CadQuery 형상 계산 → **최상위 객체별 RenderMesh**.
예: `shared/schemas/examples/model-sketch-plate.json` (스케치 사각형 돌출 판 − 원 스케치 돌출 구멍).

```json
{
  "ok": true, "issues": [], "objectCount": 3, "computeMs": 12.4,
  "meshes": [{ "objectId": "cut_1", "positions": "<base64>", "indices": "<base64>", "vertexCount": 140, "triangleCount": 96 }]
}
```
- 메시는 **객체 로컬 좌표계** (mm). 화면은 객체의 transform 을 적용해 그린다 → 이동/회전은 재계산 불필요.
- `positions`: little-endian Float32 × 3 × vertexCount, `indices`: little-endian Uint32 × 3 × triangleCount.
- 불리언의 자식은 부모 메시에 포함되므로 별도 메시가 없다.
- 형상 계산은 격리 워커에서 실행되며 기본 20초 제한 (`CAD_JOB_TIMEOUT_S`). 초과 시 `ok: false` + 메시지.

### `POST /api/export/{format}` — `stl` · `3mf` · `step` · `glb`
ModelDefinition → 파일. 모든 최상위 객체를 월드 좌표로 배치. 실패 시 `422` + `{ ok: false, issues }`.

| 형식 | Content-Type | 좌표/단위 | 비고 |
|------|--------------|-----------|------|
| stl | `model/stl` | mm, Z-up | 바이너리, 현의 오차 0.01mm |
| 3mf | `model/3mf` | mm (파일에 명시), Z-up | 객체별 매니폴드 메시, 객체 이름 포함 |
| step | `model/step` | mm | 정확한 B-rep (곡면 근사 없음) |
| glb | `model/gltf-binary` | **m, Y-up** (glTF 규칙) | 노드 이름 = 객체 이름 |

### `POST /api/model/drawing`
도면 투상 (숨은선 제거, OCCT HLR — 브라우저 정밀 엔진 `occtDrawing.ts` 와 같은 규칙).
요청: `{ "model": ModelDefinition, "views": ["front", "top", "right", "iso"], "section"?: { "view": "front" | "right", "offset": mm } }`
응답: `{ "ok": true, "issues": [], "views": [{ "name", "visible": [[x0, y0, x1, y1, …]], "hidden": [...], "circles": [{ "center", "radius", "full", "visible" }], "axes": [[x0, y0, x1, y1]], "section"?: [[…]], "bounds": [xmin, ymin, xmax, ymax] }] }`
단면도(section)는 걷어낸 뒤 투상하고 숨은선 없이, 잘린 면 경계를 `section` 으로 준다.
좌표는 보기 평면 mm (x 오른쪽, y 위). 숨김·억제 객체는 빠지고, 숨은선은 보이는 선·다른 숨은선과 겹친 부분을 지운다.

## 로컬 서버 보호
모든 요청: Host 가 루프백 이름(`127.0.0.1`, `localhost`, `::1`)이 아니면 `421`, Origin 이 다른 사이트면 `403`.
`/api` 의 POST 는 `Content-Type: application/json` 만 허용 (`415`).

## AI (`/api/ai/*`)

AI API 는 사용자가 채팅에서 보낼 때만 호출된다. 키는 로컬 서버에만 저장된다. 자세한 내용: `docs/ai.md`.

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/ai/settings` | `{enabled, model, keyConfigured, keySource, keyHint("…1234"), models[{id,label,price}]}` — 키 원문은 반환하지 않음 |
| PUT | `/api/ai/settings` | `{apiKey?, clearKey?, model?, enabled?, prices?}` |
| GET | `/api/ai/usage` | `{today, month, all: {requests, inputTokens, outputTokens, costUsd}, recent[]}` |
| POST | `/api/ai/chat` | `{model, selectedId, history[{role,text}], message}` → `{kind, message, commands[], options[], issues[], usage, month}` |

`kind`: `commands`(적용할 명령) · `question`(선택지 포함 질문) · `message`(답변만) · `refused` · `error`(`code`: `no_api_key`, `ai_disabled`, `auth`, `rate_limited`, `offline`, `invalid_model`, `api_error`).

## 예정
| Method | Path | 설명 |
|--------|------|------|
