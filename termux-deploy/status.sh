#!/data/data/com.termux/files/usr/bin/bash
# status.sh — quick check of what's running and the current tunnel URL.
set -uo pipefail

RUN_DIR="$(cd "$(dirname "$0")" && pwd)/run"

check() {
  local file="$1" label="$2"
  if [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then
    echo "$label: RUNNING (PID $(cat "$file"))"
  else
    echo "$label: stopped"
  fi
}

check "$RUN_DIR/server.pid" "Server"
check "$RUN_DIR/cloudflared.pid" "Tunnel"

if [ -f "$RUN_DIR/cloudflared.log" ]; then
  URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$RUN_DIR/cloudflared.log" | head -n1 || true)"
  [ -n "$URL" ] && echo "Public URL: $URL"
fi
