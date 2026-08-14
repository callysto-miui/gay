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

## Login gets blocked by Xiaomi's anti-bot ("Not Found" / non-JSON errors)

If sign-in fails with an error like `Xiaomi returned a non-JSON response
during "..." (HTTP 404): "Not Found"`, that's Xiaomi's passport service
(`account.xiaomi.com`) rejecting the request — not a bug in the port. Login
endpoints for accounts services are commonly guarded by WAF/anti-bot layers
that score requests by IP reputation. Datacenter/cloud IPs (Render, AWS,
GCP, etc.) get flagged far more often than residential or mobile IPs, which
is why the exact same request logic works from the Android app on your
phone but not from a hosted server — the difference is the network origin,
not the code.

The server now logs each login step (`[Login] GET /pass/serviceLogin ->
HTTP ...`) to the live console, so you can see exactly which step got
blocked instead of a raw JSON-parse crash.

**Workaround: do the login once outside Render, then only use the server
for scheduling/firing.** The unlock-apply endpoint (`sgp-api.buy.mi.com`)
tends to be far less aggressively gated than the passport login endpoints,
so once you have a valid cookie the scheduled-firing part of this tool
generally works fine from a cloud IP even when login doesn't:

1. Run the Python (`xiaomi_unlock_automator.py`) or the original Android app
   from your own machine/phone once, just to obtain the `Cookie` string
   (`new_bbs_serviceToken=...;versionCode=...;versionName=...;deviceId=...;`).
2. Paste that cookie directly into the web UI's "Cookie String" field
   (skip the Sign In panel entirely) and hit "Verify & Start Process".
3. Cookies are typically valid for a while, so you don't need to repeat
   step 1 every day — just re-check with "Verify & Start Process" (it tests
   the cookie before scheduling) and grab a fresh one if it's expired.

If you'd rather keep the full in-browser login flow working from Render,
the only reliable fix is routing the login requests through an IP that
Xiaomi doesn't flag — e.g. a residential/mobile proxy, or hosting on a VPS
in a region/provider with a cleaner reputation. That's an infrastructure
change outside what code alone can fix.

## "Android environment" for the login step — what actually helps

Two ways to interpret "make it look like an Android device," with very
different payoffs:

**Full Android emulation (redroid/Waydroid) running the real APK inside a
container.** This gives you the exact TLS/HTTP client fingerprint of a real
Xiaomi device. It needs the kernel `binder` module and usually KVM
passthrough — Render's shared web-service containers don't expose that, so
this can't run there; you'd need a separate VPS with nested virtualization.
And if the block is IP-reputation-based (very likely — see the section
above), running a perfect device fingerprint from that *same* flagged cloud
IP still doesn't fix it. Not recommended unless you already have spare VPS
infrastructure with KVM support and want to go deep.

**Push the cookie from a real Android device instead (recommended).** Your
phone, via Termux, already *is* a correctly-fingerprinted Android
environment on a residential/mobile IP — the thing Xiaomi actually trusts.
Rather than trying to reproduce that inside a cloud container, just do the
login there and hand the server the result. The web UI can generate a
**one-time setup link** for this so you never have to type or remember a
long-lived secret:

1. In the web UI, open the **"Termux"** panel and tap **Generate Termux
   Setup**. You get a `curl ... | bash` command tied to a random token that
   expires in 15 minutes and can only ever be used once.
2. On your phone: install [Termux](https://f-droid.org/packages/com.termux/),
   then paste that exact command. It:
   - installs `python` + `pip install requests`,
   - downloads `termux/push_cookie.py` from your own server (not a
     third-party host),
   - runs it, which prompts you *right there in the terminal* for your
     Xiaomi username and password (via `getpass`, so the password isn't
     echoed and never appears in shell history or the curl command itself).
3. It logs in from your phone's own network and POSTs the resulting cookie
   to `/api/cookie`, authenticated with that same one-time token. The
   server **burns the token the instant that push succeeds** — the link
   cannot be reused, replayed, or shared. The web UI auto-loads the fresh
   cookie on next page load (or refresh), and `/api/account` reflects it
   immediately.
4. Need to log in again later (cookie expired, switching accounts, etc.)?
   Just tap **Generate Termux Setup** again for a brand-new link — the old
   one is already dead. There's nothing to rotate or revoke by hand.

Cookies are typically valid for a while, so you don't need to do this right
at midnight — once a day or every few days is enough. To automate it
unattended, use Termux:Boot + `termux-job-scheduler` with a **static**
token instead (see below), since a one-time link obviously can't be reused
by a recurring cron job.

This way: your phone (trusted network, correct fingerprint) does the one
part Xiaomi is picky about, and Render (which is fine for outbound requests
to the *apply* endpoint) does the precision timing/firing.

**Alternative: a static, long-lived token.** If you'd rather run
`push_cookie.py` yourself on a schedule (Termux:Boot, cron, etc.) instead of
tapping "Generate Termux Setup" each time, set `COOKIE_PUSH_TOKEN` in
Render's env vars to your own long random string and pass it as `--token`.
Unlike a one-time link, this token is *not* consumed on use and works
indefinitely — you're trading the one-time link's automatic expiry for the
ability to automate the push unattended. Keep it secret either way: anyone
with it can push a cookie into your scheduler.

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
| POST   | `/api/provision/generate` | –                        | Mints a one-time Termux setup token (15 min TTL) + a `curl \| bash` command. |
| GET    | `/termux/setup/:token`    | –                        | Bootstrap script the curl command runs. 410 + plain-text error if the token is dead. Peeking doesn't consume it. |
| GET    | `/termux/push_cookie.py`  | –                        | Serves the companion script the bootstrap fetches. |
| POST   | `/api/cookie`      | `{ cookie }` or `{ account }` | Companion-device push (see "Android environment" section). Requires `Authorization: Bearer <token>` — either a one-time provision token (consumed on success) or a static `COOKIE_PUSH_TOKEN` if that env var is set. |
| POST   | `/api/start`       | `{ cookie, maxTriggers }`      | Begins the scheduled run |
| POST   | `/api/stop`        | –                              | Aborts a running process |
| GET    | `/api/status`      | –                              | Current status snapshot |
| GET    | `/api/stream`       | –                              | SSE: `log`, `status`, `wave`, `done` events |
