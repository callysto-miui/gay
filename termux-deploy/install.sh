#!/data/data/com.termux/files/usr/bin/bash
# install.sh — one-time setup: Node.js, project deps, cloudflared binary.
# Run this from the project root: bash termux-deploy/install.sh
set -euo pipefail

echo "[1/4] Updating Termux packages..."
pkg update -y && pkg upgrade -y

echo "[2/4] Installing Node.js + curl..."
pkg install -y nodejs-lts curl

echo "[3/4] Installing npm dependencies..."
cd "$(dirname "$0")/.."
npm install --omit=dev

echo "[4/4] Installing cloudflared..."
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) CF_ARCH="arm64" ;;
  armv7l|armv8l) CF_ARCH="arm" ;;
  x86_64)        CF_ARCH="amd64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
CF_BIN="$PREFIX/bin/cloudflared"

if command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared already installed: $(command -v cloudflared)"
else
  echo "Downloading cloudflared (${CF_ARCH})..."
  curl -L --fail -o "$CF_BIN" "$CF_URL"
  chmod +x "$CF_BIN"
fi

cloudflared --version

echo ""
echo "Setup complete. Next: bash termux-deploy/start.sh"
