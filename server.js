'use strict';

const express = require('express');
const path = require('path');
const { XiaomiAuthClient, XiaomiLoginError, XiaomiEmailVerificationRequired } = require('./lib/xiaomiAuth');
const { UnlockService } = require('./lib/unlockService');
const { saveAccount, loadAccount, clearAccount } = require('./lib/store');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// --- Single shared session (this tool is meant for one personal account at a time). ---
const service = new UnlockService();
let pendingAuthClient = null; // set while an email-OTP flow is in progress
let currentAccount = null; // last logged-in account (mirrors loggedInAccount in the Kotlin app)

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
  const client = new XiaomiAuthClient();
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
  if (!currentAccount) return res.json({ loggedIn: false });
  return res.json({
    loggedIn: true,
    account: currentAccount,
    cookie: XiaomiAuthClient.buildCookieHeader(currentAccount),
  });
});

app.post('/api/logout', (req, res) => {
  currentAccount = null;
  pendingAuthClient = null;
  clearAccount();
  service.log('[Login] Logged out.');
  return res.json({ status: 'logged_out' });
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
