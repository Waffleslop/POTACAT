'use strict';
// A serial port name as Windows knows it. The Serial Port setting has a "type
// a port" box next to the list, and operators type what Device Manager shows:
// "COM Port 10", "com 10", "10", or the whole "Silicon Labs Dual CP2105 USB to
// UART Bridge: Enhanced COM Port (COM10)". Windows only opens "COM10", so each
// of those failed with "Opening COM Port 10: File not found", forever, with
// the radio working perfectly (KF0TDB, FT-991A, 2026-10-02, twice).
// Only Windows names are rewritten; /dev/... paths pass through untouched.

function normalizeSerialPath(p, platform) {
  if (typeof p !== 'string') return p;
  const t = p.trim();
  if ((platform || process.platform) !== 'win32') return t;
  if (/^\\\\\.\\COM\d+$/i.test(t)) return t; // \\.\COM10, already the device form
  // "COM10", "com 10", "COM Port 10", "Port 10", "#10", "10"
  let m = t.match(/^(?:com\s*(?:port)?|port)?\s*#?\s*(\d{1,3})$/i);
  if (m) return 'COM' + Number(m[1]);
  // A Device Manager line pasted whole: "... (COM10)"
  m = t.match(/\((COM\d{1,3})\)\s*$/i);
  if (m) return m[1].toUpperCase();
  // "COM10 - Silicon Labs ..." (a port list label)
  m = t.match(/^(COM\d{1,3})\b/i);
  if (m) return m[1].toUpperCase();
  return t;
}

/**
 * Fix every serial port name a settings object holds. Returns the list of
 * corrections made ([{ key, from, to }]) so the caller can say so once.
 */
function normalizeSettingsSerialPaths(s, platform) {
  const fixes = [];
  if (!s || typeof s !== 'object') return fixes;
  const fix = (obj, key, label) => {
    if (!obj || typeof obj[key] !== 'string' || !obj[key]) return;
    const to = normalizeSerialPath(obj[key], platform);
    if (to !== obj[key]) { fixes.push({ key: label, from: obj[key], to }); obj[key] = to; }
  };
  fix(s.catTarget, 'path', 'catTarget.path');
  for (const k of ['cwKeyPort', 'winKeyerPort', 'rotorPort']) fix(s, k, k);
  for (const r of Array.isArray(s.rigs) ? s.rigs : []) {
    if (!r || typeof r !== 'object') continue;
    fix(r.catTarget, 'path', `rig "${r.name || r.id || '?'}" port`);
    fix(r, 'cwKeyPort', `rig "${r.name || r.id || '?'}" CW key port`);
  }
  return fixes;
}

module.exports = { normalizeSerialPath, normalizeSettingsSerialPaths };
