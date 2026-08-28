# 어시스트 감지 통합 + 부위 볼륨 단위 분리

작성 2026-08-28. 근거: DB 실데이터 17세션(2026-07-19~08-28) 대조.

## 문제

### P1. 어시스트 종목이 서버 3곳에서 일반 중량으로 처리된다

DB 실제 저장 형태에 `assisted` 플래그가 없고 `metric`이 `"weight"`다.

    {"name":"Assisted 풀업","metric":"weight","sets":[{"w":50,"r":12}, ...]}

서버는 `exercise.assisted === true`만 확인한다. 이 조건이 한 번도 참이 된 적 없다.

| 위치 | 현재 조건 | 결과 |
|---|---|---|
| `app/api/training-report/route.ts:333,336,384` | `assisted === true && metric === 'bodyweight'` | 보조 50kg을 든 무게로 계산 → e1RM 70kg (실제 38kg) |
| `app/api/morning-coach/route.ts:460` | `assisted === true` | `topWeight = max(weights) = 50` |
| `app/lib/bodyPartStats.ts:55` | TODO 미구현 | 등 부위 볼륨 65% 과대계상 |

`page.tsx:447-449`와 `missionStats.ts:190-191`은 이름 정규식으로도 감지해서 정상 동작한다.
서버 3곳만 이름 감지가 빠졌다.

파급:
- `training-report/route.ts:215` 프롬프트는 AI에게 "부하=체중−보조kg, 보조↓=성장"이라 설명하지만
  실제로는 보정 안 된 원본이 전달된다. AI가 70kg을 실부하로 해석한다.
- `morning-coach`의 `progressionFor`가 `metric='weight'` 분기를 타서 `topWeight+2.5`를 제안한다.
  결과: "보조 52.5kg × 12" = 보조를 늘리라는 제안. 방향이 반대다.
- 보조를 줄이면(성장) 숫자가 내려가 "하락"으로 읽힌다. 8/11 기록이 실제 사례.

### P2. 부위 볼륨이 kg와 회를 한 필드에 합산한다

`app/lib/bodyPartStats.ts:56`

    volume += ex.metric === "bodyweight" ? reps : weight * reps;

`weeklyVolume` 내림차순 정렬(150행)이 편중 파악 목적인데, 맨몸 전용 부위는 구조적으로 하위권 고정.
`training-report/route.ts:560-562`의 regions 합산에서 더 직접적으로 깨진다.

    하체 = 허벅지 23,333(kg) + 종아리 537(회) = 23,870
    코어 = 복근 209(회) + 허리 230(회)       =    439

AI는 "코어가 하체의 1.8%"로 읽는다. 서로 다른 단위를 더한 값이라 의미가 없다.

## 결정

부위 **간** 비교 지표를 `weeklySets`로 바꾼다. 볼륨(kg)은 레버리지가 종목마다 달라 부위 간 비교가
원래 성립하지 않는다. 훈련량 배분은 주당 세트 수로 센다. `weeklySets`는 이미 계산되어 있다.
볼륨은 삭제하지 않고 두 필드로 쪼개 부가 정보로 남긴다. 같은 부위의 시간축 비교에는 유효하기 때문.

체중 계수 환산(크런치=체중×0.3 등)은 계수에 근거가 없어 채택하지 않는다.

## 변경

### A. `app/lib/assisted.ts` 신규

`page.tsx:447-455`에서 추출해 공유한다.

    isAssistedExercise(ex)  // ex.assisted === true || /assisted|어시스티드|어시스트/i.test(name)
    minAssistWeight(ex)     // 세트 중 weight > 0 최소값, 없으면 null
    effectiveLoad(bw, assist) // Math.max(bw - assist, 1)

- `page.tsx`: 로컬 정의 삭제 후 import. 동작 변화 없음.
- `missionStats.ts:190-191`: 인라인 정규식을 `isAssistedExercise`로 교체.

### B. `app/api/training-report/route.ts`

분기 순서를 바꾼다. 어시스트는 `metric`과 무관하게 먼저 잡는다.

    현재: distance → bodyweight(내부에 assisted 분기) → weight
    변경: distance → assisted → bodyweight → weight

어시스트 경로:
- 체중 로그 있음: `load = effectiveLoad(bodyweightForDate(...), set.weight)`.
  topWeight / e1rm / volume 전부 이 값 기준.
- 체중 로그 없음: 기존 폴백(384행) 유지. 판정 조건만 `isAssistedExercise`로 교체.

프롬프트 211/213/215행 문구를 새 필드명에 맞춰 갱신.

### C. `app/api/morning-coach/route.ts`

- 460행 `exercise.assisted === true` → `isAssistedExercise(exercise)`
- `progressionFor` 어시스트 분기 조건에서 `metric === "bodyweight" &&` 제거.
  `assisted`면 metric과 무관하게 "보조 −2.5kg" 경로를 탄다.
- 123행 프롬프트 문구 갱신.

### D. `app/lib/bodyPartStats.ts`

시그니처에 체중 로그를 옵션 인자로 추가.

    computeBodyPartStats(sessions, todayKey, bodyweightLog?)

`exerciseVolume` 반환을 `{ weightVolume, repVolume, sets }`로 분리.

| 종목 유형 | 집계 |
|---|---|
| assisted + 체중 로그 있음 | `weightVolume += effectiveLoad × reps` |
| assisted + 체중 로그 없음 | `repVolume += reps` (보조 무게를 kg로 세지 않는다) |
| bodyweight | `repVolume += reps` |
| weight | `weightVolume += weight × reps` |

`BodyPartStat` 필드 교체:
- 삭제: `weeklyVolume`, `monthlyVolume`
- 추가: `weeklyWeightVolume`, `weeklyRepVolume`, `monthlyWeightVolume`, `monthlyRepVolume`, `monthlySets`

`trend` 계산(127-135행)을 `weekVolume` → `weekSets` 기준으로 교체. 단위 혼합이 사라지고
편중 지표와 추세 지표의 기준이 일치한다.

정렬(150행): `weeklySets` 내림차순, 동률이면 `weeklyWeightVolume`.

호출부 2곳에 `bodyweightLog` 전달. 둘 다 이미 해당 값을 로드하고 있다.
(`training-report:502` / `morning-coach:532`, 로드는 각각 808행 / 523행)

### E. 소비처 타입·합산

- `training-report/route.ts:72-74` `RegionStat` 타입, `560-562` 합산부
- `morning-coach/route.ts:368-369` 타입, `535-536` 전달부

## 범위 밖 (보고만, 수정 안 함)

- 핵 스쿼트 `weight: 0` 세트 → 앱 그래프는 e1RM 0을 점으로 찍고 리포트는 세션을 버린다. 처리 불일치.
- 2026-07-19 덤벨 컬 16kg → 양손 합계 입력 의심. 사용자 확인 전까지 데이터 수정 없음.

## 검증

### 1. 빌드 · 타입
`npm run build` 통과. `BodyPartStat` 필드 삭제가 있어 미갱신 소비처는 타입 에러로 드러난다.

### 2. 실데이터 대조 (수정 전후 값 비교 스크립트)
DB의 17세션을 그대로 넣고 아래 값이 나오는지 확인한다.

| 항목 | 수정 전 | 기대값 |
|---|---|---|
| 풀업 e1rm (2026-08-25) | 70.0 | 38.0 |
| 풀업 topWeight (2026-08-25) | 50 | 30 |
| 풀업 볼륨 (2026-08-25) | 1,620 | 980 |
| morning-coach 풀업 제안 | 보조 52.5kg × 12 | 보조 32.5kg × 12 |
| bodyParts 정렬 1위 | 등(volume 23,761) | 세트 수 최다 부위 |
| regions 코어 지표 | 439 (kg+회 혼합) | 세트 수, 단위 단일 |

전 종목에서 `weightVolume`과 `repVolume`이 동시에 0이 아닌 항목이 없는지도 확인한다.

### 3. 회귀
- `page.tsx` 그래프: "Assisted 풀업" 선택 시 "보조 중량 / 낮을수록 좋음" 모드 유지, 값 변화 없음.
- `missionStats`의 `pullupAssist`(최소 보조 35kg), `squatE1rm`(58.3) 변화 없음.
- 어시스트 아닌 종목의 e1rm·볼륨 전부 수정 전과 동일.
