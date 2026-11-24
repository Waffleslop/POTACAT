'use strict';
/**
 * The transmit guard for every sound POTACAT makes for the operator (#1041):
 * may this sound play now, and on which output.
 *
 * The rule it keeps: no POTACAT sound reaches the transmitter. A sound sent to
 * the radio's own sound card goes on the air while the radio transmits, and on
 * a radio with VOX it keys the transmitter by itself. So:
 *
 *   WHERE  A sound never plays on the radio's sound card. That is the output
 *          chosen as the radio's TX audio device, matched by the hardware it
 *          belongs to (groupId) and by name, never by deviceId alone: the
 *          system default shows up as the deviceId "default". A device named
 *          "USB Audio CODEC", the name the sound card built into a radio
 *          carries, counts as a radio's sound card too, so a station that set
 *          no TX audio device in POTACAT is still covered.
 *            - "Automatic" plays on the system default output. When the
 *              default is the radio's sound card, it plays on another output
 *              instead.
 *            - An output the operator chose plays there, unless it is the
 *              radio's sound card or is gone: then Automatic decides.
 *            - With no output that is not the radio's, nothing plays, and the
 *              Sounds pane says why (NO_OUTPUT_TEXT).
 *
 *   WHEN   A sound never starts while the station transmits (PTT, CW keying,
 *          JTCAT, FreeDV, a tune). A sound that comes due during a
 *          transmission is held until the radio unkeys; one held for more than
 *          HOLD_MAX_MS is dropped (the banner is not: it is not a sound). A
 *          sound already playing when a transmission starts is cut.
 *
 * Pure. renderer/sounds.js asks decide() before every play and does what it
 * says. Nothing here, and nothing that calls it, keys the radio or changes it.
 *
 * Dual-mode: require() in Node and tests, window.SoundGuard in the main window.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SoundGuard = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /** A sound held for a transmission longer than this is dropped. */
  const HOLD_MAX_MS = 3000;
  /** How often a held sound asks again whether the radio has unkeyed. */
  const HOLD_POLL_MS = 100;

  // The sound card built into a radio (Burr-Brown PCM29xx) names itself this.
  const RADIO_CODEC_RE = /USB Audio CODEC/i;

  const NO_OUTPUT_TEXT = 'Sounds are silent: the only sound output on this computer is the radio\'s sound card, and POTACAT never plays a sound into the radio. Plug in speakers or headphones to hear them.';

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }
  /** "Default - Speakers (X)" is "Speakers (X)" (the Windows role entries). */
  function labelBase(label) {
    return clean(label).replace(/^(Default|Communications)\s+-\s+/i, '');
  }
  function isRoleEntry(d) {
    return !!d && (d.deviceId === 'default' || d.deviceId === 'communications');
  }
  function outputsOf(devices) {
    return (devices || []).filter((d) => d && (d.kind === 'audiooutput' || d.kind == null) && d.deviceId != null);
  }

  /**
   * The radio's sound card, as far as this computer shows it: the labels and
   * hardware groups of every TX audio device.
   * @param {Array} devices    navigator.mediaDevices.enumerateDevices()
   * @param {Array} txDevices  the outputs transmit audio is sent to: deviceId
   *                           strings, or { deviceId, label }
   */
  function radioMarks(devices, txDevices) {
    const outs = outputsOf(devices);
    const groups = new Set();
    const labels = new Set();
    for (const t of txDevices || []) {
      const id = clean(t && typeof t === 'object' ? t.deviceId : t);
      const named = labelBase(t && typeof t === 'object' ? t.label : '');
      if (named) labels.add(named.toLowerCase());
      if (!id) continue;
      for (const d of outs) {
        if (d.deviceId !== id) continue;
        if (d.groupId) groups.add(d.groupId);
        const l = labelBase(d.label);
        if (l) labels.add(l.toLowerCase());
      }
    }
    return { groups, labels };
  }

  /** Is this output the radio's sound card? */
  function isRadioOutput(d, marks) {
    if (!d) return false;
    const l = labelBase(d.label);
    if (RADIO_CODEC_RE.test(l)) return true;
    if (d.groupId && marks.groups.has(d.groupId)) return true;
    return !!l && marks.labels.has(l.toLowerCase());
  }

  /**
   * The outputs a sound may use, the radio's sound card left out: what the
   * Sounds pane lists under "Sound output". No "default" or "communications"
   * entry (Automatic stands for the default).
   */
  function listOutputs(devices, txDevices) {
    const marks = radioMarks(devices, txDevices);
    const seen = new Set();
    const out = [];
    for (const d of outputsOf(devices)) {
      if (isRoleEntry(d) || isRadioOutput(d, marks)) continue;
      if (seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);
      out.push({ deviceId: d.deviceId, label: clean(d.label) || 'Sound output' });
    }
    return out;
  }

  /**
   * What became of the output the operator chose, for the Sounds pane:
   * '' (Automatic), 'listed' (offered and usable), 'radio' (it is the radio's
   * sound card now, so it is not offered) or 'missing' (not connected: the
   * pane keeps it as the choice, and Automatic plays until it is back).
   */
  function chosenState(a) {
    const chosenId = clean(a && a.chosenId);
    if (!chosenId) return '';
    const chosenLabel = labelBase(a && a.chosenLabel).toLowerCase();
    const same = (d) => d.deviceId === chosenId || (!!chosenLabel && labelBase(d.label).toLowerCase() === chosenLabel);
    if (listOutputs(a.devices, a.txDevices).some(same)) return 'listed';
    return outputsOf(a.devices).some((d) => !isRoleEntry(d) && same(d)) ? 'radio' : 'missing';
  }

  /**
   * Which output a sound plays on.
   * @param {object} a
   * @param {string} a.chosenId     settings.soundOutput ('' = Automatic)
   * @param {string} a.chosenLabel  settings.soundOutputLabel (finds it again when its id changed)
   * @param {Array}  a.devices      enumerateDevices()
   * @param {Array}  a.txDevices    see radioMarks
   * @returns {{ ok: true, sinkId: string, label: string, why: string } | { ok: false, reason: string, text: string }}
   *   sinkId '' is the system default. why: 'chosen', 'default', or 'moved'
   *   (the default, or the chosen output, is the radio's sound card).
   */
  function resolveOutput(a) {
    const devices = outputsOf(a && a.devices);
    const marks = radioMarks(devices, a && a.txDevices);
    const usable = listOutputs(devices, a && a.txDevices);
    const silent = { ok: false, reason: 'no-other-output', text: NO_OUTPUT_TEXT };

    // An output the operator chose, when it is there and is not the radio's.
    const chosenId = clean(a && a.chosenId);
    const chosenLabel = labelBase(a && a.chosenLabel).toLowerCase();
    let moved = false;
    if (chosenId) {
      const pick = usable.find((d) => d.deviceId === chosenId)
        || (chosenLabel ? usable.find((d) => labelBase(d.label).toLowerCase() === chosenLabel) : null);
      if (pick) return { ok: true, sinkId: pick.deviceId, label: pick.label, why: 'chosen' };
      const there = devices.find((d) => d.deviceId === chosenId);
      if (there && isRadioOutput(there, marks)) moved = true;
    }

    // Automatic: the system default, unless that is the radio's sound card.
    const def = devices.find((d) => d.deviceId === 'default');
    if (!devices.length) {
      // No list at all (the page may not ask): only the default can be named,
      // and nothing says it is the radio's.
      return { ok: true, sinkId: '', label: 'System default', why: 'default' };
    }
    if (def) {
      if (!isRadioOutput(def, marks)) {
        // The default entry names its hardware (label or group). When it names
        // neither, it cannot be told from the radio's sound card: with one in
        // the list, a named output that is not the radio's is the safe choice.
        const name = labelBase(def.label);
        const named = (!!name && !/^(default|communications)$/i.test(name))
          || devices.some((d) => !isRoleEntry(d) && d.groupId && d.groupId === def.groupId);
        const radioHere = devices.some((d) => !isRoleEntry(d) && isRadioOutput(d, marks));
        if (named || !radioHere) return { ok: true, sinkId: '', label: clean(def.label) || 'System default', why: moved ? 'moved' : 'default' };
      }
      if (usable.length) return { ok: true, sinkId: usable[0].deviceId, label: usable[0].label, why: 'moved' };
      return silent;
    }
    // No default entry in the list: any output that is not the radio's.
    if (usable.length) return { ok: true, sinkId: usable[0].deviceId, label: usable[0].label, why: moved ? 'moved' : 'default' };
    return silent;
  }

  /**
   * May a sound start now?
   * @param {boolean} txActive  the station is transmitting
   * @param {number} heldMs     how long this sound has been waiting
   * @returns {'play'|'hold'|'drop'}
   */
  function timing(txActive, heldMs) {
    if (!txActive) return 'play';
    return (Number(heldMs) || 0) >= HOLD_MAX_MS ? 'drop' : 'hold';
  }

  /**
   * The whole decision for one sound: may it play now, and where.
   * @param {object} a  resolveOutput's arguments, plus txActive and heldMs
   * @returns {{ action: 'play', sinkId, label, why } | { action: 'hold' }
   *   | { action: 'drop', reason: 'transmitting' } | { action: 'silent', reason, text }}
   */
  function decide(a) {
    const when = timing(!!(a && a.txActive), a && a.heldMs);
    if (when === 'hold') return { action: 'hold' };
    if (when === 'drop') return { action: 'drop', reason: 'transmitting' };
    const out = resolveOutput(a || {});
    if (!out.ok) return { action: 'silent', reason: out.reason, text: out.text };
    return { action: 'play', sinkId: out.sinkId, label: out.label, why: out.why };
  }

  return {
    HOLD_MAX_MS, HOLD_POLL_MS, NO_OUTPUT_TEXT,
    labelBase, radioMarks, isRadioOutput, listOutputs, chosenState, resolveOutput, timing, decide,
  };
}));
