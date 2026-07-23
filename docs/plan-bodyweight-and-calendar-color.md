# Plan — 맨몸(bodyweight) 종목 타입 + 달력 상체/하체 색 구분

## 배경
- metric은 현재 `"weight" | "distance"` 2종. 맨몸 운동(풀업·푸시업·플랭크)은 weight=0으로 기록 → 의미 뭉갬 + `buildStats`가 `weight<=0` 세트를 스킵(`training-report/route.ts:201,208`)해서 **리포트에서 완전 소멸**.
- 달력 day-lift는 전부 같은 색(빨강). 상체/하체 구분 없음.

---

## 변경 1 — 맨몸 종목 타입 (로깅·저장·달력)

### 데이터 모델
- `Metric = "weight" | "distance" | "bodyweight"`.
- 맨몸 세트: `reps`가 주 지표, `weight`는 **추가중량(+kg, 기본 0)** 으로 재사용(가중 풀업/딥스 지원). `distanceKm` 미사용.
- `jsonb` 저장이라 마이그레이션 없음. 기존 데이터 영향 없음.

### 기능 완성 기준
- 운동 추가 metric 선택지에 **맨몸** 추가(`<option value="bodyweight">맨몸</option>`).
- 맨몸 운동 세트 입력: 헤더 `＋KG / REPS`, kg 칸은 추가중량(선택, 0 허용), reps가 필수.
- cascade(변경1 로직)는 맨몸에도 그대로 적용(weight=추가중량, reps 전파).
- 저장 필터(`saveWorkout`): 맨몸은 `reps>0`이면 유효(weight 0 허용). distance/weight 기존 유지.
- `createExercise`: bodyweight → `createDefaultWeightSets()` 재사용(weight 0, reps 8, inherit true).
- 즐겨찾기 라벨: bodyweight → 단위 표기 조정("회" 또는 "+kg").

### 달력 표시
- day-lift value: bodyweight → **최고 반복수**, unit `"회"`. (weight→kg, distance→km 유지)
- `dayRecords` map에 metric 분기 추가.

### 엣지케이스
- 맨몸+추가중량 0 → "맨몸", >0 → "+Nkg" 뉘앙스는 값/단위로 표현.
- 기존 weight 0 기록(옛 맨몸)은 여전히 weight로 남음 — 신규만 bodyweight. 강제 이전 안 함.

---

## 변경 2 — 통계(리포트) 맨몸 반영

`training-report/route.ts buildStats`:
- bodyweight 분기 추가: distance처럼 별도 처리. **reps 기준 시계열**로 집계.
- `LiftPoint`에 맨몸용 필드 or 별도 `calisthenics[]` 시리즈: `{date, topReps, volume=Σreps, added=최고추가중량}`.
- 최소 침습안: 기존 `lifts[]`에 맨몸도 넣되 `metric:"reps"` 플래그 + `topReps`/`e1rm` 대신 reps 기반. 트렌드(up/flat/down/new)는 topReps 흐름으로 판정.
- 스키마(`liftAnalysis`/`LiftSeries`)에 metric 구분 필드 추가.
- 프롬프트에 한 줄: "metric:reps(맨몸) 종목은 topReps 흐름으로 트렌드 판정, 볼륨=총반복. 무게 증량 대신 반복 증가로 과부하 조언."
- 클라이언트 리포트 카드 단위: 맨몸 종목은 "회" 표기.

### 엣지케이스
- 맨몸+추가중량 있는 경우도 reps 우선(추가중량은 보조 표기).
- 데이터 부족(2회 이하) → 기존대로 new.

---

## 변경 3 — 달력 상체/하체 색 구분

### 매핑 (`bodyGroup(bodyPart)`)
- **상체(빨강)**: 가슴, 등, 어깨, 복근, 허리
- **하체(파랑)**: 허벅지, 종아리
- **중립(회색)**: 기타, 거리(유산소)
- (허리/유산소 경계는 위로 확정, 원하면 한 줄로 조정 가능)

### 구현
- `bodyGroup(part): "upper"|"lower"|"neutral"` 헬퍼.
- `dayRecords`에 `group: bodyGroup(exerciseBodyPart(exercise))` 추가.
- `<span className={`day-lift ${record.group}`}>`.
- globals.css: `.day-lift.upper`(빨강, 기존 accent 계열), `.day-lift.lower`(파랑), `.day-lift.neutral`(회색). 이름/값 텍스트 색만 변경, 레이아웃 불변.
- 한 날에 상체+하체 섞이면 각 줄이 각자 색 → 한눈에 분포 파악.

### 엣지케이스
- 기존 저장 데이터엔 bodyPart 없음 → `exerciseBodyPart`가 이름으로 폴백 추론 → 색 자동 부여.
- 색약 대비: 색만 의존 X, 순서/텍스트 유지. 대비 충분한 톤 선택.

---

## 검증
- `npm run build`(=test) 통과.
- `/final-check`/`/qa`: 맨몸 종목 추가→세트 입력(reps)→저장→달력 "회" 표시, 색 구분(상체 빨강/하체 파랑), cascade 맨몸 동작.
- 리포트: 맨몸 종목이 리포트에 등장하고 reps 트렌드로 판정되는지(빌드+로직).
- `/ui-chrome-verify`: 달력 색, 맨몸 입력 UI 렌더.
