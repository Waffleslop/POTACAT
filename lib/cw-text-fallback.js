'use strict';
// What to do when the radio link cannot send CW text itself (#383).
//
// Hamlib's send_morse (`b` to rigctld) is a per-backend feature. The Xiegu
// X5105 backend has none and answers RPRT -11 (RIG_ENAVAIL, "function not
// available"); POTACAT used to leave it there, so a macro sent nothing and
// said nothing useful. The text can still go out on a key line POTACAT
// itself owns: the CW Key Port, a USB-serial adapter whose DTR or RTS is
// wired to the key jack, keyed exactly as the key-port text path keys it.
//
// The CAT port's own DTR/RTS ("CW keying line" in Settings > Radio) is NOT a
// fallback here: under Hamlib that serial port belongs to rigctld, and
// POTACAT cannot switch its lines. PTT is never a fallback either: keying
// the transmitter with nothing to key the CW puts a carrier or dead air on
// the band.

/**
 * @param {object} s
 * @param {string} [s.keyPortPath]  settings.cwKeyPort ('' when none)
 * @param {boolean} [s.keyPortReady] the key port is open and can key now
 * @returns {{ route: 'key-port'|'none', message: string }}
 */
function cwTextUnavailablePlan(s) {
  const path = String((s && s.keyPortPath) || '').trim();
  const head = 'Hamlib cannot send CW text to this radio (send_morse is not available on its backend)';
  if (path && s.keyPortReady) {
    return { route: 'key-port', message: `${head}; keying the text on the CW Key Port (${path}) instead.` };
  }
  if (path) {
    return {
      route: 'none',
      message: `${head}, and the CW Key Port (${path}) is not open, so nothing was sent. Check the CW Key Port in Settings > ECHOCAT and that the radio's PC KEYING menu names the same line.`,
    };
  }
  return {
    route: 'none',
    message: `${head}, so nothing was sent. To send CW macros, connect a WinKeyer (Settings > Station > CW Keyer > WinKeyer Port) or a USB-serial adapter wired to the radio's key jack (Settings > ECHOCAT > CW Key Port).`,
  };
}

module.exports = { cwTextUnavailablePlan };
