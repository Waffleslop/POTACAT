// Multi-op profile directory naming.
//
// A portable callsign like LZ3AW/P is a legal operator (the Summary card's
// add-operator validation deliberately allows '/'), but '/' is a path
// separator on every platform — using the raw callsign as the directory name
// nested the profile INSIDE the base call's dir (profiles/LZ3AW/P/). It then
// never appeared in listProfiles, the Summary dropdown auto-fell-back to the
// base call, and the operator couldn't switch in either direction (LZ3AW,
// 2026-07-09).
//
// Directory names therefore encode '/' as '_'. '_' is not a legal callsign
// character (validation regex is [A-Z0-9/]), so the mapping is unambiguous
// and reversible, and listProfiles' existing "skip names starting with _"
// rule is unaffected (an encoded name can't start with '_' because a
// callsign can't start with '/').

'use strict';

const fs = require('fs');
const path = require('path');

function profileDirName(callsign) {
  return String(callsign || '').toUpperCase().trim().replace(/\//g, '_');
}

function profileCallFromDirName(name) {
  return String(name || '').replace(/_/g, '/');
}

/**
 * One-time repair for profiles created before the encoding existed: any
 * subdirectory of a profile dir that itself contains a settings.json is a
 * mis-nested slash-callsign profile (profiles/LZ3AW/P/ → operator LZ3AW/P).
 * Moves each to the encoded top-level layout (profiles/LZ3AW_P/) and rewrites
 * any absolute-path settings values (adifLogPath etc.) that pointed inside
 * the old nested location. Deeper nesting (F/LZ3AW/P) is handled child-first
 * so children move out before their parent path changes.
 *
 * Idempotent: encoded layouts have no nested settings.json dirs. Existing
 * destination dirs are left alone (conflict → skip, report).
 *
 * @param {string} profilesDir - the profiles root
 * @returns {{moved: Array<{call: string, from: string, to: string}>, skipped: Array<{call: string, reason: string}>}}
 */
function migrateNestedSlashProfiles(profilesDir) {
  const moved = [];
  const skipped = [];

  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { return null; }
  };

  const walk = (dir, callPrefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const sub = path.join(dir, name);
      let isDir = false;
      try { isDir = fs.statSync(sub).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      if (!fs.existsSync(path.join(sub, 'settings.json'))) continue;

      const call = callPrefix + '/' + name;
      // Children first — they must move out before this dir's path changes.
      walk(sub, call);

      const dest = path.join(profilesDir, profileDirName(call));
      try {
        if (fs.existsSync(dest)) {
          skipped.push({ call, reason: 'destination already exists: ' + dest });
          continue;
        }
        fs.renameSync(sub, dest);
        // Rewrite absolute paths that referenced the old nested location
        // (the add-operator seed points adifLogPath inside the profile dir).
        const sPath = path.join(dest, 'settings.json');
        const pSettings = readJson(sPath);
        if (pSettings) {
          let dirty = false;
          for (const [k, v] of Object.entries(pSettings)) {
            if (typeof v === 'string' && v.startsWith(sub)) {
              pSettings[k] = dest + v.slice(sub.length);
              dirty = true;
            }
          }
          if (dirty) fs.writeFileSync(sPath, JSON.stringify(pSettings, null, 2));
        }
        moved.push({ call, from: sub, to: dest });
      } catch (err) {
        skipped.push({ call, reason: err.message });
      }
    }
  };

  let tops = [];
  try { tops = fs.readdirSync(profilesDir); } catch { return { moved, skipped }; }
  for (const name of tops) {
    if (name.startsWith('_')) continue; // _archived etc.
    const top = path.join(profilesDir, name);
    try { if (!fs.statSync(top).isDirectory()) continue; } catch { continue; }
    walk(top, profileCallFromDirName(name));
  }
  return { moved, skipped };
}

module.exports = { profileDirName, profileCallFromDirName, migrateNestedSlashProfiles };
