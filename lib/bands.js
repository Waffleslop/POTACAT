// Amateur radio band definitions: frequency ranges in MHz
const BANDS = {
  '160m': { lower: 1.800, upper: 2.000 },
  '80m':  { lower: 3.500, upper: 4.000 },
  '60m':  { lower: 5.330, upper: 5.410 },
  '40m':  { lower: 7.000, upper: 7.300 },
  '30m':  { lower: 10.100, upper: 10.150 },
  '20m':  { lower: 14.000, upper: 14.350 },
  '17m':  { lower: 18.068, upper: 18.168 },
  '15m':  { lower: 21.000, upper: 21.450 },
  '12m':  { lower: 24.890, upper: 24.990 },
  '10m':  { lower: 28.000, upper: 29.700 },
  '6m':   { lower: 50.000, upper: 54.000 },
  '2m':   { lower: 144.000, upper: 148.000 },
};

function freqToBand(freqMHz) {
  for (const [name, { lower, upper }] of Object.entries(BANDS)) {
    if (freqMHz >= lower && freqMHz <= upper) return name;
  }
  return null;
}

module.exports = { BANDS, freqToBand };
