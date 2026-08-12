'use strict';

const fs = require('fs');
const path = require('path');

// Render's free web services have ephemeral disk that survives sleep/wake
// cycles but is wiped on redeploy — good enough to survive an UptimeRobot-
// induced restart, not a substitute for a real database if you need it to
// survive redeploys too.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveAccount(account) {
  ensureDir();
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), 'utf8');
}

function loadAccount() {
  try {
    const raw = fs.readFileSync(ACCOUNT_FILE, 'utf8');
    const account = JSON.parse(raw);
    if (account && account.userId && account.serviceToken && account.deviceId) {
      return account;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function clearAccount() {
  try {
    fs.unlinkSync(ACCOUNT_FILE);
  } catch (_) {
    // nothing to clear
  }
}

module.exports = { saveAccount, loadAccount, clearAccount };
