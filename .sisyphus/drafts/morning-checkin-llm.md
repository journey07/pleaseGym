# Draft — morning-checkin-llm (interview record)

## Intent classification
`refactor + feature` (버그 수정 성격의 동작 변경 + LLM 역할 확장). content 아님.

## Confirmed requirements (from interview)

### R1. OpenAI 모델 코드 하드코딩
- 현재: `app/api/morning-coach/route.ts:176` `getRuntimeSecret("OPENAI_MODEL") ?? "gpt-5.6-luna"` (env 우선).
- 목표: 코드 상수 `const OPENAI_MODEL = "gpt-5.6-luna"` 한 곳으로 고정, env(`OPENAI_MODEL`) 제거.
- API 키(OPENAI_API_KEY)는 보안상 env 유지.

### R2. 아침 체크인 — 같은 결정 중복 선택 방지 (핵심 정정)
- 사용자 원문: "서로 교체는 가능한데 똑같은게 계속 선택 가능한게 현재 문제."
- **완전 잠금 아님.** go↔no_go 전환(switch)은 허용. **같은 결정을 반복 선택**하는 것이 문제 → 차단.
- 판정:
  - 오늘 저장된 결정 == 새 결정 → 중복 → 새 체크인/XP/코치 재실행 안 함 (멱등). 단 코치 실패 상태면 재시도(R3) 허용.
  - 오늘 저장된 결정 != 새 결정 → 전환 → 허용(결정 갱신 + 코치 재생성).
  - 오늘 결정 없음 → 첫 체크인 → 허용.
- DB morningEvents는 (ownerId,eventDate) upsert 1행 유지 — 전환 시 decision 필드만 갱신. 다중 행 불필요.

### R3. 코치 실패 시 재시도 허용
- 결정(go/no_go)은 멱등(같은 값 중복 커밋 방지)이되, OpenAI 코치 생성 실패(coachPlan 없음) 시
  '다시 연결'로 코치만 재요청 가능. → 결정 커밋과 코치 생성을 분리.
- 서버 contract:
  1. 오늘 event 조회.
  2. existing.decision == body.decision 이고 existing.coachPlan 존재 → OpenAI 호출 없이 기존 plan 반환 (code: already_checked_in).
  3. existing.decision == body.decision 이고 coachPlan == null → 코치 재시도 → OpenAI 호출 + plan 저장.
  4. existing.decision != body.decision → 전환 → decision 갱신 + OpenAI 호출 + plan 저장.
  5. event 없음 → 첫 체크인 → 저장 + OpenAI 호출 + plan 저장.

### R4. LLM 고도화 3종 (앞선 라운드 확정)
- (a) 최근 체크인 인지: 최근 7일 morningEvents(go/no_go) 이력을 coach input에 전달 + 프롬프트 반영.
- (b) 장기 메모리: userState.coachMemory에 코칭 메모 append(최근 30건, 길이 제한) 후 upsert.
  input에 최근 5건 전달. **버그 수정 필수**: page.tsx:252,275가 state PUT마다 coachMemory:[]로 덮어씀 → 보존하도록.
- (c) 진행도 분석 강화: response schema에 progressNote:string(required) 추가, 프롬프트에 근거 지시, morning 카드에 렌더.

## Open blanks
없음 (guesswork < 10%). DB 미설정 로컬 환경은 프론트 localStorage 가드로 best-effort 커버.
