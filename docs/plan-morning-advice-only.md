# Plan — 아침 코치: 계획 생성 제거, 조언만

## 원인
아침 코치가 매번 `exercises`(운동 계획) 배열을 AI로 생성 → "이 계획으로 시작"이
`first-rep-coach-draft`로 메인 페이지에 운동을 밀어넣음 → 실제 운동과 안 맞아
매번 지우고 다시 입력해야 함.

## 목표
- AI는 **조언만** (headline / message / progressNote / safetyNote / nextAction).
- 운동 계획(exercises, planLabel) 생성·표시·주입 전부 제거.
- 결정 후 빈 상태로 바로 운동 시작 (draft 주입 없음).

## 변경 (2 파일)

### 1. app/api/morning-coach/route.ts
- `MorningCoachResponse` 타입에서 `exercises`, `planLabel` 제거.
- `responseSchema`: `exercises`, `planLabel` 프로퍼티 + required 제거.
- `isMorningCoachResponse`: 두 필드 검증 제거.
- `systemPrompt`: "운동 계획/목록을 만들지 말고 조언만"으로 규칙 수정
  (점진적 과부하는 message/progressNote 안에서 말로만 조언).

### 2. app/morning/page.tsx
- `CoachResult` 타입에서 `exercises`, `planLabel` 제거.
- `coach-plan` 렌더 블록 삭제.
- `usePlan()` 함수 삭제 (draft 작성 제거).
- 액션 버튼: 항상 `/`로 가는 링크
  - go → "운동 시작 →"
  - no_go → "오늘 결정 완료"
  - + "결정 바꾸기" 유지.

## 건드리지 않음
- app/page.tsx의 `first-rep-coach-draft` 소비 로직 → 이제 draft를 쓰는 곳이
  없어 죽은 코드지만 무해 (트리거 안 됨). 스코프 최소화 위해 유지.
- 영상 랜덤 열기 / 미션 HUD / 스킵 게이트 → 그대로.

## 검증
- go/no_go 각각 조언 카드가 계획 없이 뜨는지.
- "운동 시작" → `/` 이동 후 오늘 draft 비어 있는지 (자기 운동 직접 입력 가능).
- build + type-check 통과.
