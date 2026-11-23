'use strict';

// Which settings keys a remote device may write with `save-settings`.
//
// A device (the ECHOCAT app, ECHOCAT Web, a desktop driving this shack) sends
// a partial settings object; main.js merges it into the owner's settings and
// saves it. Without a list, a device could write any key: a program path that
// POTACAT later runs (rigctldPath, winlinkPatPath, tqslPath), a host it
// connects to, the ECHOCAT access door, a token or a cloud credential. So the
// rule is an allowlist: only the keys below pass, and the refusal patterns
// win over the list, so a key added here by mistake still cannot open those
// doors (test/device-settings-test.js checks the list against them).
//
// The list is what the clients write today (checked 2026-11-22):
//   ECHOCAT Web (renderer/remote.js): enableDxe, enableDxeSources, pskMacros,
//     jttyAudioFreq, jttyMacroStyle, jttySerial, kiwiSdrLabel1-3,
//     kiwiSdrHost1-3, sstvTemplates.
//   ECHOCAT app (save-settings sends, current and past): myCallsign, grid,
//     licenseClass, hideOutOfBand, potaAgeLimit, respotDefault,
//     logCommentTags, enableDxe, enableDxeSources, watchlistGroups,
//     jtcatUseDataMode, jttySerial, jttyMacroStyle, sstvCwId,
//     sstvPostProcess, kiwiSdrList, kiwiSdrLabel1-3, kiwiSdrHost1-3.
//   JTTY keys main.js already echoes back to every device after a save
//     (jttyMacros, jttyFt8Macros, jttyTemplates, jttyProfile, jtcatFdExch).
// Every other setting a device changes has its own message with its own
// validation (set-sources, jtcat-set-pref, save-custom-cat-buttons, ...).
// The owner's own desktop window saves through IPC and is not affected.
//
// kiwiSdrHost1-3 / kiwiSdrList name a public WebSDR the shack listens to, and
// the phone and the web page both edit that list, so they stay. The legacy
// single kiwiSdrHost ends in "Host" and is refused like every other *Host.

const DEVICE_WRITABLE_KEYS = Object.freeze([
  // Station
  'myCallsign',
  'grid',
  'licenseClass',
  // Spots
  'hideOutOfBand',
  'potaAgeLimit',
  'enableDxe',
  'enableDxeSources',
  'watchlistGroups',
  // Logging
  'respotDefault',
  'logCommentTags',
  // JTCAT / JTTY / PSK
  'jtcatUseDataMode',
  'jtcatFdExch',
  'jttySerial',
  'jttyMacroStyle',
  'jttyAudioFreq',
  'jttyMacros',
  'jttyFt8Macros',
  'jttyTemplates',
  'jttyProfile',
  'pskMacros',
  // SSTV
  'sstvTemplates',
  'sstvCwId',
  'sstvPostProcess',
  // WebSDR list
  'kiwiSdrList',
  'kiwiSdrLabel1', 'kiwiSdrLabel2', 'kiwiSdrLabel3',
  'kiwiSdrHost1', 'kiwiSdrHost2', 'kiwiSdrHost3',
]);

const ALLOWED = new Set(DEVICE_WRITABLE_KEYS);

// Settings secrets and machine credentials (lib/settings-secrets.js) plus the
// access and token keys, named so the refusal holds even if one of them is
// ever added to the list above.
let SECRETS = [];
try {
  const S = require('./settings-secrets');
  SECRETS = [].concat(S.SECRET_KEYS || [], S.MACHINE_CREDENTIAL_ARRAYS || [], S.MACHINE_IDENTITY_KEYS || []);
} catch { /* the patterns below still refuse the important ones */ }
const ALWAYS_REFUSED = new Set(SECRETS.concat([
  'enableRemote', 'remoteAccess', 'remoteToken', 'remoteRequireToken', 'echocatToken',
  'pairedDevices', 'connectionTargets',
]));

/** Why a key may never be written by a device, or '' when the patterns
 *  allow it (the allowlist still decides). */
function refusalPattern(key) {
  const k = String(key);
  if (/path$/i.test(k)) return 'path';           // a program or file the shack opens or runs
  if (/host$/i.test(k)) return 'host';           // a server the shack connects to
  if (/^remote/i.test(k)) return 'remote';       // ECHOCAT access, port, token, CW
  if (/^cloud/i.test(k)) return 'cloud';         // POTACAT Cloud account and tokens
  if (/token$|password$|secret$|apikey$/i.test(k)) return 'credential';
  if (ALWAYS_REFUSED.has(k)) return 'secret';
  if (k === '__proto__' || k === 'constructor' || k === 'prototype') return 'proto';
  return '';
}

/** May a device write this key? */
function isDeviceWritable(key) {
  return typeof key === 'string' && ALLOWED.has(key) && !refusalPattern(key);
}

/**
 * Split a device's save-settings patch. Returns { patch, refused }:
 * `patch` is a new plain object with only the writable keys (values as
 * sent; main.js still sanitises SDR, SSTV and DXE values), `refused` the
 * names of every other key, in the order sent.
 */
function filterDevicePatch(input) {
  const patch = {};
  const refused = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { patch, refused };
  for (const key of Object.keys(input)) {
    if (isDeviceWritable(key)) patch[key] = input[key];
    else refused.push(String(key).replace(/[^\x20-\x7e]/g, '?').slice(0, 64));
  }
  return { patch, refused };
}

module.exports = { DEVICE_WRITABLE_KEYS, isDeviceWritable, refusalPattern, filterDevicePatch };
