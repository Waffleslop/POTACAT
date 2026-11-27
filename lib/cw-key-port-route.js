'use strict';

// The CW Key Port's part in paddle and text keying (#1117: QMX+ on Linux).
//
// On a Linux USB-CDC driver (QMX, QDX, IC-7300) node-serialport cannot set
// DTR/RTS (TIOCMSET is rejected), so POTACAT closes its own handle on the key
// port and the persistent pyserial keyer keys it instead. The key port is then
// never "open" from node's side, and the paddle router used to fall back to
// DTR on the CAT port as if no key port existed: that failed too, and its
// failure switched the ECHOCAT paddle off for the session.

/**
 * Whether a configured CW Key Port can key the paddle, so the CAT port's own
 * DTR route must not run and its failure must not switch the paddle off.
 * Only a Windows driver that rejected the pin ioctl cannot key: the pyserial
 * keyer is POSIX-only. A port that is still opening counts as able.
 * @param {object} o
 * @param {string} o.platform       process.platform
 * @param {string} [o.cwKeyPort]    settings.cwKeyPort
 * @param {boolean} [o.ioctlLatched] the key port's driver rejected TIOCMSET this session
 * @param {string} [o.pythonPath]   the port the pyserial keyer drives, if any
 */
function keyPortCanKey({ platform, cwKeyPort, ioctlLatched, pythonPath } = {}) {
  if (!cwKeyPort) return false;
  return !(platform === 'win32' && ioctlLatched && pythonPath === cwKeyPort);
}

/**
 * How long a CW text takes to key at wpm (PARIS timing: dit 1, dah 3, 1 unit
 * between elements, 3 between characters, 7 between words). Characters the
 * table does not know are skipped, as the keyer skips them.
 * @param {string} text
 * @param {number} wpm
 * @param {Object<string,string>} morse  letter -> '.-' pattern
 * @returns {number} milliseconds
 */
function morseTextMs(text, wpm, morse) {
  const w = Math.max(5, Math.min(60, Number(wpm) || 20));
  let units = 0;
  for (const ch of String(text || '').toUpperCase()) {
    if (ch === ' ') { units += 4; continue; }        // 3 already counted after the last character
    const pat = morse && morse[ch];
    if (!pat) continue;
    for (const sym of pat) units += (sym === '-' ? 3 : 1) + 1;
    units += 2;                                       // 1 + 2 = the 3-unit character gap
  }
  return Math.round(units * 1200 / w);
}

/**
 * The plain line for a keyer that found the key port busy. On Linux the
 * usual holder is ModemManager, which opens every new USB serial port for
 * about half a minute after it appears (a radio reconnect counts). Returns ''
 * when the error is not "busy" or the platform is not Linux.
 * @param {object} o
 * @param {string} o.platform
 * @param {string} o.stderr   the keyer's error output
 */
function keyPortBusyHint({ platform, stderr } = {}) {
  if (platform !== 'linux') return '';
  if (!/busy|errno 16/i.test(String(stderr || ''))) return '';
  return '[CW] The CW Key Port is busy. On Linux this is usually ModemManager, which opens a radio\'s USB ports ' +
    'for about half a minute each time they appear, including after the radio reconnects. If this computer ' +
    'uses no cellular modem, turn it off: sudo systemctl disable --now ModemManager';
}

module.exports = { keyPortCanKey, morseTextMs, keyPortBusyHint };
