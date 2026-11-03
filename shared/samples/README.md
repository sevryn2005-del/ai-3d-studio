# 프로젝트 파일 샘플 (호환성 검증용)

**직접 수정하지 마세요.** 각 파일은 해당 커밋의 코드를 그대로 실행해 만든 실제 저장 파일이다.
새 버전의 앱이 예전 파일을 계속 열 수 있는지(열기 → 저장 → 다시 열기) 검사하는 데 쓴다.

| 파일 | 만든 코드 | 내용 |
|------|-----------|------|
| `project-v1-e0ac5e7.ai3d` | 커밋 `e0ac5e7` (1~3주 차) | 기준 판 60×40×8 − 지름 6 관통 구멍(불리언), 30° 회전한 구 |
| `project-v2-plate.ai3d` | 형식 v2 도입 커밋 (스케치·돌출) | 사각형 스케치 80×40 → 4mm 돌출 − 원 스케치 Ø6 (18,0) 돌출 6mm 관통 구멍 |

만드는 방법(재현):
- v1: `git worktree add <dir> e0ac5e7` 후 그 코드의 `serializeProject` 로 위 명령을 실행 (docs/baseline.md 참고).
- v2: `shared/schemas/examples/model-sketch-plate.json`(schemaExport.ts 의 `SKETCH_PLATE_COMMANDS` 실행 결과)을
  `serializeProject('기준 판 v2', model, new Date('2026-11-03T00:00:00Z'))` 로 저장.

검사: `frontend/e2e/legacy-project.spec.ts`, `frontend/src/features/projects/projectFile.test.ts`

형식이 v3 이상으로 바뀌면 v2 샘플도 "구버전 샘플"이 된다. 그때도 이 파일은 고치지 않고 마이그레이션 테스트에 쓴다.
