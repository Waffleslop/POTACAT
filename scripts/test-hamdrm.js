'use strict';
// ---------------------------------------------------------------------------
// Regression harness for the HamDRM (EasyPal-compatible) encoder pipeline.
//
// What this covers today (week 1):
//   - CRC-8 / CRC-16 round-trip canaries
//   - FAC bit packing: the 6-byte FAC block for a known label + frame index
//   - MOT segmenter: filename → partitioned header + body → schedule list
//   - Conv encoder invariants (zero-in, impulse response)
//
// Each *_Suites function returns the number of failures. The script exits
// nonzero if any suite fails.
//
// Vectors prefixed with GROUND_TRUTH_TODO are regression canaries locked to
// the current port — they protect against accidental drift but do NOT yet
// prove interop with EasyPal/QSSTV. Replacing them with real vectors from a
// QSSTV instrumented TX is the week-2 gate (see
// potacat-docs/hamdrm-port-notes.md for the instrumentation procedure).
// ---------------------------------------------------------------------------

const { crc8FAC, crc16Mot } = require('../lib/hamdrm/hamdrm-crc');
const { buildFACBlock } = require('../lib/hamdrm/hamdrm-fac');
const { motEncode, transportIdFromFilename, buildDataGroupFromScheduleEntry } = require('../lib/hamdrm/hamdrm-mot');
const { convEncode } = require('../lib/hamdrm/hamdrm-mlc');

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function assertEq(label, got, want) {
  const ok = (got === want) || (got != null && want != null && got.length === want.length && got.every((x, i) => x === want[i]));
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
  // GROUND_TRUTH_TODO: replace with a QSSTV-instrumented dump of frame 0
  // for label "K3SBP" (data mode, CS_1_SM, protB=0, SO_1, short interleaver).
  const b0 = buildFACBlock({ frameIdx: 0, label: 'K3SBP' });
  fails += assertEq('FAC frame 0 length',  b0.length, 6);
  fails += assertEq('FAC frame 0 bytes',   b0, new Uint8Array([0xfa, 0x65, 0xb3, 0xa6, 0x00, 0x40]));

  const b1 = buildFACBlock({ frameIdx: 1, label: 'K3SBP' });
  fails += assertEq('FAC frame 1 bytes',   b1, new Uint8Array([0x7a, 0x61, 0x50, 0x00, 0x00, 0x38]));

  const b2 = buildFACBlock({ frameIdx: 2, label: 'K3SBP' });
  fails += assertEq('FAC frame 2 bytes',   b2, new Uint8Array([0xba, 0x40, 0x00, 0x00, 0x00, 0x2b]));

  // Identity bits differ
  const ids = [b0[0] >> 6, b1[0] >> 6, b2[0] >> 6];
  const distinct = new Set(ids).size === 3;
  fails += assertEq('FAC identity distinct across frames', distinct, true);
  return fails;
}

function motSuites() {
  let fails = 0;
  console.log('\n-- MOT segmenter --');
  // QSSTV's transport ID: for "test.jpg" our hash yields this value. Pinned.
  fails += assertEq('transportId("test.jpg")', transportIdFromFilename('test.jpg'), 0x2f45);

  const fake = new Uint8Array(256);
  for (let i = 0; i < fake.length; i++) fake[i] = (i * 7 + 13) & 0xFF;
  const mot = motEncode({ filename: 'test.jpg', bodyBytes: fake, format: 'jpg', bytesAvailable: 150 });
  fails += assertEq('MOT header segments',  mot.headerSegments.length, 1);
  fails += assertEq('MOT body segments',    mot.bodySegments.length,   2);

  // Schedule must begin with a header (negative entry).
  fails += assertEq('Schedule starts with header', mot.scheduleList[0] < 0, true);

  // First data-group CRC nonzero (random data, overwhelmingly likely).
  const dg = buildDataGroupFromScheduleEntry(mot.scheduleList[0], mot, { header: 0, body: 0 });
  const crcNonZero = dg[dg.length - 2] !== 0 || dg[dg.length - 1] !== 0;
  fails += assertEq('First data group has non-zero CRC', crcNonZero, true);
  return fails;
}

function mlcSuites() {
  let fails = 0;
  console.log('\n-- Conv encoder invariants --');
  const zeros = convEncode(new Uint8Array(32));
  const allZero = zeros.every(b => b.every(x => x === 0));
  fails += assertEq('zero-in → zero-out',   allZero, true);

  // Any single-1 impulse in a long-enough zero pad produces the generator
  // polynomial bit pattern on each of the 4 branches over the next 7 steps.
  const imp = new Uint8Array(32);
  imp[0] = 1;
  const out = convEncode(imp);
  fails += assertEq('impulse branch count', out.length, 4);
  const nonTrivial = out.some(b => b.some(x => x === 1));
  fails += assertEq('impulse produces output',    nonTrivial, true);
  return fails;
}

(function main() {
  let fails = 0;
  fails += crcSuites();
  fails += facSuites();
  fails += motSuites();
  fails += mlcSuites();
  if (fails === 0) {
    console.log('\nAll HamDRM regression canaries passed.');
    process.exit(0);
  }
  console.log(`\n${fails} failure(s). See above.`);
  process.exit(1);
})();
