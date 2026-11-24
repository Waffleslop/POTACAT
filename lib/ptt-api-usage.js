'use strict';
/**
 * Local usage stamp for the HTTP PTT shortcut (/api/ptt), 2026-11-23.
 *
 * Each successful /api/ptt call records when it happened and whether it came
 * over https or plain http, so a later change to how /api/ptt is unlocked
 * (a token, an on/off switch) can be offered to the stations that actually
 * use it instead of breaking them blind.
 *
 * Local only. It lives in its own small file in userData (ptt-api-usage.json),
 * never in the settings object, so it is not in an exported settings file,
 * not in the settings sent to ECHOCAT devices, not device-writable and not
 * sent to POTACAT Cloud. Written at most once a minute; a failed write is
 * ignored (this must never get in the way of the radio).
 *
 * createPttApiUsage({ filePath, now?, minIntervalMs?, fs? })
 *   filePath may be a string or a function returning one (resolved lazily).
 *   record(route) -> true when it wrote, false when throttled or it failed
 *   read()        -> { pttApiLastUsed, pttApiLastRoute } or null
 */

const MIN_INTERVAL_MS = 60 * 1000;

function createPttApiUsage(opts) {
  const o = opts || {};
  const fsx = o.fs || require('fs');
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const minInterval = Number.isFinite(o.minIntervalMs) ? o.minIntervalMs : MIN_INTERVAL_MS;
  const resolvePath = () => (typeof o.filePath === 'function' ? o.filePath() : o.filePath);
  let lastWriteAt = -Infinity;

  function record(route) {
    const t = now();
    if (t - lastWriteAt < minInterval) return false;
    lastWriteAt = t; // throttle attempts too, so a broken disk is not hammered
    const stamp = {
      pttApiLastUsed: new Date(t).toISOString(),
      pttApiLastRoute: route === 'https' ? 'https' : 'http',
    };
    try {
      const file = resolvePath();
      if (!file) return false;
      const tmp = file + '.tmp';
      fsx.writeFileSync(tmp, JSON.stringify(stamp));
      fsx.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  function read() {
    try {
      const file = resolvePath();
      if (!file) return null;
      const j = JSON.parse(fsx.readFileSync(file, 'utf8'));
      if (!j || typeof j.pttApiLastUsed !== 'string') return null;
      return { pttApiLastUsed: j.pttApiLastUsed, pttApiLastRoute: j.pttApiLastRoute === 'https' ? 'https' : 'http' };
    } catch {
      return null;
    }
  }

  return { record, read };
}

module.exports = { createPttApiUsage, MIN_INTERVAL_MS };
