# Plan — 모델 하드코딩 + 아침 체크인 1일 1회 + LLM 역할 고도화

## 배경 / 원인 (Why)
1. **모델이 env 우선**: `app/api/morning-coach/route.ts:176` `getRuntimeSecret("OPENAI_MODEL") ?? "gpt-5.6-luna"`.
   요구: 코드 상수로 하드코딩(`gpt-5.6-luna`), env 사용 제거.
2. **아침 체크인이 여러번 가능(버그)**: `/morning` 진입 시 `decision` state가 항상 `null`로 시작 →
   '퀘스트 수락'/'오늘은 패스' 버튼이 매번 노출되고, `결정 바꾸기`(page.tsx:424)로도 재결정 가능.
   DB는 `(ownerId,eventDate)` unique upsert라 행은 1개지만, **체크인 행위 자체에 가드가 없어** 무제한 반복됨.
   요구: **하루 한 번만** 체크인 가능하도록 프론트 락 + 서버 가드.
3. **LLM이 단발성**: 최근 세션 통계만 전달. `userState.coachMemory` 필드는 있으나 미사용이고,
   `app/page.tsx:252,275`가 state PUT마다 `coachMemory: []`로 덮어써서 저장돼도 삭제됨.
   요구 고도화 3종: (a) 오늘 이전/최근 체크인 인지, (b) 장기 메모리 활용, (c) 진행도 분석 강화.

## 변경 (What) — 3축(정확성/보안/UX) 점검 포함

### A. 모델 하드코딩
- `route.ts`: 상단에 `const OPENAI_MODEL = "gpt-5.6-luna";` 상수 추가.
- `getRuntimeSecret` 타입 유니온에서 `"OPENAI_MODEL"` 제거 → `"OPENAI_API_KEY"`만.
- `route.ts:176` → `const model = OPENAI_MODEL;`
- `.env.example`, `.dev.vars`에서 `OPENAI_MODEL` 줄 삭제.
- [보안] 키(OPENAI_API_KEY)는 계속 env 유지 — 하드코딩 금지(secret-scan 위반).

### B. 아침 체크인 1일 1회 (여러번 → 한 번)
- **서버 가드** (`route.ts` POST): decision 검증 직후, `storeMorningEvent` 전에
  `getTodayMorningEvent(ownerId, todayKey)` 조회. 이미 있으면 OpenAI 호출/재저장 없이
  `409 { code:"already_checked_in", coach: <기존 coachPlan>, decision:<기존> }` 반환.
  - DB 미설정(local) 시 서버 조회 불가 → 프론트 락으로 커버(best-effort).
- **프론트 락** (`morning/page.tsx`):
  - 마운트 시 오늘 체크인 여부 판단: localStorage `first-rep-morning-decisions`에서 `todayKey` 존재 여부 +
    (가능하면) 서버 morningEvent. 이미 있으면 `decision`/`coach`를 복원하고 **잠금 상태** 렌더.
  - 잠금 상태에서는 '퀘스트 수락'/'패스'/'결정 바꾸기' 숨김 → "오늘 체크인 완료" + 달력 이동만.
  - `choose()`에서 `already_checked_in` 응답 수신 시 에러 대신 잠금 상태로 전환(기존 plan 있으면 표시).
  - `결정 바꾸기` 버튼 제거(1일 1회와 모순).
- [정확성] todayKey는 프론트(로컬 TZ)와 서버(`dateKeyInSeoul`, Asia/Seoul) 기준이 다름 →
  서버는 서울 기준 유지, 프론트는 기존 `todayKey()` 유지(현행 동작 보존). 락 판정은 각자 소스 기준.

### C. LLM 역할 고도화
- **(a) 최근 체크인 인지**: `getRecentMorningEvents(ownerId, 7)` 조회 → 최근 7일 go/no_go 이력을
  coach input의 `recentCheckins`로 전달. 프롬프트에 "최근 출석 패턴을 참고" 규칙 추가.
- **(b) 장기 메모리**:
  - 코칭 성공 후 `userState.coachMemory`에 압축 메모 1건 append(날짜, decision, planLabel, focus 요약; 최근 30건 유지)
    후 upsert. 이때 기존 coachMemory 읽어 이어붙임.
  - input에 최근 coachMemory 5건 전달, 프롬프트에 "지난 코칭 메모와 모순되지 않게" 규칙 추가.
  - `app/api/state/route.ts` PUT: `coachMemory`가 요청에 **없으면 기존 값 보존**(덮어쓰지 않음).
  - `app/page.tsx:252,275`: `coachMemory: []` 전송 제거(필드 자체를 빼서 서버 보존 로직에 위임).
- **(c) 진행도 분석 강화**: response schema에 `progressNote: string`(required) 추가.
  프롬프트에 "최근 최고중량 대비 근거를 한 문장으로" 지시. `morning/page.tsx` coach 카드에 `progressNote` 렌더.
- [보안] coachMemory append 시 크기 상한(30건) + 문자열 길이 제한으로 무한 증가 방지.

## 결과 (Result)
- 모델은 코드 상수 1곳에서 관리(`gpt-5.6-luna`), env 의존 제거.
- 아침 체크인은 하루 1회로 잠김 — 재진입/재결정 불가, 서버도 중복 차단.
- 코치가 최근 출석 이력 + 장기 메모 + 진행 근거를 반영해 응답, 메모는 다음 날까지 지속.

## 검증
- `npm run build`(타입) 통과.
- `/qa` 또는 `/final-check`로 런타임 검증(중복 체크인 차단, progressNote 렌더, 메모리 보존).

## 영향 파일
- `app/api/morning-coach/route.ts` (모델 상수, 가드, context, 메모리 write, schema/prompt)
- `app/api/state/route.ts` (coachMemory 보존)
- `app/morning/page.tsx` (1일 1회 락 UI, progressNote 렌더, already_checked_in 처리)
- `app/page.tsx` (coachMemory:[] 전송 제거)
- `.env.example`, `.dev.vars` (OPENAI_MODEL 제거)
- `db/schema.ts` (변경 없음 — 기존 unique index 재사용)
