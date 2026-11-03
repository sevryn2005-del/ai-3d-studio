# AI 자연어 명령

## 흐름

```
사용자 메시지 (전송 버튼/Enter 에서만)
  → 프론트 aiStore.send()  ── POST /api/ai/chat (로컬 백엔드)
      → 프롬프트: 고정 시스템 프롬프트(캐시) + 이전 대화(텍스트) + 현재 모델 JSON + 선택 객체
      → Claude (도구: apply_cad_commands / ask_user)
      → 서버 검증(스키마 + 참조) ─ 실패 시 오류를 돌려줘 AI 가 고침 (최대 3회)
  ← { kind: commands | question | message | refused | error, 사용량·예상 비용 }
  → commands: 보낼 때의 설계 원본이 그대로면 sceneStore.dispatchBatch(…, 'ai') — 전부 성공해야 적용, 실행 취소 1단계
              그 사이 원본이 바뀌었으면(직접 편집·실행 취소·다른 파일 열기) 적용하지 않고 다시 요청하라고 안내
```

- 명령 스키마는 `shared/schemas/cad-command.schema.json` 을 그대로 도구 입력 스키마로 사용 (단일 출처).
- AI 는 명령만 "제안"하고, 실제 적용은 직접 편집과 같은 실행기가 한다. 임의 코드 실행 경로 없음.
- 스케치·돌출: 평판처럼 원본 치수를 나중에 고칠 물체는 `create_sketch` → `add_rectangle`/`add_circle` → `extrude`,
  윤곽 치수 변경은 `set_dimension`, 위치는 `set_entity_center`, 평면은 XY·XZ·YZ 또는 기존 객체의 이름 있는 면(`face`), 음수 거리 = 안쪽으로. 사각형이 아닌 판은 `add_polygon` + `add_constraint`(앱이 풀어 좌표를 저장). 컵·노브 같은 축대칭 물체는 XZ 평면 반단면 + `revolve`. 서버 검증기가 스케치·요소·치수 참조를 따라가며 확인한다 (`app/ai/validator.py`).
- 정보가 부족하면 `ask_user` 로 질문하고 선택지를 버튼으로 보여준다. 선택지를 누르면 그 문장이 답변으로 전송된다.
- 모델: 기본 Claude Opus 5.5 (설정에서 Sonnet 5.5 / Haiku 5.5 선택 가능), effort `medium`.
  안전 분류기가 거절하면 서버 측 대체(`fallbacks: "default"`)가 권장 모델로 다시 시도한다 (Opus·Sonnet).

## 비용 원칙 (CLAUDE.md 1장 #3·#7)

| 원칙 | 구현 | 검증 |
|------|------|------|
| 요청할 때만 호출 | `send()` 에서만 `/api/ai/chat` 호출. 요청 중에는 재전송 차단 | `aiStore.test.ts`, `e2e/ai-chat.spec.ts` (편집으로는 호출 0회) |
| 사용자 키 (BYOK) | 로컬 데이터 폴더 `ai-settings.json` (0600). 응답에는 끝 4자리만 | `test_ai_api.py` |
| 사용량·예상 비용 | 요청마다 `ai-usage.jsonl` 에 토큰(입력·출력·캐시)·예상 금액 기록. 채팅에 요청별 비용, 헤더에 이번 달 합계, 설정 창에 오늘/이번 달/전체 | `test_ai_api.py` |
| 가격표 수정 | 설정 창에서 모델별 USD/100만 토큰 수정 | `test_user_prices_change_estimate` |
| 비용 절감 | 고정 프롬프트·도구 캐시, 모델 상태는 마지막 메시지에, 이전 대화는 최근 20개 텍스트만 | — |
| 남의 사이트가 키를 쓰지 못함 | 로컬 서버 보호(Host/Origin/JSON) | `test_other_websites_cannot_spend_the_users_key` |

데이터 폴더: Windows `%APPDATA%\AI3DStudio`, macOS `~/Library/Application Support/AI3DStudio`,
Linux `~/.local/share/ai3dstudio` (또는 `AI3D_DATA_DIR`). 키를 저장하지 않으면 `ANTHROPIC_API_KEY` 를 사용한다.

예상 비용은 가격표로 계산한 추정치다. 실제 청구액은 Anthropic 콘솔에서 확인한다.

## 사용 가능 환경

| 환경 | AI |
|------|----|
| 로컬 모드 · Windows 앱 | 사용 가능 (사용자 키) |
| 로컬 서버 꺼짐 / 인터넷 끊김 | 사용 불가 안내, 모델링은 그대로 |
| 정적 웹 (서버 없음) | 사용 불가 안내 (키를 브라우저에 두지 않기 위해) |

## 평가 (`backend/evals/`)

```bash
cd backend
uv run python -m evals.run --live --record --yes   # 실제 API + 녹화 (비용 발생, 케이스 15개)
uv run python -m evals.run --replay                # 녹화로 재채점 (비용 없음)
```

- 케이스: `evals/cases.json` (높이 변경, 수납함, 구멍 뚫기, 질문해야 하는 경우, 범위 초과, 스케치 판·윤곽 치수 변경 등).
  모델 픽스처는 `"objects": "fixture:<shared/schemas/examples 의 파일>"` 로 지정할 수 있다.
  채점은 명령의 의미로 한다 (예: 이동은 `translate` / `set_transform` 어느 쪽이든 정답).
- 프롬프트나 검증기를 바꾸면 `--live --record` 로 다시 녹화해 기준을 갱신한다.
- 아직 실제 API 로 실행한 기록은 없다 (개발 환경에 API 키가 없었음). 첫 실행은 사용자 키로 한다.
