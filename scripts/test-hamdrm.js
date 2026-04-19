'use strict';
// ---------------------------------------------------------------------------
// Regression harness for the HamDRM (EasyPal-compatible) encoder pipeline.
//
// Covers:
//   - CRC-8 / CRC-16 canaries (week 1)
//   - FAC bit packing (week 1)
//   - MOT segmenter (week 1)
//   - Conv encoder invariants (week 1)
//   - Puncturing: FAC → 90 bits, MSC → 2*iN_mux bits (week 2)
//   - Block/bit/symbol interleaver permutations (week 2)
//   - Cell mapping: FAC/pilot counts + iNumUsefMSCCellsPerFrame (week 2)
//   - End-to-end: fake JPEG → MOT → FAC/MSC encode → superframe grid (week 2)
//
// Canaries suffixed GROUND_TRUTH_TODO are locked to our port, not to a QSSTV
// dump; they protect against accidental drift but don't yet prove EasyPal
// interop. Replacing them with real vectors is the week-3 gate.
// ---------------------------------------------------------------------------

const { crc8FAC, crc16Mot } = require('../lib/hamdrm/hamdrm-crc');
const { buildFACBlock } = require('../lib/hamdrm/hamdrm-fac');
const {
  motEncode, transportIdFromFilename, buildDataGroupFromScheduleEntry,
} = require('../lib/hamdrm/hamdrm-mot');
const {
  convEncode, convEncodePunctured, FAC_PUNC_PARAMS, mscPuncParams,
} = require('../lib/hamdrm/hamdrm-mlc');
const {
  makeBlockInterleaverTable, BitInterleaver, SymbolInterleaver,
} = require('../lib/hamdrm/hamdrm-interleavers');
const {
  buildCellMappingModeA_SO1,
  _IsFAC, _IsMSC, _IsPilot, _IsBoosPil,
} = require('../lib/hamdrm/hamdrm-cells');
const {
  encodeFacCells, encodeMscCells, assembleSuperframe,
} = require('../lib/hamdrm/hamdrm-frame');

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function assertEq(label, got, want) {
  const ok = (got === want)
    || (got != null && want != null && got.length === want.length && got.every((x, i) => x === want[i]));
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`      got:  ${typeof got === 'number' ? '0x' + got.toString(16) : (got && got.length != null ? hex(got) : got)}`);
    console.log(`      want: ${typeof want === 'number' ? '0x' + want.toString(16) : (want && want.length != null ? hex(want) : want)}`);
  }
  return ok ? 0 : 1;
}

function crcSuites() {
  let fails = 0;
  console.log('\n-- CRC canaries --');
  fails += assertEq('crc8 empty',             crc8FAC(new Uint8Array(0)), 0x00);
  fails += assertEq('crc8 [0x00]',            crc8FAC(new Uint8Array([0x00])), 0x3b);
  fails += assertEq('crc16 "123456789"+0000', crc16Mot(new Uint8Array([0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x00,0x00])), 0x168b);
  return fails;
}

function facSuites() {
  let fails = 0;
  console.log('\n-- FAC bit packing --');
  const b0 = buildFACBlock({ frameIdx: 0, label: 'K3SBP' });
  fails += assertEq('FAC frame 0 length',  b0.length, 6);
  fails += assertEq('FAC frame 0 bytes',   b0, new Uint8Array([0xfa, 0x65, 0xb3, 0xa6, 0x00, 0x40]));
  const b1 = buildFACBlock({ frameIdx: 1, label: 'K3SBP' });
  fails += assertEq('FAC frame 1 bytes',   b1, new Uint8Array([0x7a, 0x61, 0x50, 0x00, 0x00, 0x38]));
  const b2 = buildFACBlock({ frameIdx: 2, label: 'K3SBP' });
  fails += assertEq('FAC frame 2 bytes',   b2, new Uint8Array([0xba, 0x40, 0x00, 0x00, 0x00, 0x2b]));
  return fails;
}

function motSuites() {
  let fails = 0;
  console.log('\n-- MOT segmenter --');
  fails += assertEq('transportId("test.jpg")', transportIdFromFilename('test.jpg'), 0x2f45);
  const fake = new Uint8Array(256);
  for (let i = 0; i < fake.length; i++) fake[i] = (i * 7 + 13) & 0xFF;
  const mot = motEncode({ filename: 'test.jpg', bodyBytes: fake, format: 'jpg', bytesAvailable: 150 });
  fails += assertEq('MOT header segments',  mot.headerSegments.length, 1);
  fails += assertEq('MOT body segments',    mot.bodySegments.length,   2);
  fails += assertEq('Schedule starts with header', mot.scheduleList[0] < 0, true);
  const dg = buildDataGroupFromScheduleEntry(mot.scheduleList[0], mot, { header: 0, body: 0 });
  const crcNonZero = dg[dg.length - 2] !== 0 || dg[dg.length - 1] !== 0;
  fails += assertEq('First data group has non-zero CRC', crcNonZero, true);
  return fails;
}

function mlcSuites() {
  let fails = 0;
  console.log('\n-- Conv encoder + puncturing --');
  const zeros = convEncode(new Uint8Array(32));
  fails += assertEq('zero-in → zero-out',
    zeros.every(b => b.every(x => x === 0)), true);

  // FAC: 48 input bits → exactly 90 channel bits (45 cells × 2 bits).
  const facIn = new Uint8Array(48);
  for (let i = 0; i < 48; i++) facIn[i] = (i * 31 + 7) & 1;
  const facOut = convEncodePunctured(facIn, FAC_PUNC_PARAMS);
  fails += assertEq('FAC produces 90 bits',  facOut.length, 90);

  // MSC iN_mux=740 (Mode A SO_1 actual) → 2*740 = 1480 bits.
  const mscParams = mscPuncParams(740);
  const mscIn = new Uint8Array(mscParams.iNumInBitsPartB);
  for (let i = 0; i < mscIn.length; i++) mscIn[i] = (i * 31 + 7) & 1;
  const mscOut = convEncodePunctured(mscIn, mscParams);
  fails += assertEq('MSC(740) produces 1480 bits', mscOut.length, 1480);
  return fails;
}

function interleaverSuites() {
  let fails = 0;
  console.log('\n-- Interleavers --');
  const t = makeBlockInterleaverTable(90, 21);
  const seen = new Set();
  for (let i = 0; i < 90; i++) seen.add(t[i]);
  fails += assertEq('block table (N=90, t_0=21) is bijection', seen.size, 90);

  const bi = new BitInterleaver(0, 1480, 21);
  const buf = new Uint8Array(1480);
  for (let i = 0; i < 1480; i++) buf[i] = i & 1;
  const orig = new Uint8Array(buf);
  bi.interleave(buf);
  const changed = buf.some((v, i) => v !== orig[i]);
  fails += assertEq('bit interleaver permutes 1480-bit buf', changed, true);

  const si = new SymbolInterleaver(740, 'short');
  const cells = Array.from({ length: 740 }, (_, i) => ({ re: i, im: 0 }));
  const out = si.processFrame(cells);
  const outIdx = new Set(out.map(c => c.re));
  fails += assertEq('symbol interleaver produces 740 unique cells', outIdx.size, 740);
  return fails;
}

function cellMapSuites() {
  let fails = 0;
  console.log('\n-- Cell mapping --');
  const t = buildCellMappingModeA_SO1();
  fails += assertEq('nSymSuperframe',              t.nSymSuperframe, 45);
  fails += assertEq('nCarriers',                   t.nCarriers, 57);
  fails += assertEq('iNumUsefMSCCellsPerFrame',    t.iNumUsefMSCCellsPerFrame, 740);
  let facCount = 0, tiCount = 0;
  for (let s = 0; s < t.nSymSuperframe; s++) {
    for (let c = 0; c < t.nCarriers; c++) {
      if (_IsFAC(t.map[s][c])) facCount++;
    }
  }
  fails += assertEq('FAC cells per superframe',    facCount, 135);
  return fails;
}

function endToEndSuites() {
  let fails = 0;
  console.log('\n-- End-to-end superframe --');
  const cellTable = buildCellMappingModeA_SO1();
  const facBlocks = [
    buildFACBlock({ frameIdx: 0, label: 'K3SBP' }),
    buildFACBlock({ frameIdx: 1, label: 'K3SBP' }),
    buildFACBlock({ frameIdx: 2, label: 'K3SBP' }),
  ];
  const mscByteLen = Math.ceil(mscPuncParams(cellTable.iNumUsefMSCCellsPerFrame).iNumInBitsPartB / 8);
  const mscBytes = [];
  for (let f = 0; f < 3; f++) {
    const b = new Uint8Array(mscByteLen);
    for (let i = 0; i < b.length; i++) b[i] = (i * 17 + f * 41) & 0xFF;
    mscBytes.push(b);
  }
  const grid = assembleSuperframe({ facBlocks, mscBytes, cellTable });

  // Invariants.
  let nonZero = 0, maxMag = 0, hasNaN = false;
  for (let s = 0; s < grid.length; s++) {
    for (let c = 0; c < grid[s].length; c++) {
      const cell = grid[s][c];
      if (Number.isNaN(cell.re) || Number.isNaN(cell.im)) hasNaN = true;
      const m = Math.hypot(cell.re, cell.im);
      if (m > 0) nonZero++;
      if (m > maxMag) maxMag = m;
    }
  }
  fails += assertEq('no NaN cells',             hasNaN, false);
  fails += assertEq('all 2565 cells populated', nonZero, 2565);
  fails += assertEq('max |cell| == 2 (boosted pilot)',
    Math.abs(maxMag - 2.0) < 1e-6, true);
  return fails;
}

(function main() {
  let fails = 0;
  fails += crcSuites();
  fails += facSuites();
  fails += motSuites();
  fails += mlcSuites();
  fails += interleaverSuites();
  fails += cellMapSuites();
  fails += endToEndSuites();
  if (fails === 0) {
    console.log('\nAll HamDRM regression canaries passed.');
    process.exit(0);
  }
  console.log(`\n${fails} failure(s). See above.`);
  process.exit(1);
})();
