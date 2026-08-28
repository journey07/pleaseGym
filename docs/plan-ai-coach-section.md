# Strength Report → AI Coach 섹션 재구성

작성 2026-08-28. 결정 근거: 인전님 선택 3건(코치 카드만 제거 / 종목·부위 추세 둘 다 계산 / 상하체 섹션에 진단+추세+처방).

## 배경

현재 메인의 리포트는 13개 필드가 세로로 나열된다(overall → balanceSummary → upperBody →
lowerBody → neglectNote → efficiencyVerdict → exerciseSelection → bodyweightNote →
frequencyComment → liftAnalysis → actionItems → warning). 읽는 사람이 어디를 봐야 할지
알 수 없다. 상하체 분할로 훈련하는데 정보는 부위 기준으로 묶여 있지 않다.

추세 판정도 없다. `stats.lifts`에 시계열 숫자를 넘기고 AI가 말로 흐름을 서술한다.
성장·정체·하락의 판정 기준이 코드에 없으니 매번 표현이 달라지고 숫자가 어긋날 수 있다.

## 결정

- 종목 추세는 **서버가 계산**한다. AI는 그 결론을 해석만 하고 숫자를 만들지 않는다.
- 화면은 메인 / 요약 / 상체 / 하체 / 종목 정리 5블록으로 재편한다.
- morning coach는 AI 부분만 제거한다. 오늘의 퀘스트(go/no_go)는 유지 대상이다.

## 제약 (사전 조사에서 확인)

`morning_events` 테이블의 읽기·쓰기가 전부 `app/api/morning-coach/route.ts` 안에 있다
(263행 insert, 300행 select, 330행 최근 체크인 조회). 오늘의 퀘스트를 살리려면 이 파일을
통째로 지울 수 없다. AI 호출부만 걷어내고 decision CRUD만 남긴다.

## 변경

### A. morning coach 제거 (AI 부분만)

`app/api/morning-coach/route.ts` → `app/api/morning-decision/route.ts`로 이동.

- 제거: `systemPrompt`, `responseSchema`, OpenAI 호출부, `getCoachStats`, `planExercise`,
  `progressionFor`, `formatTargetNumber`, `computeBodyPartStats`/`neglectedParts` import,
  코치 관련 타입(`CoachResult`, `CoachStats`, `LastSameSplitExercise`), 분할 추정 로직
- 유지: `getTodayMorningEvent`, decision upsert, GET(오늘 decision 조회), POST(decision 저장)
- POST 응답에서 `coach` 필드 제거. `coach_plan` 컬럼은 남기되 더 이상 쓰지 않는다(마이그레이션 없음)

`app/briefing/page.tsx`

- 제거: `CoachResult` 타입, localStorage 캐시(`first-rep-coach-result`) 저장/복원,
  `coach` state, 코치 로딩/에러/결과 카드 렌더링(약 987~1060행), `splitLabel`
- 유지: 퀘스트 카드, decision 전송, 미션 HUD(vision-card), 체중, 영상, 스케줄
- fetch URL 2곳(343행, 673행)을 `/api/morning-decision`으로 변경
- decision 전송 후 코치 결과를 기다리던 status 흐름을 즉시 완료로 단순화

`app/globals.css`: `.coach-*` 클래스 제거(130~149행 구간). 메인에서 새로 쓸 클래스와 이름이
겹치지 않도록 먼저 지운다.

### B. 추세 계산 (신규 `app/lib/progressTrend.ts`)

순수 모듈. 세션 배열과 todayKey를 받아 계산한다. `bodyPartStats`의 시그니처는 건드리지 않는다.

```
export type LiftVerdict = "growing" | "stalled" | "declining" | "idle";

export type LiftTrend = {
  name: string;
  region: "upper" | "lower" | "core" | "other";
  verdict: LiftVerdict;
  changePct: number;      // 최근 28일 첫 점 → 마지막 점
  from: number; to: number;
  unit: "kg" | "회";
  sessions: number;
  daysSinceLast: number;
  note: string;           // "20→50kg" / "55kg 3세션 동일"
};
```

기준값: 중량 종목은 `sessionLoad`(없으면 `e1rm`), 맨몸 종목은 `topReps`.
어시스티드는 이미 실부하로 환산된 값을 쓴다.

판정 순서(위에서부터 먼저 걸리는 것):

| 조건 | 판정 |
|---|---|
| `daysSinceLast >= 14` | idle |
| `sessions < 2` | 목록에서 제외(판정 보류) |
| `changePct <= -10` | declining |
| 최근 3세션 이상 `topWeight` 동일 && `changePct < 3` | stalled |
| `changePct >= 3` | growing |
| 그 외 | stalled |

부위별:

```
export type RegionTrend = {
  region: "upper" | "lower" | "core";
  setsThisWeek: number;
  setsPrevWeek: number;
  changePct: number;
  verdict: "up" | "flat" | "down";
};
```

`±10%`를 up/flat/down 경계로 쓴다. 부위 분류는 기존 `REGION_PARTS`를 재사용한다.

### C. 응답 스키마 재구성 (`app/api/training-report/route.ts`)

```
headline: string              24자 이내
verdict: string               한 줄 총평 — 지금 과부하가 되고 있는가
overall: string
frequencyComment: string
bodyweightNote: string
coreNote: string              신규. 복근·허리 한 줄
upper: { diagnosis: string; prescription: string }
lower: { diagnosis: string; prescription: string }
efficiencyVerdict: string
exerciseSelection: [{ name, verdict: keep|swap|drop, reason }]   최대 6
actionItems: [string]         최대 3
warning: string
```

- 삭제: `balanceSummary`(verdict·overall로 흡수), `upperBody`/`lowerBody`(객체로 승격),
  `neglectNote`(해당 부위 diagnosis로 흡수), **`liftAnalysis`(서버 계산 trends로 대체)**
- 신규: `verdict`, `coreNote`, `upper`, `lower`

프롬프트 변경:
- 입력에 `stats.liftTrends`, `stats.regionTrends` 추가
- 명시: 추세 판정은 서버가 계산했다. verdict와 changePct를 바꾸지 말고 해석만 한다.
  목록에 없는 종목의 추세를 지어내지 않는다.
- `upper.prescription` / `lower.prescription`은 그 부위에서 다음 7일에 할 행동 한 문장

### D. UI 재구성 (`app/page.tsx` 1873~2010행)

```
AI COACH
├ 메인     BodyLoadMap + headline + verdict
├ 요약     overall / 빈도 · 체중 · 코어 / 이번 주 할 일 3개
├ 상체     diagnosis → 종목 추세 리스트(서버) → prescription
├ 하체     diagnosis → 종목 추세 리스트(서버) → prescription
└ 종목     efficiencyVerdict + keep/swap/drop
```

종목 추세 행은 서버의 `liftTrends`를 region으로 갈라 각 섹션에 렌더링한다.
배지는 텍스트로 쓴다(성장 / 정체 / 하락 / 공백). 이모지·기하문자 사용 안 함.

패널 제목을 "AI COACH"로 바꾼다. 새 클래스 접두사는 `.coach-`를 쓴다(A에서 briefing 것을
먼저 지우므로 충돌 없음). 기존 `.report-*` 중 안 쓰이게 되는 것은 제거한다.

지킬 것:
- 한글 텍스트에 `break-keep`
- 상단 액센트 바·그라데이션·UI 이모지 금지
- 배지와 진행 표시는 배포 전 실제 화면에서 대비 확인(데스크톱·모바일 둘 다)

## 범위 밖

- 세션 부하 공식 자체(`sessionLoadFrom`)는 손대지 않는다. 별건이다.
- `morning_events.coach_plan` 컬럼 삭제와 기존 행 정리는 하지 않는다.
- 핵 스쿼트 `weight: 0`, 2026-07-19 덤벨 컬 16kg 데이터.

## 검증

### 1. 빌드 · 타입
`npm run build` 통과. 스키마 필드 삭제가 있어 미갱신 렌더링부는 타입 에러로 드러난다.

### 2. 추세 계산 단위 검증 (실데이터 17세션)
`tsx`로 `progressTrend`를 직접 호출해 아래를 확인한다.

| 종목 | 실제 기록 | 기대 판정 |
|---|---|---|
| 스쿼트 | 20kg×12 → 50kg×5 | growing |
| 레그 익스텐션 | 25kg×10 → 55kg×5 | growing |
| 이너 타이 | 66kg×12 → 55kg×10, 마지막 08-17 | declining |
| 체스트 프레스 | 마지막 08-15 | idle (13일 경과, 경계값 확인) |
| 카프 레이즈 | 15회 → 32회 | growing (unit=회) |
| Assisted 풀업 | 보조 40kg → 35kg | growing (실부하 기준, 방향 반전 없음) |

`sessions < 2`인 종목이 목록에서 빠지는지, region 분류가 8부위와 일치하는지 확인한다.

### 3. 회귀
- briefing에서 go/no_go를 누르면 `morning_events`에 저장되고, 새로고침 후 복원되는지
- 미션 HUD·체중·영상·스케줄이 그대로 동작하는지
- `computeBodyPartStats` 결과값은 이번 변경으로 바뀌면 안 된다(시그니처 미변경)

### 4. 화면
데스크톱·모바일에서 5개 블록이 순서대로 보이고, 추세 배지가 배경에 묻히지 않는지 눈으로 확인한다.
