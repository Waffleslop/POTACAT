'use strict';
/**
 * Voice in DATA mode (GitHub #24, the Xiegu G90): a per-rig option that sends
 * voice USB/LSB to the radio as USB-D/LSB-D, all the time, not just while
 * keyed. On radios whose data audio line is silent in the voice modes (the
 * G90's rear port), that is the only way receive audio reaches a Digirig and
 * ECHOCAT. The radio's own microphone is off in DATA mode, so it is opt-in.
 *
 * The radio then reports DATA, and everything that reads the mode (logging,
 * spot check marks, rig presets by mode family) would take a voice contact
 * for a digital one. So while the last mode POTACAT asked for was a voice mode
 * it sent as DATA, the reported DATA mode is read back as the voice mode.
 * Pure; RigController holds the state (`setVoiceAsData`).
 */

// The names a codec can report for USB-D / LSB-D (Kenwood/CI-V tables say
// DIGU/DIGL, Hamlib says PKTUSB/PKTLSB).
const DATA_TO_VOICE = {
  DIGU: 'USB', 'USB-D': 'USB', 'DATA-U': 'USB', PKTUSB: 'USB',
  DIGL: 'LSB', 'LSB-D': 'LSB', 'DATA-L': 'LSB', PKTLSB: 'LSB',
};

function ssbSideband(freqHz) {
  if (freqHz >= 5300000 && freqHz <= 5410000) return 'USB'; // 60 m is USB
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

/** The voice sideband a requested mode names, or null when it is not voice SSB. */
function voiceSideband(mode, freqHz) {
  const m = String(mode || '').toUpperCase();
  if (m === 'USB' || m === 'LSB') return m;
  if (m === 'SSB') return ssbSideband(freqHz || 0);
  return null;
}

/** The DATA mode to send for a voice request, or null to send it unchanged. */
function voiceToData(mode, freqHz) {
  const sb = voiceSideband(mode, freqHz);
  return sb === 'USB' ? 'DIGU' : sb === 'LSB' ? 'DIGL' : null;
}

/** The voice mode a reported DATA mode stands for, or null when it is not USB-D/LSB-D. */
function dataToVoice(mode) {
  return DATA_TO_VOICE[String(mode || '').toUpperCase()] || null;
}

module.exports = { voiceSideband, voiceToData, dataToVoice };
