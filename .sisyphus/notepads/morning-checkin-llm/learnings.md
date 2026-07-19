# Learnings — confirmed mount points

## app/api/morning-coach/route.ts (POST)
- L78 `getRuntimeSecret("OPENAI_API_KEY" | "OPENAI_MODEL")` → env reader.
- L80 `dateKeyInSeoul()` — 서버 today 기준(Asia/Seoul).
- L87 `ownerId()` = env FIRST_REP_OWNER_ID ?? "local-owner".
- L89 `storeMorningEvent(decision, model?, coachPlan?)` — upsert on (ownerId,eventDate). L163에서 결정 즉시 저장(코치 전), L229에서 코치 후 재저장.
- L127 `isMorningCoachResponse` 검증 + L223 decision 일치 확인.
- L168 apiKey 없으면 503 code:"openai_not_configured".
- L176 `model = getRuntimeSecret("OPENAI_MODEL") ?? "gpt-5.6-luna"`.
- L181 fetch https://api.openai.com/v1/responses, json_schema strict (responseSchema L33).
- systemPrompt L64. responseSchema L33 (decision/headline/message/planLabel/exercises/nextAction/safetyNote).
- 반환: `{ coach: parsed, model }`.

## app/api/state/route.ts
- GET returns state.{history,favorites,coachMemory,updatedAt}. coachMemory 이미 노출됨.
- PUT L40 body {history,favorites,coachMemory}. L51 coachMemory = Array ? body : []. L61 upsert set coachMemory 항상 덮어씀.
  → 문제: 요청에 coachMemory 없으면/[] 이면 기존값 파괴. 보존 로직 필요.

## db/schema.ts
- userState: ownerId PK, workoutHistory, favorites, coachMemory(jsonb unknown[] default []), updatedAt.
- morningEvents: id PK(`ownerId:eventDate`), ownerId, eventDate, decision, model, coachPlan(jsonb), decidedAt, updatedAt.
  uniqueIndex (ownerId,eventDate). → 하루 1행 구조 이미 존재. 스키마 변경 불필요.

## app/morning/page.tsx (client)
- L129 storeDecision: localStorage "first-rep-morning-decisions"에서 오늘 것 filter 후 push (date별 dedup, XP 1회).
- L143 calculateMissionStats: activeDates Set(dedup by date) → streak/weekGoes/totalXp.
- L204 choose(decision): storeDecision → POST /api/morning-coach → setCoach. 재진입 시 decision state=null로 시작(가드 없음 = 반복 선택 가능 원인).
- L261 usePlan: coach.exercises → localStorage "first-rep-coach-draft" → navigate /?coach=today.
- L395 coach 결과 렌더. L398 "OPENAI COACH". L424 "결정 바꾸기" 버튼(setDecision(null) 등 리셋).
- L230 code "openai_not_configured" 처리.

## app/page.tsx (calendar)
- L252, L275 두 PUT 사이트 모두 `coachMemory: []` 전송 → morning coach가 쓴 coachMemory 삭제됨. 수정 대상.
- L296 coach-draft 흡수: 오늘 세션 이미 있으면(L306) 덮어쓰지 않음(가드 존재).

## .env.example / .dev.vars
- 둘 다 OPENAI_MODEL=gpt-5.6-luna 라인 존재 → 제거 대상.

## 기존 초안
- docs/plan-morning-checkin-llm.md (완전 잠금 전제 — R2 정정으로 "중복 방지"로 수정 필요).
