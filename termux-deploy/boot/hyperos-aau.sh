#!/data/data/com.termux/files/usr/bin/bash
# Termux:Boot autostart script.
#
# Setup (one-time):
#   1. Install the "Termux:Boot" app (F-Droid — must be same source as Termux itself).
#   2. mkdir -p ~/.termux/boot
#   3. cp termux-deploy/boot/hyperos-aau.sh ~/.termux/boot/
#   4. Edit PROJECT_DIR below to match your actual install path.
#   5. Reboot the phone once to confirm it starts automatically.
#
# This makes the server + tunnel come back up automatically after a phone
# reboot, without you needing to open Termux and run start.sh by hand.
# Note: the public URL changes on every restart with the free quick tunnel
# (see termux-deploy/README.md for a stable-hostname alternative).

PROJECT_DIR="$HOME/hyperos-aau-js"   # <-- adjust to your actual path
sleep 15                             # give Android/network a moment after boot
cd "$PROJECT_DIR" && bash termux-deploy/start.sh >> "$PROJECT_DIR/termux-deploy/run/boot.log" 2>&1
