// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Dire Wolf (AX.25 packet soft TNC) — launch helpers (pure, unit-tested).
//
// Dire Wolf (https://github.com/wb2osz/direwolf, GPL-2.0, WB2OSZ) is the
// software TNC Pat talks to for Winlink packet (AX.25) over its AGWPE port.
// POTACAT launches it as a SEPARATE PROCESS for a packet session — never
// linked (the wsprd posture) — and writes its config fresh each launch.
//
// The rule that matters: Dire Wolf keys the radio THROUGH POTACAT.
// Its PTT is `PTT RIG 2 127.0.0.1:<shim>` — Hamlib's NET rigctl client
// pointed at POTACAT's loopback rigctld shim (lib/rigctld-server.js, which
// speaks the dump_state handshake for exactly this) — so keying goes through
// handleRemotePtt under radio owner 'winlink' with the failsafe, the SWR
// latch and the shim's "only during a session" gate. It is never given a COM
// port, a GPIO line, or VOX of its own. That needs a Dire Wolf built WITH
// Hamlib (scripts/build-winlink-helpers.sh builds it so); a build without it
// says so on stderr ("only available when hamlib support is enabled") and
// classifyDirewolfLine names that, rather than letting it key nothing.
//
// Audio devices: on Windows Dire Wolf opens waveIn/waveOut by the same index
// ardopcf lists; on Linux it takes the same ALSA name (plughw:C,D). So the
// ardopcf listing + matcher (lib/ardop-process.js) choose its devices too.
//
// No beacons, no digipeating, no IGate, no KISS port: the config enables
// the AGW port Pat needs and nothing that transmits on its own.

'use strict';

const DIREWOLF_DEFAULTS = Object.freeze({ agwPort: 8010, modem: 1200, txDelayMs: 300 });
const MODEMS = Object.freeze([1200, 9600]);

function direwolfBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'direwolf.exe' : 'direwolf';
}

/** Windows and Linux for now: the device listing comes from ardopcf, which has no macOS build. */
function direwolfSupported(platform = process.platform) {
  return platform === 'win32' || platform === 'linux';
}

function direwolfPathCandidates({ settings, isPackaged, resourcesPath, appDir, platform = process.platform } = {}) {
  const bin = direwolfBinaryName(platform);
  const isWin = platform === 'win32';
  const sep = isWin ? '\\' : '/';
  const join = (...parts) => parts.join(sep);
  const out = [];
  if (settings && settings.winlinkDirewolfPath) out.push(settings.winlinkDirewolfPath);
  // Bundled beside its Hamlib libraries (Windows DLLs / Linux .so RPATH $ORIGIN).
  if (isPackaged && resourcesPath) out.push(join(resourcesPath, 'direwolf', bin));
  else if (appDir) out.push(join(appDir, 'assets', 'direwolf', bin));
  if (isWin) out.push('C:\\direwolf\\direwolf.exe', 'C:\\Program Files\\direwolf\\direwolf.exe');
  else out.push('/usr/local/bin/direwolf', '/usr/bin/direwolf');
  return out;
}

function _call(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9/-]/g, '');
}

/**
 * The direwolf.conf text. `capture`/`playback` come from resolveArdopDevices
 * (an index on Windows, plughw:C,D on Linux).
 */
function buildDirewolfConfig({ mycall, capture, playback, modem, agwPort, shimPort, txDelayMs } = {}) {
  const call = _call(mycall);
  if (!call) throw new Error('Dire Wolf needs a callsign');
  if (!shimPort) throw new Error('Dire Wolf needs the POTACAT rigctld shim port for PTT');
  const m = MODEMS.includes(Number(modem)) ? Number(modem) : DIREWOLF_DEFAULTS.modem;
  const agw = Number.isInteger(Number(agwPort)) && Number(agwPort) > 0 ? Number(agwPort) : DIREWOLF_DEFAULTS.agwPort;
  // TXDELAY is in 10 ms units: the radio's key-up time before data starts.
  const txd = Math.max(5, Math.min(100, Math.round((Number(txDelayMs) || DIREWOLF_DEFAULTS.txDelayMs) / 10)));
  const dev = (d) => {
    const s = String(d == null ? '' : d);
    return /\s/.test(s) ? `"${s}"` : s;
  };
  return [
    '# Written by POTACAT for a Winlink packet session — regenerated every launch; do not edit.',
    `ADEVICE ${dev(capture)} ${dev(playback)}`,
    'ACHANNELS 1',
    'CHANNEL 0',
    `MYCALL ${call}`,
    `MODEM ${m}`,
    // Keyed through POTACAT (Hamlib NET rig → the loopback rigctld shim).
    `PTT RIG 2 127.0.0.1:${shimPort}`,
    `TXDELAY ${txd}`,
    'TXTAIL 10',
    `AGWPORT ${agw}`,
    'KISSPORT 0',
    '',
  ].join('\n');
}

function buildDirewolfArgs({ configPath } = {}) {
  // -t 0: no ANSI colour codes in the output POTACAT reads.
  return ['-c', configPath, '-t', '0'];
}

/** Dire Wolf output line → a kind POTACAT acts on, or 'log'. */
function classifyDirewolfLine(line) {
  const s = String(line || '');
  if (/only available when hamlib support is enabled|rebuild direwolf with hamlib/i.test(s)) return 'no-hamlib';
  if (/doesn't match any of the (input|output) devices|Invalid (input|output) .*audio device|Could not open audio device/i.test(s)) return 'device-error';
  if (/Unable to (open|initialize).*(rig|hamlib)|rig_open.*fail|Hamlib.*error/i.test(s)) return 'ptt-error';
  if (/bind.*(fail|in use)|Address already in use|WSAEADDRINUSE/i.test(s)) return 'port-busy';
  if (/Ready to accept AGW client application/i.test(s)) return 'ready';
  return 'log';
}

module.exports = {
  DIREWOLF_DEFAULTS,
  MODEMS,
  direwolfBinaryName,
  direwolfSupported,
  direwolfPathCandidates,
  buildDirewolfConfig,
  buildDirewolfArgs,
  classifyDirewolfLine,
};
