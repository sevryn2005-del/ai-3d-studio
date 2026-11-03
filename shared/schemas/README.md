# 공유 스키마

**직접 수정하지 마세요.** `frontend/src/cad/commandTypes.ts` (Zod)가 원본이며 아래 명령으로 생성합니다.

```bash
cd frontend && npm run schema:export
```

| 파일 | 내용 |
|------|------|
| `cad-command.schema.json` | CAD 명령 (AI 출력과 UI 조작 공통) |
| `model-definition.schema.json` | 설계 원본 (프로젝트 파일) |
| `examples/cad-commands.valid.json` | 스키마를 통과해야 하는 명령 예시 |
| `examples/cad-commands.invalid.json` | 스키마가 거부해야 하는 명령 예시 (사유 포함) |

예시 파일은 프론트엔드(vitest)와 백엔드(pytest, 2주 차~)가 **같은 판정**을 내리는지 확인하는 계약 테스트에 사용됩니다.
스키마로 표현할 수 없는 규칙(존재하지 않는 객체, 도형 종류별 파라미터, 원뿔 반지름 규칙)은 실행기에서 검증합니다.
