'use strict';
// Where JTCAT hears the band: the radio's own audio (the sound card, DAX, or
// the radio's network stream, as Settings > My Rigs chooses) or a WebSDR
// (GitHub #243, LZ3AW: websdr.ewi.utwente.nl played in the speakers while
// JTCAT, listening to the radio, showed no waterfall and no decodes).
//
// With the WebSDR as the source:
//  - its audio is resampled to 12 kHz and fed to the FT8 engine, and the
//    JTCAT window's waterfall is drawn from the same audio;
//  - the WebSDR follows JTCAT's dial: a band pick retunes it to the mode's
//    dial frequency, USB, with a passband wide enough for the FT8 sub-band;
//  - JTCAT does not transmit. A WebSDR cannot hear your own signal and is
//    not on your radio's frequency, so keying "where you hear" would put
//    the signal somewhere else from the receiver it answers.
// Pure: main.js holds the client, the engine and the settings.

const SOURCES = Object.freeze(['radio', 'websdr']);

/** The two choices, as the JTCAT windows label them. */
const SOURCE_LABELS = Object.freeze({
  radio: 'Radio (sound card)',
  websdr: 'WebSDR',
});

/** Anything unknown (an old settings.json) is the radio. */
function normalizeJtcatRxSource(v) {
  return v === 'websdr' ? 'websdr' : 'radio';
}

// USB passband for FT8/FT4 on a WebSDR, kHz from the dial (WebSDR.org's unit,
// lib/websdr.js _sendTune). The FT8 sub-band is 200-3000 Hz above the dial;
// the default USB voice passband (0.3-2.7) would cut the top 300 Hz off.
const DIGITAL_PASSBAND_KHZ = Object.freeze({ lo: 0.1, hi: 3.0 });

/** Modes whose tune is a JTCAT dial (a band pick in the JTCAT window). */
function isJtcatDialMode(mode) {
  return /^(FT8|FT4|FT2|JTTY|WSPR|PSK31|PSK|JS8)$/i.test(String(mode || ''));
}

/**
 * The tune the WebSDR client gets for a JTCAT dial.
 * @param {number} dialKhz
 * @returns {{freqKhz:number, mode:'usb', opts:{lo:number, hi:number}}|null}
 */
function websdrTuneForDial(dialKhz) {
  const f = Number(dialKhz);
  if (!(f > 100)) return null;
  return { freqKhz: +f.toFixed(3), mode: 'usb', opts: { lo: DIGITAL_PASSBAND_KHZ.lo, hi: DIGITAL_PASSBAND_KHZ.hi } };
}

const WEBSDR_TX_REFUSAL = 'TX blocked — JTCAT is receiving from the WebSDR. A WebSDR cannot hear your own signal, ' +
  'and it listens on a different frequency from your radio, so JTCAT does not transmit while it is the receive source. ' +
  'To transmit, set Receive audio back to ' + SOURCE_LABELS.radio + ' in the JTCAT window.';

/**
 * @param {string} source settings.jtcatRxSource
 * @returns {string|null} the refusal to show, or null when TX may go ahead
 */
function jtcatTxRefusalForSource(source) {
  return normalizeJtcatRxSource(source) === 'websdr' ? WEBSDR_TX_REFUSAL : null;
}

module.exports = {
  SOURCES,
  SOURCE_LABELS,
  DIGITAL_PASSBAND_KHZ,
  WEBSDR_TX_REFUSAL,
  normalizeJtcatRxSource,
  isJtcatDialMode,
  websdrTuneForDial,
  jtcatTxRefusalForSource,
};
