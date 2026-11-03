// Amateur radio band definitions: frequency ranges in MHz
const BANDS = {
  // LF/MF (2026-10-24, with the microwave bands below: every band a logged
  // frequency can land in now has a name, potacat-app logFreq.ts agrees).
  '2200m': { lower: 0.1357, upper: 0.1378 },
  '630m': { lower: 0.472, upper: 0.479 },
  '160m': { lower: 1.800, upper: 2.000 },
  '80m':  { lower: 3.500, upper: 4.000 },
  // 60m lower bound covers the international WSPR dial at 5.2872 MHz
  // (5.2887 TX) — the US channels sit at 5.330–5.4035, but freqToBand must
  // classify the WSJT-X-standard WSPR 60m dial as 60m, not null.
  '60m':  { lower: 5.250, upper: 5.410 },
  '40m':  { lower: 7.000, upper: 7.300 },
  '30m':  { lower: 10.100, upper: 10.150 },
  '20m':  { lower: 14.000, upper: 14.350 },
  '17m':  { lower: 18.068, upper: 18.168 },
  '15m':  { lower: 21.000, upper: 21.450 },
  '12m':  { lower: 24.890, upper: 24.990 },
  '10m':  { lower: 28.000, upper: 29.700 },
  '6m':   { lower: 50.000, upper: 54.000 },
  '4m':   { lower: 70.000, upper: 70.500 },
  '2m':   { lower: 144.000, upper: 148.000 },
  '70cm': { lower: 420.000, upper: 450.000 },
  // IC-9700 and friends (2026-10-20): 23cm was unknown to every table, so a
  // 1296 MHz QSO logged with NO BAND. 1.25m and 33cm are the other US bands.
  '1.25m': { lower: 222.000, upper: 225.000 },
  '33cm': { lower: 902.000, upper: 928.000 },
  '23cm': { lower: 1240.000, upper: 1300.000 },
  // Microwave, IARU (widest of the regions) — the same edges as the app's
  // logFreq.ts and lib/log-freq.js.
  '13cm': { lower: 2300.000, upper: 2450.000 },
  '9cm': { lower: 3300.000, upper: 3500.000 },
  '6cm': { lower: 5650.000, upper: 5925.000 },
  '3cm': { lower: 10000.000, upper: 10500.000 },
  '1.25cm': { lower: 24000.000, upper: 24250.000 },
};

function freqToBand(freqMHz) {
  for (const [name, { lower, upper }] of Object.entries(BANDS)) {
    if (freqMHz >= lower && freqMHz <= upper) return name;
  }
  return null;
}

module.exports = { BANDS, freqToBand };
