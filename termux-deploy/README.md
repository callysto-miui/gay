# Deploying on Termux with a free Cloudflare Tunnel

This runs the whole server (not just the cookie-push companion script)
directly on your phone in Termux, and exposes it publicly with
[`cloudflared`'s free Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) —
no domain, no Cloudflare account, no cost.

This is actually a better fit than Render for this project specifically:
the main README already notes that Xiaomi's login step gets blocked from
datacenter IPs (Render/AWS/GCP) but works fine from a real phone. Running
directly in Termux means the login *and* the scheduled firing both happen
from your phone's real mobile/residential IP — no separate companion-device
cookie push needed.

## 1. Install Termux

Get Termux from **F-Droid** (not the Play Store version, which is
unmaintained and can't update its packages):
https://f-droid.org/packages/com.termux/

## 2. Get the project onto your phone

Easiest: `pkg install git` then `git clone` your repo. Or transfer this
folder however you like (e.g. `termux-setup-storage` + copy from
`/sdcard/Download`).

## 3. One-time setup

```bash
cd hyperos-aau-js
bash termux-deploy/install.sh
```

This installs Node.js, runs `npm install`, and downloads the `cloudflared`
binary for your phone's CPU architecture (arm64 on virtually all modern
Android phones).

## 4. Start it

```bash
bash termux-deploy/start.sh
```

This starts `node server.js` in the background, waits for it to come up,
then starts `cloudflared tunnel --url http://127.0.0.1:3000` and prints the
public `https://<random>.trycloudflare.com` URL once it's ready. Open that
URL in a browser (on this phone or any other device) to use the same web UI
described in the main README — sign in, paste a cookie, generate a Termux
setup link, etc.

To lock the exposed URL down with a password (recommended — see the
"shared, single-session service" caveat in the main README):

```bash
SITE_PASSWORD=yourpassword bash termux-deploy/start.sh
```

## 5. Check status / stop

```bash
bash termux-deploy/status.sh   # shows PIDs + current public URL
bash termux-deploy/stop.sh     # stops both processes
```

## 6. Keeping it alive in the background

Android will happily kill background Termux processes to save battery. Two
things help:

- **Termux wake lock.** `pkg install termux-api` and install the
  Termux:API app (same F-Droid source), then `start.sh` will automatically
  call `termux-wake-lock` for you. Also disable battery optimization for
  Termux in Android's app settings (Settings → Apps → Termux → Battery →
  Unrestricted).
- **A persistent notification.** Running `termux-wake-lock` shows a
  low-priority notification while active — that's expected and is what
  keeps Android from freezing the process.

## 7. Auto-start on reboot (optional)

See `termux-deploy/boot/hyperos-aau.sh` — install the **Termux:Boot** app
(F-Droid), copy that script to `~/.termux/boot/`, and it'll relaunch the
server + tunnel automatically after a phone reboot.

## Free Quick Tunnel limitations

- **The URL is random and changes every time you restart the tunnel.**
  Fine for personal use where you just re-open the link each session, but
  not a stable address to bookmark or hardcode into `push_cookie.py --server`.
- **No SLA / best-effort.** It's a free Cloudflare feature meant for
  exactly this kind of personal/dev use, not production traffic.

If you want a **stable hostname** instead (still free), Cloudflare also
offers *named* tunnels tied to a domain you control in a free Cloudflare
account:

```bash
cloudflared tunnel login                 # one-time browser auth
cloudflared tunnel create hyperos-aau
cloudflared tunnel route dns hyperos-aau aau.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:3000 hyperos-aau
```

That requires owning a domain and pointing it at Cloudflare's nameservers —
more setup, but the URL never changes. The quick tunnel in `start.sh` needs
none of that.

## Outbound UDP note

The main README flags that some PaaS hosts block outbound UDP, which the
`lib/ntp.js` SNTP client needs. Termux on a phone doesn't have that
restriction — regular mobile/Wi-Fi networks allow outbound UDP, so NTP
sync should work normally here (check `termux-deploy/run/server.log` if
you ever see `[NTP] All N sample(s) failed`).
