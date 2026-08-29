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

test('ssbSideband 60m = USB (below-10MHz exception)', () => {
  assert.strictEqual(ssbSideband(5357000), 'USB');  // 60m US FT8 channel
  assert.strictEqual(ssbSideband(5403500), 'USB');  // top US 60m channel
  assert.strictEqual(ssbSideband(3573000), 'LSB');  // 80m stays LSB (no over-reach)
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

test('Kenwood setTransmit on -> TX; (generic default)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, TS590_MODEL);
  codec.setTransmit(true);
  assert.strictEqual(writes[0], 'TX;');
});

// Real-model data-send PTT: plain TX; keys the front mic; TX1; keys with the
// rear/USB data input. POTACAT only sends computer audio to these rigs, so the
// real TS-590S/SG (and TS-890S/TS-990S) must use TX1; or TX is silent dead air.
// (KF0WXX serial-logger finding, 2026-06.)
test('TS-590S/SG (real model) setTransmit on -> TX1; (data send)', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  const { codec, writes } = captureWrites(KenwoodCodec, RIG_MODELS['TS-590S/SG']);
  codec.setTransmit(true);
  assert.strictEqual(writes[0], 'TX1;');
});

test('TS-590S/SG (real model) setTransmit off -> RX; (stops TX regardless of form)', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  const { codec, writes } = captureWrites(KenwoodCodec, RIG_MODELS['TS-590S/SG']);
  codec.setTransmit(false);
  assert.strictEqual(writes[0], 'RX;');
});

test('TS-890S / TS-990S (real models) setTransmit on -> TX1; (data send)', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  for (const id of ['TS-890S', 'TS-990S']) {
    const { codec, writes } = captureWrites(KenwoodCodec, RIG_MODELS[id]);
    codec.setTransmit(true);
    assert.strictEqual(writes[0], 'TX1;', `${id} should data-send key with TX1;`);
  }
});

// Guard against over-broadening: TS-2000 predates TX0/TX1 data-send, so it must
// stay on plain TX;. Elecraft (same codec) likewise keeps TX;.
test('TS-2000 (real model) setTransmit on -> TX; (no data-send override)', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  const { codec, writes } = captureWrites(KenwoodCodec, RIG_MODELS['TS-2000']);
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

// Passband is caps-gated: rigs with fixed filters (FT-857 et al.) make
// hamlib reject "M USB 2400" outright (RPRT -1 — the MODE never changes),
// so a model without caps.filter sends passband 0 (backend default). These
// three were stale for weeks expecting the pre-gate behavior and trained
// everyone to ignore "SOME TESTS FAILED" — updated 2026-07-11 to pin BOTH
// sides of the gate.
const RIGCTLD_FILTER_MODEL = { ...RIGCTLD_MODEL, caps: { ...RIGCTLD_MODEL.caps, filter: true } };

test('rigctld setMode FT8, no filter caps -> M PKTUSB 0 (fixed-filter rigs reject passbands)', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setMode('FT8', 14074000);
  assert.strictEqual(writes[0], 'M PKTUSB 0\n');
});

test('rigctld setMode FT8, filter-capable -> M PKTUSB 3000 (wide for digital)', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_FILTER_MODEL);
  codec.setMode('FT8', 14074000);
  assert.strictEqual(writes[0], 'M PKTUSB 3000\n');
});

test('rigctld setMode CW, filter-capable -> M CW 500', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_FILTER_MODEL);
  codec.setMode('CW', 14050000);
  assert.strictEqual(writes[0], 'M CW 500\n');
});

test('rigctld setMode SSB below 10 MHz, filter-capable -> M LSB 2400', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_FILTER_MODEL);
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
test('Elecraft K3/KX3 filter width uses BW in 10 Hz units (never FW)', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  for (const key of ['K3/K3S', 'K4/K4D', 'KX2/KX3']) {
    const { codec, writes } = captureWrites(KenwoodCodec, RIG_MODELS[key]);
    codec.setFilterWidth(2700);
    assert.strictEqual(writes[0], 'BW0270;', key + ': expected BW0270; got: ' + writes[0]);
    assert.ok(!writes.some(w => w.startsWith('FW')), key + ': FW selects roofing SLOTS - must never be sent');
  }
});

test('rigctld same-mode re-send preserves explicit filter width (K6RBJ)', () => {
  const model = { protocol: 'rigctld', caps: { filter: true }, brand: 'Icom' };
  const { codec, writes } = captureWrites(RigctldCodec, model);
  codec.setMode('LSB', 7185000);
  codec.setFilterWidth(3000);
  codec.setMode('LSB', 7185000);   // band-recall / re-anchor style re-send
  codec.setMode('CW', 7030000);    // genuine change -> mode default again
  const out = writes.map((w) => String(w).trim());
  assert.strictEqual(out[2], 'M LSB 3000', 'same-mode re-send stomped the width: ' + out[2]);
  assert.ok(!out[3].includes('3000'), 'mode change must reset to the default: ' + out[3]);
});

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

test('CIV setFilterWidth 2400 SSB -> 1A 03 idx 28 (BCD 0x28)', () => {
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec._lastMode = 'USB';
  codec.setFilterWidth(2400);
  const hex = writes[0];
  assert.ok(hex.includes('1a0328'), `Expected 1A 03 28, got: ${hex}`);
});

test('CIV setFilterWidth 500 CW -> idx 9; 50 CW -> idx 0', () => {
  const a = captureWrites(CivCodec, IC7300_MODEL);
  a.codec._lastMode = 'CW';
  a.codec.setFilterWidth(500);
  assert.ok(a.writes[0].includes('1a0309'), `Expected idx 9, got: ${a.writes[0]}`);
  const b = captureWrites(CivCodec, IC7300_MODEL);
  b.codec._lastMode = 'CW';
  b.codec.setFilterWidth(50);
  assert.ok(b.writes[0].includes('1a0300'), `Expected idx 0, got: ${b.writes[0]}`);
});

test('CIV setFilterWidth caps: 3600 SSB idx 40; RTTY capped at 31; FM no-op', () => {
  const a = captureWrites(CivCodec, IC7300_MODEL);
  a.codec._lastMode = 'USB';
  a.codec.setFilterWidth(9999);
  assert.ok(a.writes[0].includes('1a0340'), `Expected idx 40 cap, got: ${a.writes[0]}`);
  const b = captureWrites(CivCodec, IC7300_MODEL);
  b.codec._lastMode = 'RTTY';
  b.codec.setFilterWidth(3600);
  assert.ok(b.writes[0].includes('1a0331'), `Expected RTTY cap 31, got: ${b.writes[0]}`);
  const c = captureWrites(CivCodec, IC7300_MODEL);
  c.codec._lastMode = 'FM';
  c.codec.setFilterWidth(2400);
  assert.strictEqual(c.writes.length, 0, 'FM must not send a width frame');
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

// The old "setFilterWidth is a no-op" pin guarded against cmd 0x06 abuse
// (preset selection that re-sends the mode byte). The 2026-08-20
// implementation uses 0x1A 0x03 — the real width command, no mode byte —
// so the pin is obsolete; coverage lives in the three width-table tests
// above (SSB/CW indices, RTTY cap, FM no-op).

test('CIV setMode sends the 2-byte [mode, filter] form, echoing the last-seen filter', () => {
  // Stale until 2026-07-11: expected the 1-byte mode-only form, but older
  // Icoms (IC-7100/7200/9100/706MKIIG) silently DROP that form — the codec
  // deliberately always sends [mode, filter], echoing the filter the rig
  // last reported so per-mode filter memory is preserved (K6RBJ IC-7100
  // 2026-05-25). First-poll default is FIL1 (0x01).
  const { codec, writes } = captureWrites(CivCodec, IC7300_MODEL);
  codec.setMode('CW', 14000000);
  const hex = writes[0];
  // Frame: FE FE 94 E0 06 03 01 FD — mode 0x03 (CW) + filter byte FIL1
  assert.ok(hex.includes('060301fd'), `Expected [mode, FIL1] form, got: ${hex}`);
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
console.log('\n=== FT-710 ATU (AC003) ===');

test('FT-710 ATU -> single AC003; (no AC001 first), button enabled', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  const m = RIG_MODELS['FT-710'];
  assert.strictEqual(m.caps.atu, true, 'FT-710 ATU button must be enabled');
  assert.strictEqual(m.atuCmd, 'ac003');
  const { codec } = captureWrites(KenwoodCodec, m);
  const seq = codec.getAtuStartSequence();
  assert.strictEqual(seq.length, 1, 'AC003 is a single command, no AC001 first');
  assert.strictEqual(seq[0].cmd, 'AC003;');
  assert.strictEqual(codec.getAtuStopCmd(), 'AC000;');
});

test('FT-710 ATU via rigctld -> w AC003;', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  const { codec } = captureWrites(RigctldCodec, RIG_MODELS['FT-710']);
  const seq = codec.getAtuStartSequence();
  assert.strictEqual(seq.length, 1);
  assert.strictEqual(seq[0].cmd, 'w AC003;\n');
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

// Preamp/ATT LADDERS (KB2UXB, FT-710, 2026-08-04). A model that declares
// steps drives the multi-step form; one that doesn't keeps the on/off pair
// above, which is why the FT891_EXT tests are untouched.
const { YAESU_PREAMP_IPO_AMP1_AMP2, YAESU_ATT_6_12_18 } = require('../lib/rig-gain-steps');
const FT710_STEPS = {
  ...FT891_EXT,
  preampSteps: YAESU_PREAMP_IPO_AMP1_AMP2,
  attSteps: YAESU_ATT_6_12_18,
};

test('laddered Yaesu preamp reaches AMP2 -> PA02;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT710_STEPS);
  codec.setPreamp(2);
  assert.strictEqual(writes[0], 'PA02;');
});

test('laddered Yaesu attenuator reaches 12 and 18 dB -> RA02; RA03;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT710_STEPS);
  codec.setAttenuator(2);
  codec.setAttenuator(3);
  assert.deepStrictEqual(writes, ['RA02;', 'RA03;']);
});

test('laddered rig still honors the legacy boolean (old clients)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT710_STEPS);
  codec.setPreamp(true);   // first ON step
  codec.setAttenuator(false);
  assert.deepStrictEqual(writes, ['PA01;', 'RA00;']);
});

test('an out-of-range step is snapped, never sent raw to the radio', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT710_STEPS);
  codec.setAttenuator(9);
  assert.strictEqual(writes[0], 'RA03;');
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
  atuCmd: 'ac103', minPower: 1, maxPower: 10, powerStep: 1,
  powerChoices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  powerMap: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 },
  maxNbLevel: 10, maxDnrLevel: 10,
  agcMap: { off: 0, fast: 1, med: 2, mid: 2, slow: 3, auto: 4 },
  commands: {
    setNbOn: 'NL0001;', setNbOff: 'NL0000;', getNb: 'NL0;', setNbLevel: 'NL0{val:pad3};',
    setPower: 'PC1{val:pad3};',
    getRfGain: 'RG0;', getAgc: 'GT0;',
    setNoiseReductionOn: 'RL001;', setNoiseReductionOff: 'RL000;', getDnrLevel: 'RL0;', setDnrLevel: 'RL0{val:pad2};',
    getMicGain: 'MG;', getVox: 'VX;', getVoxLevel: 'VG;', getAutoNotch: 'BC0;',
    getMonitor: 'ML;', getClarState: 'CF000;', getClarOffset: 'CF001;',
  },
  pcPrefix: 1, rmSwr: 6, rmAlc: 4, pollTxMetersAlways: true, powerPollEvery: 2,
};
const FTX1_OPTIMA_MODEL = Object.assign({}, FTX1_FIELD_MODEL, {
  atuCmd: 'ac103', minPower: 5, maxPower: 100, powerScale: 1,
  powerStep: 1, powerDecimals: 0, pcPrefix: 2,
  caps: Object.assign({}, FTX1_FIELD_MODEL.caps, { antennaPort: true }),
  commands: Object.assign({}, FTX1_FIELD_MODEL.commands, {
    setPower: 'PC2{val:pad3};',
    setAntennaPort: 'EX030704{val};',
    getAntennaPort: 'EX030704;',
  }),
});

// Power: model-prefixed PC set/read (PC1xxx Field, PC2xxx Optima). Field
// hardware confirms whole-watt CAT values: PC1001 -> 1W ... PC1010 -> 10W.
test('FTX-1 Field: PC1004 reply maps back to observed 4 W', () => {
  const codec = new KenwoodCodec(FTX1_FIELD_MODEL, () => {});
  let captured = null;
  codec.on('power', (w) => { captured = w; });
  codec.onData(Buffer.from('PC1004;'));
  assert.strictEqual(captured, 4);
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

test('FTX-1 Field: setTxPower emits whole-watt model-prefixed payloads', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.setTxPower(1);
  codec.setTxPower(7);
  codec.setTxPower(100);
  assert.strictEqual(writes[0], 'PC1001;');
  assert.strictEqual(writes[1], 'PC1007;');
  assert.strictEqual(writes[2], 'PC1010;');
});

test('FTX-1 Optima: setTxPower emits model-prefixed PC payload', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_OPTIMA_MODEL);
  codec.setTxPower(100);
  assert.strictEqual(writes[0], 'PC2100;');
});

test('FTX-1 Field native tuner uses external ATU start command AC103;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FTX1_FIELD_MODEL);
  codec.startTune();
  assert.deepStrictEqual(writes, ['AC103;']);
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
// Kenwood meter scaling + RM payload width (TS-480 desktop-ask,
// meter-scale-and-flex-swr-snapshot.md). Three stacked bugs made the
// TS-480 read S9 as ~S1 and SWR as blank:
//   1. SM forwarded raw (0-30, S9=15) while consumers assume S9=120.
//   2. RM forwarded raw (0-30) while consumers assume ratio = 1 + raw/60.
//   3. PR #39's 3-digit RM clamp (correct for Yaesu) truncated Kenwood's
//      4-digit replies to a tenth (RM10015 -> "001" -> 1).
// =========================================================================
console.log('\n=== Kenwood meter scaling (TS-480 desktop-ask) ===');

const TS480_MODEL = { brand: 'Kenwood', protocol: 'kenwood', caps: {}, cw: {} };

test('TS-480 SM0015 (S9 native) scales to 120 (renders S9)', () => {
  const codec = new KenwoodCodec(TS480_MODEL, () => {});
  let v = null; codec.on('smeter', (x) => { v = x; });
  codec.onData(Buffer.from('SM0015;'));
  assert.strictEqual(v, 120);
});

test('TS-480 SM0030 (full scale) scales to 240 (renders S9+)', () => {
  const codec = new KenwoodCodec(TS480_MODEL, () => {});
  let v = null; codec.on('smeter', (x) => { v = x; });
  codec.onData(Buffer.from('SM0030;'));
  assert.strictEqual(v, 240);
});

test('TS-480 RM10015 (4-digit, mid meter) parses 15 and scales to 60 (2.0:1, not blank)', () => {
  const codec = new KenwoodCodec(TS480_MODEL, () => {});
  let v = null; codec.on('swr', (x) => { v = x; });
  codec.onData(Buffer.from('RM10015;'));
  assert.strictEqual(v, 60);
});

test('TS-480 RM30015 (ALC mid) scales to 128 of 255', () => {
  const codec = new KenwoodCodec(TS480_MODEL, () => {});
  let v = null; codec.on('alc', (x) => { v = x; });
  codec.onData(Buffer.from('RM30015;'));
  assert.strictEqual(v, 128);
});

test('TS-890S per-model 0-70 meter: SM0035 (S9) scales to 120', () => {
  const codec = new KenwoodCodec({ ...TS480_MODEL, smS9: 35, rmFull: 70 }, () => {});
  let v = null; codec.on('smeter', (x) => { v = x; });
  codec.onData(Buffer.from('SM0035;'));
  assert.strictEqual(v, 120);
});

test('Yaesu SM passes through unscaled (already 0-255)', () => {
  const codec = new KenwoodCodec(FT891_MODEL, () => {});
  let v = null; codec.on('smeter', (x) => { v = x; });
  codec.onData(Buffer.from('SM0128;'));
  assert.strictEqual(v, 128);
});

test('Yaesu RM keeps the 3-digit clamp (FTX-1 extra-field guard intact)', () => {
  const codec = new KenwoodCodec(FT891_MODEL, () => {});
  let v = null; codec.on('swr', (x) => { v = x; });
  codec.onData(Buffer.from('RM4120999;')); // value 120, appended fields ignored
  assert.strictEqual(v, 120);
});

test('Non-Kenwood non-Yaesu brand passes through (no unmeasured scaling)', () => {
  const codec = new KenwoodCodec({ brand: 'Elecraft', protocol: 'kenwood', caps: {}, cw: {} }, () => {});
  let v = null; codec.on('smeter', (x) => { v = x; });
  codec.onData(Buffer.from('SM0012;'));
  assert.strictEqual(v, 12);
});

// =========================================================================
// K6RBJ hamlib-controls regression (2026-08-03): the works/fails inventory
// mapped 1:1 to correct-vs-wrong rigctl verbs. RF gain used the nonexistent
// level token RFGAIN (hamlib's is RF), preamp/ATT were sent as functions
// (hamlib has them only as dB LEVELS), NR wasn't implemented at all. These
// pin the corrected verbs, the dump_caps dB probe, and RPRT attribution.
console.log('\n=== RigctldCodec hamlib verbs (K6RBJ) ===');
// (Reuses RIGCTLD_MODEL / RIGCTLD_YAESU_MODEL declared above.)

test('rigctld setRfGain -> L RF (hamlib token is RF, not RFGAIN)', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setRfGain(0.5);
  assert.strictEqual(writes[0], 'L RF 0.500\n');
});

test('rigctld setRfGain Yaesu raw passthrough unchanged', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  codec.setRfGain(0.5);
  assert.strictEqual(writes[0], 'w RG0128;\n');
});

test('rigctld setPreamp is a LEVEL: on -> L PREAMP 10 (default), off -> L PREAMP 0', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setPreamp(true);
  codec.setPreamp(false);
  assert.deepStrictEqual(writes, ['L PREAMP 10\n', 'L PREAMP 0\n']);
});

test('rigctld setAttenuator is a LEVEL: on -> L ATT 12 (default), off -> L ATT 0', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setAttenuator(true);
  codec.setAttenuator(false);
  assert.deepStrictEqual(writes, ['L ATT 12\n', 'L ATT 0\n']);
});

test('rigctld Yaesu preamp/ATT raw passthrough unchanged', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  codec.setPreamp(true);
  codec.setAttenuator(true);
  assert.deepStrictEqual(writes, ['w PA01;\n', 'w RA01;\n']);
});

test('rigctld setNoiseReduction -> U NR 1/0', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setNoiseReduction(true);
  codec.setNoiseReduction(false);
  assert.deepStrictEqual(writes, ['U NR 1\n', 'U NR 0\n']);
});

test('rigctld setNrLevel 50 (app pct) -> L NR 0.500', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setNrLevel(50);
  assert.strictEqual(writes[0], 'L NR 0.500\n');
});

test('rigctld setNrLevel Yaesu -> w RL0nn; (1..15 depth scale)', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  codec.setNrLevel(50);
  assert.strictEqual(writes[0], 'w RL008;\n');
});

// N4RDX (IC-706MK2G, 2026-08-03): comp/VOX never existed in this codec, so
// the desktop toggles either latched while sending NOTHING (pre-1.9.22) or
// went dead (1.9.22 loud refusal). These pin the hamlib funcs.
test('rigctld setCompressor -> U COMP 1/0', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setCompressor(true);
  codec.setCompressor(false);
  assert.deepStrictEqual(writes, ['U COMP 1\n', 'U COMP 0\n']);
});

test('rigctld setVox -> U VOX 1/0', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.setVox(true);
  codec.setVox(false);
  assert.deepStrictEqual(writes, ['U VOX 1\n', 'U VOX 0\n']);
});

test('rigctld Yaesu-raw comp/VOX refuse (false, nothing written) — no lie latch', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_YAESU_MODEL);
  assert.strictEqual(codec.setCompressor(true), false);
  assert.strictEqual(codec.setVox(true), false);
  assert.deepStrictEqual(writes, []);
});

test('dump_caps probe adopts the rig\'s real preamp/ATT dB steps', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.probeCaps();
  assert.strictEqual(writes[0], '\\dump_caps\n');
  codec.onData('Preamp: 20dB\nAttenuator: 6dB 12dB\nRPRT 0\n');
  codec.setPreamp(true);
  codec.setAttenuator(true);
  assert.strictEqual(writes[1], 'L PREAMP 20\n');
  assert.strictEqual(writes[2], 'L ATT 6\n'); // lowest step = safe "on"
});

test('probed dB list becomes a reachable ladder, not just its lowest step', () => {
  // The probe kept only dbs[0], so a hamlib rig was pinned to its lowest
  // preamp/ATT position exactly like KB2UXB's serial FT-710 (2026-08-04).
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  codec.probeCaps();
  codec.onData('Preamp: 10dB 20dB\nAttenuator: 6dB 12dB 18dB\nRPRT 0\n');
  const steps = codec.getGainSteps();
  assert.deepStrictEqual(steps.preampSteps.map((s) => s.v), [0, 10, 20]);
  assert.deepStrictEqual(steps.attSteps.map((s) => s.v), [0, 6, 12, 18]);
  codec.setPreamp(20);
  codec.setAttenuator(18);
  assert.strictEqual(writes[1], 'L PREAMP 20\n');
  assert.strictEqual(writes[2], 'L ATT 18\n');
});

test('un-probed rigctld keeps the legacy single-step fallback', () => {
  const { codec, writes } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  assert.deepStrictEqual(codec.getGainSteps(), { preampSteps: [], attSteps: [] });
  codec.setPreamp(true);
  codec.setAttenuator(true);
  assert.strictEqual(writes[0], 'L PREAMP 10\n');
  assert.strictEqual(writes[1], 'L ATT 12\n');
});

test('dump_caps swallow mode: dump lines cannot misparse as frequency', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  const freqs = [];
  codec.on('frequency', (hz) => freqs.push(hz));
  codec.probeCaps();
  // A bare large integer inside the dump must be swallowed; after the RPRT
  // terminator, real responses parse normally again.
  codec.onData('Max power: 100 W\n14074000\nPreamp: 10dB\nRPRT 0\n');
  assert.deepStrictEqual(freqs, []);
  codec.onData('14074000\n');
  assert.deepStrictEqual(freqs, [14074000]);
});

test('RPRT rejection within 1.5s of a control names the command', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  const logs = [];
  codec.on('log', (m) => logs.push(m));
  codec.setPreamp(true);
  codec.onData('RPRT -11\n');
  assert.ok(logs.some((l) => l.includes('likely rejecting "L PREAMP 10"')), `got: ${logs.join(' | ')}`);
  // Attribution is consumed — a repeat of the same code without a fresh
  // user command falls back to the on-change dedup (no second line).
  const before = logs.length;
  codec.onData('RPRT -11\n');
  assert.strictEqual(logs.length, before);
});

// =========================================================================
// RigController: unsupported controls are LOUD refusals (return false + one
// log line), and the poll-staleness watchdog flips status when the radio
// behind a live transport stops answering (K6RBJ's rigctld staleness trap).
console.log('\n=== RigController guards + staleness watchdog ===');

const { RigController } = require('../lib/rig-controller');
const { EventEmitter } = require('events');

function stubRig(codecMethods = {}) {
  const transport = new EventEmitter();
  transport.connect = () => {};
  transport.disconnect = () => {};
  transport.write = () => {};
  const codec = new EventEmitter();
  codec.setTransmit = () => {};
  Object.assign(codec, codecMethods);
  const rig = new RigController({ brand: 'Test', protocol: 'rigctld', caps: {}, cw: {} }, transport, codec);
  // Simulate an established link WITHOUT emitting transport 'connect' (that
  // schedules real polling timers, which would keep the test process alive).
  rig.connected = true;
  rig._target = { host: 'test' };
  return { rig, transport, codec };
}

test('unsupported control returns false and logs once', () => {
  const { rig } = stubRig(); // codec has no setNoiseReduction
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  assert.strictEqual(rig.setNoiseReduction(true), false);
  assert.strictEqual(rig.setNoiseReduction(true), false);
  const warnings = logs.filter((l) => l.includes('NR is not supported'));
  assert.strictEqual(warnings.length, 1);
});

test('supported control returns true and reaches the codec', () => {
  const calls = [];
  const { rig } = stubRig({ setNoiseReduction: (on) => calls.push(on) });
  assert.strictEqual(rig.setNoiseReduction(true), true);
  assert.deepStrictEqual(calls, [true]);
});

test('codec per-connection refusal (returns false) propagates as loud refusal', () => {
  // rigctld Yaesu-raw has the comp/VOX methods but refuses at call time —
  // the controller must surface that identically to a missing method so
  // main.js never latches state for a command that was never sent.
  const { rig } = stubRig({ setCompressor: () => false, setVox: () => false });
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  assert.strictEqual(rig.setCompressor(true), false);
  assert.strictEqual(rig.setVox(true), false);
  assert.ok(logs.some((l) => l.includes('Compressor is not supported')), `got: ${logs.join(' | ')}`);
  assert.ok(logs.some((l) => l.includes('VOX is not supported')), `got: ${logs.join(' | ')}`);
});

test('watchdog: silent polls flip status to disconnected (stale)', () => {
  const { rig } = stubRig();
  const statuses = [];
  rig.on('status', (s) => statuses.push(s));
  rig._lastReadOkMs = Date.now() - (RigController.POLL_STALE_MS + 1000);
  rig._checkPollStaleness();
  assert.strictEqual(rig.connected, false);
  assert.strictEqual(rig._linkStale, true);
  assert.strictEqual(statuses.length, 1);
  assert.strictEqual(statuses[0].connected, false);
  assert.strictEqual(statuses[0].stale, true);
});

test('watchdog: first successful read recovers the link', () => {
  const { rig, codec } = stubRig();
  const statuses = [];
  rig.on('status', (s) => statuses.push(s));
  rig._lastReadOkMs = Date.now() - (RigController.POLL_STALE_MS + 1000);
  rig._checkPollStaleness();
  codec.emit('frequency', 14074000); // poll answered again
  assert.strictEqual(rig.connected, true);
  assert.strictEqual(rig._linkStale, false);
  assert.strictEqual(statuses.length, 2);
  assert.strictEqual(statuses[1].connected, true);
});

test('watchdog: TX never counts toward staleness (TS-480 mutes CAT in TX)', () => {
  const { rig } = stubRig();
  const statuses = [];
  rig.on('status', (s) => statuses.push(s));
  rig._transmitting = true;
  rig._lastReadOkMs = Date.now() - (RigController.POLL_STALE_MS + 60000);
  rig._checkPollStaleness();
  assert.strictEqual(rig.connected, true);
  assert.strictEqual(rig._linkStale, false);
  assert.deepStrictEqual(statuses, []);
});

// =========================================================================
// VFO A/B + split readback (LZ3AW, TS-480SAT, 2026-08-03). The whole stack
// was hardwired to FA (VFO A): a radio on VFO B displayed VFO A's frequency
// forever, spot-tunes wrote the inactive VFO, and _currentVfo/_split were
// optimistic-only. These pin the Kenwood IF; parse, the VFO-aware freq
// poll/tune, and the rigctld v/s parse (incl. the VFOB-as-phantom-mode trap).
console.log('\n=== VFO/split readback (LZ3AW) ===');

const KENWOOD_VFO_MODEL = { brand: 'Kenwood', protocol: 'kenwood', caps: {}, cw: {} };
// Kenwood IF; frame, built field by field from the published layout so the
// fixture is pinned to the SPEC and not to whatever the parser happens to do.
// The first version of this helper padded P2 to five characters, which made
// the frame 39 chars and moved every field after it one to the right — and
// because the parser was written from the same mistake, the tests passed while
// a real TS-480 reported "VFO A, no split" forever (LZ3AW 2026-08-05). The
// length assertion below is the guard: the response is 38 chars WITH the ';'.
//   P1 freq(11) P2 step(4) P3 rit(6) P4 P5 P6 P7(2) P8 P9 P10 P11 P12 P13 P14(2) P15
function kenwoodIf({ freq = '00014074000', vfo = '0', split = '0' } = {}) {
  const frame = 'IF'
    + freq          // P1  11 — operating frequency
    + '0000'        // P2   4 — step size
    + '+00000'      // P3   6 — RIT/XIT offset
    + '0'           // P4   1 — RIT on
    + '0'           // P5   1 — XIT on
    + '0'           // P6   1 — memory bank
    + '00'          // P7   2 — memory channel
    + '0'           // P8   1 — RX/TX
    + '2'           // P9   1 — mode
    + vfo           // P10  1 — RX VFO  (idx 30)
    + '0'           // P11  1 — scan
    + split         // P12  1 — split   (idx 32)
    + '0'           // P13  1 — tone
    + '00'          // P14  2 — tone number
    + '0'           // P15  1 — always 0
    + ';';
  return frame;
}

test('kenwood IF; fixture matches the published 38-char frame', () => {
  const f = kenwoodIf();
  assert.strictEqual(f.length, 38, `IF; frame must be 38 chars incl. ';', got ${f.length}: ${f}`);
  assert.strictEqual(f.charAt(30), '0', 'P10 (RX VFO) sits at index 30');
  assert.strictEqual(f.charAt(32), '0', 'P12 (split) sits at index 32');
});

test('kenwood IF; parse -> vfo B + split on', () => {
  const { codec } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  let vfo = null, split = null;
  codec.on('vfo', (v) => { vfo = v; });
  codec.on('split', (s) => { split = s; });
  codec.onData(Buffer.from(kenwoodIf({ vfo: '1', split: '1' })));
  assert.strictEqual(vfo, 'B');
  assert.strictEqual(split, true);
});

// Off-by-one detector. P11 (scan) and P13 (tone) sit immediately after the two
// fields we read; light THEM up and leave P10/P12 idle. Reading one character
// too far — the original bug — reports "VFO B, split on" from a radio that is
// on A and simplex.
test('kenwood IF; reads P10/P12, not their neighbours P11/P13', () => {
  const { codec } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  let vfo = null, split = null;
  codec.on('vfo', (v) => { vfo = v; });
  codec.on('split', (s) => { split = s; });
  const frame = kenwoodIf().replace(/^(.{31})0(.)0/, '$11$21'); // P11=1, P13=1
  assert.strictEqual(frame.length, 38, 'neighbour frame still 38 chars');
  assert.strictEqual(frame.charAt(31), '1', 'P11 lit');
  assert.strictEqual(frame.charAt(33), '1', 'P13 lit');
  codec.onData(Buffer.from(frame));
  assert.strictEqual(vfo, 'A', 'scan status must not be read as the VFO digit');
  assert.strictEqual(split, false, 'tone must not be read as the split flag');
});

test('kenwood IF; memory mode (P10=2) leaves vfo untouched, split still parsed', () => {
  const { codec } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  let vfo = null, split = null;
  codec.on('vfo', (v) => { vfo = v; });
  codec.on('split', (s) => { split = s; });
  codec.onData(Buffer.from(kenwoodIf({ vfo: '2', split: '0' })));
  assert.strictEqual(vfo, null);
  assert.strictEqual(split, false);
});

test('kenwood freq poll follows the active VFO: FA; then FB; after IF says B', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  codec.getFrequency();
  codec.onData(Buffer.from(kenwoodIf({ vfo: '1' })));
  codec.getFrequency();
  assert.deepStrictEqual(writes, ['FA;', 'FB;']);
});

test('kenwood FB moves the dial only when VFO B is active', () => {
  const { codec } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  let hz = 0, other = 0;
  codec.on('frequency', (v) => { hz = v; });
  codec.on('frequencyOther', (v) => { other = v; });
  // On VFO A (default), no split: an FB frame must NOT clobber the dial —
  // that's B's frequency, not what the operator hears.
  codec.onData(Buffer.from('FB00007074000;'));
  assert.strictEqual(hz, 0);
  assert.strictEqual(other, 0);
  // IF says VFO B active -> FB IS the dial.
  codec.onData(Buffer.from(kenwoodIf({ vfo: '1' })));
  codec.onData(Buffer.from('FB00007074000;'));
  assert.strictEqual(hz, 7074000);
});

test('kenwood split: the other VFO polls and lands as frequencyOther', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  let hz = 0, other = 0;
  codec.on('frequency', (v) => { hz = v; });
  codec.on('frequencyOther', (v) => { other = v; });
  codec.onData(Buffer.from(kenwoodIf({ vfo: '0', split: '1' })));  // A active, split on
  writes.length = 0;
  codec.getFrequency();
  assert.deepStrictEqual(writes, ['FA;', 'FB;'], 'split polls BOTH VFOs');
  codec.onData(Buffer.from('FA00014235000;'));
  codec.onData(Buffer.from('FB00014310000;'));
  assert.strictEqual(hz, 14235000, 'active VFO drives the dial');
  assert.strictEqual(other, 14310000, 'other VFO surfaces as frequencyOther (the TX line)');
});

test('kenwood tune targets the active VFO (FB write after IF says B)', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  codec.onData(Buffer.from(kenwoodIf({ vfo: '1' })));
  codec.setFrequency(7074000);
  assert.strictEqual(writes[0], 'FB00007074000;');
});

test('kenwood setVfo(B) retargets the next freq poll optimistically', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  codec.setVfo('B');
  codec.getFrequency();
  assert.deepStrictEqual(writes, ['FR1;', 'FB;']);
});

test('kenwood getVfoSplit polls IF;', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, KENWOOD_VFO_MODEL);
  codec.getVfoSplit();
  assert.strictEqual(writes[0], 'IF;');
});

test('Yaesu is gated out: getVfoSplit no-ops, IF-shaped input emits nothing, FA polling unchanged', () => {
  const { codec, writes } = captureWrites(KenwoodCodec, FT891_MODEL);
  let emitted = false;
  codec.on('vfo', () => { emitted = true; });
  codec.on('split', () => { emitted = true; });
  codec.getVfoSplit();
  codec.onData(Buffer.from(kenwoodIf({ vfo: '1', split: '1' })));
  codec.setVfo('B');           // VS1; write still works (no readback yet)
  codec.getFrequency();        // must stay FA; — no _rxVfo flip without readback
  assert.strictEqual(emitted, false);
  assert.ok(!writes.includes('IF;'));
  assert.strictEqual(writes[writes.length - 1], 'FA;');
});

test('rigctld v/s parse: VFOB is consumed, never a phantom mode', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let vfo = null, split = null;
  const modes = [];
  codec.on('vfo', (v) => { vfo = v; });
  codec.on('split', (s) => { split = s; });
  codec.on('mode', (m) => modes.push(m));
  codec.getVfoSplit();
  codec.onData('VFOB\n1\nVFOA\n'); // v answer, then s's two lines
  assert.strictEqual(vfo, 'B');
  assert.strictEqual(split, true);
  assert.deepStrictEqual(modes, []);
});

test('rigctld split off parses and the TX-VFO line is swallowed', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  let split = null;
  const modes = [];
  codec.on('split', (s) => { split = s; });
  codec.on('mode', (m) => modes.push(m));
  codec.getVfoSplit();
  codec.onData('VFOA\n0\nVFOA\n');
  assert.strictEqual(split, false);
  assert.deepStrictEqual(modes, []);
});

test('rigctld RPRT clears vfo/split expects; mode parsing resumes', () => {
  const { codec } = captureWrites(RigctldCodec, RIGCTLD_MODEL);
  const modes = [];
  codec.on('mode', (m) => modes.push(m));
  codec.getVfoSplit();
  codec.onData('RPRT -11\n');   // backend without get_vfo — expects must clear
  codec.onData('USB\n3000\n');  // a real mode response must parse normally
  assert.deepStrictEqual(modes, ['USB']);
});

// =========================================================================
// A mode the codec CANNOT parse, and a mode reply that never comes, are both
// silent today: _currentMode stays '' and every client hides PTT/HALT because
// an empty mode fails the voice-mode whitelist. KQ4DX 2026-08-10 — 40 minutes
// of `ignored implausible mode ""` on the phone with a CAT link answering
// frequency and S-meter every second, and nothing anywhere naming the cause.
console.log('\n=== mode-unknown diagnostics (KQ4DX) ===');

test('kenwood: unrecognized MD value logs once, and emits no mode', () => {
  const { codec } = captureWrites(KenwoodCodec, { brand: 'Kenwood', protocol: 'kenwood', caps: {}, cw: {} });
  const logs = [];
  const modes = [];
  codec.on('log', (m) => logs.push(m));
  codec.on('mode', (m) => modes.push(m));
  codec.onData('MD0;');  // 0 is in no parse table
  codec.onData('MD0;');  // deduped — this poll runs once a second
  codec.onData('MD0;');
  assert.deepStrictEqual(modes, []);
  const hits = logs.filter((l) => l.includes('unrecognized mode reply'));
  assert.strictEqual(hits.length, 1, `got: ${logs.join(' | ')}`);
  assert.ok(hits[0].includes('MD value 0'), hits[0]);
});

test('kenwood: a DIFFERENT unrecognized value logs again (dedupe is per value)', () => {
  const { codec } = captureWrites(KenwoodCodec, { brand: 'Kenwood', protocol: 'kenwood', caps: {}, cw: {} });
  const logs = [];
  codec.on('log', (m) => logs.push(m));
  codec.onData('MD0;');
  codec.onData('MD8;');
  assert.strictEqual(logs.filter((l) => l.includes('unrecognized mode reply')).length, 2);
});

test('kenwood: a RECOGNIZED mode still emits and logs nothing', () => {
  const { codec } = captureWrites(KenwoodCodec, { brand: 'Kenwood', protocol: 'kenwood', caps: {}, cw: {} });
  const logs = [];
  const modes = [];
  codec.on('log', (m) => logs.push(m));
  codec.on('mode', (m) => modes.push(m));
  codec.onData('MD2;');
  assert.deepStrictEqual(modes, ['USB']);
  assert.strictEqual(logs.filter((l) => l.includes('unrecognized')).length, 0);
});

test('civ: unrecognized mode byte logs once, and emits no mode', () => {
  const { codec } = captureWrites(CivCodec, { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: {}, cw: {} });
  const logs = [];
  const modes = [];
  codec.on('log', (m) => logs.push(m));
  codec.on('mode', (m) => modes.push(m));
  // FE FE E0 94 04 <mode> <filter> FD — 0x22 is in no parse table
  const frame = Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x04, 0x22, 0x01, 0xFD]);
  codec.onData(frame);
  codec.onData(frame);
  assert.deepStrictEqual(modes, []);
  const hits = logs.filter((l) => l.includes('unrecognized CI-V mode byte'));
  assert.strictEqual(hits.length, 1, `got: ${logs.join(' | ')}`);
  assert.ok(hits[0].includes('0x22'), hits[0]);
});

test('civ: a RECOGNIZED mode byte still emits and logs nothing', () => {
  const { codec } = captureWrites(CivCodec, { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: {}, cw: {} });
  const logs = [];
  const modes = [];
  codec.on('log', (m) => logs.push(m));
  codec.on('mode', (m) => modes.push(m));
  codec.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x04, 0x01, 0x01, 0xFD])); // USB
  assert.deepStrictEqual(modes, ['USB']);
  assert.strictEqual(logs.filter((l) => l.includes('unrecognized')).length, 0);
});

test('civ: a frame we do not consume is logged once per command byte', () => {
  const { codec } = captureWrites(CivCodec, { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: {}, cw: {} });
  const logs = [];
  codec.on('log', (m) => logs.push(m));
  // cmd 0x1A (rig-specific settings) — addressed to us, framed fine, unconsumed.
  const f = Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x1A, 0x06, 0x01, 0xFD]);
  codec.onData(f);
  codec.onData(f);
  const hits = logs.filter((l) => l.includes('unhandled CI-V frame'));
  assert.strictEqual(hits.length, 1, `got: ${logs.join(' | ')}`);
  assert.ok(hits[0].includes('cmd=0x1a'), hits[0]);
});

test('civ: the unhandled-frame diagnostic is capped so garbage cannot flood', () => {
  const { codec } = captureWrites(CivCodec, { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: {}, cw: {} });
  const logs = [];
  codec.on('log', (m) => logs.push(m));
  for (let cmd = 0x20; cmd < 0x40; cmd++) {
    codec.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, cmd, 0x00, 0xFD]));
  }
  assert.strictEqual(logs.filter((l) => l.includes('unhandled CI-V frame')).length, 8);
});

test('civ: a frequency frame that will not decode names the baud suspect', () => {
  const { codec } = captureWrites(CivCodec, { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: {}, cw: {} });
  const logs = [];
  const freqs = [];
  codec.on('log', (m) => logs.push(m));
  codec.on('frequency', (hz) => freqs.push(hz));
  // All-zero BCD decodes to 0 — the `hz > 0` guard that used to drop silently.
  const f = Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFD]);
  codec.onData(f);
  codec.onData(f);
  assert.deepStrictEqual(freqs, []);
  const hits = logs.filter((l) => l.includes('did not decode'));
  assert.strictEqual(hits.length, 1, `got: ${logs.join(' | ')}`);
  assert.ok(hits[0].includes('baud'), hits[0]);
});

test('civ: a GOOD frequency frame still parses and logs no baud suspicion', () => {
  const { codec } = captureWrites(CivCodec, { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: {}, cw: {} });
  const logs = [];
  const freqs = [];
  codec.on('log', (m) => logs.push(m));
  codec.on('frequency', (hz) => freqs.push(hz));
  // 14.074000 MHz, CI-V little-endian BCD: 00 40 07 14 00
  codec.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x03, 0x00, 0x40, 0x07, 0x14, 0x00, 0xFD]));
  assert.deepStrictEqual(freqs, [14074000]);
  assert.strictEqual(logs.filter((l) => l.includes('did not decode')).length, 0);
});

test('mode-silence watchdog: answering rig that never reports mode logs once', () => {
  const { rig } = stubRig();
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  rig._debug = true;
  rig._lastReadOkMs = Date.now();                                        // freq/meters ARE answering
  rig._pollStartedMs = Date.now() - (RigController.MODE_SILENCE_MS + 1000);
  rig._checkModeSilence();
  rig._checkModeSilence();
  const hits = logs.filter((l) => l.includes('never reported its MODE'));
  assert.strictEqual(hits.length, 1, `got: ${logs.join(' | ')}`);
});

test('mode-silence watchdog: silent BEFORE the window is not yet a fault', () => {
  const { rig } = stubRig();
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  rig._lastReadOkMs = Date.now();
  rig._pollStartedMs = Date.now() - 1000;
  rig._checkModeSilence();
  assert.strictEqual(logs.length, 0);
});

test('mode-silence watchdog: a rig that HAS reported a mode never trips it', () => {
  const { rig, codec } = stubRig();
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  codec.emit('mode', 'USB');
  rig._lastReadOkMs = Date.now();
  rig._pollStartedMs = Date.now() - (RigController.MODE_SILENCE_MS + 60000);
  rig._checkModeSilence();
  assert.strictEqual(logs.filter((l) => l.includes('never reported its MODE')).length, 0);
});

test('mode-silence watchdog: stays quiet when NOTHING answers (staleness owns that)', () => {
  // Two theories for one symptom would send the operator down the wrong path —
  // "nothing is answering" and "everything but mode is answering" need
  // different fixes, so only one of them may speak.
  const { rig } = stubRig();
  const logs = [];
  rig.on('log', (m) => logs.push(m));
  rig._linkStale = true;
  rig._lastReadOkMs = Date.now() - 60000;
  rig._pollStartedMs = Date.now() - (RigController.MODE_SILENCE_MS + 60000);
  rig._checkModeSilence();
  assert.strictEqual(logs.filter((l) => l.includes('never reported its MODE')).length, 0);
});

test('mode-silence watchdog: a tune sequence pause does not restart the clock', () => {
  // _startPolling() re-runs after every tune. Restarting the window there meant
  // a station tuning more often than MODE_SILENCE_MS would never reach the check.
  const { rig } = stubRig();
  const started = Date.now() - (RigController.MODE_SILENCE_MS + 5000);
  rig._pollStartedMs = started;
  rig._startPolling();
  try {
    assert.strictEqual(rig._pollStartedMs, started);
  } finally {
    rig._stopPolling(); // don't leave an interval holding the process open
  }
});

// =========================================================================
console.log('\n=== rigctld queue-order attribution (#81) + extended readback (#82) ===');

// Harness: a codec whose writes are captured and whose replies we feed by
// hand — the sequences below are VERBATIM from GoNoGoTest's wfview/IC-7300
// reproduction, not fixtures invented from the parser (the vfo-split lesson).
function rigctldHarness() {
  const { codec, writes } = captureWrites(RigctldCodec, {
    brand: 'Hamlib', protocol: 'rigctld',
    caps: { nb: true, rfgain: true, txpower: true, preamp: true, att: true },
    maxPower: 100,
  });
  const events = [];
  for (const ev of ['ptt', 'nb', 'split', 'vfo', 'nr', 'comp', 'vox', 'anf', 'rfgain', 'power', 'preamp', 'preampStep', 'att', 'attStep', 'smeter', 'frequency']) {
    codec.on(ev, (val) => events.push([ev, val]));
  }
  const feed = (lines) => { for (const l of lines) codec.onData(l + '\n'); };
  return { codec, writes, events, feed };
}

test('#81 Test 1: SPLIT ON + NB OFF — NB must not steal SPLIT\'s 1', () => {
  const h = rigctldHarness();
  h.codec.getPtt();       // t
  h.codec.getVfoSplit();  // v + s
  h.codec.getNb();        // u NB
  h.feed(['0', 'VFOA', '1', 'VFOA', '0']); // ptt, vfo, split=ON, txvfo, nb=OFF
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'split'), [['split', true]]);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'nb'), [['nb', false]]);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'ptt'), [['ptt', false]]);
});

test('#81 Test 2: SPLIT OFF + NB ON — the mirror image', () => {
  const h = rigctldHarness();
  h.codec.getPtt();
  h.codec.getVfoSplit();
  h.codec.getNb();
  h.feed(['0', 'VFOA', '0', 'VFOA', '1']);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'split'), [['split', false]]);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'nb'), [['nb', true]]);
});

test('smeter sent first keeps its 0 — NB no longer outranks the queue', () => {
  const h = rigctldHarness();
  h.codec.getSmeter();    // l STRENGTH — "0" here means S9, a legal reading
  h.codec.getNb();
  h.feed(['0', '1']);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'smeter').length, 1);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'nb'), [['nb', true]]);
});

test('#82 rfgain/power readback: wfview\'s exact float replies', () => {
  const h = rigctldHarness();
  h.codec.getRfGain();    // l RF
  h.codec.getPower();     // l RFPOWER
  h.feed(['0.129412', '0.498039']);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'rfgain'), [['rfgain', 13]]);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'power'), [['power', 50]]);
  assert.ok(h.writes.includes('l RF\n') && h.writes.includes('l RFPOWER\n'));
});

test('#82 preamp/att readback: integer dB maps to step + boolean', () => {
  const h = rigctldHarness();
  h.codec.getPreamp();
  h.codec.getAtt();
  h.feed(['10', '0']);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'preampStep'), [['preampStep', 10]]);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'preamp'), [['preamp', true]]);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'attStep'), [['attStep', 0]]);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'att'), [['att', false]]);
});

test('#82 toggles: NR/COMP/VOX/ANF track queue order among five bare digits', () => {
  const h = rigctldHarness();
  h.codec.getDnrLevel();     // u NR
  h.codec.getCompressor();   // u COMP
  h.codec.getVox();          // u VOX
  h.codec.getAutoNotch();    // u ANF
  h.codec.getNb();           // u NB
  // getDnrLevel sends TWO queries (u NR + l NR), so SIX replies come back.
  // This test used to feed five and lean on the nrlevel acceptor rejecting
  // a bare '0' — true for wfview's always-decimal floats, FALSE for hamlib
  // proper, whose %g prints zero as '0' (K6RBJ 2026-08-28: that assumption
  // let boundary float replies cascade into the toggle kinds and pinned
  // NB/preamp ON). Model the real stream: every query answers, in order.
  h.feed(['1', '0', '0', '1', '0', '1']);
  assert.deepStrictEqual(h.events, [
    ['nr', true], ['comp', false], ['vox', true], ['anf', false], ['nb', true],
  ]);
});

test('#82 RPRT rejection latches an extended readback off', () => {
  const h = rigctldHarness();
  h.codec.getRfGain();
  h.feed(['RPRT -11']);
  const before = h.writes.length;
  h.codec.getRfGain(); // latched — must write nothing
  assert.strictEqual(h.writes.length, before);
});

test('freq reply still resolves through the queue with meters in flight', () => {
  const h = rigctldHarness();
  h.codec.getFrequency();
  h.codec.getSmeter();
  h.feed(['14250000', '-20']);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'frequency'), [['frequency', 14250000]]);
  assert.strictEqual(h.events.filter(e => e[0] === 'smeter').length, 1);
});

// --- Round 3 (#82 retest): the full GoNoGoTest matrix ---
function rigctldHarness3() {
  const { codec, writes } = captureWrites(RigctldCodec, {
    brand: 'Hamlib', protocol: 'rigctld', caps: {}, maxPower: 100,
  });
  const events = [];
  for (const ev of ['agc', 'nrLevel', 'voxLevel', 'monLevel', 'micGain', 'compLevel', 'mon', 'rit', 'atu', 'passband', 'mode']) {
    codec.on(ev, (val) => events.push([ev, val]));
  }
  const feed = (lines) => { for (const l of lines) codec.onData(l + '\n'); };
  return { codec, writes, events, feed };
}

test('round-3 setters write the wfview-verified commands', () => {
  const h = rigctldHarness3();
  h.codec.setAutoNotch(true);
  h.codec.setAgc('slow');
  h.codec.setNrLevel(72);
  h.codec.setVoxLevel(50);
  h.codec.setMonitor(true);
  h.codec.setMonLevel(25);
  h.codec.setMicGain(40);
  h.codec.setCompLevel(30);
  h.codec.setRit(true);
  assert.deepStrictEqual(h.writes, [
    'U ANF 1\n', 'L AGC 3\n', 'L NR 0.720\n', 'L VOXGAIN 0.500\n',
    'U MON 1\n', 'L MONITOR_GAIN 0.250\n', 'L MICGAIN 0.400\n',
    'L COMP 0.300\n', 'U RIT 1\n',
  ]);
});

test('round-3 readbacks: levels scale to percent, AGC maps to mode strings', () => {
  const h = rigctldHarness3();
  h.codec.getAgc();
  h.codec.getDnrLevel();     // u NR + l NR
  h.codec.getVoxLevel();
  h.codec.getMonLevel();
  h.codec.getMicGain();
  h.codec.getCompLevel();
  h.codec.getMonitor();
  h.codec.getRit();
  h.codec.getAtuEnabled();
  h.feed(['2', '1', '0.721569', '0.500000', '0.250000', '0.400000', '0.300000', '1', '0', '1']);
  assert.deepStrictEqual(h.events, [
    ['agc', 'mid'], ['nrLevel', 72], ['voxLevel', 50], ['monLevel', 25],
    ['micGain', 40], ['compLevel', 30], ['mon', true], ['rit', false], ['atu', true],
  ]);
});

test('round-3: passband after mode is surfaced, not swallowed', () => {
  const h = rigctldHarness3();
  h.codec.getMode();
  h.feed(['USB', '2400']);
  assert.deepStrictEqual(h.events.filter(e => e[0] === 'passband'), [['passband', 2400]]);
});

test('round-3: ATU one-shot sends the vfo_op TUNE cycle', () => {
  const h = rigctldHarness3();
  h.codec.startTune();
  assert.ok(h.writes.includes('G TUNE\n'), 'G TUNE missing: ' + JSON.stringify(h.writes));
});

// K6RBJ regression (2026-08-28): a FULL ext poll cycle attributed correctly.
// Two bugs conspired to pin NB/preamp ON against every off-command on his
// IC-7100: RIGCTLD_PENDING_MAX (12) was smaller than the ~24-command ext
// cycle, so the write-side cap evicted the first half of the cycle's queue
// entries before any reply arrived and the whole cycle misattributed (NB's
// "1" became preamp=true; the real preamp reply fell unclaimed); and the
// float acceptors required a '.', which hamlib's %g formatting omits at the
// boundaries ("0" at zero, "1" at full scale — verified live on rigctld
// 4.7.0; wfview always prints decimals, which is what round 3 validated
// against). The reply stream below is the real dummy-rig stream, boundary
// values included. With the old cap/acceptors this test fails loudly.
function rigctldFullCycleHarness() {
  const { codec, writes } = captureWrites(RigctldCodec, {
    brand: 'Hamlib', protocol: 'rigctld', caps: {}, maxPower: 100,
  });
  const events = [];
  for (const ev of ['frequency', 'mode', 'ptt', 'vfo', 'split', 'smeter', 'power',
    'nb', 'rfgain', 'agc', 'anf', 'vox', 'voxLevel', 'nr', 'nrLevel', 'comp',
    'compLevel', 'mon', 'micGain', 'preamp', 'preampStep', 'att', 'attStep',
    'monLevel', 'rit', 'atu']) {
    codec.on(ev, (val) => events.push([ev, val]));
  }
  const feed = (lines) => { for (const l of lines) codec.onData(l + '\n'); };
  return { codec, writes, events, feed };
}

test('K6RBJ: full 24-command ext cycle, every reply lands on its own control', () => {
  const h = rigctldFullCycleHarness();
  // Exactly what RigController sends on an every-5th poll tick, same order.
  h.codec.getFrequency(); h.codec.getMode(); h.codec.getPtt();
  h.codec.getVfoSplit(); h.codec.getSmeter(); h.codec.getPower();
  h.codec.getNb(); h.codec.getRfGain(); h.codec.getAgc();
  h.codec.getAutoNotch(); h.codec.getVox(); h.codec.getVoxLevel();
  h.codec.getDnrLevel(); h.codec.getCompressor(); h.codec.getCompLevel();
  h.codec.getMonitor(); h.codec.getMicGain(); h.codec.getPreamp();
  h.codec.getAtt(); h.codec.getMonLevel(); h.codec.getRit();
  h.codec.getAtuEnabled();
  assert.strictEqual(h.writes.length, 24, 'cycle writes: ' + h.writes.length);
  // Real hamlib 4.7.0 reply stream, strict command order. Radio state:
  // NB ON, PREAMP 20dB, RF gain 0.5, VOX gain FULL (prints bare "1").
  h.feed([
    '145000000',        // f
    'FM', '15000',      // m (mode + passband)
    '0',                // t  (ptt off)
    'VFOA',             // v
    '0', 'None',        // s  (split off + TX vfo name)
    '-32',              // l STRENGTH
    '0',                // l RFPOWER  (%g zero — no decimal)
    '1',                // u NB       <- ON; the old cap fed this to preamp
    '0.5',              // l RF
    '0',                // l AGC
    '0',                // u ANF
    '0',                // u VOX
    '1',                // l VOXGAIN  (%g full scale — bare "1")
    '0',                // u NR
    '0',                // l NR
    '0',                // u COMP
    '0',                // l COMP
    '0',                // u MON
    '0',                // l MICGAIN
    '20',               // l PREAMP   <- the reply the old cap dropped
    '0',                // l ATT
    '0',                // l MONITOR_GAIN
    '0',                // u RIT
    '0',                // u TUNER
  ]);
  const last = (ev) => { const hits = h.events.filter(e => e[0] === ev); return hits.length ? hits[hits.length - 1][1] : undefined; };
  assert.strictEqual(last('nb'), true, 'NB must read ON, got ' + last('nb'));
  assert.strictEqual(last('preampStep'), 20, 'preamp must read its own 20dB, got ' + last('preampStep'));
  assert.strictEqual(last('preamp'), true);
  assert.strictEqual(last('attStep'), 0, 'ATT never set — must read 0, got ' + last('attStep'));
  assert.strictEqual(last('att'), false);
  assert.strictEqual(last('ptt'), false);
  assert.strictEqual(last('split'), false);
  assert.strictEqual(last('mode'), 'FM');
  assert.strictEqual(last('rfgain'), 50, 'RF gain 0.5 -> 50%');
});

test('K6RBJ: NB/preamp OFF survives the next full readback cycle', () => {
  const h = rigctldFullCycleHarness();
  // Operator toggles both OFF mid-session; rigctld accepts (RPRT 0 each).
  h.codec.setNb(false);
  h.codec.setPreamp(0);
  h.feed(['RPRT 0', 'RPRT 0']);
  // Next ext cycle reads the radio's true (now off) state.
  h.codec.getPtt(); h.codec.getSmeter(); h.codec.getNb();
  h.codec.getVoxLevel(); h.codec.getPreamp(); h.codec.getAtt();
  h.feed(['0', '-30', '0', '1', '0', '0']);   // ptt, smeter, NB=0, VOXGAIN=1, PREAMP=0, ATT=0
  const nbEvents = h.events.filter(e => e[0] === 'nb').map(e => e[1]);
  const preampEvents = h.events.filter(e => e[0] === 'preampStep').map(e => e[1]);
  assert.deepStrictEqual(nbEvents, [false], 'NB events: ' + JSON.stringify(nbEvents));
  assert.deepStrictEqual(preampEvents, [0], 'preamp events: ' + JSON.stringify(preampEvents));
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
