# Plan — 아침 루틴 시간/on-off UI + Mac 연동

## 목표
아침 영상 루틴의 **시간(HH:MM)과 on/off**를 앱에서 설정 → macOS launchd 알람에 near-instant 반영.

## 배경 (확인됨)
- `com.injeon.morning-motivation.plist`(launchd, StartCalendarInterval 7:29) → `morning-motivation.sh` 실행.
- `morning-motivation.sh`는 이미 `https://please-gym.vercel.app/api/morning-videos`를 curl → 웹앱이 다리.
- 웹→Mac 푸시는 불가 → Mac이 폴링해야 near-instant.

## 설계
웹앱이 config 저장, Mac sync 에이전트가 15분마다 폴링해 plist를 맞춘다.

### 기능 완성 기준
1. **웹 UI**(`/morning` "아침 루틴" 카드): ON/OFF 토글 + 시간 입력(`<input type=time>`), 자동 저장, 상태 표시("매일 오전 7:29 재생" / "꺼짐"). 절제된 톤(Linear/Notion).
2. **저장**: `userState.morningSchedule` jsonb `{enabled, hour, minute}`(ADD COLUMN, 직접 적용). 기본 `{true,7,29}`.
3. **API** `/api/morning-schedule` GET/PUT(morning-videos 패턴, force-dynamic, 부분 upsert).
4. **Mac sync**: `morning-sync.sh` + `com.injeon.morning-sync.plist`(StartInterval 900 + RunAtLoad):
   - curl GET config → enabled면 morning plist의 시간을 hour/minute로 맞추고(다르면 rewrite+`launchctl bootout/bootstrap`), 로드 보장.
   - disabled면 morning plist bootout(안 뜨게).
   - 멱등: 변경 시에만 reload. 실패는 로그.
5. **morning-motivation.sh**: 실행 초입에 enabled 재확인(fetch, off면 조기 종료) — belt-and-suspenders.
6. Mac 스크립트/plist는 repo `scripts/mac/`에도 버전 보관.

### 디자인 품질
- 토글은 큰 스위치, 시간은 native time input(모바일 휠). 저장 피드백 subtle. AI 슬롭 없음.

### 엣지케이스 방어
- config 없음(첫 로드) → 기본 7:29 enabled. API/DB 미설정 → UI는 로컬 유지, Mac은 기존 plist 유지.
- sync가 잘못된 시간(범위 밖) 받으면 무시. launchctl 실패 시 로그만, 크래시 X.
- off→on 전환 시 morning plist 재로드. 동시성: 단일 오너라 무시.
- 실제 Neon 공유 DB → 더미 저장 금지.

## 검증
- build/lint. `/api/morning-schedule` PUT→GET E2E(후 원복). sync 스크립트 dry-run(plist 시간 반영 확인). UI 렌더.

## 완료 체크리스트
### 기능 완성 (성능)
- [ ] UI에서 시간/on-off 변경 → Neon 저장 → GET 반영(E2E).
- [ ] Mac sync가 config 읽어 morning plist 시간 rewrite + reload(변경 시만), off면 unload.
- [ ] morning 스크립트 enabled 재확인으로 off 시 조기 종료.
- [ ] 성능: sync 15분 폴링, curl 타임아웃, 변경 없으면 no-op(불필요 reload 방지).
### 디자인 품질 (보안)
- [ ] 토글/시간 UI 절제된 톤, 모바일 안 깨짐, 저장 피드백 명확.
- [ ] `/api/morning-schedule`는 videos 패턴(try/catch, DB 폴백, 부분 upsert). 시크릿 하드코딩 없음.
- [ ] launchctl/plist 조작은 사용자 소유 경로만, sudo 불필요.
### 엣지케이스 방어
- [ ] config 없음/DB 미설정/범위 밖 값 → 안전 폴백.
- [ ] launchctl 실패 → 로그만, 다음 폴링서 재시도.
- [ ] 공유 Neon에 더미 저장 금지.
