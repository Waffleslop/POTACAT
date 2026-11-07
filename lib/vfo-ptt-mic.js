'use strict';
/**
 * What the PC microphone did on a VFO window PTT press (#170, KD9OUT FT-710:
 * the button keyed the radio with no modulation while ECHOCAT voice through
 * the same PC modulated it). Both paths play into the same output and key the
 * same way; the VFO window differs only in the INPUT, and it said nothing
 * about it: a failure went to the window's console, the radio keyed anyway,
 * and no log named the device opened or its level.
 *
 * assess(report) turns one press into ONE log line (input, output, level) and,
 * when something is wrong, a notice for the window. Problems, first wins:
 *   no-mic        getUserMedia failed (privacy, unplugged, in use)
 *   output-failed the radio's output device would not open
 *   no-output     no output set on a USB-audio rig: the mic plays on this PC
 *   mic-is-radio  the "microphone" is the radio's own receive audio
 *   silent        the stream opened but carries nothing (< -80 dBFS, the
 *                 Station Setup listen test's "silent" line)
 *
 * report: { path: 'usb'|'direct', micChosen, inputId, inputLabel, rigInputId,
 *   rigInputLabel, outputId, outputLabel, peakDbfs (null = not measured),
 *   heldMs, error, errorName, stage: 'mic'|'output'|'graph' }
 *
 * Dual-mode: require() in main and tests, window.VfoPttMic in the VFO window.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VfoPttMic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SILENT_DBFS = -80;
  const MIN_MEASURE_MS = 500;
  // Every radio's built-in sound card (Burr-Brown PCM29xx) names itself this;
  // Windows lists its capture side as "Microphone (USB Audio CODEC )".
  const RADIO_CODEC_RE = /USB Audio CODEC/i;

  function clean(s, max) {
    return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 120);
  }
  /** "Default - Microphone (X)" → "Microphone (X)" (Windows role entries). */
  function labelBase(label) {
    return clean(label).replace(/^(Default|Communications)\s+-\s+/i, '');
  }

  function isRadioInput(r) {
    const id = r.inputId || r.micChosen || '';
    if (r.rigInputId && id && id === r.rigInputId) return true;
    const mine = labelBase(r.inputLabel);
    if (!mine) return false;
    if (r.rigInputLabel && mine === labelBase(r.rigInputLabel)) return true;
    return RADIO_CODEC_RE.test(mine);
  }

  function micCause(name) {
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Windows or the system blocked the microphone (privacy setting)';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'the microphone was not found (unplugged or renamed)';
      case 'NotReadableError':
      case 'AbortError':
        return 'the microphone could not be opened (in use, or blocked by the privacy setting)';
      default:
        return 'the microphone could not be opened';
    }
  }

  function assess(r) {
    r = r || {};
    const direct = r.path === 'direct';
    const chosen = r.micChosen ? 'chosen in Microphone' : 'System Default';
    const inLabel = labelBase(r.inputLabel) || (r.micChosen ? 'the chosen microphone' : 'the system default microphone');
    const outLabel = direct ? 'the radio over the network'
      : r.outputId ? ('"' + (clean(r.outputLabel) || clean(r.outputId, 24)) + '"')
      : "this computer's default speaker (no TX audio out set)";
    const measured = typeof r.peakDbfs === 'number' && isFinite(r.peakDbfs) && (Number(r.heldMs) || 0) >= MIN_MEASURE_MS;
    const db = typeof r.peakDbfs === 'number' && isFinite(r.peakDbfs) ? Math.round(r.peakDbfs) : null;
    const level = measured ? ('level ' + db + ' dBFS') : 'level not measured (released too soon)';
    const err = clean(r.error, 160);

    let problem = null, why = '', notice = null;
    if (r.error && (r.stage === 'mic' || !r.stage)) {
      problem = 'no-mic';
      why = micCause(r.errorName) + ' (' + (clean(r.errorName, 40) || 'error') + ': ' + err + ')';
      notice = 'PTT keyed the radio without your voice: ' + micCause(r.errorName) + '. ' +
        (r.micChosen ? 'Choose your microphone again under Transmit audio > Microphone (the EQ button). '
          : 'Choose your microphone under Transmit audio > Microphone (the EQ button). ') +
        'On Windows also check Settings > Privacy & security > Microphone: let desktop apps access your microphone.';
    } else if (r.error && r.stage === 'output') {
      problem = 'output-failed';
      why = 'the radio\'s audio output would not open (' + err + ')';
      notice = 'PTT keyed the radio without your voice: the radio\'s audio output would not open. ' +
        'Check TX audio out (to radio) under Audio Devices in the rig settings.';
    } else if (r.error) {
      problem = 'no-mic';
      why = 'the transmit audio could not be set up (' + err + ')';
      notice = 'PTT keyed the radio without your voice: the transmit audio could not be set up (' + err + ').';
    } else if (!direct && !r.outputId) {
      problem = 'no-output';
      why = 'no TX audio out is set, so the microphone plays on this computer, not the radio';
      notice = 'Your voice is playing on this computer, not the radio: set TX audio out (to radio) under Audio Devices in the rig settings.';
    } else if (isRadioInput(r)) {
      problem = 'mic-is-radio';
      why = 'the microphone is the radio\'s own receive audio, silent while transmitting';
      notice = 'PTT is using "' + inLabel + '" as the microphone: that is the radio\'s own audio, not a microphone' +
        (r.micChosen ? '' : ' (it is the Windows System Default recording device)') +
        '. Choose your microphone by name under Transmit audio > Microphone (the EQ button).';
    } else if (measured && db < SILENT_DBFS) {
      problem = 'silent';
      why = 'no sound from the microphone';
      notice = 'No sound from "' + inLabel + '" while transmitting. Check it is the right device under Transmit audio > Microphone (the EQ button), ' +
        'that it is not muted, and on Windows Settings > Privacy & security > Microphone: let desktop apps access your microphone.';
    }

    const line = '[VFO PTT] Mic "' + inLabel + '" (' + chosen + ') -> ' + outLabel + ', ' +
      (r.error && !measured ? 'no audio' : level) + (problem ? ': ' + why : ': ok');
    return { problem, line: line.slice(0, 600), notice };
  }

  return { assess, labelBase, isRadioInput, SILENT_DBFS, MIN_MEASURE_MS };
}));
