# morning-checkin-llm

## Purpose
아침 체크인(go/no_go)이 현재 같은 결정을 무한 반복 선택 가능해 XP·코치 호출이 중복 실행되고, `app/page.tsx`의 state PUT이 `coachMemory: []`를 항상 전송해 코치 장기 메모리를 파괴한다. 이 플랜은 (1) 같은 결정 중복 커밋을 멱등 처리(전환은 허용), (2) 코치 실패 시 재시도 분리, (3) LLM 입력 고도화(최근 7일 이력 + 장기 메모리 + progressNote)를 구현한다. 모델명은 env가 아닌 코드 상수로 고정한다.

배경 근거: `.sisyphus/drafts/morning-checkin-llm.md` (R1~R4 인터뷰 확정), `.sisyphus/notepads/morning-checkin-llm/learnings.md` (마운트 포인트 검증 완료 — 본 플랜 작성 시 실제 소스 재확인함).

## Scope
- IN:
  - `app/api/morning-coach/route.ts` — 모델 상수화, 5분기 서버 contract, 7일 이력 조회, coachMemory append/전달, responseSchema `progressNote`
  - `app/api/state/route.ts` — coachMemory 보존 로직 (키 부재 시 기존값 유지)
  - `app/morning/page.tsx` — 중복 선택 가드(클라), `already_checked_in` 처리, progressNote 렌더, DB 미설정 로컬 localStorage best-effort 캐시
  - `app/page.tsx` — L252, L275 `coachMemory: []` 전송 제거 (덮어쓰기 버그 수정)
  - `.env.example`, `.dev.vars` — `OPENAI_MODEL` 라인 제거
- OUT:
  - `db/schema.ts` 변경 없음 (morningEvents (ownerId,eventDate) uniqueIndex 하루 1행 구조 이미 존재 — 마이그레이션 불필요)
  - todayKey TZ 통일 작업 없음 (서버 `dateKeyInSeoul()` = Asia/Seoul, 프론트 `todayKey()` = 로컬 TZ — **각 소스 기준 그대로 유지**, 통일 시도 금지)
  - 인증/멀티유저, XP 산정식 변경, UI 리디자인
  - `docs/plan-morning-checkin-llm.md` (구 초안, "완전 잠금" 전제라 폐기 대상 — 본 플랜이 대체. 수정하지 않고 방치해도 무해)

## Tasks

- [ ] T1 — OpenAI 모델명 코드 상수 하드코딩 (R1)
  - Files: `app/api/morning-coach/route.ts`, `.env.example`, `.dev.vars`
  - 작업:
    - `route.ts` 상단(타입 선언 근처)에 `const OPENAI_MODEL = "gpt-5.6-luna";` 추가.
    - L78 `getRuntimeSecret`의 union 타입에서 `"OPENAI_MODEL"` 제거 → `(name: "OPENAI_API_KEY")`.
    - L176 `const model = getRuntimeSecret("OPENAI_MODEL") ?? "gpt-5.6-luna";` 삭제, 이후 `model` 사용처(L187 body, L229 store, L234 응답)는 `OPENAI_MODEL` 상수 참조.
    - `.env.example:2`, `.dev.vars:2`의 `OPENAI_MODEL=gpt-5.6-luna` 라인 삭제. `OPENAI_API_KEY` 라인은 유지.
  - Acceptance:
    - `grep -rn "OPENAI_MODEL" app/ .env.example .dev.vars` 결과에 `process.env` 참조·env 파일 라인이 0건, `route.ts` 내 상수 선언 1건 + 사용처만 존재.
    - `npx tsc --noEmit` 통과 (union 타입 축소로 인한 타입 에러 없음).

- [ ] T2 — 서버 5분기 contract: 결정 멱등 + 코치 재시도 분리 (R2 서버측 + R3)
  - Files: `app/api/morning-coach/route.ts`
  - 작업:
    - 오늘 event 조회 함수 추가: `getTodayMorningEvent()` — `isDatabaseConfigured()` false면 `null` 반환, 아니면 `morningEvents`에서 `(ownerId(), dateKeyInSeoul())`로 select 1행.
    - POST 핸들러의 기존 L163 무조건 `storeMorningEvent(body.decision)` 호출을 아래 분기로 교체 (draft R3 contract 그대로):
      1. `existing == null` → 첫 체크인: `storeMorningEvent(decision)` → OpenAI 호출 → 성공 시 plan 재저장.
      2. `existing.decision === body.decision && existing.coachPlan != null` → **OpenAI 호출 없이** `NextResponse.json({ coach: existing.coachPlan, model: existing.model ?? OPENAI_MODEL, code: "already_checked_in" })` 반환 (200). 저장된 coachPlan은 `isMorningCoachResponse`로 검증 후 반환하고, 검증 실패 시 분기 3(재시도)로 처리.
      3. `existing.decision === body.decision && existing.coachPlan == null` → 코치 재시도: decision 재저장 없이(또는 upsert 멱등이므로 호출해도 무해) OpenAI 호출 → plan 저장.
      4. `existing.decision !== body.decision` → 전환 허용: `storeMorningEvent(새 decision)` (upsert가 decision만 갱신, 다중 행 생성 없음 — 기존 onConflictDoUpdate 그대로 활용) → OpenAI 호출 → plan 저장.
      5. DB 미설정(`existing == null`이며 `isDatabaseConfigured()` false) → 분기 1과 동일하게 OpenAI 호출 (저장은 skip — 기존 `storeMorningEvent`가 이미 no-op). 중복 방지는 T5의 프론트 localStorage 가드가 best-effort 담당.
    - `getTodayMorningEvent()` DB 조회 실패(Neon 다운)는 try/catch로 `null` 취급 — 기존 L164 "결정은 브라우저에 캐시됨" 철학 유지.
  - Acceptance:
    - 같은 decision + coachPlan 존재 상태에서 POST 2회차: 응답 200 + `code: "already_checked_in"` + OpenAI fetch 미발생 (서버 로그/네트워크 또는 mock으로 확인).
    - 같은 decision + coachPlan null(코치 실패 이력) 상태에서 POST: OpenAI 호출 발생 + 성공 시 morningEvents 행에 coachPlan 채워짐.
    - decision 전환(go→no_go) POST: morningEvents는 여전히 오늘 1행, decision 필드만 갱신, 새 coachPlan 저장.
    - DB 미설정 로컬(.env에 DATABASE_URL 없음)에서 POST가 500 없이 기존과 동일하게 동작.

- [ ] T3 — LLM 입력 고도화: 7일 이력 + coachMemory 전달·append + progressNote 스키마 (R4a/b/c 서버측)
  - Files: `app/api/morning-coach/route.ts`
  - 작업:
    - (R4a) `getRecentCheckins()`: morningEvents에서 `ownerId()` + eventDate ≥ 오늘-7일(문자열 비교 가능 — eventDate는 `YYYY-MM-DD` text) 조회, `[{ date, decision }]` 배열로 축약. DB 미설정/실패 시 `[]`.
    - (R4b-input) `getCoachMemory()`: userState.coachMemory에서 최근 5건 읽기. DB 미설정/실패 시 `[]`.
    - OpenAI input의 user content JSON에 `recentCheckins`, `coachMemory` 필드 추가. systemPrompt(L64)에 두 입력의 해석 규칙 추가: "recentCheckins의 go/no_go 패턴과 coachMemory의 과거 코칭 맥락을 근거로 오늘 메시지와 progressNote를 작성하라" 취지 + progressNote 규칙("최근 이력에서 실제 관찰된 사실만 근거로 1~2문장, 데이터 부족 시 부족하다고 명시. **(I2) no_go일 때는 진행도 분석 대상이 없으므로 짧은 격려 또는 빈 문자열 허용**").
    - (R4c) `responseSchema`(L33)에 `progressNote: { type: "string" }` 추가 + `required` 배열에 포함. `MorningCoachResponse` 타입(L7)과 `isMorningCoachResponse` 가드(L127)에 `progressNote: string` 반영.
    - (R4b-append) OpenAI 성공 후: userState를 읽어 기존 coachMemory 배열에 `{ date: dateKeyInSeoul(), decision, headline, nextAction, progressNote }` 형태 메모 1건 append → 같은 date 기존 항목은 교체(하루 1건) → 최근 30건으로 slice → 각 항목 문자열 필드 길이 제한(예: 200자) → userState upsert (workoutHistory/favorites는 건드리지 않는 partial update: `onConflictDoUpdate` set에 coachMemory와 updatedAt만). insert 초기값이 필요한 신규 행이면 workoutHistory/favorites는 `[]` default. append 실패는 try/catch로 무시(코치 응답 반환 우선 — 기존 L228-232 패턴 동일).
  - Acceptance:
    - OpenAI 요청 body(user content JSON)에 `recentCheckins`(≤7건), `coachMemory`(≤5건) 포함.
    - responseSchema의 `required`에 `progressNote` 포함 + strict:true 유지 → OpenAI 응답 파싱 결과에 progressNote 문자열 존재.
    - 코치 성공 후 userState.coachMemory 길이가 +1 (같은 날 재실행 시 교체로 +0), 30건 초과 시 오래된 것부터 탈락.
    - coachMemory append가 실패해도(예: DB 다운) 클라이언트는 coach 응답을 정상 수신.
    - `npx tsc --noEmit` 통과.

- [ ] T4 — coachMemory 덮어쓰기 버그 수정 (R4b 보존)
  - Files: `app/api/state/route.ts`, `app/page.tsx`
  - 작업:
    - `state/route.ts` PUT: L51 `const coachMemory = Array.isArray(body.coachMemory) ? body.coachMemory : [];` 를 "키 부재 시 보존" 시맨틱으로 변경 — `body.coachMemory`가 배열이면 그 값으로 overwrite, **undefined면 insert values에는 `[]`(신규 행 default), onConflictDoUpdate set에서는 coachMemory 필드 자체를 생략**하여 기존값 보존. (morning-coach 라우트의 partial update 패턴과 동일.)
    - `app/page.tsx` L252 `coachMemory: [],` 라인 삭제, L275 body에서 `coachMemory: []` 제거 → `JSON.stringify({ history, favorites })`.
  - Acceptance:
    - coachMemory가 N건 저장된 상태에서 `{history, favorites}`만 담은 PUT 실행 → GET 시 coachMemory 여전히 N건.
    - `coachMemory: [...]`를 명시적으로 담은 PUT은 그 값으로 overwrite (기존 명시적 쓰기 경로 호환).
    - `grep -n "coachMemory" app/page.tsx` 결과 0건.
    - history/favorites 유효성 검증(L47) 및 400/413 동작은 기존과 동일.

- [ ] T5 — 프론트 중복 선택 가드 + already_checked_in 처리 + progressNote 렌더 (R2 클라측 + R4c 렌더)
  - Files: `app/morning/page.tsx`
  - 작업:
    - `CoachResult` 타입에 `progressNote: string` 추가.
    - 마운트 시(기존 L181 useEffect) localStorage `first-rep-morning-decisions`에서 오늘(`todayKey()` — 프론트 로컬 TZ 기준 유지) 항목을 읽어 `todayDecision` state로 복원. 오늘 결정이 있으면 결정 화면 대신 결정 상태 표시.
    - `choose(nextDecision)` 가드: `todayDecision === nextDecision`이고 로컬 캐시에 성공한 coach 결과가 있으면 → API 재호출 없이 캐시 렌더 (중복 커밋/코치 재실행 차단). 같은 결정 + 캐시 없음(코치 실패)이면 → POST 진행 (R3 재시도). 다른 결정이면 → POST 진행 (전환 허용). **완전 잠금 UI 금지** — "결정 바꾸기" 버튼(L424)은 유지하되, 반대 결정으로의 전환 경로로 동작.
    - `storeDecision`(L129)은 전환/첫 결정 시에만 호출 (같은 결정 재선택 시 호출 안 함 → decidedAt 불필요 갱신 방지. date filter로 XP 중복은 원래 없지만 시맨틱 명확화).
    - 성공 응답 처리: `data.code === "already_checked_in"`이어도 `data.coach` 렌더 (서버 캐시 플랜). 성공한 coach 결과를 localStorage `first-rep-coach-result` 키에 `{ date, decision, coach }`로 저장 → DB 미설정 로컬에서도 same-decision 재선택 시 best-effort 캐시로 동작. 날짜 다르면 무시/삭제.
    - (I1) **마운트 시 코치 카드 복원**: 오늘 `first-rep-coach-result` 캐시가 존재하면 `todayDecision`뿐 아니라 `coach` state와 `status="done"`까지 복원해 새로고침 후에도 재-POST 없이 이전 코치 카드를 즉시 렌더. 날짜 불일치 캐시는 삭제.
    - 코치 결과 카드(L395~)에 progressNote 렌더 블록 추가 (예: safetyNote 위에 "PROGRESS" 라벨 + 텍스트. 기존 morning-card 스타일 톤 유지, 새 그라디언트/장식 금지).
  - Acceptance:
    - 시나리오 A(중복): go 선택 → 코치 성공 → "결정 바꾸기" → 다시 go → 네트워크 탭에 `/api/morning-coach` POST 미발생, 캐시된 플랜 즉시 렌더, TOTAL XP 불변.
    - 시나리오 B(전환): go → no_go → POST 발생, 새 코치 플랜 렌더, localStorage 오늘 항목의 decision이 no_go로 교체(행 추가 없음).
    - 시나리오 C(재시도): OPENAI_API_KEY 미설정으로 코치 실패 → "다시 연결" 클릭 → 같은 decision으로 POST 재발생 (가드에 막히지 않음).
    - 시나리오 D(DB 미설정 로컬): DATABASE_URL 없이 시나리오 A 반복 → localStorage 캐시로 동일하게 중복 차단.
    - progressNote가 코치 카드에 표시됨 (go/no_go 모두).
    - 새로고침 후에도 오늘 결정 상태가 복원됨 (localStorage 기준).

- [ ] T6 — 통합 검증 및 회귀 확인
  - Files: (수정 없음 — 검증 전용)
  - 작업: `npm run build` + `/qa` 런타임 검증 (아래 Verification 섹션 절차).
  - Acceptance:
    - `npm run build` exit 0.
    - T2~T5의 모든 시나리오 acceptance 재현 통과.
    - 기존 플로우 회귀 없음: usePlan(코치 플랜 → `/?coach=today` 초안 흡수), skip-hold 3초 포기, 미션 HUD streak/weekGoes/totalXp 계산.

## Guardrails
- Money/data-sensitive:
  - `OPENAI_API_KEY`는 반드시 env 유지 — 코드/플랜/커밋에 키 값 하드코딩 금지 (secret-scan 훅 대상).
  - userState.workoutHistory/favorites는 coachMemory append 시 **절대 덮어쓰지 않는다** (partial update만). 사용자 운동 기록이 최고 가치 데이터.
  - OpenAI 호출 비용: 중복 분기(T2 분기 2)에서 호출이 실제로 skip되는지 반드시 확인 — 멱등 분기가 깨지면 매 클릭마다 과금.
  - (I3) coachMemory read-modify-write 레이스: 단일 사용자(FIRST_REP_OWNER_ID) + 아침 체크인 순차성 전제로 수용된 위험. 동시 POST 시 한쪽 append 유실 가능하나 실질 발생률 낮음 — 멀티유저 도입 시 재검토.
- Do NOT:
  - **완전 잠금 구현 금지** — go↔no_go 전환은 항상 허용. "오늘 결정 완료, 변경 불가" 류 UI/서버 응답 금지 (R2 인터뷰 정정 사항).
  - `db/schema.ts` 수정·마이그레이션 생성 금지 (기존 스키마로 충분).
  - 서버 `dateKeyInSeoul()`(Asia/Seoul)과 프론트 `todayKey()`(로컬 TZ)를 통일하려 들지 말 것 — 각 소스 기준 유지. 자정 부근 불일치는 알려진 수용 사항.
  - morningEvents에 하루 다중 행 삽입 금지 — (ownerId,eventDate) upsert 1행 유지.
  - `docs/plan-morning-checkin-llm.md`(구 초안)를 참조·부활시키지 말 것 (완전 잠금 전제 = 폐기됨).
  - responseSchema strict:true 해제 금지. `additionalProperties: false` + required 전체 나열 유지 (OpenAI json_schema strict 요구사항).

## Rollback
- 전 변경이 코드 5파일 + env 예시 2파일 한정, 마이그레이션 없음 → `git revert <커밋>` 단일 스텝으로 완전 복구.
- 데이터 측: coachMemory에 append된 항목은 구 코드와도 호환(jsonb unknown[] — 구 코드는 읽지 않으므로 무해). morningEvents는 구조 변경 없음. 롤백 후 데이터 정리 불필요.
- 부분 롤백: T1(모델 상수)만 되돌릴 경우 `.env.example`/`.dev.vars`에 `OPENAI_MODEL` 라인 복원 필요 — 단 revert가 자동 처리.

## Verification
- 빌드/타입: `npm run build` + `npx tsc --noEmit` — T1, T3의 타입 반영(progressNote, getRuntimeSecret union 축소) 증명.
- 정적 grep:
  - `grep -rn "process.env.OPENAI_MODEL\|getRuntimeSecret(\"OPENAI_MODEL\"" app/` → 0건 (T1).
  - `grep -n "coachMemory" app/page.tsx` → 0건 (T4).
  - `grep -n "progressNote" app/api/morning-coach/route.ts app/morning/page.tsx` → schema/타입/가드/렌더 각 위치 존재 (T3, T5).
- 런타임 (`npm run dev` + `/qa`, DB·API키 설정 환경):
  - T2 분기 2: 같은 decision 2회 POST → 서버 콘솔/네트워크에서 OpenAI fetch 1회만 발생 + 2회차 응답에 `already_checked_in` — curl 2연속 호출로 재현 가능: `curl -s -X POST localhost:3000/api/morning-coach -H 'Content-Type: application/json' -d '{"decision":"go","context":{}}'` ×2, 2회차 응답 JSON의 `code` 필드 확인.
  - T2 분기 3: DB에서 오늘 행의 coach_plan을 null로 만든 뒤(또는 API 키 제거→실패 유도→키 복원) 재POST → coachPlan 채워짐 확인 (Neon 콘솔 select).
  - T2 분기 4: decision 반대값 POST → `select count(*) from morning_events where event_date = <today>` = 1 유지 + decision 갱신 확인.
  - T4: coachMemory N건 상태에서 달력 페이지 열고 기록 수정(자동 PUT 유발) → `/api/state` GET으로 coachMemory N건 유지 확인.
  - T5: 브라우저 시나리오 A~D를 Chrome MCP(`/ui-chrome-verify`)로 실행, 네트워크 요청 목록 + 코치 카드 스크린샷(progressNote 노출 포함) 채증.
  - DB 미설정 경로: `DATABASE_URL` 임시 제거 후 dev 서버 재시작 → 시나리오 D + `/api/morning-coach` 200 확인.
- 완료 선언 전 `/final-check` (빌드+테스트+리뷰+QA 통합) 필수 — 검증 스킬 대체 금지 룰 적용.

## 성능 / 확장성
- 성능:
  - 중복 분기(T2 분기 2)는 OpenAI 호출·과금을 0으로 만든다 — DB select 1회로 대체 (Neon 단건 PK-adjacent 조회, ms 단위).
  - POST당 추가 DB 조회는 최대 3회(오늘 event, 7일 이력, coachMemory) — 모두 인덱스/PK 경유 단건·소량 조회. 필요 시 오늘 event + 7일 이력은 단일 쿼리(eventDate ≥ 오늘-7)로 합쳐 2회로 축소 가능.
  - coachMemory는 30건 × 필드당 200자 캡 → userState 행 크기 상한 고정, PUT 413 한도(500KB)에 영향 없음. OpenAI input에는 5건만 전달 → 토큰 증가 미미 (수백 토큰 수준).
  - 프론트 localStorage 캐시 히트 시 네트워크 왕복 0회 렌더.
- 확장성:
  - ownerId 단일 사용자 전제(`FIRST_REP_OWNER_ID`)는 기존 구조 그대로 — 멀티유저 도입 시에도 morningEvents (ownerId,eventDate) 인덱스와 userState PK가 그대로 유효해 쿼리 변경 불필요.
  - 코치 메모 포맷을 `{date, decision, headline, nextAction, progressNote}` 객체로 고정해 이후 필드 추가가 하위호환 (jsonb unknown[]).
  - 5분기 contract는 순수 함수적 판정(existing 상태 → 분기)이라 추후 결정 종류 추가(go/no_go 외) 시 enum 확장만으로 대응.

## 완료 체크리스트
(3축: 기능 / 디자인 / 엣지)

### 기능 완성
- [ ] 기능: 같은 결정 재선택 시 OpenAI 미호출 + `already_checked_in` 캐시 플랜 반환 (서버 T2 분기 2 + 클라 T5 가드 모두)
- [ ] 기능: go↔no_go 전환 시 정상 재코칭 + morningEvents 오늘 1행 유지 (분기 4)
- [ ] 기능: 코치 실패(coachPlan null) 상태에서 "다시 연결"로 같은 결정 재시도 성공 (분기 3)
- [ ] 기능: OPENAI_MODEL이 코드 상수 단일 소스, env 참조 0건
- [ ] 기능: coach input에 recentCheckins(≤7일)·coachMemory(≤5건) 포함 + 응답에 progressNote 필수 포함
- [ ] 기능: state PUT에서 coachMemory 키 부재 시 기존값 보존, 명시 배열 시 overwrite

### 디자인 품질
- [ ] 디자인: progressNote가 코치 카드에 기존 morning-card 톤(라벨+본문 패턴)으로 렌더 — 새 그라디언트/AI-slop 패턴 없음
- [ ] 디자인: 새로고침 후 오늘 결정 상태 복원 화면이 기존 decision-lock 스타일 재사용 (완전 잠금 문구 없음, "결정 바꾸기" 경로 노출 유지)
- [ ] 디자인: 캐시 플랜 즉시 렌더 시 로딩 스피너 플래시 없음 (already_checked_in / localStorage 히트 경로)
- [ ] 디자인: 미션 HUD(streak/weekGoes/totalXp) 수치가 중복 선택 후에도 변동 없음

### 엣지케이스 방어
- [ ] 엣지: DB 미설정(DATABASE_URL 없음) 로컬 — POST 200 유지 + localStorage 가드로 중복 차단 (시나리오 D)
- [ ] 엣지: Neon 일시 다운 — 오늘 event 조회 실패 → null 취급으로 코치 진행, coachMemory append 실패해도 coach 응답 정상 반환
- [ ] 엣지: 자정 부근 TZ 불일치(서버 Seoul vs 프론트 로컬) — 각 소스 기준 동작 유지, 통일 시도 흔적 없음
- [ ] 엣지: 저장된 coachPlan이 스키마 불일치(구버전 progressNote 없음)일 때 캐시 반환 대신 재시도 분기로 폴백
- [ ] 엣지: 같은 날 코치 재실행 시 coachMemory 같은 date 항목 교체(+0), 30건 초과 시 오래된 항목 탈락
