// Shared rig utility functions and constants extracted from cat.js

// Kenwood/Flex/Yaesu MD response -> mode string
// Values 1-9 are standard Kenwood; 0xA-0xE are Yaesu extended (hex digit in MD0x response)
const MD_TO_MODE = {
  1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY', 7: 'CW', 8: 'DIGL', 9: 'DIGU',
  0xA: 'FM', 0xB: 'FM', 0xC: 'DIGU', 0xD: 'AM', 0xE: 'FM',
};

// CI-V mode byte -> POTACAT mode string
const CIV_MODE_TO_NAME = {
  0x00: 'LSB', 0x01: 'USB', 0x02: 'AM', 0x03: 'CW',
  0x04: 'RTTY', 0x05: 'FM', 0x06: 'WFM', 0x07: 'CW',   // CW-R -> CW
  0x08: 'RTTY',                                             // RTTY-R -> RTTY
};

// Yaesu SH0 bandwidth tables (1-based index -> Hz)
const YAESU_SSB_BW = [200,400,600,850,1100,1350,1500,1650,1800,1950,2100,2250,2400,2500,2600,2700,2800,2900,3000,3200,3600];
const YAESU_CW_BW  = [50,100,150,200,250,300,350,400,450,500,600,800,1000,1200,1500,2400];

function yaesuBwToIndex(hz, mode) {
  const m = (mode || '').toUpperCase();
  const table = (m === 'CW') ? YAESU_CW_BW : YAESU_SSB_BW;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - hz);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best + 1; // 1-based index
}

// LSB below 10 MHz, USB from 10 MHz and on 60 m: the one rule (lib/ssb-sideband.js).
const { ssbSideband } = require('./ssb-sideband');

function mapMode(mode, freqHz, isSerial) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return { md: 3 };
  if (m === 'USB') return { md: 2, da: isSerial ? 0 : null };
  if (m === 'LSB') return { md: 1, da: isSerial ? 0 : null };
  if (m === 'SSB') return { md: ssbSideband(freqHz) === 'USB' ? 2 : 1, da: isSerial ? 0 : null };
  if (m === 'FM') return { md: 4, da: isSerial ? 0 : null };
  if (m === 'AM') return { md: 5, da: isSerial ? 0 : null };
  if (m === 'DIGU' || m === 'PKTUSB' || m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'PSK31' || m === 'PSK' || m === 'JS8') {
    // Kenwood serial: MD2 (USB) + DA1 (data mode on)
    // Flex TCP: MD9 (DIGU)
    // PSK31 transmits in USB with a 1500 Hz audio tone — same shell
    // as FT8, so it shares the data-mode mapping. JS8 is FT8-derived
    // and rides the same baseband.
    return isSerial ? { md: 2, da: 1 } : { md: 9 };
  }
  if (m === 'DIGL' || m === 'PKTLSB') {
    return isSerial ? { md: 1, da: 1 } : { md: 6 };
  }
  if (m === 'RTTY') return { md: 6 };
  return null;
}

function mapModeRigctld(mode, freqHz) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return 'CW';
  if (m === 'USB') return 'USB';
  if (m === 'LSB') return 'LSB';
  if (m === 'SSB') return ssbSideband(freqHz);
  if (m === 'FM') return 'FM';
  if (m === 'AM') return 'AM';
  if (m === 'RTTY') return 'RTTY';
  if (m === 'DIGU' || m === 'PKTUSB' || m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'PSK31' || m === 'PSK' || m === 'JS8') return 'PKTUSB';
  if (m === 'DIGL' || m === 'PKTLSB') return 'PKTLSB';
  return null;
}

// Returns the CI-V mode byte ONLY. The data-mode flag (1A 06 01/00) is set
// separately by the LIVE Icom path in lib/codecs/civ-codec.js:setMode().
// This function is only referenced from the legacy CivClient class in
// lib/cat.js, which is no longer instantiated (kept for reference). If
// CivClient is ever revived, callers must follow up the 0x06 write with
// 1A 06 [data, filter] — see civ-codec.js for the correct pattern.
function mapModeCiv(mode, freqHz) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return 0x03;
  if (m === 'USB') return 0x01;
  if (m === 'LSB') return 0x00;
  if (m === 'SSB') return ssbSideband(freqHz) === 'USB' ? 0x01 : 0x00;
  if (m === 'FM') return 0x05;
  if (m === 'AM') return 0x02;
  if (m === 'RTTY') return 0x04;
  if (m === 'DIGU' || m === 'PKTUSB' || m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'PSK31' || m === 'PSK' || m === 'JS8') return 0x01;
  if (m === 'DIGL' || m === 'PKTLSB') return 0x00;
  return null;
}

/**
 * Expand a command template string by replacing placeholders with formatted values.
 *
 * Supported placeholders:
 *   {freq:pad9}   -> zero-pad integer to 9 digits
 *   {freq:pad11}  -> zero-pad integer to 11 digits
 *   {val:pad2}    -> zero-pad integer to 2 digits
 *   {val:pad3}    -> zero-pad integer to 3 digits
 *   {val:pad4}    -> zero-pad integer to 4 digits
 *   {mode:hexU}   -> uppercase hex of number (.toString(16).toUpperCase())
 *   {mode}        -> plain toString()
 *   {val}         -> plain toString()
 *
 * @param {string} template — the command template with {placeholders}
 * @param {object} vars — values to substitute, e.g. { freq: 14074000, mode: 9, val: 3 }
 * @returns {string} the expanded command string
 */
function expandTemplate(template, vars) {
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (match, name, fmt) => {
    const v = vars[name];
    if (v == null) return match; // leave unresolved placeholders as-is
    if (!fmt) return v.toString();
    if (fmt === 'pad9') return String(Math.round(v)).padStart(9, '0');
    if (fmt === 'pad11') return String(Math.round(v)).padStart(11, '0');
    if (fmt === 'pad2') return String(Math.round(v)).padStart(2, '0');
    if (fmt === 'pad3') return String(Math.round(v)).padStart(3, '0');
    if (fmt === 'pad4') return String(Math.round(v)).padStart(4, '0');
    if (fmt === 'hexU') return Math.round(v).toString(16).toUpperCase();
    return v.toString(); // unknown format — fall back to plain string
  });
}

module.exports = {
  MD_TO_MODE,
  CIV_MODE_TO_NAME,
  YAESU_SSB_BW,
  YAESU_CW_BW,
  ssbSideband,
  yaesuBwToIndex,
  mapMode,
  mapModeRigctld,
  mapModeCiv,
  expandTemplate,
};
