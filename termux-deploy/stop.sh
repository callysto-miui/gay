#!/data/data/com.termux/files/usr/bin/bash
# stop.sh — stop the server + cloudflared tunnel started by start.sh
set -uo pipefail

RUN_DIR="$(cd "$(dirname "$0")" && pwd)/run"

stop_pid_file() {
  local file="$1" label="$2"
  if [ -f "$file" ]; then
    local pid
    pid="$(cat "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo "Stopped $label (PID $pid)."
    else
      echo "$label not running (stale PID file)."
    fi
    rm -f "$file"
  else
    echo "$label: no PID file found."
  fi
}

stop_pid_file "$RUN_DIR/cloudflared.pid" "cloudflared tunnel"
stop_pid_file "$RUN_DIR/server.pid" "server"

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock
fi
