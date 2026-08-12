'use strict';

const dgram = require('dgram');

const NTP_PORT = 123;
const NTP_PACKET_SIZE = 48;
// Seconds between NTP epoch (1900) and Unix epoch (1970)
const NTP_UNIX_EPOCH_DELTA = 2208988800;

/**
 * Single SNTP request. Resolves with the clock offset in milliseconds:
 *   trueTime ≈ Date.now() + offsetMs
 */
function ntpRequestOnce(server, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch (_) { /* ignore */ }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('NTP request timed out'));
    }, timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    socket.once('message', (msg) => {
      const t0 = Date.now(); // approx local receive time
      clearTimeout(timer);

      // Bytes 40-43: transmit timestamp seconds (big-endian, NTP epoch)
      const txSeconds = msg.readUInt32BE(40);
      const txFraction = msg.readUInt32BE(44);
      const serverMs =
        (txSeconds - NTP_UNIX_EPOCH_DELTA) * 1000 +
        (txFraction / 0x100000000) * 1000;

      const offsetMs = serverMs - t0;
      cleanup();
      resolve(offsetMs);
    });

    const packet = Buffer.alloc(NTP_PACKET_SIZE);
    // LI = 0, VN = 3, Mode = 3 (client) -> 0x1B
    packet[0] = 0x1b;

    socket.send(packet, 0, packet.length, NTP_PORT, server, (err) => {
      if (err) {
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    });
  });
}

/**
 * Takes `samples` SNTP readings and returns the median offset in ms.
 * Silently skips failed samples (dropped UDP packets etc).
 */
async function getNtpOffsetMs(server = 'pool.ntp.org', samples = 5, timeoutMs = 3000, log = () => {}) {
  const offsets = [];
  for (let i = 0; i < samples; i++) {
    try {
      const offset = await ntpRequestOnce(server, timeoutMs);
      offsets.push(offset);
    } catch (_) {
      // skip this sample
    }
  }
  if (offsets.length === 0) {
    log(`[NTP] All ${samples} sample(s) failed - using 0 offset`);
    return 0;
  }
  offsets.sort((a, b) => a - b);
  const median = offsets[Math.floor(offsets.length / 2)];
  log(`[NTP] ${offsets.length}/${samples} ok [${offsets.map((o) => o.toFixed(0)).join(', ')}] -> median ${median.toFixed(0)}ms`);
  return median;
}

module.exports = { getNtpOffsetMs };
