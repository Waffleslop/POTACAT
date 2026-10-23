// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// ardopcf (ARDOP modem) — launch helpers (pure, unit-tested).
//
// ardopcf (https://github.com/pflarue/ardop, MIT — Muething, Wiseman, LaRue)
// is the open ARDOP modem Winlink gateways accept. POTACAT launches it as a
// separate process for a Winlink radio session; Pat talks to its host port.
//
// The rule that matters: ardopcf NEVER keys the radio. It is launched with no
// -p/--ptt, -c/--cat, -g, -k/--keystring, -u/--unkeystring, so it only reports
// "PTT TRUE/FALSE" to its host; Pat (ptt_ctrl: true) keys through POTACAT's
// rigctld shim, and POTACAT keys through its one PTT dispatcher. A second
// program on the radio's COM port is exactly what this design exists to avoid.
//
// Audio devices: ardopcf takes positional <capture> <playback>. On Windows a
// value of 1–2 characters is an index into the list it prints at startup; a
// longer value is a case-insensitive SUBSTRING of a name, matched against
// names cut to 31 characters (waveIn MAXPNAMELEN). Indexes shift when USB
// devices come and go, so POTACAT lists the devices fresh before every launch
// (a run with a device that cannot exist prints the list and exits) and
// resolves the operator's chosen LABEL to the current index. On Linux the
// value is an ALSA name (plughw:C,D), resolved from the same listing.
//
// macOS: ardopcf has no CoreAudio backend, and needs none here — POTACAT runs
// it with the socket audio backend (device "tcp:<port>") on every OS, so the
// macOS build compiles its Linux sources against a no-op ALSA stand-in
// (helpers/alsa-stub) and lists no sound devices at all. Device listing and
// matching below are for a hand-built ardopcf opening a sound card itself.

'use strict';

const ARDOP_DEFAULTS = Object.freeze({ port: 8515, driveLevel: 90 });
const FORBIDDEN_FLAGS = Object.freeze(['-p', '--ptt', '-c', '--cat', '-g', '-k', '--keystring', '-u', '--unkeystring']);
/** The device name used for a listing run — long enough to be a substring search, matches nothing. */
const LIST_ONLY_DEVICE = 'POTACAT-LIST-DEVICES';

function ardopBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'ardopcf.exe' : 'ardopcf';
}

function ardopSupported(platform = process.platform) {
  return platform === 'win32' || platform === 'linux' || platform === 'darwin';
}

function ardopPathCandidates({ settings, isPackaged, resourcesPath, appDir, platform = process.platform } = {}) {
  const bin = ardopBinaryName(platform);
  const isWin = platform === 'win32';
  const sep = isWin ? '\\' : '/';
  const join = (...parts) => parts.join(sep);
  const out = [];
  if (settings && settings.winlinkArdopPath) out.push(settings.winlinkArdopPath);
  if (isPackaged && resourcesPath) out.push(join(resourcesPath, 'bin', bin));
  else if (appDir) out.push(join(appDir, 'assets', 'ardopcf', bin));
  if (isWin) out.push('C:\\ardop\\ardopcf.exe', 'C:\\Program Files\\ardopcf\\ardopcf.exe');
  else out.push('/usr/local/bin/ardopcf', '/usr/bin/ardopcf');
  return out;
}

/**
 * Launch args. `capture`/`playback` are what resolveArdopDevices returned
 * (an index on Windows, an ALSA name on Linux).
 */
function buildArdopArgs({ port, capture, playback, logDir, driveLevel, mycall } = {}) {
  const p = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : ARDOP_DEFAULTS.port;
  const drive = Math.max(1, Math.min(100, Math.round(Number(driveLevel) || ARDOP_DEFAULTS.driveLevel)));
  const cmds = [`DRIVELEVEL ${drive}`];
  if (mycall) cmds.unshift(`MYCALL ${String(mycall).toUpperCase().replace(/[^A-Z0-9/-]/g, '')}`);
  const args = [];
  if (logDir) args.push('--logdir', logDir);
  args.push('--hostcommands', cmds.join(';'));
  args.push(String(p), String(capture == null ? '0' : capture), String(playback == null ? '0' : playback));
  for (const a of args) if (FORBIDDEN_FLAGS.includes(a)) throw new Error(`ardopcf must never get ${a}`);
  return args;
}

/** Args for a listing run: prints both device lists, then fails on the impossible device and exits. */
function buildArdopListArgs({ port } = {}) {
  return [String(port || ARDOP_DEFAULTS.port + 9), LIST_ONLY_DEVICE, LIST_ONLY_DEVICE];
}

/**
 * Parse a listing run's stdout into {capture:[{id,name}], playback:[...]}.
 * Windows: "Capture Devices" / "Playback Devices" headers, then "<n> <name>".
 * Linux: the same headers, then "  Device hw:C,D ID `x', name `y', ..." lines
 * (id becomes "plughw:C,D", which resamples for us).
 */
function parseArdopDeviceList(text) {
  const out = { capture: [], playback: [] };
  let section = null;
  let card = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*Capture Devices\s*$/i.test(line)) { section = 'capture'; continue; }
    if (/^\s*Playback Devices\s*$/i.test(line)) { section = 'playback'; continue; }
    if (!section) continue;
    let m = /^\s*Card \d+, ID `[^']*', name `([^']*)'/.exec(line);
    if (m) { card = m[1]; continue; }
    m = /^\s*Device hw:(\d+),(\d+) ID `[^']*', name `([^']*)'/.exec(line);
    if (m) {
      out[section].push({ id: `plughw:${m[1]},${m[2]}`, name: card ? `${m[3]} (${card})` : m[3] });
      continue;
    }
    m = /^(\d{1,2}) (.+)$/.exec(line);
    if (m) { out[section].push({ id: m[1], name: m[2].trim() }); continue; }
    // Anything else (a version banner, the "not found" error) ends nothing — keep scanning.
  }
  return out;
}

function _norm(s) {
  return String(s || '').toLowerCase()
    .replace(/\([0-9a-f]{4}:[0-9a-f]{4}\)/g, ' ') // Chromium's "(08bb:2902)" USB id suffix
    .replace(/^(default|communications)\s*-\s*/, '')
    .replace(/\s+/g, ' ').trim();
}

// Channel numbers stay ("DAX Audio RX 1" vs "RX 2" differ ONLY by the digit);
// the generic words that every device carries do not.
function _tokens(s) {
  return _norm(s).split(/[^a-z0-9]+/).filter((t) => t && !['microphone', 'speakers', 'speaker', 'line', 'in', 'out', 'device', 'audio'].includes(t));
}

/**
 * Best entry for a label (Chromium's device label, or a name the operator
 * picked from a previous listing). In order:
 *   1. exact, ignoring case and spacing;
 *   2. the listed name is the START of the label — ardopcf (waveIn) cuts
 *      names at 31 characters, so "DAX Audio RX 1 (FlexRadio Syste" is how a
 *      DAX channel always appears; the longest such prefix wins;
 *   3. token overlap, digits included.
 * Ties and zero overlap → null: a wrong guess opens the wrong radio's audio.
 */
function matchArdopDevice(label, list) {
  if (!label || !Array.isArray(list) || !list.length) return null;
  const lab = _norm(label);
  const exact = list.find((d) => _norm(d.name) === lab);
  if (exact) return exact;
  const prefixed = list.filter((d) => _norm(d.name).length >= 8 && lab.startsWith(_norm(d.name)))
    .sort((a, b) => _norm(b.name).length - _norm(a.name).length);
  if (prefixed.length && (prefixed.length === 1 || _norm(prefixed[0].name).length > _norm(prefixed[1].name).length)) return prefixed[0];
  const want = _tokens(label);
  if (!want.length) return null;
  let best = null, bestScore = 0, tie = false;
  for (const d of list) {
    const have = new Set(_tokens(d.name));
    const score = want.filter((t) => have.has(t)).length;
    if (score > bestScore) { best = d; bestScore = score; tie = false; }
    else if (score && score === bestScore) tie = true;
  }
  return bestScore && !tie ? best : null;
}

/**
 * Resolve the operator's chosen labels against a FRESH listing.
 * @returns {{ok:boolean, capture?:string, playback?:string, missing:string[], captureName?:string, playbackName?:string}}
 */
function resolveArdopDevices({ captureLabel, playbackLabel, devices } = {}) {
  const d = devices || { capture: [], playback: [] };
  const missing = [];
  const cap = matchArdopDevice(captureLabel, d.capture);
  const play = matchArdopDevice(playbackLabel, d.playback);
  if (!captureLabel) missing.push('capture (none chosen)');
  else if (!cap) missing.push(`capture "${captureLabel}"`);
  if (!playbackLabel) missing.push('playback (none chosen)');
  else if (!play) missing.push(`playback "${playbackLabel}"`);
  if (missing.length) return { ok: false, missing };
  return { ok: true, capture: cap.id, playback: play.id, captureName: cap.name, playbackName: play.name, missing };
}

/**
 * Propose the radio's sound devices for Winlink, so a first-time operator
 * confirms instead of choosing. Almost everyone wants exactly what the rig
 * already uses for FT8 — the modem needs the same two sound paths — so that
 * comes first. In order:
 *   1. 'rig'      the rig's own FT8 input/output (labels resolved by the renderer);
 *   2. 'flex-dax' on a Flex, DAX RX 1 and DAX TX (Flex Direct users have no FT8
 *                 sound device to copy; DAX is what an external program opens);
 *   3. 'codec'    one obvious USB audio CODEC / USB sound card for each side.
 * A side that cannot be decided is null and the card asks — never a guess.
 * @returns {{capture:{id,name}|null, playback:{id,name}|null, why:string}}
 */
function proposeArdopDevices({ devices, inputLabel, outputLabel, family } = {}) {
  const d = devices || { capture: [], playback: [] };
  let capture = inputLabel ? matchArdopDevice(inputLabel, d.capture) : null;
  let playback = outputLabel ? matchArdopDevice(outputLabel, d.playback) : null;
  let why = capture && playback ? 'rig' : '';
  const only = (list, re) => {
    const hits = list.filter((x) => re.test(x.name));
    return hits.length === 1 ? hits[0] : null;
  };
  // First pattern that has exactly one match wins.
  const first = (list, res) => {
    for (const re of res) { const hit = only(list, re); if (hit) return hit; }
    return null;
  };
  if (family === 'flex') {
    // SmartSDR 4.2.18+ (DAXv2) names its endpoints "DAX RX 1 (FlexRadio DAX)";
    // the older "DAX Audio RX 1 (FlexRadio Systems…)" endpoints often linger
    // in Windows beside them, dead. The live DAXv2 name wins.
    if (!capture) capture = first(d.capture, [/^DAX RX 1 \(FlexRadio DAX/i, /^DAX Audio RX 1\b/i]);
    if (!playback) playback = first(d.playback, [/^DAX TX \(FlexRadio DAX/i, /^DAX Audio TX\b/i]);
    if (!why && capture && playback) why = 'flex-dax';
  }
  if (!capture) capture = only(d.capture, /USB Audio CODEC|USB Audio Device|USB PnP Sound/i);
  if (!playback) playback = only(d.playback, /USB Audio CODEC|USB Audio Device|USB PnP Sound/i);
  if (!why && capture && playback) why = 'codec';
  return { capture: capture || null, playback: playback || null, why: why || (capture || playback ? 'partial' : 'none') };
}

/** ardopcf stdout/stderr line → a kind POTACAT acts on, or 'log'. */
function classifyArdopLine(line) {
  const s = String(line || '');
  if (/(capture|playback)device = '.*' not found|cannot open (playback|capture) audio device|Failed to open Wave(In|Out)/i.test(s)) return 'device-error';
  if (/bind.*(fail|in use)|address already in use|Unable to bind|WSAEADDRINUSE/i.test(s)) return 'port-busy';
  if (/listening on port|TCPHostInterface.*listen|Host port/i.test(s)) return 'listening';
  return 'log';
}

module.exports = {
  ARDOP_DEFAULTS,
  FORBIDDEN_FLAGS,
  LIST_ONLY_DEVICE,
  ardopBinaryName,
  ardopSupported,
  ardopPathCandidates,
  buildArdopArgs,
  buildArdopListArgs,
  parseArdopDeviceList,
  matchArdopDevice,
  resolveArdopDevices,
  proposeArdopDevices,
  classifyArdopLine,
};
