#!/usr/bin/env node
'use strict';
/**
 * SDRconnect WebSocket API, pure part (lib/sdrconnect-protocol.js): the
 * envelope, every binary type, short and odd frames, the demodulator map,
 * spans, levels from bins of several widths, stereo to mono, the restore
 * set, gain steps and the error sentences. Formats from SDRplay's
 * "SDRconnect WebSocket API 1.0.3".
 *
 * Run: node test/sdrconnect-protocol-test.js
 */
const assert = require('assert');
const P = require('../lib/sdrconnect-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}

test('client messages: the API envelope, every value a string', () => {
  assert.deepStrictEqual(JSON.parse(P.buildMessage('set_property', 'device_center_frequency', 101000000, 'primary')),
    { event_type: 'set_property', property: 'device_center_frequency', value: '101000000', device: 'primary' });
  assert.deepStrictEqual(JSON.parse(P.buildMessage('audio_stream_enable', '', true)),
    { event_type: 'audio_stream_enable', property: '', value: 'true' }, 'no device field when not given (the API assumes primary)');
  assert.deepStrictEqual(JSON.parse(P.buildMessage('get_property', 'api_version')), { event_type: 'get_property', property: 'api_version', value: '' });
  assert.strictEqual(JSON.parse(P.buildMessage('set_property', 'agc_enable', false)).value, 'false');
  assert.ok(!('device' in JSON.parse(P.buildMessage('x', 'y', 1, 'bogus'))));
});

test('server messages: parsed, tolerant of numbers, junk is null', () => {
  assert.deepStrictEqual(P.parseText('{"event_type":"property_changed","property":"device_center_frequency","device":"primary","value":"100000000"}'),
    { eventType: 'property_changed', property: 'device_center_frequency', value: '100000000', device: 'primary' });
  assert.strictEqual(P.parseText('{"event_type":"get_property_response","property":"lna_state","value":4}').value, '4', 'a number value reads as its string');
  assert.strictEqual(P.parseText('{"event_type":"property_changed","property":"x","value":"1","device":"secondary"}').device, 'secondary');
  assert.strictEqual(P.parseText('not json'), null);
  assert.strictEqual(P.parseText('{"property":"x"}'), null, 'no event_type');
  assert.strictEqual(P.parseText('[]'), null);
});

test('binary: every type, primary and secondary', () => {
  const frame = (type, bytes) => { const b = Buffer.alloc(2 + bytes.length); b.writeUInt16LE(type, 0); Buffer.from(bytes).copy(b, 2); return b; };
  const want = { 1: ['audio', 'primary'], 2: ['iq', 'primary'], 3: ['spectrum', 'primary'], 4: ['audio', 'secondary'], 5: ['iq', 'secondary'], 6: ['spectrum', 'secondary'] };
  for (const [t, [kind, device]] of Object.entries(want)) {
    const f = P.parseBinary(frame(Number(t), [1, 2, 3, 4]));
    assert.strictEqual(f.kind, kind, 'type ' + t);
    assert.strictEqual(f.device, device, 'type ' + t);
    assert.strictEqual(f.payload.length, 4);
  }
  assert.strictEqual(P.parseBinary(frame(99, [1])).kind, 'unknown', 'an unknown type is counted, not dropped silently');
});

test('binary: short and odd frames', () => {
  assert.strictEqual(P.parseBinary(Buffer.from([1])), null, 'shorter than the type word');
  assert.strictEqual(P.parseBinary(null), null);
  const empty = P.parseBinary(Buffer.from([3, 0]));
  assert.strictEqual(empty.kind, 'spectrum'); assert.strictEqual(empty.payload.length, 0);
  const odd = P.parseBinary(Buffer.from([1, 0, 1, 2, 3, 4, 5]));
  assert.strictEqual(odd.payload.length, 4, '16-bit audio drops a dangling byte');
  const oddSpec = P.parseBinary(Buffer.from([3, 0, 1, 2, 3]));
  assert.strictEqual(oddSpec.payload.length, 3, '8-bit spectrum keeps every byte');
});

test('values: booleans, numbers, devices, versions', () => {
  assert.strictEqual(P.parseBool('true'), true); assert.strictEqual(P.parseBool('True'), true); assert.strictEqual(P.parseBool('1'), true);
  assert.strictEqual(P.parseBool('false'), false); assert.strictEqual(P.parseBool(''), false);
  assert.strictEqual(P.parseNum('2000000.0'), 2000000); assert.strictEqual(P.parseNum(''), null); assert.strictEqual(P.parseNum('x'), null);
  assert.deepStrictEqual(P.parseValidDevices('nRSP-ST 2401AB0001, RSP1B 1,,'), ['nRSP-ST 2401AB0001', 'RSP1B 1']);
  assert.deepStrictEqual(P.parseValidDevices(''), []);
  assert.deepStrictEqual(P.parseApiVersion('1.0.3'), { major: 1, minor: 0, patch: 3, text: '1.0.3' });
  assert.strictEqual(P.apiVersionSupported('1.0.3'), true);
  assert.strictEqual(P.apiVersionSupported('1.2'), true, 'a newer minor is still version 1');
  assert.strictEqual(P.apiVersionSupported('2.0.0'), false);
  assert.strictEqual(P.parseApiVersion('garbage'), null);
});

test('demodulator from the rig mode', () => {
  assert.deepStrictEqual(P.demodFor('USB'), { demodulator: 'USB', bandwidthHz: 2700 });
  assert.deepStrictEqual(P.demodFor('LSB'), { demodulator: 'LSB', bandwidthHz: 2700 });
  assert.deepStrictEqual(P.demodFor('CW'), { demodulator: 'CW', bandwidthHz: 500 });
  assert.deepStrictEqual(P.demodFor('AM'), { demodulator: 'AM', bandwidthHz: 6000 });
  assert.strictEqual(P.demodFor('FM').demodulator, 'NFM');
  assert.strictEqual(P.demodFor('WFM').demodulator, 'WFM');
  for (const m of ['DIGU', 'PKTUSB', 'FT8', 'FT4', 'WSPR', 'data-usb']) assert.deepStrictEqual(P.demodFor(m), { demodulator: 'USB', bandwidthHz: 3000 }, m);
  assert.strictEqual(P.demodFor('DIGL').demodulator, 'LSB');
  assert.deepStrictEqual(P.demodFor('usb', { lo: 0.1, hi: 3.0 }), { demodulator: 'USB', bandwidthHz: 3000 }, "JTCAT's passband sets the width");
});

test('spans: choices, saved value, drawn span from the read-back rate', () => {
  assert.deepStrictEqual(P.spanChoices().map((s) => s.label), ['200 kHz', '800 kHz', '1.6 MHz', '5 MHz', '8 MHz']);
  assert.strictEqual(P.spanFor(5000000).sampleRate, 6000000);
  assert.strictEqual(P.spanFor(12345).spanHz, 800000, 'unknown -> 800 kHz');
  assert.strictEqual(P.drawnSpanHz(800000, 2000000), 800000);
  assert.strictEqual(P.drawnSpanHz(8000000, 2000000), 1800000, 'never more than the bins cover');
  assert.strictEqual(P.drawnSpanHz(800000, null), 800000);
});

test('levels from bins: 850 columns from bins of several widths, a carrier lands in the right place', () => {
  for (const n of [256, 1024, 2048, 4096, 8192]) {
    const u8 = new Uint8Array(n).fill(40);
    // A carrier 100 kHz above centre, visible span 2 MHz.
    const k = Math.round((100000 + 1000000) / (2000000 / n));
    u8[k] = 230;
    const lv = P.levelsFromBins(u8, 2000000, 800000, { topDb: 0, bottomDb: -120 });
    assert.strictEqual(lv.length, 850, n + ' bins');
    const peak = lv.indexOf(Math.max(...lv));
    const carrierHz = (k + 0.5) * (2000000 / n) - 1000000; // where bin k really sits
    const expect = Math.round(850 * (carrierHz + 400000) / 800000 - 0.5);
    const tol = Math.max(2, Math.ceil(850 / (800000 / (2000000 / n)))); // a bin is several columns wide when stretching
    assert.ok(Math.abs(peak - expect) <= tol, `${n} bins: peak at ${peak}, expected ~${expect}`);
    assert.ok(lv[peak] > 200, 'the carrier is bright');
    assert.ok(lv[10] < 40, 'the floor is dark');
  }
});

test('levels from bins: a shifted centre, and columns outside the bins are the floor', () => {
  const n = 1000;
  const u8 = new Uint8Array(n).fill(40);
  u8[500] = 230; // at the bins' centre
  // The dial (scope centre) is 200 kHz above where the receiver sits: the carrier is 200 kHz below the scope centre.
  const lv = P.levelsFromBins(u8, 2000000, 800000, { shiftHz: 200000 });
  const peak = lv.indexOf(Math.max(...lv));
  assert.ok(Math.abs(peak - Math.round(850 * 200000 / 800000)) <= 2, 'peak at ' + peak);
  const off = P.levelsFromBins(u8, 1000000, 2000000, {});
  assert.strictEqual(off[0], 0); assert.strictEqual(off[849], 0);
  assert.deepStrictEqual(Array.from(P.levelsFromBins(new Uint8Array(0), 2e6, 8e5)).filter(Boolean), []);
});

test('levels from bins: the floor tracks, so SDRconnect\'s display range does not whiten the picture', () => {
  const state = {};
  const hot = new Uint8Array(1024).fill(200); hot[512] = 255;
  const lv = P.levelsFromBins(hot, 2e6, 8e5, { state, topDb: -20, bottomDb: -120 });
  const median = Array.from(lv).sort((a, b) => a - b)[425];
  assert.ok(median < 40, 'a high noise floor still draws dark: ' + median);
});

test('stereo 16-bit to mono float', () => {
  const b = Buffer.alloc(12);
  b.writeInt16LE(16384, 0); b.writeInt16LE(16384, 2);
  b.writeInt16LE(-32768, 4); b.writeInt16LE(-32768, 6);
  b.writeInt16LE(32767, 8); b.writeInt16LE(-32767, 10);
  const m = P.stereoToMono(b);
  assert.strictEqual(m.length, 3);
  assert.ok(Math.abs(m[0] - 0.5) < 1e-6); assert.ok(Math.abs(m[1] + 1) < 1e-6); assert.ok(Math.abs(m[2]) < 1e-4);
  assert.strictEqual(P.stereoToMono(Buffer.alloc(3)).length, 0, 'a partial frame is dropped');
});

test('restore: only what POTACAT changed and what differs, rate before centre before VFO', () => {
  const before = { device_sample_rate: '2000000', device_center_frequency: '7100000', device_vfo_frequency: '7100000', lna_state: '3', demodulator: 'AM', audio_mute: 'false' };
  const now = { device_sample_rate: '6000000', device_center_frequency: '14074000', device_vfo_frequency: '14074000', lna_state: '3', demodulator: 'USB', audio_mute: 'false' };
  const msgs = P.restoreMessages(before, now, ['device_vfo_frequency', 'device_center_frequency', 'device_sample_rate', 'demodulator', 'lna_state']).map((t) => JSON.parse(t));
  assert.deepStrictEqual(msgs.map((m) => [m.property, m.value]), [
    ['device_sample_rate', '2000000'], ['device_center_frequency', '7100000'], ['device_vfo_frequency', '7100000'], ['demodulator', 'AM'],
  ], 'lna_state unchanged is not sent; audio_mute untouched is not sent');
  assert.ok(msgs.every((m) => m.event_type === 'set_property'));
  assert.deepStrictEqual(P.restoreMessages(before, { ...now, device_sample_rate: '2000000.0' }, ['device_sample_rate']), [], '2000000.0 is 2000000');
  assert.deepStrictEqual(P.restoreMessages({}, now, ['demodulator']), [], 'nothing read, nothing put back');
  assert.ok(P.snapshotProps().includes('agc_enable') && P.snapshotProps().includes('spectrum_base'));
});

test('RF gain: auto leaves SDRconnect alone, a step is clamped', () => {
  assert.strictEqual(P.lnaForGain('auto', 0, 9), null);
  assert.strictEqual(P.lnaForGain('', 0, 9), null);
  assert.strictEqual(P.lnaForGain(4, 0, 9), 4);
  assert.strictEqual(P.lnaForGain(40, 0, 9), 9);
  assert.strictEqual(P.lnaForGain(-3, 0, 9), 0);
  assert.strictEqual(P.lnaForGain(5, null, null), 5);
});

test('every failure has one plain sentence and an action, no jargon', () => {
  for (const k of ['refused', 'unreachable', 'not-sdrconnect', 'api-version', 'no-device', 'stalled']) {
    const d = P.describeSdrConnectError(k, { host: '127.0.0.1', port: 5454, version: '2.0.0' });
    assert.strictEqual(d.key, k);
    assert.ok(d.headline && d.headline.length < 90, k + ' headline');
    assert.ok(d.action, k + ' says what to do');
  }
  assert.ok(/127\.0\.0\.1:5454/.test(P.describeSdrConnectError('refused').headline));
  assert.ok(/2\.0\.0/.test(P.describeSdrConnectError('api-version', { version: '2.0.0' }).headline));
  assert.ok(/tuning waits until control comes back/.test(P.describeSdrConnectError('no-control').detail));
});

console.log(`\nSDRconnect protocol: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
