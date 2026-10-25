'use strict';
/**
 * Read a logged contact's frequency, whatever unit it was typed in.
 *
 * The log box is labelled kHz, but people type MHz ("14.285"), kHz
 * ("14285"), a decimal comma ("14,285") or a stray Hz value. NA4DQ
 * (2026-10-24) typed MHz on the phone for a 100-QSO activation: every record
 * was saved with FREQ 0.014285 MHz and no BAND, POTA.app refused the file and
 * MacLoggerDX imported 100 contacts at 14 kHz.
 *
 * The rule, the SAME as the app's src/utils/logFreq.ts (potacat-app 5e2431c + d505524;
 * cases from its __tests__/logFreq.test.ts are in test/log-freq-test.js):
 * below 1000 is MHz, except the two LF/MF windows, which are kHz; 1000 and up
 * is kHz, else MHz (23 cm and up), else Hz. A value that lands in no amateur band is refused. The band
 * table is the app's (bands.ts + its extra windows), not lib/bands.js, so the
 * phone and the desktop agree to the Hz.
 */

// potacat-app src/utils/bands.ts, verbatim (Hz).
const BANDS_HZ = [
  ['160m', 1_800_000, 2_000_000],
  ['80m', 3_500_000, 4_000_000],
  ['60m', 5_330_000, 5_410_000],
  ['40m', 7_000_000, 7_300_000],
  ['30m', 10_100_000, 10_150_000],
  ['20m', 14_000_000, 14_350_000],
  ['17m', 18_068_000, 18_168_000],
  ['15m', 21_000_000, 21_450_000],
  ['12m', 24_890_000, 24_990_000],
  ['10m', 28_000_000, 29_700_000],
  ['6m', 50_000_000, 54_000_000],
  ['4m', 70_000_000, 70_500_000],
  ['2m', 144_000_000, 148_000_000],
  ['1.25m', 222_000_000, 225_000_000],
  ['70cm', 420_000_000, 450_000_000],
  ['33cm', 902_000_000, 928_000_000],
  ['23cm', 1_240_000_000, 1_300_000_000],
];
// potacat-app src/utils/logFreq.ts EXTRA_BANDS (kHz).
const EXTRA_BANDS = [
  ['2200m', 135.7, 137.8],
  ['630m', 472, 479],
  ['60m', 5250, 5450],
  ['4m', 69_900, 70_500],
  // Microwave (IARU allocations, widest of the regions), potacat-app d505524.
  ['13cm', 2_300_000, 2_450_000],
  ['9cm', 3_300_000, 3_500_000],
  ['6cm', 5_650_000, 5_925_000],
  ['3cm', 10_000_000, 10_500_000],
  ['1.25cm', 24_000_000, 24_250_000],
];

/** The amateur band for a frequency in kHz, or null. */
function hamBandOfKhz(khz) {
  if (!Number.isFinite(khz) || khz <= 0) return null;
  const hz = Math.round(khz * 1000);
  for (const [code, lo, hi] of BANDS_HZ) if (hz >= lo && hz <= hi) return code;
  for (const [code, lo, hi] of EXTRA_BANDS) if (khz >= lo && khz <= hi) return code;
  return null;
}

function toNumber(raw) {
  let t = String(raw).trim().replace(/\s+/g, '').replace(/(k|m)?hz$/i, '');
  if (!t) return null;
  // "14,285.5": the comma groups thousands. "14,285" / "14285,5": it is the decimal mark.
  if (t.includes(',') && t.includes('.')) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @returns {{kind:'empty'} | {kind:'ok', khz:number, band:string, text:string} | {kind:'bad'}}
 */
function parseLogFreq(raw) {
  if (raw == null || !String(raw).trim()) return { kind: 'empty' };
  const n = toNumber(raw);
  if (n == null) return { kind: 'bad' };
  // Under 1000: kHz (the LF/MF windows), then MHz. 1000 and up: kHz first
  // (3500 is 80 m, 10120 is 30 m), then MHz for 23 cm and up ("1296.1",
  // "10368.1"), then Hz.
  const candidates = n < 1000 ? [n, n * 1000] : [n, n * 1000, n / 1000];
  for (const khz of candidates) {
    const band = hamBandOfKhz(khz);
    if (band) {
      const rounded = Math.round(khz * 1000) / 1000;
      return { kind: 'ok', khz: rounded, band, text: String(rounded) };
    }
  }
  return { kind: 'bad' };
}

/**
 * A saved record's FREQ (MHz, ADIF) that is really kHz/1000 mistaken for MHz
 * — the NA4DQ records: FREQ under 1 MHz, outside the 2200 m and 630 m
 * windows, no BAND, and FREQ × 1000 lands in a band. Returns the repaired
 * {freqMhz, band} or null when the record is fine or cannot be read safely.
 */
function repairMhzTypedAsKhz(rec) {
  if (!rec || String(rec.BAND || '').trim()) return null;
  const f = Number(String(rec.FREQ || '').trim());
  if (!Number.isFinite(f) || f <= 0 || f >= 1) return null;
  if ((f >= 0.1357 && f <= 0.1378) || (f >= 0.472 && f <= 0.479)) return null; // real LF/MF
  const khz = f * 1000 * 1000; // the MHz the operator meant, in kHz
  const band = hamBandOfKhz(khz);
  if (!band) return null;
  return { freqMhz: String(Math.round(f * 1000 * 1e6) / 1e6), band };
}

module.exports = { hamBandOfKhz, parseLogFreq, repairMhzTypedAsKhz };
