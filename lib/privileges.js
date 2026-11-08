/**
 * License privilege data and the two checks built on it: the spot filter
 * (isOutOfPrivilege) and the key-down refusal (txPrivilegeRefusal).
 *
 * Dual-mode, like lib/spot-row.js: require() in main and the tests,
 * window.Privileges in the renderer (index.html for the spot filter, and the
 * bandspread pop-out for its overlay). This file is the ONLY copy of the
 * tables: renderer/app.js and renderer/bandspread-popout.js used to carry
 * their own, held equal by a test, so every new class meant three edits
 * (GitHub #250 step 1). Nothing here may be declared at column 0: every
 * classic script on a page shares one top-level scope
 * (test/page-script-globals-test.js).
 *
 * Each class is { label, country, ranges, verified, source }.
 *   ranges:   [lowerKhz, upperKhz, modes]. modes: 'all' = any mode,
 *             'cw_digi' = CW/digital, 'cw' = CW only, 'phone' = SSB/FM/AM.
 *   verified: true once the table has been checked against the regulator's
 *             own text. An UNVERIFIED class still filters spots and draws its
 *             bands, but txPrivilegeRefusal never refuses a key-down for it:
 *             a wrong range must never stop a legal transmission (Casey,
 *             2026-11-08: new classes are filter-only until verified).
 *   source:   the regulator document and section the ranges come from.
 *
 * VHF and up are here as well as HF: the tables used to end at 6 m, so once
 * the key-down check (txPrivilegeRefusal, 2026-11-01) used them, every 2 m
 * and 70 cm transmission read as outside every licence (FT8 on 144.174 was
 * refused for an Extra).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Privileges = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 60 m: the five channels (dial = suppressed carrier, 2.8 kHz wide) and the
  // 5351.5-5366.5 kHz band. General and up.
  const US_60M = [
    [5330.5, 5333.5, 'all'], [5346.5, 5349.5, 'all'], [5351.5, 5366.5, 'all'],
    [5371.5, 5374.5, 'all'], [5403.5, 5406.5, 'all'],
  ];
  // 6 m and up: the same for Technician, General, Advanced and Extra.
  const US_VHF_UP = [
    [50000, 50100, 'cw'], [50100, 54000, 'all'],
    [144000, 144100, 'cw'], [144100, 148000, 'all'],
    [222000, 225000, 'all'], [420000, 450000, 'all'],
    [902000, 928000, 'all'], [1240000, 1300000, 'all'],
  ];
  // 30, 17, 12 and 10 m are the same for General, Advanced and Extra.
  const US_WARC_10M = [
    [10100, 10150, 'cw_digi'],
    [18068, 18110, 'cw_digi'], [18110, 18168, 'phone'],
    [24890, 24930, 'cw_digi'], [24930, 24990, 'phone'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'],
  ];

  const US_EXTRA = [
    [1800, 2000, 'all'],
    [3500, 3600, 'cw_digi'], [3600, 4000, 'phone'],
    ...US_60M,
    [7000, 7125, 'cw_digi'], [7125, 7300, 'phone'],
    [14000, 14150, 'cw_digi'], [14150, 14350, 'phone'],
    [21000, 21200, 'cw_digi'], [21200, 21450, 'phone'],
    ...US_WARC_10M,
    ...US_VHF_UP,
  ];

  const US_ADVANCED = [
    [1800, 2000, 'all'],
    [3525, 3600, 'cw_digi'], [3700, 4000, 'phone'],
    ...US_60M,
    [7025, 7125, 'cw_digi'], [7125, 7300, 'phone'],
    [14025, 14150, 'cw_digi'], [14175, 14350, 'phone'],
    [21025, 21200, 'cw_digi'], [21225, 21450, 'phone'],
    ...US_WARC_10M,
    ...US_VHF_UP,
  ];

  const US_GENERAL = [
    [1800, 2000, 'all'],
    [3525, 3600, 'cw_digi'], [3800, 4000, 'phone'],
    ...US_60M,
    [7025, 7125, 'cw_digi'], [7175, 7300, 'phone'],
    [14025, 14150, 'cw_digi'], [14225, 14350, 'phone'],
    [21025, 21200, 'cw_digi'], [21275, 21450, 'phone'],
    ...US_WARC_10M,
    ...US_VHF_UP,
  ];

  // Technician: CW only on 80, 40 and 15 m; CW/data and phone on 10 m.
  const US_TECHNICIAN = [
    [3525, 3600, 'cw'], [7025, 7125, 'cw'], [21025, 21200, 'cw'],
    [28000, 28300, 'cw_digi'], [28300, 28500, 'phone'],
    ...US_VHF_UP,
  ];

  // Canada: 6 m and up for every class (70 cm is 430-450 there).
  const CA_VHF_UP = [
    [50000, 54000, 'all'], [144000, 148000, 'all'], [222000, 225000, 'all'],
    [430000, 450000, 'all'], [902000, 928000, 'all'], [1240000, 1300000, 'all'],
  ];

  const CA_BASIC = [
    // No HF privileges — above 30 MHz only
    ...CA_VHF_UP,
  ];

  const CA_HONOURS = [
    // Full HF access, no sub-band restrictions
    [1800, 2000, 'all'],
    [3500, 4000, 'all'],
    ...US_60M,
    [7000, 7300, 'all'],
    [10100, 10150, 'all'],
    [14000, 14350, 'all'],
    [18068, 18168, 'all'],
    [21000, 21450, 'all'],
    [24890, 24990, 'all'],
    [28000, 29700, 'all'],
    ...CA_VHF_UP,
  ];

  const FCC = 'FCC Part 97.301/97.305';
  const ISED = 'ISED RBR-4';

  // Every licence class POTACAT knows. Keys are the values the License Class
  // selects store (Settings > Station, Welcome).
  const CLASSES = {
    us_extra: { label: 'US Extra', country: 'US', ranges: US_EXTRA, verified: true, source: FCC },
    us_advanced: { label: 'US Advanced', country: 'US', ranges: US_ADVANCED, verified: true, source: FCC },
    us_general: { label: 'US General', country: 'US', ranges: US_GENERAL, verified: true, source: FCC },
    us_technician: { label: 'US Technician', country: 'US', ranges: US_TECHNICIAN, verified: true, source: FCC },
    ca_basic: { label: 'CA Basic', country: 'CA', ranges: CA_BASIC, verified: true, source: ISED },
    ca_honours: { label: 'CA Advanced / Basic with Honours', country: 'CA', ranges: CA_HONOURS, verified: true, source: ISED },
  };

  // class -> ranges, and class -> the name Settings > Station > License Class
  // shows. Derived from CLASSES so there is one place to add a class.
  const PRIVILEGE_MAP = {};
  const CLASS_LABELS = {};
  for (const k of Object.keys(CLASSES)) {
    PRIVILEGE_MAP[k] = CLASSES[k].ranges;
    CLASS_LABELS[k] = CLASSES[k].label;
  }

  // Modes that count as CW/digital. Includes both spot-style names
  // (FT8, RTTY) and rig-CAT data-mode names (DIGU/DIGL, PKTUSB/PKTLSB,
  // FSK) — tuneRadio() passes the CAT mode to the Guest Pass
  // interceptor, and an unrecognized mode in a cw_digi-only segment
  // reads as out-of-privilege. That blocked ECHOCAT's FT8 Start QSY
  // (jtcat-set-band tunes with 'DIGU') for pass guests (2026-06-10).
  const CW_DIGI_MODES = new Set([
    'CW', 'CW-R', 'FT8', 'FT4', 'FT2', 'RTTY', 'RTTY-R', 'DIGI', 'JS8',
    'PSK31', 'PSK',
    'DIGU', 'DIGL', 'PKTUSB', 'PKTLSB', 'DATA', 'DATA-U', 'DATA-L', 'FSK', 'FSK-R',
    // Icom and Kenwood data-mode names (USB-D, USB-D1..3) and Yaesu PKT-U/L: an
    // Icom FT8 key-down reported USB-D, which read as an unknown mode.
    'USB-D', 'LSB-D', 'USB-D1', 'USB-D2', 'USB-D3', 'LSB-D1', 'LSB-D2', 'LSB-D3',
    'PKT-U', 'PKT-L', 'JTTY', 'MFSK', 'WSPR', 'OLIVIA', 'VARA', 'ARDOP', 'PACKET',
  ]);
  // Modes that count as phone
  const PHONE_MODES = new Set(['SSB', 'USB', 'LSB', 'FM', 'AM']);

  /** True when the class's table has been checked against the regulator's text. */
  function isVerified(licenseClass) {
    const c = Object.prototype.hasOwnProperty.call(CLASSES, licenseClass) ? CLASSES[licenseClass] : null;
    return !!(c && c.verified === true);
  }

  /**
   * Returns true if the frequency+mode is NOT allowed for the given license class.
   * Applies to every class with a table, verified or not (the spot filter).
   * @param {number} freqKhz - frequency in kHz
   * @param {string} mode - spot mode (CW, SSB, FT8, etc.)
   * @param {string} licenseClass - a CLASSES key, or 'none'
   */
  function isOutOfPrivilege(freqKhz, mode, licenseClass) {
    if (!licenseClass || licenseClass === 'none') return false;

    const ranges = PRIVILEGE_MAP[licenseClass];
    if (!ranges) return false;

    // Unknown/empty mode — don't flag
    if (!mode) return false;

    const modeUpper = mode.toUpperCase();

    for (const [lower, upper, allowed] of ranges) {
      if (freqKhz >= lower && freqKhz <= upper) {
        if (allowed === 'all') return false;
        if (allowed === 'cw' && (modeUpper === 'CW' || modeUpper === 'CW-R')) return false;
        if (allowed === 'cw_digi' && CW_DIGI_MODES.has(modeUpper)) return false;
        if (allowed === 'phone' && PHONE_MODES.has(modeUpper)) return false;
      }
    }

    // Frequency not in any allowed range for this class+mode
    return true;
  }

  /**
   * What a transmission IS, for the privilege table: 'CW', 'DATA' or 'PHONE',
   * or null when the mode is not one we can classify (never refused on a guess).
   * SSTV and other image modes go where phone goes (US Part 97.305).
   */
  function emissionOf(mode) {
    const m = String(mode || '').toUpperCase().trim();
    if (!m) return null;
    if (m === 'CW' || m === 'CW-R' || m === 'CW-L' || m === 'CW-U') return 'CW';
    if (m === 'SSTV' || m === 'IMAGE' || m === 'FAX') return 'PHONE';
    if (PHONE_MODES.has(m)) return 'PHONE';
    if (CW_DIGI_MODES.has(m) || /^(DIG|PKT|DATA)/.test(m) || /-D\d?$/.test(m)) return 'DATA';
    return null;
  }

  /**
   * The operator's OWN licence, at the moment of key-down (K3SBP 2026-11-01: a
   * Technician's FT8 went out on 10 m above 28.300 MHz; the class in Settings
   * filtered spots but never stopped a transmission). Returns null when the
   * transmission is allowed or cannot be judged (no class, unknown frequency or
   * mode, a class with no table, a class not yet verified), else the sentence
   * to show the operator. Listening is never refused; only transmitting.
   */
  function txPrivilegeRefusal({ freqHz, mode, licenseClass }) {
    const cls = licenseClass || 'none';
    if (cls === 'none' || !PRIVILEGE_MAP[cls]) return null;
    // Unverified: filter-only. Never refuse a key-down on an unchecked table.
    if (!isVerified(cls)) return null;
    const khz = Number(freqHz) / 1000;
    if (!Number.isFinite(khz) || khz <= 0) return null;
    const emission = emissionOf(mode);
    if (!emission) return null;
    const probe = emission === 'PHONE' ? 'USB' : emission === 'CW' ? 'CW' : 'FT8';
    if (!isOutOfPrivilege(khz, probe, cls)) return null;
    const what = emission === 'PHONE' ? 'phone' : emission === 'CW' ? 'CW' : 'data';
    return `${(khz / 1000).toFixed(3)} MHz ${what} is outside ${CLASS_LABELS[cls] || cls} privileges. ` +
      `Not transmitted. Tune inside your privileges, or check Settings > Station > License Class.`;
  }

  return { isOutOfPrivilege, PRIVILEGE_MAP, CW_DIGI_MODES, PHONE_MODES, CLASS_LABELS, CLASSES, isVerified, emissionOf, txPrivilegeRefusal };
});
