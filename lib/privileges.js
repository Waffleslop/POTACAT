// License privilege data for US (FCC Part 97) and Canadian (ISED RBR-4) classes
// Each entry: [lowerKhz, upperKhz, modes]
// modes: 'all' = any mode, 'cw_digi' = CW/digital, 'phone' = SSB/FM/AM

const US_EXTRA = [
  [1800, 2000, 'all'],
  [3500, 3600, 'cw_digi'],
  [3600, 4000, 'phone'],
  [7000, 7125, 'cw_digi'],
  [7125, 7300, 'phone'],
  [10100, 10150, 'all'],
  [14000, 14150, 'cw_digi'],
  [14150, 14350, 'phone'],
  [18068, 18168, 'all'],
  [21000, 21200, 'cw_digi'],
  [21200, 21450, 'phone'],
  [24890, 24990, 'all'],
  [28000, 28300, 'cw_digi'],
  [28300, 29700, 'phone'],
  [50000, 54000, 'all'],
];

const US_GENERAL = [
  [1800, 2000, 'all'],
  [3525, 3600, 'cw_digi'],
  [3800, 4000, 'phone'],
  [7025, 7125, 'cw_digi'],
  [7175, 7300, 'phone'],
  [10100, 10150, 'all'],
  [14025, 14150, 'cw_digi'],
  [14225, 14350, 'phone'],
  [18068, 18168, 'all'],
  [21025, 21200, 'cw_digi'],
  [21275, 21450, 'phone'],
  [24890, 24990, 'all'],
  [28000, 28300, 'cw_digi'],
  [28300, 29700, 'phone'],
  [50000, 54000, 'all'],
];

const US_TECHNICIAN = [
  [3525, 3600, 'cw_digi'],
  [7025, 7125, 'cw_digi'],
  [21025, 21200, 'cw_digi'],
  [28000, 28300, 'cw_digi'],
  [28300, 28500, 'phone'],
  [50000, 54000, 'all'],
];

const CA_BASIC = [
  // No HF privileges — above 30 MHz only
  [50000, 54000, 'all'],
];

const CA_HONOURS = [
  // Full HF access, no sub-band restrictions
  [1800, 2000, 'all'],
  [3500, 4000, 'all'],
  [7000, 7300, 'all'],
  [10100, 10150, 'all'],
  [14000, 14350, 'all'],
  [18068, 18168, 'all'],
  [21000, 21450, 'all'],
  [24890, 24990, 'all'],
  [28000, 29700, 'all'],
  [50000, 54000, 'all'],
];

const PRIVILEGE_MAP = {
  us_extra: US_EXTRA,
  us_general: US_GENERAL,
  us_technician: US_TECHNICIAN,
  ca_basic: CA_BASIC,
  ca_honours: CA_HONOURS,
};

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

/**
 * Returns true if the frequency+mode is NOT allowed for the given license class.
 * @param {number} freqKhz - frequency in kHz
 * @param {string} mode - spot mode (CW, SSB, FT8, etc.)
 * @param {string} licenseClass - one of: none, us_extra, us_general, us_technician, ca_basic, ca_honours
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
      if (allowed === 'cw_digi' && CW_DIGI_MODES.has(modeUpper)) return false;
      if (allowed === 'phone' && PHONE_MODES.has(modeUpper)) return false;
    }
  }

  // Frequency not in any allowed range for this class+mode
  return true;
}

// The names Settings > Station > License Class shows.
const CLASS_LABELS = {
  us_extra: 'US Extra', us_general: 'US General', us_technician: 'US Technician',
  ca_basic: 'CA Basic', ca_honours: 'CA Advanced / Basic with Honours',
};

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
 * mode, a class with no table), else the sentence to show the operator.
 * Listening is never refused; only transmitting.
 */
function txPrivilegeRefusal({ freqHz, mode, licenseClass }) {
  const cls = licenseClass || 'none';
  if (cls === 'none' || !PRIVILEGE_MAP[cls]) return null;
  const khz = Number(freqHz) / 1000;
  if (!Number.isFinite(khz) || khz <= 0) return null;
  const emission = emissionOf(mode);
  if (!emission) return null;
  const probe = emission === 'PHONE' ? 'USB' : 'CW';
  if (!isOutOfPrivilege(khz, probe, cls)) return null;
  const what = emission === 'PHONE' ? 'phone' : emission === 'CW' ? 'CW' : 'data';
  return `${(khz / 1000).toFixed(3)} MHz ${what} is outside ${CLASS_LABELS[cls] || cls} privileges. ` +
    `Not transmitted. Tune inside your privileges, or check Settings > Station > License Class.`;
}

module.exports = { isOutOfPrivilege, PRIVILEGE_MAP, CW_DIGI_MODES, PHONE_MODES, CLASS_LABELS, emissionOf, txPrivilegeRefusal };
