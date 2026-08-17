# Plan: 모닝 페이지 스트릭·XP 개선 (주 3회 현실 반영)

## 문제 (실제 데이터로 확인)
- 30일간 13세션, 주당 정확히 3.0회. 그런데 **역대 최장 연속일이 1일**.
  세션 간격이 2일 8번, 3일 3번, 4일 1번이라 하루도 연달아 한 적이 없다.
- 현재 `DAY STREAK`은 달력상 연속일을 세므로 이 앱을 쓴 이래 늘 1 또는 NEW.
  잘 지키고 있는데 화면은 실패처럼 보인다.
- 현재 XP는 아침에 "간다"만 누르면 무조건 100. 실제 운동 여부·운동량과 무관.
  `first-rep-morning-decisions` localStorage에만 있어 기기 바꾸면 소멸.

## 확정된 방향 (사용자 선택)
- 스트릭: **주간 스트릭 + 세션 스트릭 둘 다 표시** (주간을 크게, 세션을 작게)
- XP: **실제 운동량 반영 + 레벨 시스템**

## 설계

### 스트릭 2종
- **주간 스트릭(WEEK STREAK)**: 월~일 달력주 기준, 3회 이상 한 주가 연속 몇 주인지.
  **진행 중인 이번 주는 판정에서 제외**한다(아직 채울 기회가 있으므로 끊김 사유가
  되지 않는다). 즉 지난 주부터 거슬러 올라가며 센다. 이번 주가 이미 3회를
  채웠다면 그 주도 포함해서 +1.
- **세션 스트릭(SESSIONS)**: 연속 세션 수. **쉬는 날은 최대 2일까지** 인정하므로
  세션 간격이 3일 이내면 유지, 4일 이상 비면 리셋. 근육은 쉬어야 크므로 휴식일
  자체가 벌이 되지는 않되, 너무 벌어지면 습관으로 안 친다.
  마지막 운동으로부터 오늘까지 4일 이상 지났으면 0으로 표시.
  (실제 기록 기준 현재값 6. 8/01 → 8/05 간격 4일에서 끊김)

### XP (누적 저장 금지, 기록에서 계산)
XP는 카운터로 쌓지 않고 `history` + `morning_events`에서 매번 계산한다.
기기 독립적이고 데이터가 어긋나지 않는다.
- 아침 체크인 go: 하루 +20
- 완료된 운동 1세트: +10
- 개인 최고중량 갱신: +50 (종목별 정규화 이름 기준, 첫 기록은 갱신 아님)
- 주간 목표 3회 달성: 주당 +200

실제 기록 기준 현재값: go 9회(180) + 세트 273개(2730) + PR 15회(750) +
달성 3주(600) = **4,260 XP**

### 레벨
- `threshold(n) = 300*(n-1) + 100*(n-1)*(n-2)/2`
  (L2:300, L3:700, L4:1200, L5:1800, L6:2500, L7:3300, L8:4200, L9:5200, L10:6300)
- 첫 레벨업 300, 이후 필요량이 100씩 증가. 4,260 XP = **LV.8**
- 현재 레벨 + 다음 레벨까지 남은 XP + 진행 게이지 표시.

## 변경 (3 파일)

### 1. app/lib/missionStats.ts (신규, 순수 모듈)
클라이언트 전용이지만 계산을 UI에서 분리해 테스트 가능하게 한다.
Date.now() 대신 `todayKey`를 인자로 받는다.
- `weekStartKey(dateKey)`: 그 날짜가 속한 월요일 키.
- `computeMissionStats({ sessions, goDates, todayKey })`:
  `{ weekStreak, sessionStreak, thisWeekCount, weeklyGoal, totalXp, level,
     xpIntoLevel, xpForNextLevel, xpBreakdown }` 반환.
- `xpBreakdown`은 `{ checkIn, sets, prs, weeklyGoals }` 4개 항목.
- PR 판정은 `normalizeExerciseName`(기존 `app/lib/exerciseName.ts`) 키를 쓰고,
  `metric === "distance"`는 제외한다. 어시스티드는 보조중량이라 PR 대상 제외.

### 2. app/morning/page.tsx
- `MissionStats` 타입을 새 반환 형태로 교체. `calculateMissionStats`를 제거하고
  lib 호출로 대체 (localStorage에서 sessions·goDates만 읽어 넘긴다).
- `StoredExercise.metric`에 `"bodyweight"`가 빠져 있어 추가 (현재 타입 누락).
- HUD 렌더 교체:
  - 좌: `WEEK STREAK` 큰 숫자 + 아래 작게 `13 SESSIONS`
  - 중: `THIS WEEK n/3` 게이지 (기존 `/4` → `/3`, 달력주 기준으로 변경)
  - 우: `TOTAL XP` + `LV.n` + 다음 레벨까지 게이지
- `/api/state` 동기화 완료 후 미션 통계를 다시 계산하도록 의존성 정리
  (첫 로드 때 stale localStorage로 계산되고 끝나지 않게).
- 결정 버튼 옆 정적 문구 `+100 XP`(893, 971행)를 새 규칙에 맞게 `+20 XP`로.

### 3. app/globals.css
- `.mission-hud` 3열 유지. 스트릭 칸에 보조 텍스트 줄, XP 칸에 레벨 배지와
  진행 게이지 추가. 기존 모노 라벨·`var(--soft-line)`·`var(--accent)` 톤 유지.
- 모바일(720px 이하)에서 3열이 좁으므로 스트릭+XP 2열, 게이지는 아래 전폭.

## 건드리지 않음
- `first-rep-morning-decisions` 저장 포맷 (기존 `xp: 100` 필드는 무시하고
  계산에 안 쓴다. 삭제는 하지 않아 롤백 가능).
- DB 스키마, 코치 로직, 달력 페이지.

## 검증
- `npm run build`, `npx tsc --noEmit`, `npm run lint` 통과.
- node로 실제 history를 넣어 확인:
  1) weekStreak: 주별 3,3,2,3 이면 8/03 주(2회)에서 끊겨 1이 나오는지
  2) sessionStreak: 실제 간격(2 2 2 3 2 2 4 3 3 2 2 2)에서 6이 나오는지
  3) totalXp === 4260, level === 8
  4) 4일 이상 공백이면 sessionStreak이 0으로 리셋되는지
- 모바일 폭에서 HUD가 안 깨지는지.

---

# Part 2: HUD 재설계 (꾸준함 하나로 압축)

## 방향 확정 (사용자)
- 목적은 **"내 꾸준한 운동"이 유일**하다. 무게·부위 비율·체형 비교는 전부 뺀다.
- **레벨과 XP를 삭제**한다. 파생 숫자라 감정이 안 붙는다.
- 스트릭은 "n일째 루틴 지키는 중 (시작일)" 형식. 숫자로 크기, 날짜로 닻.
- 경쟁자는 **한 명**. "3년 뒤의 나". 수치 비교가 아니라 **도달 상태**를 적는다.
  "진짜 이렇게 되어야겠다" 느낌이 나야 한다.

## 삭제
- `level`, `xp`, `totalXp`, `xpBreakdown`, `weekStreak`, 레벨 게이지, TOTAL XP 칸
- `first-rep-morning-decisions`의 `xp` 필드는 계산에 쓰지 않는다 (포맷은 유지)
- 결정 버튼 옆 `+20 XP` / `NO XP` 문구 제거

## 남기고 바꾸는 것

### 1. 이번 주 진행 (행동에 직결되는 유일한 숫자)
- `●●○` 3칸. 완료 수만큼 채운다. 목표 주 3회.
- 아래 한 줄: "이번 주 N회 남았다" (0이면 "이번 주 다 채웠다")

### 2. 스트릭 문구
- `{n}일째 루틴 지키는 중 ({시작일} 부터)`
- n은 스트릭 시작 세션일부터 오늘까지 (당일 포함). 시작일은 "8월 5일" 형식.
- 끊긴 상태(마지막 운동 후 4일 이상)면 "루틴이 끊겼다. 오늘 다시 시작" 표시.
- 쉬는 날 최대 2일 규칙(`MAX_SESSION_GAP`)은 그대로.
- 실제 기록 검증값: 8/05부터 오늘(8/17)까지 **13일째**

### 3. 3년 뒤의 나 (도달 상태 카드)
정적 문구. 계산하지 않는다. 상수로 두고 나중에 수정 가능하게 한다.
현재 기록(64→65kg, 스쿼트 e1RM 40, 어시스티드 풀업)에서 한 번 도출한 값이다.

```
3년 뒤의 나

73kg. 지금보다 8kg 무겁고 셔츠가 안 맞는다.
보조 없이 풀업 10개.
스쿼트에 100kg를 올린다.

주 3회는 더 이상 결심이 아니다.
```

가정 명시: 주 3회 유지 + 체중 증가 유지. 3년 자연 트레이닝 기준으로
근육 8~10kg 증가는 현실적 상한에 가깝고, 스쿼트 체중 1.4배도 중급자 범위다.
숫자를 바꾸고 싶으면 `THREE_YEAR_VISION` 상수만 고친다.

## HUD 최종
```
  ●●○   이번 주 2회 남았다
  13일째 루틴 지키는 중 (8월 5일부터)
  ─────────────────────────────────
  3년 뒤의 나
  73kg. 지금보다 8kg 무겁고 셔츠가 안 맞는다.
  보조 없이 풀업 10개.
  스쿼트에 100kg를 올린다.
  주 3회는 더 이상 결심이 아니다.
```

## 변경 (3 파일)
### app/lib/missionStats.ts
- 반환 타입 축소: `{ thisWeekCount, weeklyGoal, remainingThisWeek,
  streakDays, streakStartDate, streakBroken }`
- `level` / `totalXp` / `xpBreakdown` / `weekStreak` / PR 계산(`countPrs`) 제거.
  XP를 안 쓰므로 PR 집계도 불필요하다.
- `streakDays`: 세션 스트릭 시작일부터 today까지 당일 포함 일수.
- `streakStartDate`: 그 시작 세션의 날짜 키.
- `MAX_SESSION_GAP`(=3) 유지.

### app/morning/page.tsx
- `MissionStats` 타입 교체, HUD 렌더 교체, `+20 XP` 문구 제거.
- `THREE_YEAR_VISION` 상수를 이 파일 상단에 둔다 (문구 4줄).

### app/globals.css
- `.mission-hud`를 3열에서 세로 스택으로. 진행 도트, 스트릭 문구, 비전 카드.
- 레벨·XP 게이지 스타일 제거. 기존 톤 유지, 새 컬러 도입 X.

## 검증
- build / tsc / lint 통과.
- 실제 기록으로 `streakDays === 13`, `streakStartDate === "2026-08-05"`,
  `thisWeekCount === 1`, `remainingThisWeek === 2`.
- 마지막 운동 후 4일 이상이면 `streakBroken === true`.
- 반환 객체에 level/xp 관련 키가 남아 있지 않은지 확인.
- 모바일 폭에서 비전 카드 줄바꿈 확인.
