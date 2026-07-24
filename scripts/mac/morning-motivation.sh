#!/bin/zsh

set -eu

readonly BRAVE_APP="/Applications/Brave Browser.app"
readonly PYTHON_BINARY="/opt/homebrew/bin/python3"
readonly ROUTINE_DIR="/Users/Injeon/Library/Application Support/MorningMotivation"
readonly LOG_DIR="/Users/Injeon/Library/Logs/MorningMotivation"
readonly LOG_FILE="${LOG_DIR}/routine.log"
readonly VIDEO_API_URL="https://please-gym.vercel.app/api/morning-videos"
readonly VIDEO_CACHE_FILE="${ROUTINE_DIR}/videos-cache.json"
readonly DEFAULT_VIDEO_ID="zJQaEXcP2SI"
readonly OUTPUT_VOLUME="40"

/bin/mkdir -p "${ROUTINE_DIR}" "${LOG_DIR}"
exec >>"${LOG_FILE}" 2>&1

timestamp() {
  /bin/date '+%Y-%m-%d %H:%M:%S %Z'
}

pick_video_url() {
  "${PYTHON_BINARY}" - "$1" "$2" <<'PYTHON'
import json
import os
import random
import sys
from urllib.parse import urlparse

source_path = sys.argv[1]
cache_path = sys.argv[2]

try:
    with open(source_path, encoding="utf-8") as source:
        payload = json.load(source)
except (OSError, ValueError):
    raise SystemExit(1)

entries = payload.get("videos") if isinstance(payload, dict) else payload
if not isinstance(entries, list):
    raise SystemExit(1)

valid_videos = []
for entry in entries:
    if not isinstance(entry, dict):
        continue
    value = entry.get("url")
    if not isinstance(value, str):
        continue
    url = value.strip()
    if not url or any(ord(character) < 32 for character in url):
        continue
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        continue
    video = dict(entry)
    video["url"] = url
    valid_videos.append(video)

if not valid_videos:
    raise SystemExit(1)

if cache_path:
    temporary_path = f"{cache_path}.tmp"
    try:
        with open(temporary_path, "w", encoding="utf-8") as cache:
            json.dump(valid_videos, cache, ensure_ascii=False)
        os.replace(temporary_path, cache_path)
    except OSError as error:
        print(f"Could not update video cache: {error}", file=sys.stderr)

print(random.choice(valid_videos)["url"])
PYTHON
}

classify_video_url() {
  "${PYTHON_BINARY}" - "$1" <<'PYTHON'
import re
import sys
from urllib.parse import parse_qs, urlparse

url = sys.argv[1]
parsed = urlparse(url)
host = (parsed.hostname or "").lower().rstrip(".")
path_parts = [part for part in parsed.path.split("/") if part]
video_id = None

if host in {"youtu.be", "www.youtu.be"} and path_parts:
    video_id = path_parts[0]
elif host == "youtube.com" or host.endswith(".youtube.com") or host == "youtube-nocookie.com" or host.endswith(".youtube-nocookie.com"):
    if parsed.path.rstrip("/") == "/watch":
        video_id = parse_qs(parsed.query).get("v", [None])[0]
    elif len(path_parts) >= 2 and path_parts[0] in {"shorts", "embed"}:
        video_id = path_parts[1]

if isinstance(video_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
    print(f"https://www.youtube.com/watch?v={video_id}")
else:
    print(url)
PYTHON
}

print -r -- "[$(timestamp)] Morning Motivation routine started."

# App(/api/morning-schedule)에서 알람이 꺼져 있으면 조기 종료. sync 에이전트가 보통
# 언로드하지만, 15분 폴링 창을 커버하는 2차 안전장치. fetch 실패 시엔 그대로 진행.
readonly SCHEDULE_API_URL="https://please-gym.vercel.app/api/morning-schedule"
if schedule_enabled=$(/usr/bin/curl -fsS --max-time 6 "${SCHEDULE_API_URL}" 2>/dev/null \
  | "${PYTHON_BINARY}" -c 'import json,sys; print("1" if json.load(sys.stdin).get("schedule",{}).get("enabled",True) else "0")' 2>/dev/null); then
  if [[ "${schedule_enabled}" == "0" ]]; then
    print -r -- "[$(timestamp)] Skipped: morning alarm is OFF in the app."
    exit 0
  fi
fi

if [[ ! -d "${BRAVE_APP}" ]]; then
  print -r -- "[$(timestamp)] ERROR: Brave Browser was not found at ${BRAVE_APP}."
  exit 1
fi

if [[ ! -x "${PYTHON_BINARY}" ]]; then
  print -r -- "[$(timestamp)] ERROR: Python was not found at ${PYTHON_BINARY}."
  exit 1
fi

selected_url=""
selected_source=""

if api_response_file=$(/usr/bin/mktemp "${ROUTINE_DIR}/videos-api.XXXXXX"); then
  if /usr/bin/curl -fsS --max-time 8 "${VIDEO_API_URL}" --output "${api_response_file}"; then
    if selected_url=$(pick_video_url "${api_response_file}" "${VIDEO_CACHE_FILE}"); then
      selected_source="api"
    fi
  fi
  /bin/rm -f "${api_response_file}" || true
fi

if [[ -z "${selected_url}" && -f "${VIDEO_CACHE_FILE}" ]]; then
  if selected_url=$(pick_video_url "${VIDEO_CACHE_FILE}" ""); then
    selected_source="cache"
  fi
fi

if [[ -z "${selected_url}" ]]; then
  selected_url="https://www.youtube.com/watch?v=${DEFAULT_VIDEO_ID}"
  selected_source="default"
fi

launch_url=$(classify_video_url "${selected_url}")

print -r -- "[$(timestamp)] Selected ${selected_source} video: ${selected_url}"

# Set a predictable, audible volume before launching the video.
# Never let a transient volume-control failure abort the routine under `set -e`.
/usr/bin/osascript -e "set volume output volume ${OUTPUT_VOLUME} without output muted" || true

# Brave reuses an existing session or launches normally, opening the URL in a new tab.
# Captions and dubbing follow the user's Brave/YouTube account defaults.
if /usr/bin/open -a "Brave Browser" "${launch_url}"; then
  /bin/sleep 6

  # Requires macOS Accessibility permission for the launchd/osascript process:
  # System Settings -> Privacy & Security -> Accessibility. If the video does not
  # go fullscreen at 6AM, this permission is the likely cause.
  /usr/bin/osascript -e 'tell application "Brave Browser" to activate' -e 'delay 0.5' -e 'tell application "System Events" to keystroke "f"' || true
  print -r -- "[$(timestamp)] Fullscreen keystroke attempted."
  print -r -- "[$(timestamp)] SUCCESS: Opened ${launch_url} in Brave Browser."
else
  print -r -- "[$(timestamp)] ERROR: Could not open ${launch_url} in Brave Browser."
  exit 1
fi
