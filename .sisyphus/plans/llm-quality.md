# llm-quality — 코치/리포트 개인화·고도화

## Purpose
LLM 코치(아침)와 리포트(주간)가 "뻔하고, 신규 도배되고, 실행 지침이 약한" 문제를 해결.
사용자는 **말라서 몸을 크게(두께+너비, 전체 골고루) 키우려는 근비대 목표**. 분석 단위를 종목명→부위로
승격하고, 부위별 볼륨·체중 추세 등 rich data를 주입해 진짜 개인화된 코칭을 만든다.

## Scope
- IN:
  - 부위(bodyPart) 단위 집계 유틸(서버) — 주간 부위 볼륨/빈도/마지막훈련일.
  - 코치(morning-coach) 데이터·프롬프트 개편 = 짧고 오늘 중심 + 몸 스냅샷 + 최근 피드백 + 처방 1개.
  - 리포트(training-report) 데이터·프롬프트·스키마 개편 = 부위 볼륨 밸런스/방치 경고/체중·총볼륨 추세.
  - 체중 추적 신규(입력 UI + jsonb 저장 + LLM 전달).
  - buildCoachContext(클라) rich data 전송으로 확장.
- OUT:
  - 톤 변경(스파르타 유지). 목표무게 프로필/영양 트래킹. 운동 프로그램 자동 생성기(주간 분할 자동 편성)는 이번 범위 아님.
  - 새 DB 테이블/마이그레이션(전부 jsonb 확장으로).

## Background (코드 팩트 — 확인됨)
- 코치: `app/api/morning-coach/route.ts` (프롬프트 58~/POST 312~). 컨텍스트는 `app/morning/page.tsx buildCoachContext`가
  최근 6세션의 **최고 세트 1개**로 축약(bodyPart·volume·streak 버림).
- 리포트: `app/api/training-report/route.ts` `buildStats`(153~) 종목명 단위 시계열(e1rm/volume). bodyPart 미사용 → "신규 도배".
- 데이터: `Exercise.bodyPart`(가슴/등/어깨/팔/허벅지/종아리/복근/허리/기타) 존재. `metric`에 weight/bodyweight/distance.
- 저장: `db/schema.ts userState` = jsonb(workoutHistory/favorites/coachMemory/morningVideos). 여기 `bodyweightLog` 추가 가능(무마이그레이션).
- 소유자 단일(`ownerId="local-owner"`) → 체형 목표는 프롬프트 상수로 내장 가능.

## 의존성 (순서 게이트)
- T2(매핑 추출) → T1(집계 유틸, T2 import).
- T3(체중) 먼저 → T4/T5의 "체중 추세"가 T3에 의존.
- T1+T2 → T4(코치) / T5(리포트). 둘은 T1·T2 완료 후 병렬 가능.
- 권장 순서: **T2 → T1 → T3 → T4 → T5 → T6**.

## Tasks

- [ ] **T2 — bodyPart 매핑을 client-safe 순수 모듈로 추출**
  - Files: 신규 `app/lib/bodyPart.ts` = `inferBodyPart` + `BODY_PART_KEYWORDS` + `BodyPart` 타입 이동
    (`app/page.tsx:127,277` 에서 이동). `app/page.tsx`는 여기서 re-export/import.
  - 순수 함수(브라우저/노드 모두 안전) — 서버 route와 클라 양쪽이 동일 함수 사용.
  - Acceptance: `app/page.tsx` 빌드/기존 분류 결과 100% 불변(덤벨컬→팔, 레그컬→허벅지 등 회귀 없음). import 순환 없음.

- [ ] **T1 — 부위 집계 유틸 (isomorphic 순수 함수)**
  - Files: 신규 `app/lib/bodyPartStats.ts`. **route 내부 헬퍼 금지** — 서버 route + 클라 양쪽 import 가능한 순수 함수로 확정.
  - 입력: `Session[]`(각 exercise에 `bodyPart?`, `metric`, `sets`). 부위는 **`exercise.bodyPart ?? inferBodyPart(name)`**
    (수동 교정 우선 — I3).
  - 산출(부위별, **근육 8부위: 가슴/등/어깨/팔/허벅지/종아리/복근/허리**, 기타·거리 **제외**):
    { weeklySets, weeklyVolume(중량=Σ중량×반복, 맨몸=Σ반복, 거리 제외), lastTrainedDate, fourWeekVolumeTrend(up/flat/down/new), freq7d, freq28d }.
  - Acceptance: **고정 샘플 history 픽스처** → 기대 집계값 assertion(예: 등 세트수/볼륨 정확, 하체 lastTrainedDate=YYYY-MM-DD).
    맨몸/거리 혼재·빈 세트·bodyPart 미존재(구데이터) 모두 NaN 0/폴백. 콘솔 스크립트로 재현.

- [ ] **T3 — 체중 추적 (입력+저장)**
  - Files: `db/schema.ts`(userState에 `bodyweightLog jsonb [{date, kg}]` default []), 신규 `app/api/bodyweight/route.ts`(GET/PUT, morning-videos 패턴),
    `app/morning/page.tsx`(가벼운 "체중 kg" 입력 한 줄 — 주 1~2회, 선택, mount GET 하이드레이션). 옵션: 메인 통계에 최신 체중.
  - Acceptance: 체중 입력→PUT→Neon 저장→GET 재조회 확인(E2E). 미입력이어도 앱 정상. 무마이그레이션(jsonb).
  - Guardrail: 저장 try/await/catch. **PUT은 `onConflictDoUpdate set:{bodyweightLog}`만** → `/api/state`의 workoutHistory/favorites PUT과 컬럼이 달라 서로 clobber 안 함(부분 upsert). 기기 동기화 GET on mount.

- [ ] **T4 — 코치 데이터/프롬프트 개편 (매일·간결, 서버 집계)**
  - Files: `app/api/morning-coach/route.ts`(프롬프트 재작성 + 입력 스키마 + **서버에서 `userState.workoutHistory` 읽어 부위 집계**),
    `app/morning/page.tsx buildCoachContext`(집계 스냅샷 위주로 단순화 — raw 세트 대량 전송 X).
  - **B1 해결**: 방치 부위 판정에 필요한 부위별 lastTrainedDate/4주 볼륨은 6세션으론 불가 → 코치 route가 `getCoachMemory`처럼
    서버에서 full `workoutHistory`를 읽어 `bodyPartStats`(T1) 집계 후 LLM에 **작은 스냅샷**으로 전달(24KB cap 여유).
    체중 추세는 `bodyweightLog`(T3)에서.
  - 내용: 스타일 A. "몸 스냅샷 1줄(편중/방치) + 최근 대비 피드백 1개 + 오늘 처방 1개 + **왜(근거 1줄)**." 짧게(코치 output 스키마 불변 → 길이 구조적 보장).
  - **설명(왜) 요구**: 처방/경고마다 근거를 한 줄로. 예: "사이드레이즈 → 측면 삼각근이 어깨 너비(V)를 만든다." 지식 트레이너처럼, 잔소리 아님.
  - 목표 렌즈 프롬프트 내장: "사용자는 마른 체형→전신 근비대(두께+너비). 부위 균형·볼륨 관점, 방치 부위 콕 집기. **왜 그 부위/처방인지 원리를 짧게 설명**."
  - Acceptance: 실제 history로 호출 시 (a) 부위 편중/방치 언급, (b) 최근 기록 인용, (c) 오늘 구체 처방 1개, (d) **처방/경고에 '왜' 근거 1줄**, (e) 4~6문장(설명 포함으로 소폭 증가). before/after 스크린샷.

- [ ] **T5 — 리포트 데이터/프롬프트/스키마 개편 (주간·깊게)**
  - Files: `app/api/training-report/route.ts`(buildStats에 `bodyPartStats` 병합 + **PostedExercise에 `bodyPart?` 추가**해 `bodyPart ?? infer` 사용[I3],
    responseSchema에 부위밸런스/방치/체중추세 필드, `isTrainingReport` 가드 동기화, 프롬프트 재작성),
    `app/page.tsx`(`TrainingReport` 타입 동기화, 리포트 카드에 부위 밸런스/방치/체중·볼륨 섹션 **null-guard 렌더**).
  - **I4 해결**: 스키마 필드 추가 시 (a)서버 가드 (b)클라 타입 (c)`REPORT_CACHE_KEY` 구캐시 3곳 함께. 신규 섹션은 optional 렌더,
    구 캐시 shape 불일치면 무시하고 재생성(크래시 방지).
  - 클라 히스토리 POST(`app/page.tsx`)가 `bodyPart` 포함해 전송하는지 확인(draft에 이미 존재).
  - 필수 섹션: ① 부위별 주간 볼륨 밸런스 ② 약점·방치 부위 경고 ③ 체중·총볼륨 추세. 종목별 트렌드는 보조.
  - **설명(왜) 요구**: 각 경고/처방에 근거 1줄(원리·해부학·근비대 논리). 예: "데드/기립근 없음 → 후면 두께 안 큰다(광배 너비는 챙겼지만 척추기립근 두께 빠짐)." schema에 각 항목 `why` 필드 or comment에 근거 포함.
  - "신규 도배" 해결: 부위 단위가 1차 분석. 목표 렌즈: 두께(로우·데드·가슴)/너비(어깨측면·랫).
  - Acceptance: 실제 history로 호출 시 부위 밸런스+방치 경고+체중/볼륨 추세가 뜨고 "신규" 위주 아님. **각 인사이트에 '왜' 근거 포함.** 구 캐시로 크래시 없음. before/after 스크린샷.

- [ ] **T6 — 검증**
  - `npm run build`, `/final-check`, `/ui-chrome-verify`(코치/리포트 실렌더), 실 history로 LLM 출력 before/after 비교.

## Guardrails
- Money/data-sensitive: 없음. 단, **실 Neon DB 연결 환경** — 테스트 체중/세션 저장으로 실데이터 오염 금지(더미는 저장 안 함).
- Do NOT: 톤 스파르타 제거, 새 마이그레이션, 운동 자동 프로그래밍(범위 밖), LLM에 top-set만 주던 축약 유지.
- LLM 토큰: rich data 커지면 max_output_tokens/effort 재점검(리포트 medium 이미 상향).

## Rollback
- 각 route는 프롬프트/스키마 커밋 단위 → git revert. 체중 기능은 jsonb 필드라 미사용 시 무해.
- buildStats/buildCoachContext는 순수 함수 → 이전 버전 복원 가능.

## Verification
- T1: 샘플 history → 부위 집계 콘솔 검증.
- T3: 체중 E2E(입력→GET) + Chrome 렌더.
- T4/T5: 실 history LLM 호출 전/후 스크린샷 — (신규 도배 사라짐 / 부위 밸런스·방치·체중 언급 / 개인화 인용).
- T6: build green, final-check, ui-chrome-verify.

## 완료 체크리스트

### 기능 완성 (Performance/성능 포함)
- [ ] 코치가 부위 편중/방치를 콕 집고, 최근 기록을 실제 인용하며, 오늘 처방 1개를 준다 (3~5문장, 뻔한 일반론 아님).
- [ ] 리포트가 부위별 주간 볼륨 밸런스 + 방치 부위 경고 + 체중·총볼륨 추세를 낸다. "신규" 위주가 아니다(부위 단위 트렌드).
- [ ] 체중 입력→Neon 저장→재조회(E2E)가 되고, 코치/리포트가 체중 추세를 참조한다.
- [ ] 성능: rich data 주입 후에도 코치 응답 지연 체감 없음(top-set 축약 제거로 payload 커짐 → max_output_tokens/effort 재점검, 24KB 상한 준수).

### 디자인 품질 (보안 포함)
- [ ] 리포트 카드에 부위 밸런스/방치/체중·볼륨 추세 섹션이 기존 톤(Linear/Notion, 스파르타 카피)과 일관되게 렌더. AI 슬롭 없음.
- [ ] 체중 입력 UI가 아침 페이지에 절제되게 통합(주 1~2회, 선택). 레이아웃 안 깨짐(모바일 포함).
- [ ] 보안: 새 `/api/bodyweight` GET/PUT는 기존 morning-videos 패턴 준수(try/await/catch, DB 미설정 폴백, origin 체크는 기존 posture 일관). 시크릿 하드코딩 없음.

### 엣지케이스 방어
- [ ] 데이터 부족(세션<4, 부위 표본 얕음): 판정 유보/기준점 안내로 폴백, 수치 지어내지 않음.
- [ ] 체중 미입력/1회뿐: 추세 대신 "기록 쌓자" 안내. NaN/빈배열 안전.
- [ ] 맨몸·거리·중량 혼재 세션에서 부위 볼륨 집계 정확(맨몸=Σ반복, 거리 제외). 기존 저장 데이터(bodyPart 없음)는 이름 폴백.
- [ ] 실 Neon 환경에서 더미 테스트 데이터 저장 금지(실데이터 오염 방지).
