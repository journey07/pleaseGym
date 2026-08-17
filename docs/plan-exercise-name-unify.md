# Plan: 운동 이름 입력 통합 (띄어쓰기·대소문자 달라도 하나로)

## 요청
DB에서 수동으로 합친 2건(인클라인 체스트프레스/인클라인 체스트 프레스,
케이블 암풀다운/케이블 암 풀다운)이 앞으로는 자동으로 하나가 되게.
사용자가 어떻게 입력하든 같은 운동으로 분류.

## 현재 문제
- `app/page.tsx:356` `normalizeExerciseName` = `trim + toLocaleLowerCase`.
  공백 차이를 못 잡아 "암풀다운"과 "암 풀다운"이 다른 운동이 됨.
- 이 함수는 즐겨찾기·draft 중복 체크에만 쓰임. 실제 집계는 원문 이름으로 갈림:
  - `app/page.tsx:672` coachInsight 빈도 카운트 (normalize 없음)
  - `app/api/training-report/route.ts:295,504` liftMap/bwMap/cardioMap/인벤토리
  - `app/api/morning-coach/route.ts:393,499` lastSameSplit / recentSplits
- 결과: 같은 운동이 그래프·리포트·모닝 플랜에서 각각 쪼개짐.

## 변경 (5 파일)

### 1. app/lib/exerciseName.ts (신규, 순수 모듈)
서버 route와 클라이언트가 공유. Date/DOM/네트워크 미사용.
- `normalizeExerciseName(name)`: `trim` → `toLocaleLowerCase("ko-KR")` →
  `replace(/\s+/g, "")`. 공백 전부 제거가 핵심.
- `canonicalNameMap(names: string[]): Map<string, string>`:
  normalized key → 표시용 정본 이름. 정본 = 최빈 표기, 동률이면 목록 뒤쪽
  (더 최근) 표기. 입력 순서는 오래된 것부터라고 가정.
- `groupByExerciseName<T>(items, getName)`: normalized key로 묶고 정본 이름을
  붙여 돌려주는 헬퍼. 서버 3곳이 같은 규칙을 쓰게.

### 2. app/page.tsx
- 로컬 `normalizeExerciseName` 정의 삭제하고 lib에서 import (기존 호출부 4곳
  `713,716,739,753`은 시그니처 동일하므로 그대로 동작).
- `addExerciseToDraft`: 입력한 이름의 normalized key가 기존 기록(history 전체)
  이나 즐겨찾기에 있으면 **정본 표기로 치환해서 저장**. 없으면 입력값 그대로.
  → 사용자가 "암풀다운"이라 쳐도 달력엔 "케이블 암 풀다운"으로 들어감.
- `coachInsight`(672): `exerciseCounts` 키를 normalized로, 표시는 정본으로.

### 3. app/api/training-report/route.ts
- `buildStats`: liftMap/bwMap/cardioMap의 Map 키를 normalized로 바꾸고,
  series의 `name`은 정본 표기로. (`295` 근처)
- 종목 인벤토리 `inventory`(504 근처)도 동일하게 normalized 키 + 정본 이름.
- 정본은 `canonicalNameMap`으로 history 전체를 한 번 훑어 만든다.

### 4. app/api/morning-coach/route.ts
- `planExercise`(393)의 name과 `recentSplits`(499)의 종목명을 정본 표기로.
- `lastSameSplit` 구성 시 같은 세션 안에서 normalized 키가 같은 종목이 둘이면
  합치지 말고 첫 항목 유지(같은 날 같은 운동 중복 입력은 드묾, 스코프 밖).

### 5. app/lib/bodyPart.ts / bodyPartStats.ts
변경 없음. 부위 추론은 이름 문자열을 키워드로만 보므로 영향 없음.
단 `inferBodyPart`는 공백 제거된 이름이 아니라 **원문**을 받아야 키워드
("레그 레이즈" 등)가 계속 맞는다. normalized 값을 넘기지 말 것.

## 마이그레이션
과거 DB 기록은 이미 수동 병합 완료(2건). 추가 일괄 변환 없음.
정본 치환은 앞으로 입력되는 것에만 적용되고, 집계는 normalized 키라서
옛 표기가 남아 있어도 자동으로 묶인다.

## 건드리지 않음
- DB 스키마, 운동 부위 분류 키워드, Part A/B에서 추가한 코치 필드.
- 자동완성 UI 신규 추가 (요청 범위 밖).

## 검증
- `npm run build`, `npx tsc --noEmit` 통과.
- 유닛 확인: normalizeExerciseName("케이블 암풀다운") ===
  normalizeExerciseName("케이블 암 풀다운") === "케이블암풀다운".
- 실제 history로 buildStats 호출 시 lifts/exercises에 "인클라인 체스트프레스"와
  "인클라인 체스트 프레스"가 하나로만 나오는지.
- 달력에서 기존 운동을 다른 띄어쓰기로 입력 → 정본 표기로 저장되는지.
- inferBodyPart가 여전히 정상 부위를 돌려주는지(공백 제거 이름을 안 넘기는지).

---

# Part 2: 코드리뷰 지적 수정 (코치 기능)

opus code-reviewer 리뷰 결과 중 확정 결함만 수정한다. 위 이름 통합과 같은
파일을 건드리므로 한 번에 처리한다.

## Critical
1. **모닝 코치 전체 장애 위험** `app/api/morning-coach/route.ts:666-683`
   모델 응답의 name/target을 서버 값과 문자열 완전일치로 검증하고 틀리면 throw
   → 502. LLM이 "×"를 "x"로 쓰거나 순서만 바꿔도 코칭 전체가 안 나온다.
   **수정**: 모델에게 name/target을 받지 말고 note만 받는다. todayPlan은 서버가
   lastSameSplit에서 직접 조립한다.
   - responseSchema의 todayPlan items에서 name/target 제거, note만 유지
     (또는 todayNotes: string[]로 단순화). 검증도 그에 맞게 축소.
   - 응답 직전 서버에서 조립:
     `todayPlan = lastSameSplit.slice(0,8).map((ex,i)=>({name:ex.name,
      target:ex.suggested, note: parsedNotes[i] ?? ""}))`
   - no_go면 todayPlan=[] 유지.
2. 프롬프트에서 name/target 요구 문구를 note 전용으로 재작성 (1번의 짝).

## Important
3. **오래된 기록으로 증량 처방** `route.ts:513-520`: lastSameSplit에 기간 제한이
   없어 6개월 전 최고중량에 +2.5kg를 처방한다. 60일 초과면 lastSameSplit=[]로
   두고, 60일 이내면 lastDate를 화면 행에 함께 표시(`app/morning/page.tsx`).
4. **전신 운동만 하는 경우 빈 계획** `route.ts:504-520`: 모든 세션이 full이면
   매칭 실패로 "첫 기록 만들자"가 나온다. exact 매칭 실패 시 가장 최근
   non-cardio 세션으로 폴백.
5. **olderSplit이 하체로 편향** `route.ts:444-455`: LOWER_PARTS에 허리가 있고
   미기록 부위가 28로 기본값이라 어제 하체를 했어도 또 하체를 권한다.
   daysSinceLast가 null인 부위는 평균에서 제외.
6. **splitOf 분모 오류** `route.ts:360-361`: 분모 strengthSets에 복근·기타가
   포함돼 상체 8세트+복근 4세트가 full로 떨어진다.
   분모를 `upperSets + lowerSets`(분류된 세트)로 교체.
7. **화면에 숫자 0이 찍힘** `app/page.tsx:1133`: `report.exerciseSelection?.length`
   가 0일 때 `&&` 식이 0을 반환해 React가 "0"을 렌더한다.
   `(report.exerciseSelection?.length ?? 0) > 0`으로 교체.
8. **0kg 처방** `route.ts:382-385`: weight 0으로 기록된 종목이 "0kg × 12"가 된다.
   `topWeight <= 0`이면 반복수 처방으로 폴백.

## Minor (같이 처리)
12. 5% 상한 결과가 15.75kg 같은 값이 되므로 0.5 단위로 내림.
14. `regions.freq7/freq28`이 reps>0 필터 없이 세션을 세어 weeklySets=0인데
    freq7=2가 나온다. computeBodyPartStats와 같은 조건 적용.
16. `recentSplits.exercises`가 done 필터 없이 전체 종목을 나열. completedSets 사용.
18. `.coach-plan-row` 모바일 오버라이드 추가 (`grid-template-columns: 1fr`).

## 수정하지 않음 (근거)
- 리뷰 9번(달력 유산소 색): plan 밖 변경이 맞지만 사용자가 이 세션 첫 요청으로
  명시 지시한 것이라 결함 아님. 단 가독성은 별도 보고 (대비 1.19:1).
- 리뷰 13(부위 상수 공용화), 15, 17(포맷), 19(캐시 무효화): 스코프 밖 리팩터
  이거나 의도된 동작.
- 리뷰 10, 11: 기존 클라이언트 관례와 일치. 지금 바꾸면 표시 규칙이 갈린다.

## 검증
- `npm run build`, `npx tsc --noEmit` 통과.
- todayPlan 조립이 서버 값과 항상 일치(모델 응답이 어긋나도 502 안 남).
- splitOf: 상체 8세트+복근 4세트 → "upper" 판정되는지 노드로 확인.
- efficiencyVerdict="" + exerciseSelection=[] 일 때 화면에 "0"이 안 찍히는지.
