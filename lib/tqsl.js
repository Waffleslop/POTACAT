// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// LoTW upload via the operator's own TrustedQSL install (never bundled —
// the cert store and station locations are theirs). Pure helpers here;
// main owns the spawn. Plan + locked decisions: docs/tqsl-lotw-plan.md.
'use strict';

const fs = require('fs');
const path = require('path');

/** TQSL's Flathub app id (flathub.org/apps/org.arrl.trustedqsl, verified
 *  2026-11-15). Flatpak exports a launcher named after it that runs
 *  `flatpak run org.arrl.trustedqsl` with the same arguments. The manifest
 *  grants --filesystem=home and TQSL keeps ~/.tqsl, so the batch file in
 *  POTACAT's config folder and the Station Locations are both visible. */
const TQSL_FLATPAK_ID = 'org.arrl.trustedqsl';

/** Candidate tqsl paths, most likely first. On Linux: the distro and
 *  /usr/local installs, ~/.local/bin, then the Flatpak launchers (system and
 *  per-user), so a Flatpak TQSL (SteamOS, GitHub #343) is found. */
function tqslCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return [
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'TrustedQSL', 'tqsl.exe'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'TrustedQSL', 'tqsl.exe'),
    ];
  }
  if (platform === 'darwin') return ['/Applications/TrustedQSL/tqsl.app/Contents/MacOS/tqsl', '/Applications/tqsl.app/Contents/MacOS/tqsl'];
  const home = env.HOME || '';
  const out = ['/usr/bin/tqsl', '/usr/local/bin/tqsl'];
  if (home) out.push(path.posix.join(home, '.local/bin/tqsl'));
  out.push(path.posix.join('/var/lib/flatpak/exports/bin', TQSL_FLATPAK_ID));
  if (home) out.push(path.posix.join(home, '.local/share/flatpak/exports/bin', TQSL_FLATPAK_ID));
  return out;
}

/** What the operator typed or picked, made runnable: trims quotes and
 *  spaces, and turns a picked macOS app bundle (tqsl.app) into the program
 *  inside it, since a bundle is a folder and cannot be run directly. */
function resolveTqslPath(p, platform = process.platform) {
  let s = String(p || '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!s) return '';
  if (platform === 'darwin' && /\.app\/?$/i.test(s)) s = s.replace(/\/?$/, '') + '/Contents/MacOS/tqsl';
  return s;
}

/** The program to run: the operator's own path first, then the usual
 *  places. isFile is injectable for the test. */
function findTqsl(configuredPath, platform = process.platform, env = process.env, isFile = defaultIsFile) {
  const own = resolveTqslPath(configuredPath, platform);
  const all = own ? [own, ...tqslCandidates(platform, env)] : tqslCandidates(platform, env);
  for (const p of all) {
    if (isFile(p)) return p;
  }
  return null;
}

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Where the TQSL program setting lives, for every message that sends the
 *  operator there. Matches renderer/index.html. */
const TQSL_SETTING_PLACE = 'Settings > Logging > "TQSL program"';

/** Where TQSL keeps station_data: %APPDATA%\TrustedQSL on Windows,
 *  ~/.tqsl everywhere else (ARRL docs; wxWidgets standard paths). */
function stationDataCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roaming = env.APPDATA || path.join(env.USERPROFILE || 'C:\\', 'AppData', 'Roaming');
    return [path.join(roaming, 'TrustedQSL', 'station_data')];
  }
  const home = env.HOME || '';
  return [path.join(home, '.tqsl', 'station_data')];
}

/** Station Location names from TQSL's station_data XML. Regex, not an XML
 *  parser: the file is TQSL-generated with a fixed shape, and a parser dep
 *  for one attribute is not worth it. */
function parseStationLocations(xml) {
  return [...String(xml || '').matchAll(/<StationData\s+name="([^"]+)"/g)].map((m) => m[1]);
}

/** argv for a batch (headless) sign-and-upload of one ADIF file. */
function buildTqslArgs({ location, adifPath, password }) {
  const args = [
    '-q',              // quiet/batch — no GUI
    '-x',              // exit when done
    '-d',              // suppress the date-range dialog
    '-u',              // sign AND upload to LoTW
    '-a', 'compliant', // duplicates: upload the new ones, skip known dupes
    '-l', String(location || ''),
  ];
  if (password) args.push('-p', String(password));
  args.push(String(adifPath || ''));
  return args;
}

/** TQSL batch exit codes → honest outcomes (TQSL command-line docs). */
function mapTqslExit(code) {
  switch (code) {
    // 0 still fires when -a compliant skipped noncompliant QSOs (wrong
    // operator, grid mismatch, missing band) — seen on the first real
    // upload 2026-08-13 — so never claim "all accepted" here.
    case 0: return { ok: true, message: 'Uploaded to LoTW — accepted for processing.' };
    // 8 vs 9 verified against a live run 2026-08-13: a full re-upload
    // exited 8 with "Final Status: No QSOs to upload(8)" and sent nothing.
    case 8: return { ok: true, message: 'Nothing new to upload — every QSO was already at LoTW.', allDupes: true };
    case 9: return { ok: true, message: 'Uploaded to LoTW — new QSOs accepted, previously-uploaded ones skipped as duplicates.' };
    case 1: return { ok: false, message: 'TQSL was cancelled by the user.' };
    case 2: return { ok: false, message: 'TQSL rejected the station location or callsign certificate — open TQSL and check Station Locations.' };
    case 3: return { ok: false, message: 'TQSL reported a response error talking to LoTW — try again in a minute.' };
    case 4: return { ok: false, message: 'TQSL problem — signing failed. Is the certificate password correct?' };
    case 5: return { ok: false, message: 'TQSL could not open or parse the ADIF file.' };
    case 6: return { ok: false, message: 'TQSL: nothing in the file could be processed.' };
    case 7: return { ok: false, message: 'TQSL: the LoTW server rejected the upload.' };
    case 10: return { ok: false, message: 'TQSL internal error.' };
    case 11: return { ok: false, message: 'TQSL: connection to LoTW failed — check your internet connection.' };
    default: return { ok: false, message: `TQSL exited with unexpected code ${code}.` };
  }
}

module.exports = { TQSL_FLATPAK_ID, TQSL_SETTING_PLACE, tqslCandidates, resolveTqslPath, findTqsl, stationDataCandidates, parseStationLocations, buildTqslArgs, mapTqslExit };
