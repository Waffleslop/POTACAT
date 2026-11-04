// lib/voice-tx-check.js — "FT8 works, voice is silent" (2026-11-04: KD9OUT,
// KD9WJY, thecoffeepotcodger on the FT-710; Will KJ5CHK IC-7300 MK II with
// DATA MOD = MIC). The radio keys, the wattmeter reads 0 W and ALC never
// moves: no audio reaches the modulator, and the reason is a radio menu that
// POTACAT cannot read. Data modes work because they use a different input.
//
// Pure policy: given what one voice key-down measured, say whether to show the
// hint and which one. main.js keeps the measurement (handleRemotePtt opens
// it, sendCatFwdPower / sendCatAlc feed it, key-up decides) and shows a hint
// once per rig and mode family per session.
//
// The menu names are the ones the reporters' radios show; they are named, not
// guessed into full paths, except the Icom path, which is the same on every
// current Icom with USB audio (MENU > SET > Connectors > MOD Input).
'use strict';

const MIN_KEYED_MS = 2000;   // shorter than this is a blip, not a test of the audio path

function isDataMode(mode) {
  return /^(DIGU|DIGL|PKTUSB|PKTLSB|USB-D\d?|LSB-D\d?|DATA|DATA-U|DATA-L|FT8|FT4|FT2|PKT|DIGFM|FM-D)$/i.test(String(mode || ''));
}

/**
 * @param {object} m  what the key-down measured:
 *   keyedMs, fwdEvents (power readings during TX), peakW, alcEvents, peakAlc,
 *   mode (the radio's mode while keyed), brand ('Yaesu' | 'Icom' | ...)
 * @returns {null | {key, hint}}  null = audio reached the radio, or we cannot tell
 */
function decideVoiceTxHint(m) {
  if (!m || !(m.keyedMs >= MIN_KEYED_MS)) return null;
  // A radio that reports no power while keyed cannot tell us anything.
  if (!(m.fwdEvents > 0)) return null;
  if (m.peakW > 0) return null;
  if (m.alcEvents > 0 && m.peakAlc > 0) return null;
  const data = isDataMode(m.mode);
  const lead = 'The radio keyed with 0 W out and no ALC: no voice audio is reaching its transmitter.';
  if (m.brand === 'Yaesu') {
    return {
      key: 'yaesu',
      hint: lead + ' On the radio set SSB MOD SOURCE to REAR and REAR SELECT to USB, and in Settings > My Rigs > Audio pick the radio\'s own sound device (USB Audio CODEC) as the transmit audio.',
    };
  }
  if (m.brand === 'Icom') {
    return {
      key: data ? 'icom-data' : 'icom-voice',
      hint: lead + ' On the radio: MENU > SET > Connectors > MOD Input > ' + (data ? 'DATA MOD' : 'DATA OFF MOD')
        + ' = USB, and in Settings > My Rigs > Audio pick the radio\'s own sound device (USB Audio CODEC) as the transmit audio.',
    };
  }
  return {
    key: 'other',
    hint: lead + ' Check the radio\'s input source for USB or rear-panel audio, and that Settings > My Rigs > Audio sends transmit audio to the radio\'s own sound device.',
  };
}

module.exports = { decideVoiceTxHint, isDataMode, MIN_KEYED_MS };
