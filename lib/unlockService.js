'use strict';

const axios = require('axios');
const { EventEmitter } = require('events');
const { getNtpOffsetMs } = require('./ntp');

const USER_AGENT = 'okhttp/4.12.0';
const UNLOCK_URL = 'https://sgp-api.buy.mi.com/bbs/api/global/apply/bl-auth';
const PING_HOST = 'https://sgp-api.buy.mi.com';

const RESULT_MEANINGS = {
  1: 'APPROVED!',
  2: 'Already approved',
  6: 'Quota full - try tomorrow',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function beijingMidnightUtcMs() {
  // Compute "now" in Beijing time (UTC+8), then find the NEXT local midnight,
  // then convert that instant back to a UTC epoch ms.
  const nowUtcMs = Date.now();
  const bjOffsetMs = 8 * 60 * 60 * 1000;
  const nowBjMs = nowUtcMs + bjOffsetMs;
  const nowBj = new Date(nowBjMs);

  const nextMidnightBj = Date.UTC(
    nowBj.getUTCFullYear(),
    nowBj.getUTCMonth(),
    nowBj.getUTCDate() + 1,
    0, 0, 0, 0
  );

  return nextMidnightBj - bjOffsetMs;
}

function formatBjTime(utcMs, withMillis = true) {
  const d = new Date(utcMs + 8 * 60 * 60 * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withMillis ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

function buildHeaders(cookie) {
  return {
    Accept: 'application/json',
    Connection: 'Keep-Alive',
    'Content-Type': 'application/json; charset=utf-8',
    Cookie: cookie,
    Host: 'sgp-api.buy.mi.com',
    'User-Agent': USER_AGENT,
  };
}

/**
 * UnlockService — one run at a time. Emits:
 *   'log'    (string)
 *   'status' ({ countdownText, latencyMs, ntpOffsetMs, isRunning })
 *   'wave'   ({ id, offsetLabel, state, resultText })
 *   'done'
 */
class UnlockService extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this._abort = false;
    this.cookie = '';
    this.latencyMs = null;
    this.ntpOffsetMs = null;
    this.countdownText = 'Ready';
    this.waves = [];
  }

  log(msg) {
    this.emit('log', msg);
  }

  setCountdown(text) {
    this.countdownText = text;
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      latencyMs: this.latencyMs,
      ntpOffsetMs: this.ntpOffsetMs,
      countdownText: this.countdownText,
      waves: this.waves,
    };
  }

  async testCookie(cookie) {
    try {
      const resp = await axios.post(UNLOCK_URL, { is_retry: false }, {
        headers: buildHeaders(cookie),
        timeout: 10000,
        validateStatus: () => true,
      });
      const data = resp.data || {};
      const msg = data.msg || '';
      const result = data.data ? data.data.apply_result : -1;
      this.log(`[Test] HTTP ${resp.status} | msg=${msg} | result=${result} ${RESULT_MEANINGS[result] || ''}`);
      return msg !== 'need login';
    } catch (e) {
      this.log(`[Test] Error: ${e.message}`);
      return false;
    }
  }

  async measureLatencyMs(samples = 3, timeoutMs = 1200) {
    const times = [];
    for (let i = 0; i < samples; i++) {
      try {
        const t0 = Date.now();
        await axios.head(PING_HOST, { timeout: timeoutMs, validateStatus: () => true });
        times.push(Date.now() - t0);
      } catch (_) {
        // ignore a dropped/slow sample
      }
    }
    if (times.length === 0) {
      this.log('[Latency] Could not measure — defaulting to 300ms');
      return 300;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    this.log(`[Latency] samples=[${times.join(', ')}] -> using median ${median}ms`);
    return median;
  }

  async sendWave(waveId, cookie) {
    const idx = waveId - 1;
    try {
      const resp = await axios.post(UNLOCK_URL, { is_retry: false }, {
        headers: buildHeaders(cookie),
        timeout: 10000,
        validateStatus: () => true,
      });
      const ts = formatBjTime(Date.now() + (this.ntpOffsetMs || 0));
      const data = resp.data || {};
      const msg = data.msg || '?';
      const result = data.data ? data.data.apply_result : -1;
      this.log(`[Wave ${waveId}] ${ts} CST | HTTP ${resp.status} | ${msg} | result=${result} ${RESULT_MEANINGS[result] || ''}`);

      let state = 'ERROR';
      if (result === 1 || result === 2) state = 'SUCCESS';
      else if (result === 6) state = 'FULL';

      if (this.waves[idx]) {
        this.waves[idx].state = state;
        this.waves[idx].resultText = `Res ${result}`;
        this.emit('wave', this.waves[idx]);
      }
    } catch (e) {
      this.log(`[Wave ${waveId}] ERROR: ${e.message}`);
      if (this.waves[idx]) {
        this.waves[idx].state = 'ERROR';
        this.waves[idx].resultText = 'Error';
        this.emit('wave', this.waves[idx]);
      }
    }
  }

  stop() {
    this._abort = true;
    this.isRunning = false;
    this.log('[!] User aborted.');
    this.emit('status', this.getStatus());
  }

  async start(cookie, maxTriggers = 4) {
    if (this.isRunning) {
      this.log('[!] Already running.');
      return;
    }
    if (!cookie || !cookie.trim()) {
      this.log('[!] Cookie cannot be empty.');
      return;
    }

    this.cookie = cookie;
    this._abort = false;
    this.isRunning = true;
    this.waves = [];
    this.emit('status', this.getStatus());

    this.log('='.repeat(40));
    this.log('Starting Xiaomi BL Unlock Automator (Pro Mode)...');

    this.log('[Test] Verifying cookie...');
    const valid = await this.testCookie(cookie);
    if (!valid) {
      this.log('[!] Cookie rejected (need login). It may have expired. Please provide a new one.');
      this.isRunning = false;
      this.emit('status', this.getStatus());
      return;
    }
    this.log('[OK] Cookie is valid! Setting up...');

    this.log('[NTP] Syncing clock initially (multi-sample)...');
    this.ntpOffsetMs = await getNtpOffsetMs('pool.ntp.org', 5, 3000, (m) => this.log(m));
    this.emit('status', this.getStatus());

    const targetUtcMs = beijingMidnightUtcMs();
    this.log(`[Target] ${formatBjTime(targetUtcMs, false)} CST (Beijing Midnight)`);

    const targetPingTimeUtcMs = targetUtcMs - 10_000;
    let lastResyncAtMs = Date.now();
    const resyncIntervalMs = 5 * 60_000;

    while (this.isRunning && !this._abort) {
      const nowAccurate = Date.now() + (this.ntpOffsetMs || 0);
      const remaining = targetPingTimeUtcMs - nowAccurate;
      if (remaining <= 0) break;

      if (remaining > 60_000) {
        if (Date.now() - lastResyncAtMs >= resyncIntervalMs) {
          const fresh = await getNtpOffsetMs('pool.ntp.org', 3, 2000, (m) => this.log(m));
          const drift = fresh - (this.ntpOffsetMs || 0);
          this.ntpOffsetMs = fresh;
          lastResyncAtMs = Date.now();
          this.log(`[NTP] Re-synced: offset=${fresh}ms (drift ${drift >= 0 ? '+' : ''}${drift}ms)`);
        }
        const h = Math.floor(remaining / 3600000);
        const m = Math.floor((remaining % 3600000) / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        this.setCountdown(`Ping in ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`);
        await sleep(1000);
      } else if (remaining > 3000) {
        this.setCountdown(`Ping in ${(remaining / 1000).toFixed(2)}s`);
        await sleep(50);
      } else {
        this.setCountdown(`Ping in ${(remaining / 1000).toFixed(3)}s`);
        await sleep(remaining);
        break;
      }
    }

    if (!this.isRunning || this._abort) {
      this.isRunning = false;
      this.emit('status', this.getStatus());
      return;
    }

    this.log('[NTP] Final quick re-sync before firing window...');
    const finalOffset = await getNtpOffsetMs('pool.ntp.org', 2, 800, (m) => this.log(m));
    if (finalOffset || this.ntpOffsetMs == null) {
      this.ntpOffsetMs = finalOffset;
    }
    this.log(`[NTP] Final offset: ${this.ntpOffsetMs}ms`);

    this.log('[Latency] 23:59:50 reached! Measuring final latency...');
    this.setCountdown('Pinging...');
    this.latencyMs = await this.measureLatencyMs();
    this.log(`[Latency] Final measured latency: ${this.latencyMs}ms`);

    const triggerCount = Math.max(1, parseInt(maxTriggers, 10) || 4);
    this.log(`[Config] Firing ${triggerCount} trigger(s)`);

    const baseSendTimeUtcMs = targetUtcMs - this.latencyMs;
    const bracketHalfMs = 60;
    let offsets;
    if (triggerCount === 1) {
      offsets = [0];
    } else {
      offsets = Array.from({ length: triggerCount }, (_, i) =>
        Math.round(-bracketHalfMs + (2 * bracketHalfMs * i) / (triggerCount - 1))
      );
    }

    const wave1SendTimeUtcMs = baseSendTimeUtcMs + offsets[0];

    this.waves = offsets.map((off, idx) => ({
      id: idx + 1,
      offsetLabel: off >= 0 ? `+${off}ms` : `${off}ms`,
      state: 'IDLE',
      resultText: 'Pending',
    }));
    this.emit('status', this.getStatus());

    while (this.isRunning && !this._abort) {
      const nowAccurate = Date.now() + (this.ntpOffsetMs || 0);
      const remaining = wave1SendTimeUtcMs - nowAccurate;
      if (remaining <= 0) break;

      if (remaining > 2000) {
        this.setCountdown(`Fire in ${(remaining / 1000).toFixed(2)}s`);
        await sleep(50);
      } else {
        this.setCountdown(`Fire in ${(remaining / 1000).toFixed(3)}s`);
        await sleep(remaining);
        break;
      }
    }

    if (!this.isRunning || this._abort) {
      this.isRunning = false;
      this.emit('status', this.getStatus());
      return;
    }

    this.setCountdown('FIRING');
    this.log('===');

    let prevOffset = 0;
    const firePromises = [];
    for (let idx = 0; idx < offsets.length; idx++) {
      const off = offsets[idx];
      const gap = off - prevOffset;
      prevOffset = off;
      if (gap > 0) await sleep(gap);

      const waveId = idx + 1;
      const ts = formatBjTime(Date.now() + (this.ntpOffsetMs || 0));
      const label = off >= 0 ? `+${off}ms` : `${off}ms`;
      this.log(`[Spam ${waveId}] Launched at ${ts} CST (${label} bracket)`);
      if (this.waves[idx]) {
        this.waves[idx].state = 'SENDING';
        this.emit('wave', this.waves[idx]);
      }
      firePromises.push(this.sendWave(waveId, cookie));
    }

    await Promise.allSettled(firePromises);
    await sleep(1000);

    this.log('[Done] Process Complete.');
    this.isRunning = false;
    this.setCountdown('Done');
    this.emit('done');
  }
}

module.exports = { UnlockService };
