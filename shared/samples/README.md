# 프로젝트 파일 샘플 (호환성 검증용)

**직접 수정하지 마세요.** 각 파일은 해당 커밋의 코드를 그대로 실행해 만든 실제 저장 파일이다.
새 버전의 앱이 예전 파일을 계속 열 수 있는지(열기 → 저장 → 다시 열기) 검사하는 데 쓴다.

| 파일 | 만든 코드 | 내용 |
|------|-----------|------|
| `project-v1-e0ac5e7.ai3d` | 커밋 `e0ac5e7` (1~3주 차) | 기준 판 60×40×8 − 지름 6 관통 구멍(불리언), 30° 회전한 구 |

만드는 방법(재현): `git worktree add <dir> e0ac5e7` 후 그 코드의 `serializeProject` 로 위 명령을 실행 (docs/baseline.md 참고).

검사: `frontend/e2e/legacy-project.spec.ts`, `frontend/src/features/projects/projectFile.test.ts`
