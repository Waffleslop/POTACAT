'use strict';
/**
 * The active rig's audio devices are the source of truth; settings.remoteAudioInput
 * / remoteAudioOutput are only the runtime mirror every capture path reads (the
 * ECHOCAT audio bridge, the JTCAT window, SSTV). An EMPTY input mirror is not
 * harmless: the bridge then opens the system DEFAULT recording device, which on
 * a Mac is the built-in microphone — the room went to a guest, and remote FT8
 * only decoded with the radio's speaker turned up (KF0WWL IC-7300, 2026-10-23,
 * Station Setup green because it reads the RIG's input).
 *
 * healRigAudioMirror(settings) copies the active rig's devices into the mirror
 * when they differ. It never blanks a mirror (a rig with no device keeps the
 * global, the pre-per-rig behaviour). Pure: returns what it changed.
 */
function healRigAudioMirror(settings) {
  const out = { changed: false, fields: [] };
  if (!settings || !Array.isArray(settings.rigs)) return out;
  const rig = settings.rigs.find((r) => r && r.id === settings.activeRigId);
  if (!rig) return out;
  for (const [rigKey, globalKey] of [['remoteAudioInput', 'remoteAudioInput'], ['remoteAudioOutput', 'remoteAudioOutput']]) {
    const want = rig[rigKey];
    if (typeof want === 'string' && want && settings[globalKey] !== want) {
      out.fields.push({ key: globalKey, was: settings[globalKey] || '' });
      settings[globalKey] = want;
      out.changed = true;
    }
  }
  return out;
}

module.exports = { healRigAudioMirror };
