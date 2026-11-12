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

// TXDELAY 500 ms / TXTAIL 200 ms (#257, NA4DQ IC-7100 on rigctld): Dire Wolf
// starts timing TXDELAY when it asks for PTT, but POTACAT keys the radio over
// CAT (Dire Wolf -> the rigctld shim -> rigctld or CI-V), so the radio comes on
// air a good part of the preamble later. 300 ms left too little for the
// gateway to lock on the first frame; 500 ms is what worked for the reporter.
// The tail (Dire Wolf's own TXTAIL default 10 = 100 ms) is flags sent after the
// frame, before Dire Wolf asks for PTT off: 200 ms of them covers the audio
// still in POTACAT's pipeline when it unkeys (see packetUnkeyDrainMs).
const DIREWOLF_DEFAULTS = Object.freeze({ agwPort: 8010, modem: 1200, txDelayMs: 500, txTailMs: 200 });
/** The values a setting may take, in ms (Dire Wolf counts both in 10 ms units). */
const TX_DELAY_RANGE = Object.freeze({ min: 50, max: 1000 });
const TX_TAIL_RANGE = Object.freeze({ min: 10, max: 500 });
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

function _clampMs(v, fallback, range) {
  const n = Number(v);
  const ms = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.round(Math.max(range.min, Math.min(range.max, ms)) / 10) * 10;
}
/** TXDELAY in ms: blank / zero / junk = the default; kept within 50..1000 ms, in 10 ms steps. */
function clampTxDelayMs(v) { return _clampMs(v, DIREWOLF_DEFAULTS.txDelayMs, TX_DELAY_RANGE); }
/** TXTAIL in ms: blank / zero / junk = the default; kept within 10..500 ms, in 10 ms steps. */
function clampTxTailMs(v) { return _clampMs(v, DIREWOLF_DEFAULTS.txTailMs, TX_TAIL_RANGE); }
/** The TX timing a packet session uses, from the profile's settings. */
function packetTiming(settings = {}) {
  const s = settings || {};
  return { txDelayMs: clampTxDelayMs(s.winlinkPacketTxDelayMs), txTailMs: clampTxTailMs(s.winlinkPacketTxTailMs) };
}

/**
 * How long POTACAT holds PTT after Dire Wolf asks for it off. The hold exists
 * for audio still in POTACAT's pipeline (socket -> resampler -> bridge ring or
 * Flex / Icom stream) when the modem unkeys: Dire Wolf's socket backend has
 * already waited out its own playback clock (audio_tcp.c tcpaudio_wait). Dire
 * Wolf sends TXTAIL (flags, no data) after the frame and before it asks for
 * PTT off, so the last txTailMs of that buffered audio is tail, not frame:
 * only the part of the pipeline the tail does not cover still needs holding.
 * ARDOP / VARA / Mercury have no such tail and keep the full hold.
 *
 * But the old hold was sized on top of the old 100 ms tail, and the codec's
 * real output latency was never measured. So only tail BEYOND 100 ms replaces
 * hold time: PTT never drops sooner after the frame's last flag than it did
 * before #257 (pipeline + 100 ms of cover).
 */
const LEGACY_TX_TAIL_MS = 100;
/**
 * With the modem audio lane (#187) the bridge says when an over's audio has
 * actually played; packet may drop PTT this much before that end, the part of
 * Dire Wolf's TXTAIL beyond the legacy tail (the same allowance as below).
 */
function packetUnkeyLeaveMs(txTailMs) {
  const tail = Math.max(0, Number(txTailMs) || 0);
  return Math.max(0, tail - LEGACY_TX_TAIL_MS);
}

function packetUnkeyDrainMs(pipelineMs, txTailMs) {
  const base = Math.max(0, Number(pipelineMs) || 0);
  const tail = Math.max(0, Number(txTailMs) || 0);
  return Math.max(0, base - Math.max(0, tail - LEGACY_TX_TAIL_MS));
}

/**
 * The "Dire Wolf decoded nothing" verdict at the end of a failed packet
 * session. Pat connecting proves Dire Wolf decoded the gateway's UA, whatever
 * the counters say (Dire Wolf's stdout never reaches POTACAT on Windows, #128;
 * 1.13.10 had no AGW monitor, so both counts stayed 0 in a session Pat
 * connected in, #257).
 */
function packetDecodedNothing({ stdoutHeard = 0, monitorHeard = 0, patConnected = false } = {}) {
  if (patConnected) return false;
  return !(Number(stdoutHeard) > 0) && !(Number(monitorHeard) > 0);
}
/** A Pat line that says the AX.25 (or any) link came up: "Connected to KJ4AJP-10 (AX.25)". */
function patLineSaysConnected(line) {
  return /\bConnected to [A-Z0-9/-]+/i.test(String(line || ''));
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
function buildDirewolfConfig({ mycall, audioPort, capture, playback, modem, agwPort, shimPort, txDelayMs, txTailMs } = {}) {
  const call = _call(mycall);
  if (!call) throw new Error('Dire Wolf needs a callsign');
  if (!shimPort) throw new Error('Dire Wolf needs the POTACAT rigctld shim port for PTT');
  const port = Number(audioPort);
  if (audioPort != null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`Dire Wolf audio port ${audioPort} is not a port`);
  if (audioPort == null && (capture == null || playback == null)) throw new Error('Dire Wolf needs POTACAT\'s modem audio port (or two sound devices)');
  const m = MODEMS.includes(Number(modem)) ? Number(modem) : DIREWOLF_DEFAULTS.modem;
  const agw = Number.isInteger(Number(agwPort)) && Number(agwPort) > 0 ? Number(agwPort) : DIREWOLF_DEFAULTS.agwPort;
  // TXDELAY / TXTAIL are in 10 ms units: the preamble before the data (the
  // radio's key-up time, which includes POTACAT's CAT keying) and the flags
  // after it, before Dire Wolf asks for PTT off.
  const txd = clampTxDelayMs(txDelayMs) / 10;
  const txt = clampTxTailMs(txTailMs) / 10;
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
    `TXTAIL ${txt}`,
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
  // What Dire Wolf HEARD: "W1ABC-10 audio level = 48(12/11)" heads every
  // decoded frame, and "[0.3] W1ABC-10>K3SBP:..." is the frame itself. These are
  // the only proof the receive audio reaches the modem (a gateway that answered
  // but decoded nothing here = "Session failure {NumReceived:0}").
  if (/audio level\s*=/i.test(s)) return 'heard';
  if (/^\[\d+(\.\d+)?[A-Z]?\]/.test(s)) return 'frame';
  return 'log';
}

/**
 * One readiness probe of Dire Wolf's AGW port: does anything accept a TCP
 * connection there? Never throws and never rejects (it runs from a timer,
 * where a throw is an uncaught exception that ends POTACAT). Resolves
 * {ok:true} or {ok:false, code}: 'ECONNREFUSED' = nothing listening,
 * 'TIMEOUT' = no answer in timeoutMs.
 */
function probeAgwPort({ host = '127.0.0.1', port, timeoutMs = 400, net = require('net') } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch {}
      resolve(r);
    };
    try { sock = net.connect({ host, port }); }
    catch (e) { finish({ ok: false, code: (e && e.code) || 'ERROR' }); return; }
    sock.once('connect', () => finish({ ok: true }));
    sock.once('error', (e) => finish({ ok: false, code: (e && e.code) || 'ERROR' }));
    sock.setTimeout(timeoutMs, () => finish({ ok: false, code: 'TIMEOUT' }));
  });
}

/**
 * Why Dire Wolf was given up on after the start-up wait, in the operator's
 * terms. `lastProbe` is the last probeAgwPort result (null = never probed).
 * Antivirus is named only when nothing was listening: a port that refused
 * every probe means the process never got as far as opening it.
 */
function agwTimeoutMessage({ port, seconds = 15, lastLines = [], lastProbe = null } = {}) {
  const head = `Dire Wolf never opened its AGW port ${port} in ${seconds} s`;
  if (lastLines.length) return `${head} — it last said: ${lastLines.join(' | ')}`;
  if (lastProbe && lastProbe.code && lastProbe.code !== 'ECONNREFUSED') {
    return `${head} and printed nothing; connecting to 127.0.0.1:${port} gave ${lastProbe.code}` +
      ' (a firewall or security program may be holding local connections)';
  }
  return `${head} and printed nothing; nothing was listening on 127.0.0.1:${port}` +
    ' (the log has its spawn line; is direwolf.exe being blocked by antivirus or another program?)';
}

module.exports = {
  DIREWOLF_DEFAULTS,
  DIREWOLF_RATE,
  MODEMS,
  TX_DELAY_RANGE,
  TX_TAIL_RANGE,
  clampTxDelayMs,
  clampTxTailMs,
  packetTiming,
  packetUnkeyDrainMs,
  packetUnkeyLeaveMs,
  packetDecodedNothing,
  patLineSaysConnected,
  direwolfBinaryName,
  direwolfSupported,
  direwolfPathCandidates,
  buildDirewolfConfig,
  buildDirewolfArgs,
  classifyDirewolfLine,
  probeAgwPort,
  agwTimeoutMessage,
};
