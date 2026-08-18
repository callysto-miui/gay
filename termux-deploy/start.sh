#!/data/data/com.termux/files/usr/bin/bash
# start.sh — start the server + a free Cloudflare Quick Tunnel, print the public URL.
# Run: bash termux-deploy/start.sh
# Stop: bash termux-deploy/stop.sh
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$PROJECT_DIR/termux-deploy/run"
mkdir -p "$RUN_DIR"

PORT="${PORT:-3000}"
SERVER_LOG="$RUN_DIR/server.log"
TUNNEL_LOG="$RUN_DIR/cloudflared.log"
SERVER_PID_FILE="$RUN_DIR/server.pid"
TUNNEL_PID_FILE="$RUN_DIR/cloudflared.pid"

if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
  echo "Server already running (PID $(cat "$SERVER_PID_FILE")). Run stop.sh first if you want to restart."
  exit 1
fi

# Optional: keep the CPU from doze-sleeping while this runs (needs Termux:API app + termux-api package).
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "Acquired termux-wake-lock (prevents Android from suspending Termux)."
else
  echo "Tip: 'pkg install termux-api' + the Termux:API app lets this script call termux-wake-lock"
  echo "     so Android doesn't freeze the process in the background."
fi

echo "Starting HyperOS AAU server on port $PORT..."
cd "$PROJECT_DIR"
PORT="$PORT" nohup node server.js > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$SERVER_PID_FILE"

# Wait for the server to actually come up before pointing a tunnel at it.
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz"; then
    break
  fi
  sleep 0.5
done

echo "Starting free Cloudflare quick tunnel..."
nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

echo -n "Waiting for tunnel URL"
URL=""
for i in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true)"
  if [ -n "$URL" ]; then break; fi
  echo -n "."
  sleep 0.5
done
echo ""

if [ -z "$URL" ]; then
  echo "Couldn't find the tunnel URL yet — check $TUNNEL_LOG manually."
else
  echo "=============================================="
  echo " Server PID:  $SERVER_PID   (log: $SERVER_LOG)"
  echo " Tunnel PID:  $TUNNEL_PID   (log: $TUNNEL_LOG)"
  echo " Public URL:  $URL"
  echo "=============================================="
  echo "This URL is random and changes every time you run start.sh."
  echo "Set SITE_PASSWORD before starting if you want this exposed URL locked down:"
  echo "  SITE_PASSWORD=yourpass bash termux-deploy/start.sh"
fi
