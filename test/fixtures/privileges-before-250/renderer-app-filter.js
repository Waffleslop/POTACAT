// FROZEN ORACLE, do not edit: the spot filter's own copy in renderer/app.js on
// master at 804095e1 (lines 11892-11968), before #250 step 1 deleted it.
// test/privileges-no-change-test.js compares the shared module against it.
'use strict';
// --- License privilege check (duplicated from lib/privileges.js — no require in renderer) ---
const PRIVILEGE_RANGES = {
  us_extra: [
    [1800, 2000, 'all'], [3500, 3600, 'cw_digi'], [3600, 4000, 'phone'], [5330.5, 5333.5, 'all'],
    [5346.5, 5349.5, 'all'], [5351.5, 5366.5, 'all'], [5371.5, 5374.5, 'all'], [5403.5, 5406.5, 'all'],
    [7000, 7125, 'cw_digi'], [7125, 7300, 'phone'], [14000, 14150, 'cw_digi'], [14150, 14350, 'phone'],
    [21000, 21200, 'cw_digi'], [21200, 21450, 'phone'], [10100, 10150, 'cw_digi'], [18068, 18110, 'cw_digi'],
    [18110, 18168, 'phone'], [24890, 24930, 'cw_digi'], [24930, 24990, 'phone'], [28000, 28300, 'cw_digi'],
    [28300, 29700, 'phone'], [50000, 50100, 'cw'], [50100, 54000, 'all'], [144000, 144100, 'cw'],
    [144100, 148000, 'all'], [222000, 225000, 'all'], [420000, 450000, 'all'], [902000, 928000, 'all'],
    [1240000, 1300000, 'all'],
  ],
  us_advanced: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3700, 4000, 'phone'], [5330.5, 5333.5, 'all'],
    [5346.5, 5349.5, 'all'], [5351.5, 5366.5, 'all'], [5371.5, 5374.5, 'all'], [5403.5, 5406.5, 'all'],
    [7025, 7125, 'cw_digi'], [7125, 7300, 'phone'], [14025, 14150, 'cw_digi'], [14175, 14350, 'phone'],
    [21025, 21200, 'cw_digi'], [21225, 21450, 'phone'], [10100, 10150, 'cw_digi'], [18068, 18110, 'cw_digi'],
    [18110, 18168, 'phone'], [24890, 24930, 'cw_digi'], [24930, 24990, 'phone'], [28000, 28300, 'cw_digi'],
    [28300, 29700, 'phone'], [50000, 50100, 'cw'], [50100, 54000, 'all'], [144000, 144100, 'cw'],
    [144100, 148000, 'all'], [222000, 225000, 'all'], [420000, 450000, 'all'], [902000, 928000, 'all'],
    [1240000, 1300000, 'all'],
  ],
  us_general: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3800, 4000, 'phone'], [5330.5, 5333.5, 'all'],
    [5346.5, 5349.5, 'all'], [5351.5, 5366.5, 'all'], [5371.5, 5374.5, 'all'], [5403.5, 5406.5, 'all'],
    [7025, 7125, 'cw_digi'], [7175, 7300, 'phone'], [14025, 14150, 'cw_digi'], [14225, 14350, 'phone'],
    [21025, 21200, 'cw_digi'], [21275, 21450, 'phone'], [10100, 10150, 'cw_digi'], [18068, 18110, 'cw_digi'],
    [18110, 18168, 'phone'], [24890, 24930, 'cw_digi'], [24930, 24990, 'phone'], [28000, 28300, 'cw_digi'],
    [28300, 29700, 'phone'], [50000, 50100, 'cw'], [50100, 54000, 'all'], [144000, 144100, 'cw'],
    [144100, 148000, 'all'], [222000, 225000, 'all'], [420000, 450000, 'all'], [902000, 928000, 'all'],
    [1240000, 1300000, 'all'],
  ],
  us_technician: [
    [3525, 3600, 'cw'], [7025, 7125, 'cw'], [21025, 21200, 'cw'], [28000, 28300, 'cw_digi'],
    [28300, 28500, 'phone'], [50000, 50100, 'cw'], [50100, 54000, 'all'], [144000, 144100, 'cw'],
    [144100, 148000, 'all'], [222000, 225000, 'all'], [420000, 450000, 'all'], [902000, 928000, 'all'],
    [1240000, 1300000, 'all'],
  ],
  ca_basic: [
    [50000, 54000, 'all'], [144000, 148000, 'all'], [222000, 225000, 'all'], [430000, 450000, 'all'],
    [902000, 928000, 'all'], [1240000, 1300000, 'all'],
  ],
  ca_honours: [
    [1800, 2000, 'all'], [3500, 4000, 'all'], [5330.5, 5333.5, 'all'], [5346.5, 5349.5, 'all'],
    [5351.5, 5366.5, 'all'], [5371.5, 5374.5, 'all'], [5403.5, 5406.5, 'all'], [7000, 7300, 'all'],
    [10100, 10150, 'all'], [14000, 14350, 'all'], [18068, 18168, 'all'], [21000, 21450, 'all'],
    [24890, 24990, 'all'], [28000, 29700, 'all'], [50000, 54000, 'all'], [144000, 148000, 'all'],
    [222000, 225000, 'all'], [430000, 450000, 'all'], [902000, 928000, 'all'], [1240000, 1300000, 'all'],
  ],
};

const CW_DIGI_MODES = new Set(['CW', 'FT8', 'FT4', 'FT2', 'RTTY', 'DIGI', 'JS8', 'PSK31', 'PSK']);
const PHONE_MODES = new Set(['SSB', 'USB', 'LSB', 'FM', 'AM']);

function isOutOfPrivilege(freqKhz, mode, cls) {
  if (!cls || cls === 'none') return false;
  const ranges = PRIVILEGE_RANGES[cls];
  if (!ranges) return false;
  if (!mode) return false;
  const modeUpper = mode.toUpperCase();
  for (const [lower, upper, allowed] of ranges) {
    if (freqKhz >= lower && freqKhz <= upper) {
      if (allowed === 'all') return false;
      if (allowed === 'cw' && modeUpper === 'CW') return false;
      if (allowed === 'cw_digi' && CW_DIGI_MODES.has(modeUpper)) return false;
      if (allowed === 'phone' && PHONE_MODES.has(modeUpper)) return false;
    }
  }
  return true;
}
module.exports = { PRIVILEGE_RANGES, CW_DIGI_MODES, PHONE_MODES, isOutOfPrivilege };
