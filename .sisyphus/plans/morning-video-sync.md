# Plan — 모닝 비디오 웹앱 ↔ 맥 스크립트 연동

## 문제 / 원인
- 웹앱 영상 목록은 브라우저 `localStorage`(`first-rep-morning-videos`)에만 존재 → 서버·맥에서 읽을 경로 없음.
- 맥 스크립트 `morning-motivation.sh`(매일 06:00, launchd)는 `player.html`에 유튜브 영상이 하드코딩(`zJQaEXcP2SI`) → 목록 무시.
- 앱엔 Neon DB(`/api/state`)가 있으나 영상 목록은 저장 안 됨.
- 배포(`https://please-gym.vercel.app`) API는 **인증 없이 공개 접근 가능** 확인 → 맥 스크립트가 bypass 토큰 없이 curl 가능.

## 결정 (사용자 합의)
- 저장소: **서버 DB + 스크립트 fetch**.
- 6시 재생: **랜덤** (웹앱 openRandomVideo와 동일).

## 변경 항목

### 1. DB — 컬럼 추가 (`db/schema.ts` + 마이그레이션)
- `userState`에 `morningVideos: jsonb("morning_videos").$type<unknown[]>().notNull().default([])` 추가.
- `npx drizzle-kit generate` → `drizzle/0001_*.sql` (ALTER TABLE ADD COLUMN, additive·안전).
- **배포 반영**: Neon 프로덕션에 마이그레이션 적용 필요 (사용자 실행).

### 2. API — 신규 라우트 `app/api/morning-videos/route.ts`
- `GET`: `{ configured, videos }` 반환 (작은 페이로드 — 맥 스크립트용).
- `PUT`: `{ videos: [...] }` 검증(배열 + 크기 상한 재사용) 후 `user_state.morning_videos` upsert.
- `ownerId()` = 기존 로직 재사용 (`FIRST_REP_OWNER_ID ?? "local-owner"`).
- DB 미설정 시 기존 `unavailable()` 503 패턴 재사용.

### 3. 웹앱 — `app/morning/page.tsx` (기존 page.tsx 동기화 패턴 그대로)
- localStorage 하이드레이션 후 `GET /api/morning-videos`:
  - 서버에 목록 있으면 → 그걸로 `setVideos` + localStorage 미러.
  - 서버 비었고 로컬 있으면 → `PUT`으로 import.
  - `videosNeonReady` 플래그 set.
- `videos` 변경 시 450ms 디바운스 `PUT` (ready일 때만).
- localStorage 쓰기는 유지 → 오프라인/로컬 dev fallback.

### 4. 맥 스크립트 — `morning-motivation.sh`
- 하드코딩 `VIDEO_ID` 제거 → 실행 시:
  1. `curl -fsS https://please-gym.vercel.app/api/morning-videos` (타임아웃 8s).
  2. python으로 JSON 파싱 → 유효 URL 필터 → `random.choice`.
  3. 성공 시 목록을 `${ROUTINE_DIR}/videos-cache.json`에 캐시.
- **Fallback 체인**: 서버 실패/빈 목록 → 캐시 파일 → 하드코딩 기본값 `zJQaEXcP2SI`.
- 선택된 URL에서 유튜브 ID 추출(youtu.be / watch?v= / shorts / embed). 유튜브 아니면 원본 URL을 그대로 kiosk로 오픈.

### 5. `player.html` — 동적 생성
- 스크립트가 매 실행 시 선택된 영상 ID로 `player.html`을 heredoc 템플릿에서 재생성 (referrer/origin 파라미터 유지).
- 기존 `.bak` 백업 유지.

## 검증
- API: 로컬 `PUT`→`GET` 왕복, 잘못된 body 400, DB 미설정 503.
- 웹앱: 영상 추가/삭제 후 새로고침 시 서버에서 복원, 다른 브라우저에서 동일 목록.
- 맥 스크립트: 수동 실행(`launchctl kickstart` 또는 직접 실행)으로 랜덤 영상 재생 + API 다운 시 fallback 동작 확인. `/final-check` 검증.

## 배포 순서 (사용자)
1. Neon 프로덕션 마이그레이션 적용.
2. Vercel 재배포.
3. 맥 스크립트/player.html은 로컬 — 다음 06:00 또는 수동 실행 시 반영.

## 5대 체크
- **성능**: 맥 스크립트 GET은 작은 전용 엔드포인트(전체 state 아님) → 페이로드 최소. 웹앱 PUT은 450ms 디바운스로 과다 호출 방지. curl 타임아웃 8s로 6시 루틴 지연 상한.
- **보안**: API는 이미 공개(단일 사용자 MVP). PUT body 크기 상한(500KB) + 배열 검증 재사용. 시크릿 하드코딩 없음(공개 URL만). 임의 URL 저장되므로 player.html 주입 시 영상 ID/URL을 python으로 파싱·화이트리스트(youtube/원본 URL만) → 스크립트 인젝션 차단.
- **확장성**: jsonb 컬럼이라 영상 스키마 확장 자유. 전용 라우트라 향후 다중 사용자 시 ownerId 스코프만 확장.
- **엣지케이스**: 서버 다운 / 빈 목록 / 파싱 불가 URL / 유튜브 아닌 URL / DB 미설정 로컬 — 각각 fallback 체인(캐시→기본값) 및 raw URL 오픈으로 처리. 네트워크 자체 다운 시 유튜브 재생 불가는 불가피(로그만).
- **롤백**: 컬럼은 additive(default `[]`)라 기존 동작 무영향 → 앱만 이전 배포로 되돌리면 됨. 맥 스크립트/player.html은 `.bak` 백업 유지 → `git`/백업 복원으로 즉시 원복.

## 완료 체크리스트

### 기능 완성
- [ ] `GET /api/morning-videos` 로컬에서 저장된 목록 반환 확인
- [ ] `PUT /api/morning-videos` 저장 후 GET 왕복 일치
- [ ] 웹앱에서 영상 추가/삭제 → 새로고침 후 서버에서 복원
- [ ] 맥 스크립트 수동 실행 시 목록에서 랜덤 영상 kiosk 재생

### 디자인 품질
- [ ] 웹앱 영상 섹션 기존 UI/동작(추가·삭제·랜덤 열기) 그대로 유지
- [ ] 서버 동기화 실패해도 localStorage로 기존처럼 동작(무중단)
- [ ] 저장 상태가 사용자에게 혼란 주지 않음(기존 notice 톤 유지)

### 엣지케이스 방어
- [ ] API 다운 → 캐시 파일 → 기본 영상 순으로 fallback 동작
- [ ] 목록 비었을 때 기본 영상 재생
- [ ] 유튜브 아닌 URL → raw URL 오픈, 파싱 불가 URL 제외
- [ ] DB 미설정 로컬 환경에서 503 처리 + 앱 크래시 없음
