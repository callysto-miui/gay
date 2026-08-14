'use strict';

/**
 * One-time Termux provisioning tokens.
 *
 * Flow:
 *   1. Web UI calls POST /api/provision/generate -> gets a fresh random token
 *      + a ready-to-paste `curl ... | bash` command.
 *   2. That command hits GET /termux/setup/:token on the phone, which checks
 *      the token is still valid (unused + unexpired) before handing back the
 *      bootstrap script. Dead links get a plain-text error, not a script.
 *   3. The bootstrap script runs push_cookie.py, which logs into Xiaomi from
 *      the phone's own network and POSTs the cookie to /api/cookie using the
 *      SAME token as its Authorization: Bearer value.
 *   4. /api/cookie consumes the token on that first successful push. Any
 *      further use of the same token/link (replay, second device, whatever)
 *      is rejected. To log in again you generate a new link from the UI.
 *
 * In-memory by design: these are meant to live minutes, not survive a
 * restart, and losing them on redeploy is the correct/safe behavior (an old
 * link should not still work after the server restarts).
 */

const crypto = require('crypto');

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes to actually run the Termux command

const tokens = new Map(); // token -> { createdAt, expiresAt, used, usedAt }

function prune() {
  const now = Date.now();
  for (const [t, meta] of tokens) {
    if (meta.used || meta.expiresAt < now) tokens.delete(t);
  }
}

function generateToken() {
  prune();
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  tokens.set(token, { createdAt: now, expiresAt: now + TOKEN_TTL_MS, used: false, usedAt: null });
  return { token, expiresAt: now + TOKEN_TTL_MS, ttlSeconds: TOKEN_TTL_MS / 1000 };
}

/**
 * @param {string} token
 * @param {{consume?: boolean}} opts - pass consume:true to atomically mark
 *   the token used (call this exactly once, at the point the cookie push is
 *   actually accepted). Peeking (consume:false) does NOT burn the token, so
 *   the setup script can be re-fetched (e.g. curl retried on a flaky
 *   connection) without losing the one-time push.
 */
function validateToken(token, { consume = false } = {}) {
  if (!token) return { ok: false, reason: 'missing' };
  const meta = tokens.get(token);
  if (!meta) return { ok: false, reason: 'unknown_or_already_used' };
  if (meta.used) return { ok: false, reason: 'already_used' };
  if (meta.expiresAt < Date.now()) {
    tokens.delete(token);
    return { ok: false, reason: 'expired' };
  }
  if (consume) {
    meta.used = true;
    meta.usedAt = Date.now();
  }
  return { ok: true };
}

function activeCount() {
  prune();
  return tokens.size;
}

module.exports = { generateToken, validateToken, activeCount, TOKEN_TTL_MS };
