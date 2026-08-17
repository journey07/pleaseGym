# Plan: AI 분석, 상체/하체 분리 진단 + 운동 선택 평가

## 요청
"무게에만 집중한 느낌". 상체와 하체로 나눠 진단하고, 지금 하는 운동 종류가
목표(마른 체형에서 전신 근비대·두께·너비)에 최적인지도 같이 봐달라.
단, 운동 가짓수를 늘리고 싶지 않다. 시간 대비 근육이 가장 잘 붙는 종목으로
"제대로 하고 있는지"가 궁금한 것. 렌즈는 "시간 효율", 처방은 추가가 아니라 교체.

## 현재 문제
- 출력이 종목별 e1rm 추이(liftAnalysis)에 무게가 실림. 부위 밸런스는 한 줄.
- 모델에 넘기는 `stats.lifts`는 세션수 상위 8개뿐. 종목 선택을 평가하려면
  최근 28일 전체 종목 목록이 필요한데 없음.
- 상체/하체 묶음 수치가 없어 모델이 부위 8개를 매번 재조합해야 함.

## 변경 (3 파일)

### 1. app/api/training-report/route.ts
stats 추가 (서버 계산, 모델은 인용만)
- `regions`: 상체(가슴·등·어깨·팔) / 하체(허벅지·종아리) / 코어(복근·허리)
  각각 `{ parts, weeklySets, weeklyVolume, monthlyVolume, freq7, freq28 }`.
  `bodyParts` 합산.
- `exercises`: 최근 28일 고유 종목 전체(최대 30) `{ name, part, metric,
  assisted, sessions28, sets28 }`. 세션수 내림차순. `lifts`(top 8 시계열)와
  별개로 "무엇을 하고 있는지" 인벤토리.

응답 스키마/타입/`isTrainingReport` 필드 추가
- `upperBody: string`: 상체 진단 2~3문장. 가슴/등/어깨/팔 각각 되는 곳·구멍,
  두께(로우·수평당기기)/너비(측면삼각근·수직당기기) 관점.
- `lowerBody: string`: 하체 진단 2~3문장. 대퇴사두/후면(햄·둔근·힙힌지)/
  종아리 커버 여부. 상체 대비 볼륨 비율 언급.
- `exerciseSelection: Array<{ name, verdict: "keep"|"swap"|"drop", reason }>`
  최대 6. keep=시간 대비 효율 높은 핵심 종목(왜 좋은지 한 줄), swap=같은
  시간에 더 많이 붙는 대체가 있음(reason에 "X 대신 Y" 명시. 빠진 패턴은
  저효율 종목을 밀어내는 swap으로만 들어옴), drop=중복·저효율이라 빼도 됨.
  "add" 없음: 총 종목 수가 늘어나는 처방 금지.
- `efficiencyVerdict: string`: "지금 제대로 하고 있나"에 대한 한 줄 총평
  (예: "핵심 8종은 맞게 잡았고, 레그 익스텐션·이너타이에 시간이 샌다").
- `max_output_tokens` 2400 → 3200 (필드 3개 증가분).

프롬프트 보강
- "출력 필드"에 upperBody / lowerBody / exerciseSelection 정의 추가.
- 종목 평가 기준 명시: 시간 대비 근비대 효율. 다관절 복합운동이 1순위이고,
  고립운동은 일괄 저효율 판정 금지. 판단은 우선순위로: 패턴 커버리지(수평밀기·
  수직밀기·수평당기기·수직당기기·스쿼트·힙힌지·종아리)에 빈 패턴이 있으면
  그 패턴이 고립운동보다 우선이므로 빈 패턴을 저효율 종목(내전/외전 머신,
  중복 컬 등)과 맞바꾸는 swap 제안. 패턴이 다 채워져 있으면 약한 부위
  고립운동(예: 스쿼트 뒤 레그 익스텐션 마무리)은 keep. 같은 고립운동이 최다
  빈도인데 큰 패턴이 비어 있으면 "빼라"가 아니라 "순서·세트 줄이고 빈 패턴에
  자리 내줘라"로.
  같은 패턴 중복(컬 3종, 풀다운+암풀다운)은 drop. 이상적 세트는 8~10종.
  `stats.exercises` 전체를 근거로 판단, 목록에 없는 종목을 "하고 있다"고
  말하지 않기.
- liftAnalysis는 "보조" 그대로 두되 최대 6에서 4로 줄여 비중 낮춤.

### 2. app/page.tsx
- `TrainingReport` 타입에 `upperBody?`, `lowerBody?`, `exerciseSelection?`
  (optional. 서버 옛 응답/스키마 불일치 시에도 렌더 안 깨지게).
- 렌더 순서: overall → 부위 밸런스 → 상체 진단 → 하체 진단 → 방치 부위
  → 운동 선택 → 체중·볼륨 → 빈도 → 종목 추이 → NEXT 7 DAYS → warning.
- 상체/하체는 기존 `.report-section` 재사용(라벨만 "상체 진단"/"하체 진단").
- 운동 선택은 `.report-picks` 리스트: 상단에 efficiencyVerdict 한 줄, 아래
  verdict 배지(유지/교체/제외) + 종목명 + reason. 기존 `.report-lift` 행 톤과 동일(border-bottom 행, 작은 배지).

### 3. app/globals.css
- `.report-picks`, `.report-pick`, `.pick-keep/.pick-swap/.pick-drop` 배지 스타일.
  기존 report 톤(모노 라벨, soft-line, accent 한 색) 유지. 새 컬러 도입 X.
- 모바일 미디어쿼리에서 배지 줄바꿈 안 깨지게 `flex-wrap`.

## 건드리지 않음
- bodyPartStats/bodyPart 분류 로직, DB 스키마, morning-coach, 계산식(e1rm 등).
- balanceSummary/neglectNote/bodyweightNote 등 기존 필드와 UI 위치.

## 검증
- `npm run build` + `npx tsc --noEmit` 통과.
- 실제 DB 기록으로 `/api/training-report` 호출. 응답에 upperBody/lowerBody/
  exerciseSelection이 채워지고, exerciseSelection의 name이 전부
  stats.exercises에 있는 종목인지(없는 종목을 지어내지 않는지) 확인.
- 화면에서 상체/하체/운동 선택 섹션 렌더 확인 (모바일 폭 포함).
- /final-check.

---

# Part B: 모닝 코치, 오늘 종목 + 목표 무게 제안 (상/하체 분할 인식)

## 요청
모닝 코치는 오늘 할 운동의 종목과 무게를 조언한다. 살짝씩이라도 무게가 늘게.
보통 상체/하체를 번갈아 하니 그걸 파악해서 오늘 어느 쪽인지 잡고 조언.
메인 코치(training-report)는 지금처럼 종합 조언 (Part A).

## 이전 결정과의 관계 (plan-morning-advice-only.md)
그때 뺀 건 "AI가 지어낸 운동 목록을 메인 달력 draft에 자동 주입"이었다.
이번엔 (1) 종목은 사용자가 실제로 한 최근 같은 분할 세션에서 가져오고,
(2) 무게는 서버가 마지막 수행 기록에서 계산한 값을 모델이 인용만 하며,
(3) 화면에 표시만 하고 draft 주입은 하지 않는다. 자동 주입 금지 결정은 유지.

## 변경 (2 파일 + CSS)

### 1. app/api/morning-coach/route.ts
서버 계산 추가 (`getCoachStats` 확장)
- 세션별 분할 판정 `splitOf(session)`: 종목 bodyPart(수동 우선, 없으면
  inferBodyPart)로 세트를 상체(가슴·등·어깨·팔) / 하체(허벅지·종아리·허리)로
  집계. 한쪽이 70%+ 면 upper/lower, 아니면 full. distance만 있으면 cardio.
- `recentSplits`: 최근 6세션 `{ date, split, exercises: [name...] }`.
- `suggestedSplit`: 마지막 non-cardio 세션의 반대(upper→lower, lower→upper).
  full이거나 기록 없으면 bodyParts.daysSinceLast가 더 오래된 쪽.
- `lastSameSplit`: suggestedSplit과 같은 분할의 가장 최근 세션 종목별
  `{ name, metric, assisted, sets, topWeight, repsAtTop, lastDate, suggested }`.
  `suggested`는 서버 규칙:
  - 중량: repsAtTop ≥ 8 → weight +2.5kg(단 5% 상한), 아니면 같은 무게 reps+1
  - 어시스티드: 보조 −2.5kg (0 미만 불가), reps 유지
  - 맨몸: reps +1
  - 거리: 그대로 (제안 없음)
  기록이 없으면 lastSameSplit = [] (모델은 "첫 기록 만들자").

응답 스키마/타입/`isMorningCoachResponse` 필드 추가
- `todaySplit: "upper" | "lower" | "full" | "rest"`: 오늘 권장 분할.
  no_go면 rest.
- `todayPlan: Array<{ name, target, note }>` 최대 8. go일 때만, no_go면 [].
  name은 lastSameSplit의 종목명 그대로(지어내기 금지). target은 "62.5kg × 8"
  / "보조 30kg × 6" / "12회" 같은 짧은 문자열. note는 한 줄(왜 이 무게인지,
  또는 Part A 원칙에 따라 1개까지 "X 대신 Y" 교체 제안 가능. 교체 시
  note에 명시).

프롬프트 보강
- 입력 설명에 recentSplits / suggestedSplit / lastSameSplit 추가.
- 규칙: go면 todaySplit=suggestedSplit, todayPlan은 lastSameSplit 종목을
  순서대로 채우되 suggested 값을 인용. 5% 초과 증량 금지 유지. 지난 코칭
  메모(coachMemory)와 recentCheckins로 연속 출석·정체 언급은 그대로.
- message는 지금 3~4문장 유지하되 ①몸 스냅샷 ②피드백 ③오늘 분할과 무게
  방향("오늘은 하체, 스쿼트 +2.5") 한 줄. 세부는 todayPlan에.
- `max_output_tokens` 1400 → 2000.

### 2. app/morning/page.tsx
- `CoachResult`에 `todaySplit?`, `todayPlan?` (optional, 캐시된 옛 응답 호환).
- coach-result에서 message 아래에 `.coach-plan` 블록: 라벨 "TODAY · 하체"
  (todaySplit 한글: 상체/하체/전신), 행마다 종목명 + target(모노) + note.
  no_go 또는 todayPlan 빈 배열이면 렌더 안 함.
- draft 주입 없음. "운동 시작 →" 링크는 그대로 `/`.

### 3. app/globals.css
- `.coach-plan`, `.coach-plan-row` 스타일. `.coach-progress`와 같은 톤
  (soft-line 상단선, 모노 라벨, target은 `.day-lift strong` 톤).

## 건드리지 않음
- morning_events 저장 구조(coach_plan jsonb에 새 필드가 그냥 들어감),
  coachMemory 포맷, go/no_go 흐름, 영상/미션 HUD.
- app/page.tsx의 `first-rep-coach-draft` 소비 로직(죽은 코드 그대로).

## 검증 (Part B)
- 실제 DB로 `POST /api/morning-coach { decision: "go" }` 호출:
  todaySplit이 마지막 세션의 반대인지, todayPlan의 name이 전부 lastSameSplit
  에 있는지, target 무게가 마지막 topWeight의 +5% 이내인지.
- no_go 응답에 todayPlan=[] / todaySplit=rest.
- 모닝 화면 렌더(모바일 폭). 결정 바꾸기 → 재생성 정상.
- build + tsc + /final-check (Part A와 함께 1회).
