'use strict';

const express = require('express');
const path = require('path');
const { XiaomiAuthClient, XiaomiLoginError, XiaomiEmailVerificationRequired } = require('./lib/xiaomiAuth');
const { UnlockService } = require('./lib/unlockService');
const { saveAccount, loadAccount, clearAccount } = require('./lib/store');
const { generateToken, validateToken } = require('./lib/provision');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// --- Single shared session (this tool is meant for one personal account at a time). ---
const service = new UnlockService();
let pendingAuthClient = null; // set while an email-OTP flow is in progress
let currentAccount = null; // last logged-in account (mirrors loggedInAccount in the Kotlin app)
let lastPushedCookie = null; // raw cookie pushed by a companion device via /api/cookie (no full account)

// Fast, dependency-free endpoint for uptime pingers (UptimeRobot etc) to hit
// so the free-tier dyno doesn't spin down from inactivity. Keep this above
// static/middleware-heavy routes so it always resolves quickly.
app.get('/healthz', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

// Resume a persisted session on boot (mirrors UnlockViewModel.loadPersistedAccount()).
(function loadPersistedSessionOnBoot() {
  const account = loadAccount();
  if (account) {
    currentAccount = account;
    service.log(`[Login] Resumed persisted session for ${account.userId} (${account.region}).`);
  }
})();

// --- SSE log/status stream ---
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

service.on('log', (msg) => broadcast('log', { message: msg, ts: Date.now() }));
service.on('status', (status) => broadcast('status', status));
service.on('wave', (wave) => broadcast('wave', wave));
service.on('done', () => broadcast('done', {}));

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: status\ndata: ${JSON.stringify(service.getStatus())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// --- Auth endpoints ---

app.post('/api/login', async (req, res) => {
  const { user, password } = req.body || {};
  if (!user || !password) {
    return res.status(400).json({ error: 'user and password are required' });
  }
  const client = new XiaomiAuthClient((msg) => service.log(msg));
  pendingAuthClient = client;
  try {
    const account = await client.login(user, password);
    pendingAuthClient = null;
    currentAccount = account;
    saveAccount(account);
    const cookie = XiaomiAuthClient.buildCookieHeader(account);
    return res.json({ status: 'logged_in', account, cookie });
  } catch (e) {
    if (e instanceof XiaomiEmailVerificationRequired) {
      try {
        await client.sendEmailCode();
      } catch (sendErr) {
        pendingAuthClient = null;
        return res.status(400).json({ error: sendErr.message });
      }
      return res.json({
        status: 'need_code',
        maskedEmail: e.maskedEmail,
        attemptsLeft: e.attemptsLeft,
      });
    }
    pendingAuthClient = null;
    const message = e instanceof XiaomiLoginError ? e.message : `Unexpected error: ${e.message}`;
    return res.status(400).json({ error: message });
  }
});

app.post('/api/resend-code', async (req, res) => {
  if (!pendingAuthClient) return res.status(400).json({ error: 'No login in progress.' });
  try {
    await pendingAuthClient.sendEmailCode();
    return res.json({ status: 'sent' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post('/api/verify-code', async (req, res) => {
  const { code } = req.body || {};
  if (!pendingAuthClient) return res.status(400).json({ error: 'No login in progress.' });
  if (!code) return res.status(400).json({ error: 'code is required' });
  try {
    const account = await pendingAuthClient.verifyEmailCode(String(code).trim());
    pendingAuthClient = null;
    currentAccount = account;
    saveAccount(account);
    const cookie = XiaomiAuthClient.buildCookieHeader(account);
    return res.json({ status: 'logged_in', account, cookie });
  } catch (e) {
    const message = e instanceof XiaomiLoginError ? e.message : `Unexpected error: ${e.message}`;
    return res.status(400).json({ error: message });
  }
});

app.get('/api/account', (req, res) => {
  if (currentAccount) {
    return res.json({
      loggedIn: true,
      account: currentAccount,
      cookie: XiaomiAuthClient.buildCookieHeader(currentAccount),
    });
  }
  if (lastPushedCookie) {
    return res.json({ loggedIn: false, pushedCookie: lastPushedCookie });
  }
  return res.json({ loggedIn: false });
});

app.post('/api/logout', (req, res) => {
  currentAccount = null;
  pendingAuthClient = null;
  lastPushedCookie = null;
  clearAccount();
  service.log('[Login] Logged out.');
  return res.json({ status: 'logged_out' });
});

/**
 * One-time Termux provisioning.
 *
 * The web UI calls this to mint a fresh random token + a ready-to-paste
 * `curl ... | bash` command. That command installs python/requests on the
 * phone, fetches push_cookie.py from THIS server, and runs it — the script
 * prompts for the Xiaomi account interactively (nothing sensitive rides
 * along in the curl command or shell history). The same token is also what
 * authorizes the resulting POST to /api/cookie below, and gets burned the
 * moment that push succeeds — see lib/provision.js for the single-use logic.
 */
app.post('/api/provision/generate', (req, res) => {
  const { token, ttlSeconds } = generateToken();
  const base = `${req.protocol}://${req.get('host')}`;
  const setupUrl = `${base}/termux/setup/${token}`;
  service.log('[Provision] Generated a one-time Termux setup link.');
  return res.json({
    token,
    expiresInSeconds: ttlSeconds,
    setupUrl,
    curl: `curl -sSL "${setupUrl}" | bash`,
  });
});

// Bootstrap script fetched by the curl command above. Token is checked but
// NOT consumed here — only a successful /api/cookie push burns it, so a
// flaky connection retrying the curl doesn't cost you the one-time use.
app.get('/termux/setup/:token', (req, res) => {
  const check = validateToken(req.params.token);
  res.type('text/x-shellscript');
  if (!check.ok) {
    return res.status(410).send(
      `#!/data/data/com.termux/files/usr/bin/bash\n` +
      `echo "This one-time setup link is invalid, expired, or already used (${check.reason})." >&2\n` +
      `echo "Generate a new one from the web UI (\\"Generate Termux Setup\\") and re-run its curl command." >&2\n` +
      `exit 1\n`
    );
  }
  const base = `${req.protocol}://${req.get('host')}`;
  const token = req.params.token;
  return res.status(200).send(
    `#!/data/data/com.termux/files/usr/bin/bash\n` +
    `set -e\n` +
    `echo "== HyperOS AAU: one-time Termux setup =="\n` +
    `# Skip the slow/flaky mirror benchmark by pinning a known-fast mirror,\n` +
    `# then retry install a few times in case of transient network drops.\n` +
    `echo "deb https://packages.termux.dev/apt/termux-main stable main" > $PREFIX/etc/apt/sources.list\n` +
    `ok=0\n` +
    `for i in 1 2 3; do\n` +
    `  pkg update -y && pkg install -y python && { ok=1; break; }\n` +
    `  echo "[setup] install attempt $i failed, retrying in 5s..." >&2\n` +
    `  sleep 5\n` +
    `done\n` +
    `if [ "$ok" != "1" ]; then\n` +
    `  echo "[setup] pkg install python failed after 3 attempts — check your phone's network and re-run the curl command (link is still valid until used)." >&2\n` +
    `  exit 1\n` +
    `fi\n` +
    `pip install --quiet --upgrade pip\n` +
    `pip install --quiet requests\n` +
    `curl -sSL "${base}/termux/push_cookie.py" -o push_cookie.py\n` +
    `echo "This link is single-use — the server rejects it after this push succeeds."\n` +
    `python push_cookie.py --server "${base}" --token "${token}"\n`
  );
});

// Serves the actual companion script the bootstrap command downloads.
app.get('/termux/push_cookie.py', (req, res) => {
  res.type('text/x-python').sendFile(path.join(__dirname, 'termux', 'push_cookie.py'));
});

/**
 * Companion-device push endpoint. Meant for a script running on your OWN
 * Android phone (e.g. via Termux) or PC on a trusted network to log in
 * where Xiaomi doesn't flag the request, then hand the resulting cookie to
 * this server — instead of the server attempting the login itself.
 *
 * Two ways to authorize a push:
 *   1. A one-time token minted by POST /api/provision/generate. Consumed
 *      (burned) the instant this succeeds — reusing the same link/token
 *      after that gets a 401, same as if it had never existed.
 *   2. A static COOKIE_PUSH_TOKEN env var, for people who'd rather manage
 *      their own long-lived secret than regenerate a link each time.
 * Without either configured, the endpoint is open to anyone who finds your
 * URL — fine for local testing, not for a real deployment.
 */
app.post('/api/cookie', (req, res) => {
  const configuredToken = process.env.COOKIE_PUSH_TOKEN;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  let authorized = false;
  let viaOneTimeToken = false;

  if (configuredToken && provided === configuredToken) {
    authorized = true;
  } else if (provided) {
    const check = validateToken(provided, { consume: true });
    if (check.ok) {
      authorized = true;
      viaOneTimeToken = true;
    }
  }

  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized — bad, missing, expired, or already-used token.' });
  }

  const { cookie, account } = req.body || {};
  if (!cookie && !account) {
    return res.status(400).json({ error: 'Provide either "cookie" or "account".' });
  }

  if (account && account.userId && account.serviceToken && account.deviceId) {
    currentAccount = account;
    saveAccount(account);
    lastPushedCookie = null;
    service.log(`[Push] Received full account for ${account.userId} from companion device.`);
  } else if (cookie) {
    lastPushedCookie = cookie;
    service.log('[Push] Received a raw cookie from companion device.');
  }

  if (viaOneTimeToken) {
    service.log('[Provision] One-time setup link consumed — generate a new one from the UI to log in again.');
  }

  return res.json({ status: 'ok', oneTimeTokenConsumed: viaOneTimeToken });
});

// --- Unlock service control ---

app.post('/api/test-cookie', async (req, res) => {
  const { cookie } = req.body || {};
  if (!cookie) return res.status(400).json({ error: 'cookie is required' });
  const valid = await service.testCookie(cookie);
  return res.json({ valid });
});

app.post('/api/start', async (req, res) => {
  const { cookie, maxTriggers } = req.body || {};
  if (!cookie) return res.status(400).json({ error: 'cookie is required' });
  if (service.isRunning) return res.status(409).json({ error: 'Already running.' });

  // Fire and forget — progress streams over SSE.
  service.start(cookie, maxTriggers).catch((e) => {
    service.log(`[Fatal] ${e.message}`);
    service.isRunning = false;
  });

  return res.json({ status: 'started' });
});

app.post('/api/stop', (req, res) => {
  service.stop();
  return res.json({ status: 'stopped' });
});

app.get('/api/status', (req, res) => {
  res.json(service.getStatus());
});

const httpServer = app.listen(PORT, () => {
  console.log(`HyperOS AAU server listening on port ${PORT}`);
});

// Render sends SIGTERM before redeploys/restarts — log it (and warn if a
// timed run is in flight) instead of dying silently, so it's visible in the
// Render logs why a countdown got cut off.
function shutdown(signal) {
  console.log(`[Server] Received ${signal}.`);
  if (service.isRunning) {
    console.warn('[Server] Shutting down WHILE a scheduled run is in progress — it will be lost.');
  }
  httpServer.close(() => {
    console.log('[Server] HTTP server closed. Exiting.');
    process.exit(0);
  });
  // Force-exit if close() hangs (e.g. lingering SSE connections).
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
