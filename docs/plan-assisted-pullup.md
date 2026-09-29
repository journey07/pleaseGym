# Plan — 어시스티드 풀업 (보조 부하) 지원

## 문제
어시스티드 풀업/딥스는 머신·밴드가 체중의 일부를 **덜어준다**. 보조 무게가 클수록 부하는
작아진다(더 쉬움). 그런데 현재 앱엔 이 개념이 전혀 없어서:
- bodyweight 종목의 `weight` 필드 의미는 "추가중량(+kg)" 하나뿐 (`app/page.tsx:85`).
- 코치/리포트는 bodyweight 종목을 **reps만**으로 진척 판정 (`training-report/route.ts:224-262`, e1rm=0).
- 결과: 보조를 30kg→20kg로 줄인 = 실력 상승인데, 시스템은 이걸 전혀 못 읽음. reps가 같으면
  "정체"로 보고, 보조 무게를 늘리면(더 쉬워졌는데) 오히려 "추가중량 늘었다"로 오해할 수 있음.

## 결정 (사용자 확정)
1. **부하 = 절대값**: 실제부하 = `체중 − 보조kg`. `bodyweightLog`(T3/T4로 이미 존재)로 체중 조회.
2. **입력 UX = '보조' 토글 + 양수 입력**: 토글 켜면 양수(예 30) 입력 → 30kg 보조 의미.
3. **저장 = 양수 크기 + `assisted` 플래그** (음수 저장 안 함 — sign 꼬임 방지, 기록 가독성↑).
   `weight`는 보조 크기의 양수 magnitude, `exercise.assisted:true`가 "빼는 값"임을 표시.

## 진척 모델 (핵심)
어시스티드 풀업은 웨이트 풀업과 **같은 절대부하 축** 위에 있다:
```
보조30kg  ···  보조10kg  ···  맨몸  ···  +5kg  ···  +20kg
 부하=BW-30    BW-10        BW      BW+5     BW+20   (오른쪽=강함=성장)
```
→ 어시스티드 세트를 `load` kind로 태우고 e1rm(Epley) = effLoad × (1 + reps/30) 계산.
   보조 감소 → effLoad 상승 → e1rm 상승 → trend up. **별도 반전 로직 불필요.**

`effLoad = assisted ? max(BW − assist, FLOOR) : BW + added`  (FLOOR=최소 1kg, 보조>BW 방어)

## 변경 파일 & 작업

### 1) 타입 — `assisted?` 플래그 추가
- `app/page.tsx:82-90` `Exercise`에 `assisted?: boolean` 추가 (bodyweight일 때만 유효, 주석).
- `app/api/training-report/route.ts:23-28` `PostedExercise`에 `assisted?: boolean`.
- `app/lib/bodyPartStats.ts:13-18` `StatExercise`에 `assisted?: boolean` (미래 대비, 이번엔 미사용 OK).
- FavoriteExercise/기본 데이터는 변경 없음(기본 undefined=false).

### 2) 입력 UI — `app/page.tsx`
- bodyweight 종목 카드에 "보조" 토글 버튼 1개 추가 (metric/bodyPart 컨트롤 옆, isBodyweight일 때만 렌더).
  - 토글 → `updateExercise(id, { assisted: !assisted })` 류로 상태 반영.
- 세트 헤더 라벨 `page.tsx:1371`: `isBodyweight ? (assisted ? "보조KG" : "＋KG") : "KG"`.
- aria-label `page.tsx:1389`도 동일 분기("보조중량").
- weight 입력은 그대로 양수(min="0" 유지). 값 변환 없음 — magnitude 그대로 저장.
- MAX 표시(`page.tsx:1297-1299`)에 assisted면 "보조 Nkg" 힌트 정도(선택, 과하면 생략).

### 3) 진척/리포트 — `app/api/training-report/route.ts` (진짜 핵심)
- **순서 재배치**: bodyweight 로그를 `buildStats` **전에** 조회해서 넘긴다.
  - 현재 `buildStats`(:567) → 이후 `getBodyweightTrend`(:581). 로그 조회를 앞으로.
  - `getBodyweightLog()` 신설(정렬된 `{date,kg}[]` 반환) 또는 `getBodyweightTrend`가 log도 반환.
  - `buildStats(history, bwLog)` 시그니처 확장. bwLog 없으면(빈 배열) 기존 동작으로 폴백.
- **per-date 체중 조회 헬퍼**: 세션 date 기준 "그 날짜 이하 가장 최근" 체중, 없으면 최초값.
- **bodyweight 분기 수정**(:224-262):
  - `assisted === true` **그리고 bw 조회 가능** → `load` kind로 처리:
    effLoad = max(bw − assist, FLOOR), topWeight=effLoad최대, repsAtTop, e1rm=Epley, volume=Σ effLoad×reps.
    → liftMap(load)에 넣음. reps-kind(bwMap) 대신.
  - `assisted` 아니거나 bw 없음 → **기존 reps-kind 유지** (회귀 0, 절대 반전 안 됨).
- 프롬프트(:145) 한 줄 보강: "kind=load엔 어시스티드 풀업 포함(부하=체중−보조, 보조↓=성장)".

### 4) 볼륨 집계 — `app/lib/bodyPartStats.ts` (범위 밖, 주석만)
- 현재 bodyweight 볼륨=reps. 어시스티드도 reps로 카운트됨(과대평가 소지).
- 이번 범위 제외: bw를 여기까지 넘기려면 배관 추가 필요 + "reversed progress" 버그와 무관.
  코드에 TODO 주석만 남김. (원하면 후속.)

## 검증 (3축)
- **정상 동작**: 어시스티드 풀업 세션 2개(보조 30→20, reps 동일) 입력 → 리포트 trend "up",
  e1rm 상승 확인. 보조 20→30(퇴보) → trend "down". `/qa` 런타임 검증.
- **엣지케이스**:
  - bodyweightLog 없음 → reps-kind 폴백, 에러 없음, 반전 안 됨.
  - 보조 > 체중(비현실) → FLOOR로 클램프, e1rm 양수.
  - assisted=true인데 metric≠bodyweight → 플래그 무시(weight 종목 로직 그대로).
  - 기존 순수 맨몸/추가중량 풀업(assisted=false) → 동작 100% 불변(회귀 없음).
- **롤백**: 커밋 단위 분리. 문제 시 `git revert`. `assisted` 필드는 하위호환
  (기존 데이터 undefined=false → 기존 경로). DB 마이그레이션 없음(JSONB).

## 검증 방식
- `npm run build` 타입 통과.
- `/final-check` (커밋 직전) — 빌드+리뷰+QA 통합.

---

## 후속 (2026-08-05, 사용자 피드백)

사용자 결정: 종목 타입 안 바꾸고 **이름으로 어시스티드 자동 감지**. `app/page.tsx`만 수정.

1. **무게 입력칸 0 지우기** (`page.tsx:1416`): `value={set.weight===0?"":set.weight}`,
   onChange는 빈 문자열→0. placeholder "0". (reps는 요청 밖, 유지)
2. **isAssistedExercise 헬퍼** (모듈 레벨, `exerciseBodyPart` 근처): `exercise.assisted===true ||
   /assisted|어시스티드|어시스트/i.test(name)`.
3. **MAX 칩 = 최소 보조값** (`page.tsx:1266,1306`): 어시스티드면 세트 중 weight>0 최소값을
   `보조 {min}kg`로 표시. 없으면 기존(맨몸=회, 중량=MAX kg).
4. **HEAVIEST 제외** (`monthStats:604`, `draftStats:624`): 최대중량 계산에서
   isAssistedExercise 종목 제외. **세트 수(sets.length)·volume은 유지**(요청 밖).

범위 밖(주석/보고만): training-report의 중량-metric 이름감지 어시스티드 스코어링,
어시스티드 볼륨 집계.
