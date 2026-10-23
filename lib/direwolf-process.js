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
// Audio: Dire Wolf opens NO sound device. POTACAT's build carries the socket
// audio backend (third_party/direwolf/src/audio_tcp.c, hooked in by
// potacat-socket-audio.patch): `ADEVICE tcp:<port>` takes receive audio from,
// and sends transmit audio to, lib/modem-audio-server.js at DIREWOLF_RATE,
// and POTACAT moves that audio to the radio the same way it does for FT8 (the
// Flex / Icom Network streams, or the modem bridge window on a sound-card
// rig). So there is nothing to pick, on any OS — docs/modem-audio-bridge-plan.md.
// (`capture`/`playback` device names are still accepted for a hand-built
// Dire Wolf without the backend.)
//
// No beacons, no digipeating, no IGate, no KISS port: the config enables
// the AGW port Pat needs and nothing that transmits on its own.

'use strict';

const DIREWOLF_DEFAULTS = Object.freeze({ agwPort: 8010, modem: 1200, txDelayMs: 300 });
const MODEMS = Object.freeze([1200, 9600]);
/** The sample rate on the socket (ARATE): 9600-baud packet wants at least 4x the baud rate. */
const DIREWOLF_RATE = 48000;

function direwolfBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'direwolf.exe' : 'direwolf';
}

/** Windows, Linux and macOS (built with PortAudio there, but it opens no device for POTACAT). */
function direwolfSupported(platform = process.platform) {
  return platform === 'win32' || platform === 'linux' || platform === 'darwin';
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
 * The direwolf.conf text. `audioPort` = POTACAT's modem audio server (the
 * normal case: `ADEVICE tcp:<port>` + `ARATE 48000`, no sound device);
 * `capture`/`playback` are the fallback device names for a Dire Wolf built
 * without the socket backend. One or the other, never both.
 */
function buildDirewolfConfig({ mycall, audioPort, capture, playback, modem, agwPort, shimPort, txDelayMs } = {}) {
  const call = _call(mycall);
  if (!call) throw new Error('Dire Wolf needs a callsign');
  if (!shimPort) throw new Error('Dire Wolf needs the POTACAT rigctld shim port for PTT');
  const port = Number(audioPort);
  if (audioPort != null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`Dire Wolf audio port ${audioPort} is not a port`);
  if (audioPort == null && (capture == null || playback == null)) throw new Error('Dire Wolf needs POTACAT\'s modem audio port (or two sound devices)');
  const m = MODEMS.includes(Number(modem)) ? Number(modem) : DIREWOLF_DEFAULTS.modem;
  const agw = Number.isInteger(Number(agwPort)) && Number(agwPort) > 0 ? Number(agwPort) : DIREWOLF_DEFAULTS.agwPort;
  // TXDELAY is in 10 ms units: the radio's key-up time before data starts.
  const txd = Math.max(5, Math.min(100, Math.round((Number(txDelayMs) || DIREWOLF_DEFAULTS.txDelayMs) / 10)));
  const dev = (d) => {
    const s = String(d == null ? '' : d);
    return /\s/.test(s) ? `"${s}"` : s;
  };
  // ARATE applies to the ADEVICE line before it; the socket carries exactly that rate.
  const audio = audioPort != null ? [`ADEVICE tcp:${port}`, `ARATE ${DIREWOLF_RATE}`] : [`ADEVICE ${dev(capture)} ${dev(playback)}`];
  return [
    '# Written by POTACAT for a Winlink packet session — regenerated every launch; do not edit.',
    ...audio,
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

/**
 * Launch args. Dire Wolf cuts the -c path at ~100 characters (a real path
 * under a long Windows profile came back "Could not open configuration file
 * ...c444"), so POTACAT runs it with cwd = the config's folder and passes the
 * bare file name. -t 0: no ANSI colour codes in the output POTACAT reads.
 */
function buildDirewolfArgs({ configName = 'direwolf.conf' } = {}) {
  return ['-c', configName, '-t', '0'];
}

/** Dire Wolf output line → a kind POTACAT acts on, or 'log'. */
function classifyDirewolfLine(line) {
  const s = String(line || '');
  if (/only available when hamlib support is enabled|rebuild direwolf with hamlib/i.test(s)) return 'no-hamlib';
  if (/doesn't match any of the (input|output) devices|Invalid (input|output) .*audio device|Could not open audio device|nothing is serving modem audio|carries 16-bit mono only/i.test(s)) return 'device-error';
  if (/Unable to (open|initialize).*(rig|hamlib)|rig_open.*fail|Hamlib.*error/i.test(s)) return 'ptt-error';
  if (/bind.*(fail|in use)|Address already in use|WSAEADDRINUSE/i.test(s)) return 'port-busy';
  if (/Ready to accept AGW client application/i.test(s)) return 'ready';
  return 'log';
}

module.exports = {
  DIREWOLF_DEFAULTS,
  DIREWOLF_RATE,
  MODEMS,
  direwolfBinaryName,
  direwolfSupported,
  direwolfPathCandidates,
  buildDirewolfConfig,
  buildDirewolfArgs,
  classifyDirewolfLine,
};
