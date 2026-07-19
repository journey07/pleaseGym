# Metis critique (Opus 4.8) — morning-checkin-llm plan

## Verdict: 조건부 통과 (reject 없음, 3개 보강)

## Findings

### I1 (보강) — 새로고침 후 코치 카드 복원 미명시
T5는 `todayDecision` 복원만 명시하고, 이전에 성공한 coach 결과 카드를 마운트 시 복원하는지 불명확.
React state는 리로드로 초기화되므로, `first-rep-coach-result` 캐시가 있으면 마운트 시 `coach` state까지
복원해 카드를 즉시 렌더해야 함(재-POST 없이). → T5에 명시 추가.

### I2 (보강) — no_go의 progressNote 처리
responseSchema strict + required이므로 no_go도 progressNote 문자열 필수. no_go는 exercises 빈 배열이라
진행도 분석 대상이 없음. 프롬프트에 "no_go면 progressNote는 짧은 격려 또는 빈 문자열 허용" 명시 필요.
→ T3 프롬프트 규칙에 추가.

### I3 (수용 위험, 문서화) — coachMemory read-modify-write 레이스
T3 append는 userState를 읽고 배열에 추가 후 upsert. 동시 POST 2건이면 한쪽이 덮일 수 있음.
단일 사용자(FIRST_REP_OWNER_ID) 전제 + 아침 체크인은 사실상 순차라 실질 위험 낮음. 수용하되 Guardrails에 명시.

## Over-engineering 점검
- `first-rep-coach-result` localStorage 캐시: DB 미설정 로컬 시나리오 D 대응에 필요. 앱이 이미 오프라인
  localStorage 우선 구조라 일관적. 과설계 아님 — 유지.
- 5분기 contract: 요구(멱등+전환+재시도)에서 직접 도출. 최소 분기. 유지.
- 결론: 제거할 과설계 없음.

## 통과 근거 (Momus 4기준 예비)
- Clarity: 각 Task가 파일/라인/함수명 명시. OK.
- Verification: acceptance가 grep/curl/시나리오로 측정 가능. OK.
- Context: draft+learnings 근거, guesswork <10%. OK.
- Big picture: Purpose/Scope/Rollback 명확. OK.
