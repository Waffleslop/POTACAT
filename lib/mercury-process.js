// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Mercury HF data modem — process helpers (pure, unit-tested).
//
// Mercury (https://github.com/Rhizomatica/mercury, GPL-3.0-or-later) is an
// external, standalone HF data modem. POTACAT launches it as a SEPARATE
// PROCESS and talks to it only over its TCP TNC interface — never linked —
// which keeps Mercury's GPL off the Apache-2.0 POTACAT binary (same "mere
// aggregation" posture as the bundled wsprd; see NOTICE / docs).
//
// This module holds the PURE decisions (binary-name, path candidates, CLI
// args, ini text) so they can be tested without spawning anything. The impure
// spawn/supervise/socket glue lives in main.js (findMercury/spawnMercury/
// connectMercury), cloned from the rigctld management pattern.
//
// Key design invariant: POTACAT keeps PTT/radio ownership. Mercury is launched
// with NO hamlib/HERMES radio-control flags (-R/-A/-S) and radio_model = -1,
// so it does NOT key the rig — it emits "PTT ON"/"PTT OFF" on the control
// socket and leaves keying to the TCP client (POTACAT's handleRemotePtt).

'use strict';

const MERCURY_DEFAULTS = Object.freeze({
  basePort: 8300,        // control = base, data = base + 1
  broadcastPort: 8100,   // KISS-over-TCP (Reticulum path, later phase)
  soundSystem: 'auto',   // auto | alsa | pulse | wasapi | dsound | coreaudio | fifo | ...
  captureChannel: 'left',// left | right | stereo
  txGainDb: 0,           // Mercury [audio] tx_gain_db
});

/** Platform-correct Mercury executable name. */
function mercuryBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'mercury.exe' : 'mercury';
}

/**
 * Ordered list of candidate binary locations to probe (most-specific first).
 * The bare executable name (PATH fallback) is intentionally NOT included —
 * findMercury() returns it only after every candidate misses, mirroring
 * findRigctld().
 *
 * @param {object} o
 * @param {object} [o.settings]        POTACAT settings (mercuryPath override)
 * @param {boolean} [o.isPackaged]     app.isPackaged
 * @param {string} [o.resourcesPath]   process.resourcesPath (packaged)
 * @param {string} [o.appDir]          __dirname of main (dev)
 * @param {string} [o.platform]        process.platform
 * @returns {string[]}
 */
function mercuryPathCandidates({ settings, isPackaged, resourcesPath, appDir, platform = process.platform } = {}) {
  const bin = mercuryBinaryName(platform);
  const isWin = platform === 'win32';
  const sep = isWin ? '\\' : '/';
  const join = (...parts) => parts.join(sep);
  const out = [];

  // 1. User override wins (nightly / custom build).
  if (settings && settings.mercuryPath) out.push(settings.mercuryPath);

  // 2. Bundled (mere aggregation): third_party/mercury/<bin>.
  if (isPackaged && resourcesPath) out.push(join(resourcesPath, 'third_party', 'mercury', bin));
  else if (appDir) out.push(join(appDir, 'third_party', 'mercury', bin));

  // 3. Common install locations.
  if (isWin) {
    out.push('C:\\Program Files\\Mercury\\mercury.exe',
      'C:\\Program Files\\mercury\\mercury.exe',
      'C:\\mercury\\mercury.exe');
  } else {
    out.push('/usr/bin/mercury', '/usr/local/bin/mercury',
      '/opt/homebrew/bin/mercury', '/opt/mercury/mercury', '/snap/bin/mercury');
  }
  return out;
}

/** Coerce a settings value to a positive int port, else the fallback. */
function _port(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Resolved, defaulted runtime config from raw settings. */
function mercuryConfig(settings = {}) {
  const gain = Number(settings.mercuryTxGainDb);
  return {
    basePort: _port(settings.mercuryBasePort, MERCURY_DEFAULTS.basePort),
    broadcastPort: _port(settings.mercuryBroadcastPort, MERCURY_DEFAULTS.broadcastPort),
    soundSystem: settings.mercurySoundSystem || MERCURY_DEFAULTS.soundSystem,
    inputDevice: settings.mercuryInputDevice || '',
    outputDevice: settings.mercuryOutputDevice || '',
    captureChannel: settings.mercuryCaptureChannel || MERCURY_DEFAULTS.captureChannel,
    txGainDb: Number.isFinite(gain) ? Math.max(-20, Math.min(20, gain)) : MERCURY_DEFAULTS.txGainDb,
    verbose: !!settings.mercuryVerbose,
  };
}

/** The control/data port pair Mercury will listen on for the given settings. */
function mercuryPorts(settings = {}) {
  const base = _port(settings.mercuryBasePort, MERCURY_DEFAULTS.basePort);
  return { control: base, data: base + 1, broadcast: _port(settings.mercuryBroadcastPort, MERCURY_DEFAULTS.broadcastPort) };
}

/**
 * CLI args for spawning Mercury. Deliberately omits all radio-control flags
 * (-R/-A/-S) so Mercury never keys the rig — POTACAT owns PTT. The ini (see
 * buildMercuryIni) carries the safe base config; these CLI args override it
 * and, like the rigctld spawn line, are logged so a bug report shows exactly
 * what Mercury received.
 *
 * @param {object} settings
 * @param {string} iniPath  path to the generated mercury.ini
 * @returns {string[]}
 */
function buildMercuryArgs(settings, iniPath) {
  const c = mercuryConfig(settings);
  const args = ['-C', iniPath, '-p', String(c.basePort), '-b', String(c.broadcastPort)];
  if (c.soundSystem && c.soundSystem !== 'auto') args.push('-x', c.soundSystem);
  if (c.inputDevice) args.push('-i', c.inputDevice);
  if (c.outputDevice) args.push('-o', c.outputDevice);
  if (c.captureChannel && c.captureChannel !== 'left') args.push('-k', c.captureChannel);
  if (c.verbose) args.push('-v');
  return args;
}

/**
 * Generate the mercury.ini text. Holds the safety-critical defaults so they
 * apply even if a future arg is dropped: radio_model = -1 (never key the rig)
 * and ui_enabled = false (POTACAT is the controller, not mercury-qt).
 * @param {object} settings
 * @returns {string}
 */
function buildMercuryIni(settings = {}) {
  const c = mercuryConfig(settings);
  return [
    '; Generated by POTACAT — do not edit; regenerated on each launch.',
    '; Mercury is launched WITHOUT radio-control flags so POTACAT keeps PTT.',
    '',
    '[main]',
    'ui_enabled = false',
    'waterfall_enabled = false',
    'radio_model = -1',
    `arq_tcp_base_port = ${c.basePort}`,
    `broadcast_tcp_port = ${c.broadcastPort}`,
    `sound_system = ${c.soundSystem}`,
    `input_device = ${c.inputDevice}`,
    `output_device = ${c.outputDevice}`,
    `capture_channel = ${c.captureChannel}`,
    '',
    '[audio]',
    `tx_gain_db = ${c.txGainDb.toFixed(1)}`,
    '',
  ].join('\n');
}

module.exports = {
  MERCURY_DEFAULTS,
  mercuryBinaryName,
  mercuryPathCandidates,
  mercuryConfig,
  mercuryPorts,
  buildMercuryArgs,
  buildMercuryIni,
};
