#!/bin/zsh
# Morning Alarm sync — 웹앱(/api/morning-schedule)의 시간/on-off를 launchd 알람에 반영.
# launchd 에이전트(com.injeon.morning-sync)가 주기적으로 실행. 웹→Mac은 폴링만 가능하므로.
set -eu

readonly LABEL="com.injeon.morning-motivation"
readonly PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
readonly PLISTBUDDY="/usr/libexec/PlistBuddy"
readonly PYTHON_BINARY="/opt/homebrew/bin/python3"
readonly API_URL="https://please-gym.vercel.app/api/morning-schedule"
readonly LOG_DIR="${HOME}/Library/Logs/MorningMotivation"
readonly LOG_FILE="${LOG_DIR}/sync.log"

/bin/mkdir -p "${LOG_DIR}"
exec >>"${LOG_FILE}" 2>&1

log() { print -r -- "[$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')] $1"; }

is_loaded() { /bin/launchctl list 2>/dev/null | /usr/bin/grep -q "${LABEL}"; }

# 설정 fetch (실패 시 조용히 종료 — 다음 폴링에서 재시도).
if ! response=$(/usr/bin/curl -fsS --max-time 8 "${API_URL}"); then
  log "config fetch 실패 — 이번 주기 건너뜀."
  exit 0
fi

# python으로 안전 파싱: "configured enabled hour minute" 한 줄.
if ! parsed=$(print -r -- "${response}" | "${PYTHON_BINARY}" -c '
import json, sys
try:
    payload = json.load(sys.stdin)
    configured = 1 if payload.get("configured") is True else 0
    d = payload.get("schedule", {})
    en = 1 if d.get("enabled", True) else 0
    h = int(d.get("hour", 7)); m = int(d.get("minute", 29))
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ValueError
    print(configured, en, h, m)
except Exception:
    sys.exit(1)
'); then
  log "config 파싱 실패 — 건너뜀."
  exit 0
fi

configured=${parsed[(w)1]}
enabled=${parsed[(w)2]}
hour=${parsed[(w)3]}
minute=${parsed[(w)4]}

if [[ "${configured}" != "1" ]]; then
  log "config 미설정 — 이번 주기 건너뜀."
  exit 0
fi

if [[ ! -f "${PLIST}" ]]; then
  log "morning plist 없음 (${PLIST}) — 스킵."
  exit 0
fi

# OFF: 알람 언로드.
if [[ "${enabled}" == "0" ]]; then
  if is_loaded; then
    /bin/launchctl unload -w "${PLIST}" 2>/dev/null || true
    log "알람 OFF → 언로드."
  fi
  exit 0
fi

# ON: 현재 plist 시간 읽기.
cur_hour=$("${PLISTBUDDY}" -c "Print :StartCalendarInterval:Hour" "${PLIST}" 2>/dev/null || echo "")
cur_min=$("${PLISTBUDDY}" -c "Print :StartCalendarInterval:Minute" "${PLIST}" 2>/dev/null || echo "")

changed=0
if [[ "${cur_hour}" != "${hour}" || "${cur_min}" != "${minute}" ]]; then
  "${PLISTBUDDY}" -c "Set :StartCalendarInterval:Hour ${hour}" "${PLIST}" 2>/dev/null \
    || "${PLISTBUDDY}" -c "Add :StartCalendarInterval:Hour integer ${hour}" "${PLIST}"
  "${PLISTBUDDY}" -c "Set :StartCalendarInterval:Minute ${minute}" "${PLIST}" 2>/dev/null \
    || "${PLISTBUDDY}" -c "Add :StartCalendarInterval:Minute integer ${minute}" "${PLIST}"
  changed=1
  log "시간 변경 ${cur_hour}:${cur_min} → ${hour}:${minute}."
fi

# 변경됐거나 로드 안 돼 있으면 reload.
if [[ "${changed}" == "1" ]] || ! is_loaded; then
  /bin/launchctl unload "${PLIST}" 2>/dev/null || true
  /bin/launchctl load -w "${PLIST}"
  log "알람 ON, ${hour}:${minute}로 (재)로드."
fi
