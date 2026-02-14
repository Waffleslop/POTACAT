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

// Modes that count as CW/digital
const CW_DIGI_MODES = new Set(['CW', 'FT8', 'FT4', 'RTTY', 'DIGI', 'JS8', 'PSK31', 'PSK']);
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

module.exports = { isOutOfPrivilege };
