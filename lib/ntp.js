/**
 * Lightweight SNTP client for measuring clock offset against NTP servers.
 * Uses Node's built-in dgram — no extra dependencies.
 *
 * FT8/FT4 digital modes require clock accuracy within ~0.5 seconds of UTC.
 * This module queries NTP servers and returns the offset in milliseconds.
 */

const dgram = require('dgram');
const dns = require('dns');

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
 * The offset is NTP's theta, ((t2 - t1) + (t3 - t4)) / 2 = server minus local:
 * positive = the local clock is BEHIND (add it), negative = AHEAD.
 *
 * @param {string} server — NTP server hostname
 * @returns {Promise<{offset: number, roundtrip: number, server: string}>}
 */
function queryNtp(server) {
  // Resolve first. socket.send() with a hostname looks it up before sending,
  // and t1 used to be stamped before that lookup, so a slow DNS answer counted
  // as network delay on the way out and read as a clock that was behind.
  return new Promise((resolve, reject) => {
    dns.lookup(server, { family: 4 }, (err, address) => {
      if (err) { reject(err); return; }
      queryNtpAt(server, address).then(resolve, reject);
    });
  });
}

function queryNtpAt(server, address) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);

    // Set LI=0, Version=4, Mode=3 (client) in first byte
    packet[0] = 0x23; // 00 100 011

    let t1 = 0; // local transmit time, stamped at the send

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

    t1 = Date.now();
    socket.send(packet, 0, 48, NTP_PORT, address, (err) => {
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

  const pick = pickOffset(results);
  if (!pick) throw new Error('All NTP servers failed');
  return Object.assign(pick, { results });
}

// A reply's offset can be wrong by up to half its round trip, and a reply that
// waited (a busy main process, a slow path) is wrong in one direction: late t4
// reads as a clock that is behind. So keep only the replies whose round trip
// is near the best one, as NTP's own clock filter does, and take the median of
// those (KC1SSY 2026-10-01: warnings on a PC that Dimension 4 keeps synced).
const RTT_SLACK_MS = 100;
function pickOffset(results) {
  const good = (results || []).filter(r => r && !r.error && Number.isFinite(r.offset) && Number.isFinite(r.roundtrip));
  if (!good.length) return null;
  const minRtt = Math.min(...good.map(r => Math.max(0, r.roundtrip)));
  const near = good.filter(r => Math.max(0, r.roundtrip) <= minRtt + RTT_SLACK_MS).sort((a, b) => a.offset - b.offset);
  const mid = Math.floor(near.length / 2);
  const offset = near.length % 2 === 0
    ? Math.round((near[mid - 1].offset + near[mid].offset) / 2)
    : near[mid].offset;
  return { offset, roundtrip: near[mid].roundtrip, server: near[mid].server, used: near.length };
}

/**
 * Sync the system clock on Windows.
 *
 * `w32tm /resync` alone could never fix the clock this warns about (K3SBP
 * 2026-10-15: +0.4 s, UAC approved, nothing changed). Windows Time STEPS the
 * clock only for a large error; anything smaller it SLEWS, a little per tick,
 * over hours, so the re-measure a second later read the same offset and the
 * button looked dead. And with its default discipline (time.windows.com,
 * polled every 1024 s) Windows considers a few hundred ms "synced" — that PC
 * reported a successful sync minutes earlier with 8 s of root dispersion.
 *
 * So the repair, in one elevated batch (one UAC prompt):
 *   1. enable + start the Windows Time service;
 *   2. Microsoft's documented high-accuracy settings (poll every 64 s, update
 *      every 100 ticks, faster frequency correction) and better peers, so the
 *      clock STAYS within tens of ms instead of drifting back out;
 *   3. STEP the clock by the offset just measured (`Set-Date -Adjust` is
 *      relative, so the seconds the UAC prompt sits open do not matter);
 *   4. resync, which now finds next to nothing to correct.
 * The step comes BEFORE the resync: a resync first would start a slew towards
 * the old error that would then carry the stepped clock past UTC.
 *
 * Authoritative success is the re-measured offset the caller takes right after;
 * the returned message is a human-readable note about what happened.
 *
 * @param {{ offsetMs?: number }} [opts] a fresh offset; measured here if absent
 * @returns {Promise<{success: boolean, elevated?: boolean, steppedMs?: number, message: string}>}
 */
// Never step by more than this from one NTP measurement: a bogus reply must not
// throw the clock across the day. A clock that far out is "Time settings" work.
const MAX_STEP_MS = 10 * 60 * 1000;

// Microsoft's "high accuracy" W32Time values (Windows Server 2016+ / Windows 10
// accurate-time guidance), as [value name, DWORD].
const W32TIME_HIGH_ACCURACY = [
  ['MinPollInterval', 6],      // 2^6 = 64 s
  ['MaxPollInterval', 6],
  ['UpdateInterval', 100],     // clock-adjust interval, in 1/100 s ticks
  ['FrequencyCorrectRate', 2],
];
const W32TIME_PEERS = 'time.cloudflare.com,0x9 time.google.com,0x9 time.windows.com,0x9 pool.ntp.org,0x9';

/** The elevated repair batch for a measured offset (pure; test/clock-offset-test.js). */
function buildTimeSyncBatch(offsetMs) {
  const w32 = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time';
  const cfg = w32 + '\\Config';
  const lines = [
    '@echo off',
    'sc config w32time start= auto',
    'net start w32time',
  ];
  for (const [name, v] of W32TIME_HIGH_ACCURACY) {
    lines.push(`reg add "${cfg}" /v ${name} /t REG_DWORD /d ${v} /f`);
  }
  lines.push(`reg add "${w32}\\TimeProviders\\NtpClient" /v SpecialPollInterval /t REG_DWORD /d 64 /f`);
  lines.push(`w32tm /config /manualpeerlist:"${W32TIME_PEERS}" /syncfromflags:manual /update`);
  const step = Math.round(Number(offsetMs));
  if (Number.isFinite(step) && step !== 0 && Math.abs(step) <= MAX_STEP_MS) {
    lines.push(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Date -Adjust ([TimeSpan]::FromMilliseconds(${step})) | Out-Null"`);
  }
  lines.push('w32tm /resync /force');
  lines.push('exit /b 0');
  return lines;
}

async function syncSystemClock(opts = {}) {
  if (process.platform !== 'win32') {
    return { success: false, message: 'System clock sync only supported on Windows' };
  }
  const { execFile } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // A fresh measurement: the step is only as good as the offset it uses.
  let offsetMs = Number.isFinite(opts.offsetMs) ? opts.offsetMs : null;
  if (offsetMs == null) {
    try { offsetMs = (await checkClockOffset()).offset; } catch { offsetMs = null; }
  }

  const bat = path.join(os.tmpdir(), 'potacat-timesync.bat');
  try { fs.writeFileSync(bat, buildTimeSyncBatch(offsetMs).join('\r\n')); }
  catch (e) { return { success: false, message: 'Could not write temp sync script: ' + e.message }; }

  // No double-quotes inside the -Command string (single-quote the path) so
  // there's nothing to escape; execFile avoids a cmd.exe shell entirely.
  const psCmd = `try { $p = Start-Process -FilePath '${bat}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { timeout: 60000 }, (err) => {
      try { fs.unlinkSync(bat); } catch {}
      if (!err) {
        const stepped = offsetMs != null && Math.abs(offsetMs) <= MAX_STEP_MS ? Math.round(offsetMs) : null;
        resolve({
          success: true,
          elevated: true,
          steppedMs: stepped,
          message: stepped != null
            ? `Clock stepped ${stepped >= 0 ? '+' : ''}${(stepped / 1000).toFixed(2)} s and Windows Time set to keep it there.`
            : 'Windows Time service enabled and resynced.',
        });
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

// How far off UTC the PC clock is allowed to be before JTCAT says something.
//
// These used to be 1 s / 2 s, "chosen to match FT8's decode tolerance". That
// calibrated the warning against the WRONG QUESTION. The decoder searches a
// window around each slot, so a clock a second out decodes everything
// perfectly — the operator sees a full band, a green "Sync: OK", and no
// reason to suspect the clock. What it costs is the other direction: the
// transmission lands outside the window the station you are calling will
// accept, and nobody comes back. You are not deaf, you are inaudible, and
// every visible indicator says you are fine.
//
// K3SBP lost TWO WEEKS to this (2026-09-03): decoding South America and
// Europe, PSKReporter showing him spotted out to the Mississippi, and not one
// QSO. Installing an NTP client produced a contact immediately. PSKReporter
// is what made it so convincing — it aggregates the most permissive receivers
// on the planet, so a late transmission still collects a few pins while the
// station being called hears nothing. Being spotted by somebody is not the
// same as being workable by anybody.
//
// So the thresholds are now set against "will I be answered", not "will I
// decode". With any time sync running at all the offset is tens of
// milliseconds; a quarter second means nothing is disciplining the clock,
// which is worth saying out loud before it costs somebody a fortnight.
const CLOCK_OK_MS = 250;    // below this: nothing to say
const CLOCK_BAD_MS = 1000;  // at or above this: QSOs are being lost right now

/** 'ok' | 'warn' | 'bad' for a signed offset in ms. */
function classifyClockOffset(offsetMs) {
  const abs = Math.abs(Number(offsetMs) || 0);
  if (abs < CLOCK_OK_MS) return 'ok';
  if (abs < CLOCK_BAD_MS) return 'warn';
  return 'bad';
}

module.exports = { queryNtp, checkClockOffset, pickOffset, syncSystemClock, buildTimeSyncBatch, classifyClockOffset,
  CLOCK_OK_MS, CLOCK_BAD_MS, MAX_STEP_MS, DEFAULT_SERVERS };
