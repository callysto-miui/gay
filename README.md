# HyperOS Auto Unlock (Node.js port)

A Node/Express port of the Android "HyperOS AAU" tool: logs into your Xiaomi
account, waits for the daily bootloader-unlock quota reset (00:00 Beijing
time), and fires one or more precisely-timed requests at the official apply
endpoint.

## Structure

```
server.js            Express app + SSE log/status stream + REST API
lib/xiaomiAuth.js     Login flow (password auth, optional email OTP)
lib/unlockService.js  NTP sync, countdown scheduling, wave firing
lib/ntp.js            Dependency-free SNTP client (UDP)
public/index.html     Single-page control UI (mirrors the Android app)
render.yaml            Render Blueprint (one-click deploy config)
```

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Sign in with your Xiaomi account in the UI (handles the email-OTP step if
your account needs it), or paste a `Cookie` header directly if you already
have one. Set "Max Triggers", then "Verify & Start Process" — logs and wave
results stream live via Server-Sent Events.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. In Render: **New +** → **Blueprint**, point it at the repo — `render.yaml`
   configures the service automatically (Node web service, `npm install`,
   `node server.js`).
   - Or manually: **New +** → **Web Service** → build command `npm install`,
     start command `node server.js`.
3. Deploy. Render assigns a public URL serving the same UI.

## Keeping it running with UptimeRobot

Render's free web services spin down after ~15 minutes with no inbound HTTP
traffic. To stop that from happening:

1. Deploy this repo to Render (see above) and note the public URL, e.g.
   `https://hyperos-aau.onrender.com`.
2. In [UptimeRobot](https://uptimerobot.com), add a new **HTTP(s)** monitor:
   - URL: `https://hyperos-aau.onrender.com/healthz`
   - Interval: every 5 minutes (comfortably under Render's 15-minute
     inactivity window)
3. That's it — as long as UptimeRobot keeps pinging, the dyno stays warm and
   `service.start()` (which runs as a plain async function on the Node event
   loop, not tied to any individual HTTP request) keeps counting down and
   will fire at Beijing midnight even with no browser tab open.

Two things this does **not** protect against:
- **Redeploys.** Pushing a new commit or manually redeploying restarts the
  process and loses any run that was mid-countdown. Don't redeploy while a
  countdown is active — check `GET /api/status` (`isRunning: true`) first.
- **Render's own maintenance restarts.** Rare, but possible on any host.
  `server.js` now logs a clear `[Server] Shutting down WHILE a scheduled run
  is in progress` warning to Render's log viewer if this happens, so at least
  you'll know why a run didn't fire.

The persisted login (see below) means that even if a restart does happen,
the *next* run only needs "Verify & Start Process" again — not a fresh
login — as long as disk state survived the restart.

## Session persistence

`lib/store.js` writes the logged-in account (`userId`, `serviceToken`,
`region`, `deviceId`) to `data/account.json` on disk after a successful
login, and the server reloads it on boot — mirroring the Kotlin app's
`SharedPreferences`-based `persistAccount()` / `loadPersistedAccount()`. The
UI calls `GET /api/account` on load to restore your logged-in state
automatically.

Caveat: Render's free-tier disk persists across sleep/wake cycles but is
**wiped on redeploy**. If you need it to survive redeploys too, swap
`lib/store.js` for a real datastore (Render Postgres/Redis, or even a
tiny external key-value service) — the three exported functions
(`saveAccount`/`loadAccount`/`clearAccount`) are the only thing to swap out.

## Important caveats before you rely on this in production

- **Free-tier sleep.** Render's free web services spin down after ~15 minutes
  of inbound-traffic inactivity and take a few seconds to cold-start on the
  next request. The countdown loop itself runs fine once a request is being
  served (it's driven by your browser hitting `/api/start`, then the server
  process stays alive doing the waiting/firing), but if the *dyno* gets
  killed for other reasons mid-wait you'll miss the window. For an
  unattended, exact-midnight run, use a paid instance type that doesn't sleep,
  or keep the tab open and the server warm.
- **Outbound UDP for NTP.** Some PaaS sandboxes restrict outbound UDP, which
  the SNTP client in `lib/ntp.js` needs to hit `pool.ntp.org:123`. If NTP
  requests fail in your environment, the code falls back to a 0ms offset
  (trusting the container's system clock, which on most cloud VMs is already
  NTP-synced by the host). Check your Render service logs after a run — you'll
  see `[NTP] All N sample(s) failed` if this happens.
- **This is a shared, single-session service.** As written, `server.js` keeps
  one `UnlockService` instance for the whole deployment — fine for personal
  use, but if you expose the URL publicly, anyone who finds it can see your
  logs and control the process, and login/cookie values pass over your
  connection to the server. Put it behind Render's basic-auth / IP allowlist,
  or your own auth middleware, before sharing the URL with anyone or leaving
  it publicly reachable.
- **Credentials handling.** Password is only held in memory for the duration
  of the login call and never persisted; only the resulting `serviceToken`
  cookie is kept (in memory, not written to disk). If you restart the
  service you'll need to sign in again or re-paste the cookie.

## Feature parity checklist (vs. the original Kotlin/Compose app)

| Kotlin app (`UnlockViewModel.kt` / `XiaomiAuth.kt` / `MainActivity.kt`) | JS port |
|---|---|
| `XiaomiAuthClient.login()` — password auth via `pass/serviceLoginAuth2` | `lib/xiaomiAuth.js` → `login()` ✅ |
| Email-OTP branch (`XiaomiEmailVerificationRequired`, `sendEmailCode`, `verifyEmailCode`) | Same three methods, same error types ✅ |
| Cookie/serviceToken derivation (`finishLogin`, nonce/ssecurity signing) | `_finishLogin()` — identical SHA-1 signing scheme ✅ |
| `buildCookieHeader()` | `XiaomiAuthClient.buildCookieHeader()` ✅ |
| NTP multi-sample median offset (`getNtpOffset`) | `lib/ntp.js` → `getNtpOffsetMs()`, dependency-free UDP client ✅ |
| Beijing-midnight target + periodic re-sync while waiting | `unlockService.js` → `start()` main loop ✅ |
| Final latency measurement (median of HEAD requests) | `measureLatencyMs()` ✅ |
| Multi-wave bracket scheduling (±60ms spread across `maxTriggers`) | Same offset formula in `start()` ✅ |
| `sendWave()` → POST `bl-auth`, parse `apply_result` (1/2/6) | `sendWave()`, same result codes/meanings ✅ |
| Live log console | SSE `log` events → `#log` panel ✅ |
| Wave status cards (IDLE/SENDING/SUCCESS/FULL/ERROR) | SSE `wave` events → `.wave` cards ✅ |
| Countdown text updates | SSE `status` events → `#countdown` ✅ |
| Start/Stop buttons, abort mid-run | `/api/start`, `/api/stop` ✅ |
| Persisted account across restarts (`SharedPreferences`) | `lib/store.js` (disk-backed) ✅ |
| Local push notification on success | *Not ported* — no mobile OS to notify. The SSE `wave`/`log`/`done` events give you the same info in the browser; wire up your own webhook/email/Telegram alert in `unlockService.js`'s `sendWave()` if you want out-of-band notification. |
| `caffeineMode` (keep phone screen on) | *N/A* — this is a server process, nothing to keep awake on-device. |
| Wake lock (`PowerManager`) | *N/A* — no OS-level sleep to fight; Render keeps the process running as long as the dyno is up (see UptimeRobot section). |

Everything that affects the actual timing/firing/auth logic is ported
1:1. The two "not ported" rows are Android-OS-specific concerns that simply
don't apply to a server process — flagging them explicitly so nothing looks
silently dropped.

## API summary

| Method | Path              | Body                          | Notes |
|--------|-------------------|--------------------------------|-------|
| POST   | `/api/login`       | `{ user, password }`          | May return `need_code` |
| POST   | `/api/verify-code` | `{ code }`                    | Finishes OTP login |
| POST   | `/api/resend-code` | –                              | Resends email OTP |
| POST   | `/api/test-cookie` | `{ cookie }`                  | Validates a cookie |
| POST   | `/api/start`       | `{ cookie, maxTriggers }`      | Begins the scheduled run |
| POST   | `/api/stop`        | –                              | Aborts a running process |
| GET    | `/api/status`      | –                              | Current status snapshot |
| GET    | `/api/stream`       | –                              | SSE: `log`, `status`, `wave`, `done` events |
