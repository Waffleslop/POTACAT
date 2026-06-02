#!/usr/bin/env node
'use strict';
/**
 * Rig layer test — verifies codecs produce correct commands and parse responses.
 * Run: node test/rig-test.js
 * No dependencies — just Node.js assertions.
 */

const assert = require('assert');
const { KenwoodCodec, expand, ssbSideband } = require('../lib/codecs/kenwood-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { CivCodec } = require('../lib/codecs/civ-codec');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// Helper: capture writes from a codec
function captureWrites(CodecClass, model) {
  const writes = [];
  const codec = new CodecClass(model, (data) => writes.push(typeof data === 'string' ? data : data.toString('hex')));
  return { codec, writes };
}

// =========================================================================
console.log('\n=== Template Expansion ===');

test('expand pad9 frequency', () => {
  assert.strictEqual(expand('FA{freq:pad9};', { freq: 14074000 }), 'FA014074000;');
});

test('expand pad11 frequency', () => {
  assert.strictEqual(expand('FA{freq:pad11};', { freq: 14074000 }), 'FA00014074000;');
});

test('expand hexU mode (DATA-USB = 0xC)', () => {
  assert.strictEqual(expand('MD0{mode:hexU};', { mode: 0xC }), 'MD0C;');
});

test('expand hexU mode (DATA-LSB = 8)', () => {
  assert.strictEqual(expand('MD0{mode:hexU};', { mode: 8 }), 'MD08;');
});

test('expand pad3 RF gain', () => {
  assert.strictEqual(expand('RG0{val:pad3};', { val: 128 }), 'RG0128;');
});

test('expand plain mode (Kenwood decimal)', () => {
  assert.strictEqual(expand('MD{mode};', { mode: 3 }), 'MD3;');
});

test('ssbSideband below 10MHz = LSB', () => {
  assert.strictEqual(ssbSideband(7074000), 'LSB');
});

test('ssbSideband at 10MHz+ = USB', () => {
  assert.strictEqual(ssbSideband(14074000), 'USB');
});

// =========================================================================
console.log('\n=== KenwoodCodec (Yaesu FT-891) ===');

const FT891_MODEL = {
  brand: 'Yaesu', protocol: 'kenwood',
  caps: { nb: true, atu: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true },
  cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx' },
  atuCmd: 'ft891', minPower: 5, maxPower: 100,
};

test('Yaesu setFrequency pads to 9 digits', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setFrequency(14074000);
  assert.strictEqual(writes[0], 'FA014074000;');
});

test('Yaesu setMode FT8 -> MD0C (hex)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setMode('FT8', 14074000);
  assert.strictEqual(writes[0], 'MD0C;');
  assert.strictEqual(writes.length, 1); // no DA command for Yaesu
});

test('Yaesu setMode CW -> MD03', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setMode('CW', 7042000);
  assert.strictEqual(writes[0], 'MD03;');
});

test('Yaesu setMode SSB@7MHz -> MD01 (LSB)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setMode('SSB', 7260000);
  assert.strictEqual(writes[0], 'MD01;');
});

test('Yaesu setMode SSB@14MHz -> MD02 (USB)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setMode('SSB', 14270000);
  assert.strictEqual(writes[0], 'MD02;');
});

test('Yaesu setTransmit on -> TX1;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setTransmit(true);
  assert.strictEqual(writes[0], 'TX1;');
});

test('Yaesu setTransmit off -> TX0;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setTransmit(false);
  assert.strictEqual(writes[0], 'TX0;');
});

test('Yaesu setNb on -> NB01;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setNb(true);
  assert.strictEqual(writes[0], 'NB01;');
});

test('Yaesu setRfGain 50% -> RG0128; (50*2.55=127.5->128)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setRfGain(50);
  // 50 * 2.55 = 127.5 -> Math.round = 128... but implementation truncates slightly
  assert.ok(writes[0] === 'RG0127;' || writes[0] === 'RG0128;', `Got: ${writes[0]}`);
});

test('Yaesu setTxPower clamps to min 5W', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setTxPower(0);
  assert.strictEqual(writes[0], 'PC005;');
});

test('Yaesu setTxPower 100W', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setTxPower(100);
  assert.strictEqual(writes[0], 'PC100;');
});

test('Yaesu ATU ft891 sequence: AC001 + AC002', () => {
  const { codec } = captureWrites(KenwoodCodec, FT891_MODEL);
  const seq = codec.getAtuStartSequence();
  assert.strictEqual(seq.length, 2);
  assert.strictEqual(seq[0].cmd, 'AC001;');
  assert.strictEqual(seq[1].cmd, 'AC002;');
  assert.strictEqual(seq[1].delay, 300);
});

test('Yaesu filter SH01 indexed', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setFilterWidth(3000);
  assert.ok(writes[0].startsWith('SH01'));
});

test('Yaesu parse FA response (9 digits)', () => {
  const { codec } = captureWrites(KenwoodCodec, FT891_MODEL);
  let freq = 0;
  codec.on('frequency', (hz) => { freq = hz; });
  codec.onData('FA014074000;');
  assert.strictEqual(freq, 14074000);
});

test('Yaesu parse MD0C response -> DIGU', () => {
  const { codec } = captureWrites(KenwoodCodec, FT891_MODEL);
  let mode = '';
  codec.on('mode', (m) => { mode = m; });
  codec.onData('MD0C;');
  assert.strictEqual(mode, 'DIGU');
});

test('Yaesu setSplit(true) -> ST1;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setSplit(true);
  assert.strictEqual(writes[0], 'ST1;');
});

test('Yaesu setSplit(false) -> ST0;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setSplit(false);
  assert.strictEqual(writes[0], 'ST0;');
});

// =========================================================================
console.log('\n=== KenwoodCodec (Kenwood TS-590) ===');

const TS590_MODEL = {
  brand: 'Kenwood', protocol: 'kenwood',
  caps: { nb: true, atu: true, filter: true, filterType: 'direct', rfgain: true, txpower: true },
  cw: { text: 'ky', textChunk: 24, speed: 'ks', paddleKey: 'ta', taKey: true },
  atuCmd: 'standard', maxPower: 100,
};

test('Kenwood setFrequency pads to 11 digits', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setFrequency(14074000);
  assert.strictEqual(writes[0], 'FA00014074000;');
});

test('Kenwood setMode FT8 -> MD2 + DA1', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setMode('FT8', 14074000);
  assert.strictEqual(writes[0], 'MD2;');
  assert.strictEqual(writes[1], 'DA1;');
});

test('Kenwood setMode CW -> MD3 (no DA)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setMode('CW', 14050000);
  assert.strictEqual(writes[0], 'MD3;');
  assert.strictEqual(writes.length, 1);
});

test('Kenwood setTransmit on -> TX;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setTransmit(true);
  assert.strictEqual(writes[0], 'TX;');
});

test('Kenwood setNb on -> NB1;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setNb(true);
  assert.strictEqual(writes[0], 'NB1;');
});

test('Kenwood setRfGain -> RG127/128; (no 0 prefix)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setRfGain(50);
  assert.ok(writes[0] === 'RG127;' || writes[0] === 'RG128;', `Got: ${writes[0]}`);
});

test('Kenwood filter FW direct Hz', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setFilterWidth(500);
  assert.strictEqual(writes[0], 'FW0500;');
});

test('Kenwood setSplit(true) -> FT1;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setSplit(true);
  assert.strictEqual(writes[0], 'FT1;');
});

test('Kenwood setSplit(false) -> FT0;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setSplit(false);
  assert.strictEqual(writes[0], 'FT0;');
});

test('Kenwood parse FA response (11 digits)', () => {
  const { codec } = captureWrites(KenwoodCodec, TS590_MODEL);
  let freq = 0;
  codec.on('frequency', (hz) => { freq = hz; });
  codec.onData('FA00014074000;');
  assert.strictEqual(freq, 14074000);
});

test('Kenwood parse MD2 response -> USB', () => {
  const { codec } = captureWrites(KenwoodCodec, TS590_MODEL);
  let mode = '';
  codec.on('mode', (m) => { mode = m; });
  codec.onData('MD2;');
  assert.strictEqual(mode, 'USB');
});

// =========================================================================
console.log('\n=== KenwoodCodec (QMX — digiMd override) ===');

const QMX_MODEL = {
  brand: 'QRP Labs', protocol: 'kenwood',
  caps: { nb: false },
  cw: { text: 'ky', textChunk: 80, speed: 'ks', paddleKey: 'dtr', dtrPins: { dtr: true, rts: true } },
  atuCmd: false, maxPower: 5, digiMd: 6,
};

test('QMX setMode FT8 -> MD6 (digiMd override)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, QMX_MODEL);
  codec.setMode('FT8', 14074000);
  assert.strictEqual(writes[0], 'MD6;'); // QRP Labs is not Yaesu, no MD0 prefix
});

// =========================================================================
console.log('\n=== RigctldCodec ===');

const RIGCTLD_MODEL = {
  brand: 'Hamlib', protocol: 'rigctld',
  caps: { nb: true, atu: true, rfgain: true, txpower: true },
  maxPower: 100,
};

test('rigctld setFrequency', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setFrequency(14074000);
  assert.strictEqual(writes[0], 'F 14074000\n');
});

test('rigctld setMode FT8 -> M PKTUSB 3000 (wide for digital)', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setMode('FT8', 14074000);
  assert.strictEqual(writes[0], 'M PKTUSB 3000\n');
});

test('rigctld setMode CW -> M CW 500', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setMode('CW', 14050000);
  assert.strictEqual(writes[0], 'M CW 500\n');
});

test('rigctld setMode SSB below 10 MHz -> M LSB 2400', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setMode('SSB', 7200000);
  assert.strictEqual(writes[0], 'M LSB 2400\n');
});

test('rigctld setTransmit on -> T 1', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setTransmit(true);
  assert.strictEqual(writes[0], 'T 1\n');
});

test('rigctld setSplit(true) -> S 1 VFOB', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setSplit(true);
  assert.strictEqual(writes[0], 'S 1 VFOB\n');
});

test('rigctld setSplit(false) -> S 0 VFOA', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setSplit(false);
  assert.strictEqual(writes[0], 'S 0 VFOA\n');
});

test('rigctld setNb (non-Yaesu) -> U NB 1', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setNb(true);
  assert.strictEqual(writes[0], 'U NB 1\n');
});

test('rigctld ATU (non-Yaesu) -> U TUNER 1', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  const seq = codec.getAtuStartSequence();
  assert.strictEqual(seq[0].cmd, 'U TUNER 1\n');
});

test('rigctld parse frequency response', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let freq = 0;
  codec.on('frequency', (hz) => { freq = hz; });
  codec.onData('14074000\n');
  assert.strictEqual(freq, 14074000);
});

test('rigctld parse mode response + passband', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let mode = '';
  codec.on('mode', (m) => { mode = m; });
  codec.onData('USB\n3000\n');
  assert.strictEqual(mode, 'USB');
});

test('rigctld passband not eaten as frequency', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  const freqs = [];
  codec.on('frequency', (hz) => freqs.push(hz));
  codec.onData('14074000\nUSB\n3000\n');
  assert.strictEqual(freqs.length, 1);
  assert.strictEqual(freqs[0], 14074000);
});

// AB9AI regression: poll order is freq -> mode -> smeter, all fired in
// the same tick. Responses arrive in order. The freq response is a large
// integer that previously cleared _expectSmeter, so the actual S-meter
// response was silently dropped. The fix leaves _expectSmeter set until
// either an in-range value or an RPRT clears it.
test('rigctld smeter survives interleaved freq+mode poll (AB9AI)', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let smeter = -1;
  codec.on('smeter', (v) => { smeter = v; });
  codec.getFrequency();
  codec.getMode();
  codec.getSmeter();
  // Responses in order: freq, mode, passband, smeter (-12 dB rel S9)
  codec.onData('14074000\nUSB\n3000\n-12\n');
  // -12 dB -> (-12 + 54) * 255 / 114 ~= 94
  assert.strictEqual(smeter, 94);
});

test('rigctld smeter alone parses correctly', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let smeter = -1;
  codec.on('smeter', (v) => { smeter = v; });
  codec.getSmeter();
  codec.onData('0\n'); // S9
  // 0 dB -> 54 * 255 / 114 ~= 121
  assert.strictEqual(smeter, 121);
});

test('rigctld getSwr writes "l SWR"', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.getSwr();
  assert.strictEqual(writes[0], 'l SWR\n');
});

test('rigctld getAlc writes "l ALC"', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.getAlc();
  assert.strictEqual(writes[0], 'l ALC\n');
});

test('rigctld parse SWR 1.5 -> 30 (UI scale)', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let swr = -1;
  codec.on('swr', (v) => { swr = v; });
  codec.getSwr();
  codec.onData('1.5\n');
  // (1.5 - 1.0) * 60 = 30
  assert.strictEqual(swr, 30);
});

test('rigctld parse ALC 0.5 -> 128', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let alc = -1;
  codec.on('alc', (v) => { alc = v; });
  codec.getAlc();
  codec.onData('0.5\n');
  // 0.5 * 255 = 127.5 -> 128
  assert.strictEqual(alc, 128);
});

test('rigctld swr survives interleaved freq response', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let swr = -1;
  codec.on('swr', (v) => { swr = v; });
  codec.getFrequency();
  codec.getSwr();
  codec.onData('14074000\n2.0\n');
  // (2.0 - 1.0) * 60 = 60
  assert.strictEqual(swr, 60);
});

test('rigctld RPRT -11 clears all expectations (function not available)', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let smeter = -1, swr = -1, alc = -1;
  codec.on('smeter', (v) => { smeter = v; });
  codec.on('swr', (v) => { swr = v; });
  codec.on('alc', (v) => { alc = v; });
  codec.getSmeter();
  codec.getSwr();
  codec.getAlc();
  codec.onData('RPRT -11\n');
  // No subsequent integer should land on smeter/swr/alc
  codec.onData('14074000\n');
  assert.strictEqual(smeter, -1);
  assert.strictEqual(swr, -1);
  assert.strictEqual(alc, -1);
});

// =========================================================================
console.log('\n=== RigctldCodec (Yaesu via rigctld) ===');

const RIGCTLD_YAESU_MODEL = {
  brand: 'Yaesu', protocol: 'rigctld',
  caps: { nb: true, rfgain: true, txpower: true },
  atuCmd: 'ft891', minPower: 5, maxPower: 100,
};

test('rigctld Yaesu NB -> raw passthrough w NB01;', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  codec.setNb(true);
  assert.strictEqual(writes[0], 'w NB01;\n');
});

test('rigctld Yaesu RF gain -> raw passthrough w RG0128;', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  codec.setRfGain(0.5);
  assert.strictEqual(writes[0], 'w RG0128;\n');
});

test('rigctld Yaesu TX power -> raw passthrough w PC050;', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  codec.setTxPower(0.5);
  assert.strictEqual(writes[0], 'w PC050;\n');
});

test('rigctld Yaesu ATU ft891 -> raw passthrough', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  const seq = codec.getAtuStartSequence();
  assert.strictEqual(seq[0].cmd, 'w AC001;\n');
  assert.strictEqual(seq[1].cmd, 'w AC002;\n');
});

// =========================================================================
console.log('\n=== CivCodec (IC-7300) ===');

const IC7300_MODEL = {
  brand: 'Icom', protocol: 'civ', civAddr: 0x94,
  caps: { nb: true, atu: true, rfgain: true, txpower: true },
  cw: { textChunk: 30, paddleKey: 'dtr', dtrPins: { dtr: true } },
  maxPower: 100,
};

test('CIV setFrequency builds correct BCD frame', () => {
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec.setFrequency(14074000);
  const hex = writes[0];
  assert.ok(hex.startsWith('fefe94e005'), `Expected CI-V freq frame, got: ${hex}`);
  assert.ok(hex.endsWith('fd'), `Expected FD terminator, got: ${hex}`);
});

test('CIV setTransmit on -> 1C 00 01', () => {
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec.setTransmit(true);
  const hex = writes[0];
  assert.ok(hex.includes('1c0001'), `Expected PTT on, got: ${hex}`);
});

test('CIV setTransmit off -> 1C 00 00', () => {
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec.setTransmit(false);
  const hex = writes[0];
  assert.ok(hex.includes('1c0000'), `Expected PTT off, got: ${hex}`);
});

test('CIV setNb on -> 16 22 01', () => {
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec.setNb(true);
  const hex = writes[0];
  assert.ok(hex.includes('162201'), `Expected NB on, got: ${hex}`);
});

test('CIV parse frequency response', () => {
  const { codec } = captureWrites(CivCodec, IC7300_MODEL);
  let freq = 0;
  codec.on('frequency', (hz) => { freq = hz; });
  // Frequency 14.074.000 as BCD: 00 40 07 14 00 (LSB first)
  const frame = Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x03, 0x00, 0x40, 0x07, 0x14, 0x00, 0xFD]);
  codec.onData(frame);
  assert.strictEqual(freq, 14074000);
});

test('CIV parse mode response', () => {
  const { codec } = captureWrites(CivCodec, IC7300_MODEL);
  let mode = '';
  codec.on('mode', (m) => { mode = m; });
  // Mode USB (0x01)
  const frame = Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x01, 0x01, 0xFD]);
  codec.onData(frame);
  assert.strictEqual(mode, 'USB');
});

test('CIV setFilterWidth is no-op (FIL presets not Hz-addressable)', () => {
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec.setMode('CW', 14000000);
  writes.length = 0; // clear mode writes
  codec.setFilterWidth(500);
  assert.strictEqual(writes.length, 0, 'Should not send any filter command for CI-V');
});

test('CIV setMode does not include filter byte', () => {
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec.setMode('CW', 14000000);
  const hex = writes[0];
  // cmd 0x06 with just mode byte 0x03 (CW), no filter byte
  // Frame: FE FE 94 E0 06 03 FD — mode only, no 0x01/0x02/0x03 filter
  assert.ok(hex.includes('0603fd'), `Expected mode-only (no filter byte), got: ${hex}`);
});

// =========================================================================
console.log('\n=== FTdx3000 ATU ===');

const FTDX3000_MODEL = {
  brand: 'Yaesu', protocol: 'kenwood',
  caps: { atu: true },
  cw: {},
  atuCmd: 'ac002', maxPower: 100,
};

test('FTdx3000 ATU -> single AC002;', () => {
  const { codec } = captureWrites(KenwoodCodec, FTDX3000_MODEL);
  const seq = codec.getAtuStartSequence();
  assert.strictEqual(seq.length, 1);
  assert.strictEqual(seq[0].cmd, 'AC002;');
});

// =========================================================================
console.log('\n=== Extended Controls (FT-891) ===');

const FT891_EXT = {
  brand: 'Yaesu', protocol: 'kenwood',
  caps: { nb: true, nbLevel: true, afGain: true, preamp: true, attenuator: true, vfoCopy: true },
  cw: {}, atuCmd: 'ft891', minPower: 5, maxPower: 100, maxNbLevel: 10,
};

test('Yaesu NB level 5 -> NL0005;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setNbLevel(5);
  assert.strictEqual(writes[0], 'NL0005;');
});

test('Yaesu NB level 10 -> NL0010;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setNbLevel(10);
  assert.strictEqual(writes[0], 'NL0010;');
});

test('Yaesu AF gain 100% -> AG0255;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setAfGain(100);
  assert.strictEqual(writes[0], 'AG0255;');
});

test('Yaesu AF gain 0% -> AG0000;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setAfGain(0);
  assert.strictEqual(writes[0], 'AG0000;');
});

test('Yaesu preamp on -> PA01;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setPreamp(true);
  assert.strictEqual(writes[0], 'PA01;');
});

test('Yaesu preamp off -> PA00;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setPreamp(false);
  assert.strictEqual(writes[0], 'PA00;');
});

test('Yaesu attenuator on -> RA01;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setAttenuator(true);
  assert.strictEqual(writes[0], 'RA01;');
});

test('Yaesu attenuator off -> RA00;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setAttenuator(false);
  assert.strictEqual(writes[0], 'RA00;');
});

test('Yaesu VFO copy A->B -> AB;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.vfoCopyAB();
  assert.strictEqual(writes[0], 'AB;');
});

test('Yaesu VFO copy B->A -> BA;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.vfoCopyBA();
  assert.strictEqual(writes[0], 'BA;');
});

test('Yaesu XIT +80Hz -> XT1; RC; RU0080;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setXit(80);
  assert.strictEqual(writes[0], 'XT1;');
  assert.strictEqual(writes[1], 'RC;');
  assert.strictEqual(writes[2], 'RU0080;');
});

test('Yaesu XIT -50Hz -> XT1; RC; RD0050;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setXit(-50);
  assert.strictEqual(writes[0], 'XT1;');
  assert.strictEqual(writes[1], 'RC;');
  assert.strictEqual(writes[2], 'RD0050;');
});

test('Yaesu XIT off -> XT0;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_EXT);
  codec.setXit(0);
  assert.strictEqual(writes[0], 'XT0;');
  assert.strictEqual(writes.length, 1);
});

// Kenwood extended (no 0 prefix)
console.log('\n=== Extended Controls (Kenwood) ===');

test('Kenwood NB level 5 -> NL005;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setNbLevel(5);
  assert.strictEqual(writes[0], 'NL005;');
});

test('Kenwood preamp on -> PA1;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setPreamp(true);
  assert.strictEqual(writes[0], 'PA1;');
});

test('Kenwood attenuator on -> RA1;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setAttenuator(true);
  assert.strictEqual(writes[0], 'RA1;');
});

// =========================================================================
// FTX-1 Field + Optima — model-specific behavior validated against real
// hardware by Hitman90210 (KF4YHC) in PR #39, integrated here.
// =========================================================================
console.log('\n=== Yaesu FTX-1 ===');

const FTX1_FIELD_MODEL = {
  brand: 'Yaesu', protocol: 'kenwood',
  caps: {
    nb: true, atu: true, filter: true, filterType: 'indexed', rfgain: true,
    txpower: true, vfo: true, comp: false, compLevel: false, nr: true,
    nrLevel: false, dnrLevel: true, anf: true, vox: true, voxLevel: true,
    agc: true, rit: false, mon: true, monLevel: true, micGain: true,
    clarRx: true, clarTx: true, clarOffset: true, breakIn: true,
    breakInDelay: true, ftx1Clar: true,
  },
  cw: { text: 'ky1', textChunk: 50, speed: 'ks', paddleKey: 'txrx', kyMode: 'km' },
  atuCmd: 'standard', minPower: 5, maxPower: 100, maxNbLevel: 10, maxDnrLevel: 10,
  agcMap: { off: 0, fast: 1, med: 2, mid: 2, slow: 3, auto: 4 },
  commands: {
    setNbOn: 'NL0001;', setNbOff: 'NL0000;', getNb: 'NL0;', setNbLevel: 'NL0{val:pad3};',
    getRfGain: 'RG0;', getAgc: 'GT0;',
    setNoiseReductionOn: 'RL001;', setNoiseReductionOff: 'RL000;', getDnrLevel: 'RL0;', setDnrLevel: 'RL0{val:pad2};',
    getMicGain: 'MG;', getVox: 'VX;', getVoxLevel: 'VG;', getAutoNotch: 'BC0;',
    getMonitor: 'ML;', getClarState: 'CF000;', getClarOffset: 'CF001;',
  },
  pcPrefix: 1, rmSwr: 6, rmAlc: 4, pollTxMetersAlways: true, powerPollEvery: 2,
};
const FTX1_OPTIMA_MODEL = Object.assign({}, FTX1_FIELD_MODEL, {
  atuCmd: 'ac103', pcPrefix: 2,
  caps: Object.assign({}, FTX1_FIELD_MODEL.caps, { antennaPort: true }),
  commands: Object.assign({}, FTX1_FIELD_MODEL.commands, {
    setAntennaPort: 'EX030704{val};',
    getAntennaPort: 'EX030704;',
  }),
});

// Power: model-prefixed PC parsing (PC1xxx Field, PC2xxx Optima).
test('FTX-1 Field: PC1100 reply parses as 100 W (prefix stripped)', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let captured = null;
  codec.on('power', (w) => { captured = w; });
  codec.onData(Buffer.from('PC1100;'));
  assert.strictEqual(captured, 100);
});

test('FTX-1 Optima: PC2100 reply parses as 100 W (prefix stripped)', () => {
  const codec = new KenwoodCodec(FTX1_OPTIMA_MODEL, () => {});
  let captured = null;
  codec.on('power', (w) => { captured = w; });
  codec.onData(Buffer.from('PC2100;'));
  assert.strictEqual(captured, 100);
});

test('FTX-1 Optima: PC1100 (wrong prefix) parses as 1100 (no strip)', () => {
  // Sanity check: stripping only happens when the leading byte matches the
  // model's prefix. A mismatched prefix should NOT be silently dropped.
  const codec = new KenwoodCodec(FTX1_OPTIMA_MODEL, () => {});
  let captured = null;
  codec.on('power', (w) => { captured = w; });
  codec.onData(Buffer.from('PC1100;'));
  assert.strictEqual(captured, 1100);
});

// Meter channel routing (FTX-1 = RM6 SWR, RM4 ALC).
test('FTX-1 getSwr writes RM6;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.getSwr();
  assert.strictEqual(writes[0], 'RM6;');
});

test('FTX-1 getAlc writes RM4;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.getAlc();
  assert.strictEqual(writes[0], 'RM4;');
});

test('FTX-1 RM6 reply routes to swr', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let swr = null, alc = null;
  codec.on('swr', (v) => { swr = v; });
  codec.on('alc', (v) => { alc = v; });
  codec.onData(Buffer.from('RM6055;'));
  assert.strictEqual(swr, 55);
  assert.strictEqual(alc, null);
});

test('FTX-1 RM4 reply routes to alc', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let swr = null, alc = null;
  codec.on('swr', (v) => { swr = v; });
  codec.on('alc', (v) => { alc = v; });
  codec.onData(Buffer.from('RM4042;'));
  assert.strictEqual(alc, 42);
  assert.strictEqual(swr, null);
});

// Physical PTT polling (TX;) — added to YAESU_DEFAULTS so all Yaesu rigs
// get it, not just FTX-1.
test('FTX-1 getPtt writes TX;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.getPtt();
  assert.strictEqual(writes[0], 'TX;');
});

test('FTX-1 TX1 reply emits ptt=true', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let ptt = null;
  codec.on('ptt', (v) => { ptt = v; });
  codec.onData(Buffer.from('TX1;'));
  assert.strictEqual(ptt, true);
});

test('FTX-1 TX0 reply emits ptt=false', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let ptt = null;
  codec.on('ptt', (v) => { ptt = v; });
  codec.onData(Buffer.from('TX0;'));
  assert.strictEqual(ptt, false);
});

test('FTX-1 NB toggle uses NL level off/on commands', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setNb(true);
  codec.setNb(false);
  assert.deepStrictEqual(writes, ['NL0001;', 'NL0000;']);
});

test('FTX-1 NB level clamps to 0..10', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setNbLevel(10);
  codec.setNbLevel(99);
  assert.deepStrictEqual(writes, ['NL0010;', 'NL0010;']);
});

test('FTX-1 NL reply drives NB state and level', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let state = null, level = null;
  codec.on('nb', (v) => { state = v; });
  codec.on('nbLevel', (v) => { level = v; });
  codec.onData(Buffer.from('NL0008;'));
  assert.strictEqual(state, true);
  assert.strictEqual(level, 8);
});

test('FTX-1 DNR level 0..10 uses RL000..RL010', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setDnrLevel(0);
  codec.setDnrLevel(10);
  codec.setDnrLevel(99);
  assert.deepStrictEqual(writes, ['RL000;', 'RL010;', 'RL010;']);
});

test('FTX-1 DNR toggle uses RL000/RL001', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setNoiseReduction(false);
  codec.setNoiseReduction(true);
  assert.deepStrictEqual(writes, ['RL000;', 'RL001;']);
});

test('FTX-1 RL reply drives DNR state and level', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let state = null, level = null;
  codec.on('nr', (v) => { state = v; });
  codec.on('dnrLevel', (v) => { level = v; });
  codec.onData(Buffer.from('RL010;'));
  assert.strictEqual(state, true);
  assert.strictEqual(level, 10);
});

test('FTX-1 AGC mapping matches OFF/AUTO/FAST/MID/SLOW', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setAgc('off');
  codec.setAgc('auto');
  codec.setAgc('fast');
  codec.setAgc('med');
  codec.setAgc('slow');
  assert.deepStrictEqual(writes, ['GT00;', 'GT04;', 'GT01;', 'GT02;', 'GT03;']);
});

test('FTX-1 GT reply parses Auto correctly', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let agc = null;
  codec.on('agc', (v) => { agc = v; });
  codec.onData(Buffer.from('GT04;'));
  assert.strictEqual(agc, 'auto');
});

test('FTX-1 does not expose PROC controls in POTACAT', () => {
  assert.strictEqual(FTX1_FIELD_MODEL.caps.comp, false);
  assert.strictEqual(FTX1_FIELD_MODEL.caps.compLevel, false);
  assert.strictEqual(FTX1_FIELD_MODEL.commands.setCompOn, undefined);
  assert.strictEqual(FTX1_FIELD_MODEL.commands.getCompLevel, undefined);
});

test('FTX-1 RF gain reply maps raw 255 to 100%', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let rf = null;
  codec.on('rfgain', (v) => { rf = v; });
  codec.onData(Buffer.from('RG0255;'));
  assert.strictEqual(rf, 100);
});

test('FTX-1 preamp allows AMP2 only on HF/50', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setPreampTarget('hf50', 2);
  codec.setPreampTarget('vhf', 2);
  codec.setPreampTarget('uhf', 2);
  assert.deepStrictEqual(writes, ['PA02;', 'PA11;', 'PA21;']);
});

test('FTX-1 Optima antenna select writes EX0307040/1; only on Optima', () => {
  const optima = captureWrites(KenwoodCodec, FTX1_OPTIMA_MODEL);
  optima.codec.setAntennaPort(1);
  optima.codec.setAntennaPort(2);
  assert.deepStrictEqual(optima.writes, ['EX0307040;', 'EX0307041;']);

  const field = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  field.codec.setAntennaPort(2);
  assert.deepStrictEqual(field.writes, []);
});

test('FTX-1 Optima antenna readback parses EX0307040/1 to ANT 1/2', () => {
  const codec = new KenwoodCodec(FTX1_OPTIMA_MODEL, () => {});
  const ports = [];
  codec.on('antennaPort', (v) => { ports.push(v); });
  codec.onData(Buffer.from('EX0307040;EX0307041;'));
  assert.deepStrictEqual(ports, [1, 2]);
});

// Monitor: channel 0 carries enable bit, channel 1 carries level.
test('FTX-1 setMonitor(true) writes ML0001;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setMonitor(true);
  assert.strictEqual(writes[0], 'ML0001;');
});

test('FTX-1 setMonitor(false) writes ML0000;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setMonitor(false);
  assert.strictEqual(writes[0], 'ML0000;');
});

test('FTX-1 setMonLevel(50) writes ML1050; (channel 1)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setMonLevel(50);
  assert.strictEqual(writes[0], 'ML1050;');
});

// Clarifier: setting-mode 0 toggles RX/TX enable together; setting-mode 1
// writes the shared offset.
test('FTX-1 setClarRx(true) writes CF000 with RX bit set', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setClarRx(true);
  assert.strictEqual(writes[0], 'CF00010000;');
});

test('FTX-1 setClarTx(true) preserves prior RX state', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setClarRx(true);
  codec.setClarTx(true);
  assert.strictEqual(writes[0], 'CF00010000;');
  assert.strictEqual(writes[1], 'CF00011000;');
});

test('FTX-1 setClarOffset(+500) writes CF001+0500;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setClarOffset(500);
  assert.strictEqual(writes[0], 'CF001+0500;');
});

test('FTX-1 setClarOffset(-250) writes CF001-0250;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setClarOffset(-250);
  assert.strictEqual(writes[0], 'CF001-0250;');
});

test('FTX-1 CF000 reply parses RX/TX enable bits', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let rit = null, txClar = null;
  codec.on('rit', (v) => { rit = v; });
  codec.on('txClar', (v) => { txClar = v; });
  codec.onData(Buffer.from('CF00011000;'));
  assert.strictEqual(rit, true);
  assert.strictEqual(txClar, true);
});

test('FTX-1 CF001 reply parses signed offset', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let freq = null;
  codec.on('clarFreq', (v) => { freq = v; });
  codec.onData(Buffer.from('CF001-0123;'));
  assert.strictEqual(freq, -123);
});

// =========================================================================
// Non-FTX-1 Yaesu regression guards — these are the controls PR #39's first
// pass accidentally broke. Lock them down so the next FTX-1-style refactor
// can't silently kill RIT/NR/ANF on FT-991/FTDX10/FT-710 etc.
// =========================================================================
console.log('\n=== Yaesu non-FTX-1 regression guards ===');

test('Non-FTX-1 Yaesu setRit writes RT1;/RT0; (FT-891 fixture)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setRit(true);
  codec.setRit(false);
  assert.deepStrictEqual(writes, ['RT1;', 'RT0;']);
});

test('Non-FTX-1 Yaesu setNoiseReduction writes NR01;/NR00;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setNoiseReduction(true);
  codec.setNoiseReduction(false);
  assert.deepStrictEqual(writes, ['NR01;', 'NR00;']);
});

test('Non-FTX-1 Yaesu setAutoNotch writes BC01;/BC00;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  codec.setAutoNotch(true);
  codec.setAutoNotch(false);
  assert.deepStrictEqual(writes, ['BC01;', 'BC00;']);
});

// =========================================================================
// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
