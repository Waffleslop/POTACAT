/**
 * Lightweight SNTP client for measuring clock offset against NTP servers.
 * Uses Node's built-in dgram — no extra dependencies.
 *
 * FT8/FT4 digital modes require clock accuracy within ~0.5 seconds of UTC.
 * This module queries NTP servers and returns the offset in milliseconds.
 */

const dgram = require('dgram');

// Public NTP servers — pool.ntp.org round-robins globally
const DEFAULT_SERVERS = [
  'pool.ntp.org',
  'time.google.com',
  'time.cloudflare.com',
  'time.nist.gov',
];

const NTP_PORT = 123;
const NTP_EPOCH_OFFSET = 2208988800; // seconds from 1900-01-01 to 1970-01-01
const TIMEOUT_MS = 3000;

/**
 * Query a single NTP server and return the clock offset in milliseconds.
 * Positive offset = local clock is AHEAD of NTP (need to subtract).
 * Negative offset = local clock is BEHIND NTP (need to add).
 *
 * @param {string} server — NTP server hostname
 * @returns {Promise<{offset: number, roundtrip: number, server: string}>}
 */
function queryNtp(server) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);

    // Set LI=0, Version=4, Mode=3 (client) in first byte
    packet[0] = 0x23; // 00 100 011

    const t1 = Date.now(); // local transmit time

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`NTP timeout: ${server}`));
    }, TIMEOUT_MS);

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.on('message', (msg) => {
      clearTimeout(timer);
      const t4 = Date.now(); // local receive time

      if (msg.length < 48) {
        socket.close();
        reject(new Error('NTP response too short'));
        return;
      }

      // Parse server transmit timestamp (bytes 40-47)
      const seconds = msg.readUInt32BE(40) - NTP_EPOCH_OFFSET;
      const fraction = msg.readUInt32BE(44);
      const t3 = seconds * 1000 + (fraction / 0x100000000) * 1000;

      // Parse server receive timestamp (bytes 32-39)
      const rxSeconds = msg.readUInt32BE(32) - NTP_EPOCH_OFFSET;
      const rxFraction = msg.readUInt32BE(36);
      const t2 = rxSeconds * 1000 + (rxFraction / 0x100000000) * 1000;

      // NTP offset formula: ((t2 - t1) + (t3 - t4)) / 2
      const offset = ((t2 - t1) + (t3 - t4)) / 2;
      const roundtrip = (t4 - t1) - (t3 - t2);

      socket.close();
      resolve({ offset: Math.round(offset), roundtrip: Math.round(roundtrip), server });
    });

    socket.send(packet, 0, 48, NTP_PORT, server, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.close();
        reject(err);
      }
    });
  });
}

/**
 * Query multiple NTP servers and return the median offset.
 * Filters outliers by using median rather than mean.
 *
 * @param {string[]} [servers] — list of servers (default: pool + Google + Cloudflare + NIST)
 * @returns {Promise<{offset: number, roundtrip: number, server: string, results: Array}>}
 */
async function checkClockOffset(servers) {
  const serverList = servers || DEFAULT_SERVERS;
  const results = [];

  // Query all servers in parallel
  const promises = serverList.map(s =>
    queryNtp(s).catch(err => ({ error: err.message, server: s }))
  );
  const responses = await Promise.all(promises);

  for (const r of responses) {
    if (r.error) {
      results.push(r);
    } else {
      results.push(r);
    }
  }

  // Get successful results, sorted by offset
  const good = results.filter(r => !r.error).sort((a, b) => a.offset - b.offset);
  if (good.length === 0) {
    throw new Error('All NTP servers failed');
  }

  // Use median
  const mid = Math.floor(good.length / 2);
  const median = good.length % 2 === 0
    ? Math.round((good[mid - 1].offset + good[mid].offset) / 2)
    : good[mid].offset;

  return {
    offset: median,
    roundtrip: good[mid].roundtrip,
    server: good[mid].server,
    results,
  };
}

/**
 * Sync the system clock on Windows. A plain `w32tm /resync` only works when the
 * Windows Time service is already enabled, running, and configured — which on
 * many machines it is NOT (default install leaves it "Manual"/never-synced,
 * `Source: Local CMOS Clock`). So if the plain resync fails we run a one-shot
 * ELEVATED repair (UAC prompt): enable + start w32time, set NTP peers, resync.
 *
 * Authoritative success is the re-measured offset the caller takes right after
 * (the clock either moved into spec or it didn't); the returned message is just
 * a human-readable note about what happened.
 *
 * @returns {Promise<{success: boolean, elevated?: boolean, message: string}>}
 */
async function syncSystemClock() {
  if (process.platform !== 'win32') {
    return { success: false, message: 'System clock sync only supported on Windows' };
  }
  const { exec, execFile } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // 1) Plain resync first — no UAC if the service is already configured + we
  //    have rights (e.g. POTACAT launched as Administrator).
  const plainOk = await new Promise((resolve) => {
    exec('w32tm /resync /force', { timeout: 10000 }, (err) => resolve(!err));
  });
  if (plainOk) return { success: true, elevated: false, message: 'Clock resync requested.' };

  // 2) Plain resync failed (service disabled/unconfigured, or not elevated).
  //    Run an elevated repair batch. Start-Process -Verb RunAs raises the UAC
  //    prompt; the batch enables the service, points it at NTP peers, and
  //    resyncs. `net start` is harmless if already running; `exit /b 0` makes
  //    the batch report success-ran so we know it executed vs. was declined.
  const bat = path.join(os.tmpdir(), 'potacat-timesync.bat');
  const lines = [
    '@echo off',
    'sc config w32time start= auto',
    'net start w32time',
    'w32tm /config /manualpeerlist:"time.windows.com,0x9 pool.ntp.org,0x9 time.nist.gov,0x9" /syncfromflags:manual /update',
    'w32tm /resync /force',
    'exit /b 0',
  ];
  try { fs.writeFileSync(bat, lines.join('\r\n')); }
  catch (e) { return { success: false, message: 'Could not write temp sync script: ' + e.message }; }

  // No double-quotes inside the -Command string (single-quote the path) so
  // there's nothing to escape; execFile avoids a cmd.exe shell entirely.
  const psCmd = `try { $p = Start-Process -FilePath '${bat}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { timeout: 60000 }, (err) => {
      try { fs.unlinkSync(bat); } catch {}
      if (!err) {
        resolve({ success: true, elevated: true, message: 'Windows Time service enabled and resynced.' });
      } else {
        const declined = err.code === 1223 || /\b1223\b/.test(err.message || '');
        resolve({
          success: false,
          elevated: true,
          message: declined
            ? 'Administrator approval was declined — clock not synced. Use "Time settings…" to sync without admin.'
            : 'Could not configure Windows Time. Open "Time settings…" and turn on "Set time automatically".',
        });
      }
    });
  });
}

module.exports = { queryNtp, checkClockOffset, syncSystemClock, DEFAULT_SERVERS };
