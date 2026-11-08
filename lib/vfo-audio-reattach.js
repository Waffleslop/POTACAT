'use strict';
/**
 * VFO window radio audio after a radio power cycle (GitHub #247, ride1226,
 * FT-710 on serial CAT, Windows). Pure. Dual-mode: require() in tests,
 * window.VfoAudioReattach in the VFO window (which also loads
 * lib/audio-device-heal.js as window.AudioDeviceHeal).
 *
 * A radio whose USB audio CODEC is powered by the radio (FT-710 and most
 * USB-audio rigs) takes the CODEC out of Windows when it powers off. The VFO
 * window's capture track ends, and on power-on the CODEC comes back, sometimes
 * under a new device ID. The window kept the dead stream and unmute only set
 * the gain on it, so nothing played until the window was reopened.
 *
 * decide(state, event) -> { reopen, pending }
 *   state: { active, direct, muted, streamLive, pending }
 *   event: 'power-on' (POTACAT switched the radio on), 'devicechange'
 *          (a device came or went), 'unmute' (the speaker button)
 *   - Only a running capture monitor is reattached; packet audio (SmartSDR,
 *     Icom Network, SCU-LAN10 — `direct`) has no device to reopen.
 *   - A power-on or a dead stream makes a reopen PENDING; it is done when the
 *     window is unmuted, and stays pending while muted (unmute does it).
 *   - The caller clears `pending` only when the reopen succeeded.
 *
 * pickInput({deviceId, label, rigName}, devices) -> { ok, deviceId, label, note }
 *   The device to reopen, followed by NAME through
 *   AudioDeviceHeal.healRigAudioDevices (the same rule as the rig settings:
 *   only the one device with exactly the saved label; never a different one).
 *
 * logLine(why, device) -> the one CAT-log line said on a reattach.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./audio-device-heal'));
  else root.VfoAudioReattach = factory(root.AudioDeviceHeal);
}(typeof self !== 'undefined' ? self : this, function (AudioDeviceHeal) {
  const EVENTS = ['power-on', 'devicechange', 'unmute'];

  function decide(state, event) {
    const s = state || {};
    if (!s.active || s.direct) return { reopen: false, pending: false };
    const pending = !!(s.pending || !s.streamLive || event === 'power-on');
    if (!EVENTS.includes(event)) return { reopen: false, pending };
    return { reopen: pending && !s.muted, pending };
  }

  function isRoleId(id) {
    return !id || id === 'default' || id === 'communications';
  }

  function pickInput(want, devices) {
    const w = want || {};
    const inputs = (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === 'audioinput');
    const id = String(w.deviceId || '');
    if (isRoleId(id)) {
      // No saved input: the system default, which exists once any input does.
      const def = inputs.find((d) => d.deviceId === (id || 'default')) || inputs[0];
      return def ? { ok: true, deviceId: id, label: '', note: '' } : { ok: false, deviceId: id, label: '', note: '' };
    }
    const present = inputs.find((d) => d.deviceId === id);
    if (present) return { ok: true, deviceId: id, label: String(present.label || w.label || ''), note: '' };
    if (!AudioDeviceHeal || typeof AudioDeviceHeal.healRigAudioDevices !== 'function') {
      return { ok: false, deviceId: id, label: '', note: '' };
    }
    // The one name matcher: a one-rig list through the settings heal.
    const rig = { name: w.rigName || 'radio', remoteAudioInput: id, remoteAudioInputLabel: String(w.label || '') };
    const r = AudioDeviceHeal.healRigAudioDevices([rig], devices);
    const healed = r.rigs[0] || rig;
    const note = r.notes[0] || '';
    if (healed.remoteAudioInput && healed.remoteAudioInput !== id) {
      return { ok: true, deviceId: healed.remoteAudioInput, label: String(w.label || ''), note };
    }
    return { ok: false, deviceId: id, label: '', note };
  }

  const WHY = {
    'power-on': 'power-on',
    devicechange: 'its USB audio device came back',
    unmute: 'unmute',
  };

  function clean(s, max) {
    // eslint-disable-next-line no-control-regex
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function logLine(why, device) {
    const w = WHY[why] || 'a radio power cycle';
    const dev = clean(device, 80) || 'the default input';
    return `[VFO] radio audio back after ${w} — reopened "${dev}"`;
  }

  return { decide, pickInput, logLine };
}));
