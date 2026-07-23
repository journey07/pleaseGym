# Plan — 세트 무게 cascade 일반화 + 운동 순서 드래그 재정렬

## 배경 / 현재 동작

`app/page.tsx`의 `updateSet` (674–714):
- 세트 무게/반복 변경 시 **오직 첫 번째 세트(index 0)를 바꿀 때만** 이후 세트로 전파됨 (line 698 `if (editedIndex !== 0) return set;` 가 원인).
- 전파 대상은 `inheritWeight`/`inheritReps` 플래그가 살아있는(=수동 수정 안 된) 이후 세트만. 세트를 직접 수정하면 그 세트의 inherit 플래그가 꺼짐(690–695).

운동 목록(`draft`)은 편집 패널(`.draft-list`, 1078~)에서 배열 순서대로 렌더. 재정렬 수단 없음. 드래그 라이브러리 미설치.

---

## 변경 1 — 무게/반복 cascade를 "편집한 세트 이후 전부"로 일반화

### 기능 완성 기준
- **어느 세트를 수정하든** 그 세트보다 **뒤(index 큰)** 세트 중 inherit 살아있는 세트가 새 값으로 갱신.
- 편집한 세트보다 **앞** 세트는 절대 안 바뀜.
- 편집한 세트 자신은 inherit 플래그가 꺼져 "앵커"가 됨 (기존 690–695 유지).
- weight/reps 각각 독립적으로 동작 (distance 종목의 단일 세트도 기존대로 무영향).

### 구현
`updateSet`의 map 콜백에서 편집 세트가 아닌 세트 처리부(698–707) 교체:
```
if (setIndex < editedIndex) return set;          // 앞 세트 보존
return {                                          // 뒤 세트: inherit면 전파
  ...set,
  ...(patch.weight !== undefined && set.inheritWeight ? { weight: patch.weight } : {}),
  ...(patch.reps   !== undefined && set.inheritReps   ? { reps:   patch.reps   } : {}),
};
```
- index 0 편집 시: 기존과 100% 동일 (setIndex<0 없음 → 전부 뒤 세트로 처리).
- 중간 세트 편집 시: 앞은 보존, 뒤 inherit 세트만 따라옴.

### 엣지케이스 방어
- 편집 세트가 마지막이면 뒤 세트 없음 → 자기만 변경 (정상).
- 이미 수동 수정된(inherit=false) 뒤 세트는 덮어쓰지 않음 → 사용자가 개별 지정한 값 보호.
- `editedIndex < 0`(세트 못 찾음) 방어는 기존 683 라인 그대로.

---

## 변경 2 — 운동 순서 드래그 재정렬 (@dnd-kit)

### 라이브러리
`@dnd-kit/core` `@dnd-kit/sortable` `@dnd-kit/utilities` 설치.
- peerDeps `react >=16.8` → React 19.2 호환. 터치+마우스 모두 지원, 스무스 애니메이션 내장.
- 설치는 dev 서버 끈 상태에서 1회 (lessons: 다수 Edit 중 install 금지 → install 먼저, 그 다음 코드).

### 기능 완성 기준
- 운동 헤더의 드래그 핸들(⠿)을 잡고 위/아래로 끌면 순서가 바뀌고, 놓으면 확정.
- 순서 변경 시 `setDirty(true)` → 저장 대상에 반영. 저장 로직(`saveWorkout`)은 `draft` 배열 순서를 그대로 쓰므로 별도 수정 불필요(확인 필요).
- 01/02/03 번호(`pad(exerciseIndex+1)`)가 드래그 후 자동 갱신.

### 구현
- 큰 JSX 재작성 최소화 위해 **render-prop 래퍼** `SortableExercise({id, children})` 도입:
  `useSortable`에서 `setNodeRef/transform/transition/attributes/listeners/isDragging`를 children 함수로 전달.
- `.draft-list`를 `<DndContext sensors=... onDragEnd>` + `<SortableContext items=draft.map(id) strategy=verticalListSortingStrategy>`로 감쌈.
- 각 `exercise-entry`에 `ref`, transform style, `.dragging` 클래스; `.exercise-head` 맨 앞에 핸들 span(`{...attributes}{...listeners}`).
- 센서: `PointerSensor`(activationConstraint distance 6px — 입력 클릭과 드래그 구분) + `KeyboardSensor`.
- `handleReorder`: `arrayMove(draft, oldIndex, newIndex)` → `setDraft` → `setDirty(true)`.

### 디자인 품질 (globals.css)
- `.drag-handle`: 회색 grip, `cursor: grab`/`:active grab`, 터치 타깃 ≥28px, `touch-action: none`.
- `.exercise-entry.dragging`: 살짝 들림(shadow + scale 1.02), 나머지는 dnd-kit transition으로 부드럽게 이동.
- 기존 입력 필드 클릭/포커스와 충돌 없게 핸들 영역에서만 드래그 시작.

### 엣지케이스 방어
- 운동 0~1개: 드래그해도 순서 불변(정상), 에러 없음.
- 드래그 중 입력 편집 방지: 핸들에서만 리스너 부착(입력 onChange 무영향).
- 터치 스크롤 vs 드래그: activationConstraint로 구분. 핸들 `touch-action: none`.
- 저장 안 하고 날짜 이동 시 기존 dirty 처리 흐름 그대로.

---

## 변경 3 — 운동 부위 분류 (하이브리드 자동+수동, 단일 부위)

결정: 자동 추론 + 수동 보정 / 운동당 부위 1개. `workoutHistory`/`favorites`가 `jsonb`라 **DB 마이그레이션 불필요** — `Exercise` 필드 추가만.

### 기능 완성 기준
- `Exercise`에 `bodyPart?: BodyPart`(가슴/등/어깨/허벅지/종아리/복근/허리/기타) + `bodyPartManual?: boolean` 추가.
- 운동 이름 입력/변경 시 키워드 사전으로 자동 태깅(`inferBodyPart`). 단, `bodyPartManual`이면 재추론 안 함(사용자 지정 유지).
- 각 운동에 칩 8개 표시, 탭하면 해당 부위로 지정 + `bodyPartManual=true` + `setDirty`.
- 저장 시 `...exercise` spread로 자동 보존. 기존/시드 데이터는 `bodyPart` 없으면 `inferBodyPart(name)` 폴백 표시(무마이그레이션).

### 구현
- 파일 상단: `BODY_PARTS` 배열, `BODY_PART_KEYWORDS`(부위별 키워드), `inferBodyPart(name)`, `exerciseBodyPart(ex)=ex.bodyPart ?? inferBodyPart(ex.name)`.
- 키워드 매칭 순서(first-hit) = 복근→종아리→허리→허벅지→등→가슴→어깨. 일반 토큰(프레스/레이즈/익스텐션)은 뒤로 배치해 오분류 방지(벤치프레스→가슴, 레그프레스→허벅지, 레그레이즈→복근, 백익스텐션→허리 검증).
- `createExercise`: `bodyPart: inferBodyPart(name), bodyPartManual:false`.
- `updateExerciseName`: `!bodyPartManual`면 bodyPart 재계산.
- `setExerciseBodyPart(id, part)` 핸들러 신규.
- JSX: `.exercise-head` 아래 `.bodypart-row`(칩 8개), 활성 칩 강조.

### 디자인 품질 (globals.css)
- `.bodypart-row`: 작은 pill 래핑, 비활성 muted, 활성 filled. 톤은 절제(Linear/Notion), 무지개 그라디언트 금지.
- 모바일에서도 칩 탭 타깃 확보, 줄바꿈 허용.

### 엣지케이스 방어
- 사전 미매칭 이름 → `기타`. distance 종목도 동일(달리기→기타).
- 짧은 모호 토큰(레그/익스텐션/레이즈/프레스) 오분류 → 순서·구체 토큰으로 회피(위 검증 케이스).
- 기존 데이터 `bodyPart` undefined → 폴백 추론, 사용자가 칩 누르면 확정 저장.

---

## 변경 4 — 아침 "가겠다/안 가겠다" 기기 간 동기화 버그

원인: 결정은 Neon `morning_events`에 저장되나, 페이지 mount 시 `localStorage`에서만 복원하고 서버 값을 읽는 GET이 없음(영상은 GET 있음, 결정만 누락).

### 구현
- `app/api/morning-coach/route.ts`: `GET` 핸들러 신규 — 기존 `getTodayMorningEvent()` 노출. DB 미설정 시 `{code:"not_configured", decision:null}`, 없으면 `{decision:null}`, 있으면 `{decision, coach, model, date}`.
- `app/morning/page.tsx`: mount에 서버 하이드레이션 useEffect 추가(videos 패턴). 서버에 오늘 결정 있으면 `setTodayDecision`+`storeDecision`(로컬 미러)+`setMissionStats` 재계산, coach 있으면 카드 복원+캐시. 서버=기기 간 진실 소스.

### 엣지케이스 방어
- 오프라인/DB 미설정 → 로컬 복원 유지(서버 decision null이면 로컬 안 지움).
- try-catch로 fetch 실패 시 로컬 폴백. `cancelled` 플래그로 언마운트 경합 방지.

## 변경 5 — 코치 분석 깊이 상향

- `app/api/training-report/route.ts`: `reasoning.effort` low→medium, `max_output_tokens` 1200→2400(reasoning 토큰이 예산 잠식해 JSON 잘림 방지).

---

## 검증
- `npm run build` (= test) 통과 확인(에러/경고 0).
- `/final-check`/`/qa` 런타임: cascade(1/중간/마지막 세트), 드래그 재정렬+저장, 부위 자동추론+칩 보정.
- 동기화(A): DB 있는 환경에서 기기 A 결정 → 기기 B mount 시 반영(E2E: 프론트→GET→DB→표시).
- 코치(B): 리포트 재생성 시 JSON 정상(토큰 예산 확인).
- Chrome MCP 렌더 확인(칩 레이아웃, 드래그 스무스).
