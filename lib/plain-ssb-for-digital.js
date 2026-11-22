'use strict';
// "Switch radio to DATA mode (PKTUSB) for FT8 / FT4 (JTCAT)" off (settings.jtcatUseDataMode === false)
// keeps an older Yaesu (FTDX3000, FT-950) in plain USB for JTCAT, where its DATA IF is too narrow
// for FT8. The setting is JTCAT's. A Winlink radio session is not JTCAT: its modem (VARA HF, ARDOP)
// keys the radio in its data mode, as Winlink Express does. Before this, a Winlink tune went through
// the same rewrite and an FTDX10 on flrig was moved from DATA-U to USB for VARA HF. Pure.

const DATA_UPPER = new Set(['FT8', 'FT4', 'FT2', 'DIGU', 'PKTUSB', 'JS8', 'WSPR', 'JTTY']);
const DATA_LOWER = new Set(['DIGL', 'PKTLSB']);

/**
 * The mode a tune sends once the JTCAT plain-USB setting is applied.
 * @param {string} mode       the mode the caller asked for
 * @param {object} o
 * @param {boolean} o.useDataMode  settings.jtcatUseDataMode !== false
 * @param {string} [o.purpose]     'winlink' for a Winlink radio session (never rewritten)
 * @param {boolean} [o.freedv]     a FreeDV tune (has its own setting, never rewritten here)
 * @returns {string} the mode to send (unchanged unless the rewrite applies)
 */
function plainSsbForDigital(mode, { useDataMode = true, purpose = '', freedv = false } = {}) {
  if (!mode || useDataMode || freedv || purpose === 'winlink') return mode;
  const m = String(mode).toUpperCase();
  if (DATA_UPPER.has(m) || m.startsWith('PSK')) return 'USB';
  if (DATA_LOWER.has(m)) return 'LSB';
  return mode;
}

module.exports = { plainSsbForDigital };
