'use strict';
/**
 * The "Settings saved" line of a bug report (AE5JE 2026-10-26: audio devices,
 * window positions and open windows forgot themselves every launch on a PC
 * running Bitdefender, while the callsign and rigs set long ago survived — a
 * settings save that fails leaves the change in memory for the session only,
 * and until now said nothing anywhere).
 *
 * Pure: main.js records what happened, this says it in one line.
 *
 * @param {object} p
 * @param {Array<{label:string, mtimeMsAtLaunch:?number, lastWrite:?{at:number, ok:boolean, error?:string}}>} p.files
 * @param {number} p.now
 * @returns {string}
 */
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function describeFile(f, now) {
  const w = f.lastWrite;
  if (w && !w.ok) {
    return `${f.label} FAILED to save ${ago(now - w.at)}: ${w.error || 'unknown error'} — changes since launch are not kept (security software blocking %APPDATA%\\POTACAT? Bitdefender Safe Files does this)`;
  }
  if (w && w.ok) return `${f.label} saved ${ago(now - w.at)}`;
  if (Number.isFinite(f.mtimeMsAtLaunch)) return `${f.label} not saved this session (file last written ${ago(now - f.mtimeMsAtLaunch)})`;
  return `${f.label} not saved this session (no file yet)`;
}

function describeSaveStatus(p) {
  const files = (p && Array.isArray(p.files)) ? p.files : [];
  const now = (p && Number.isFinite(p.now)) ? p.now : Date.now();
  if (!files.length) return '(unknown)';
  return files.map((f) => describeFile(f, now)).join('; ');
}

module.exports = { describeSaveStatus, ago };
