#!/usr/bin/env node
'use strict';
// APRS phase 2: what Dire Wolf heard on the radio, as the phase 1 parser reads
// it (lib/aprs-rf-frames.js). The fixture is RECORDED: five APRS packets were
// sent as 1200-baud AFSK into the bundled Dire Wolf 1.8.1 (APRS receive
// config, no PTT, offline, no radio), and the AGW monitor records it sent
// back were saved byte for byte (test/fixtures/aprs/direwolf-agw-monitor-frames.json).
// Run: node test/aprs-rf-frames-test.js

const assert = require('assert');
const RF = require('../lib/aprs-rf-frames');
const P = require('../lib/aprs-parser');
const REC = require('./fixtures/aprs/direwolf-agw-monitor-frames.json');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const frames = REC.frames.map((f) => ({ ...f, data: Buffer.from(f.dataHex, 'hex') }));
const heard = frames.map((f) => RF.fromMonitorFrame(f));

console.log('APRS from Dire Wolf\'s AGW monitor (recorded frames)');

test('every recorded UI frame becomes the TNC2 line that was sent', () => {
  assert.strictEqual(heard.length, REC.sent.length);
  // Dire Wolf's monitor marks only the LAST repeated digipeater with '*', so
  // the sent K3SBP/KD2ABC lines compare with that form.
  const want = REC.sent.map((s) => s.replace('N2DEF-3*,W2GHI-1*,WIDE2*', 'N2DEF-3*,W2GHI-1,WIDE2'));
  heard.forEach((h, i) => assert.strictEqual(h.line, want[i]));
});

test('direct: no digipeater in the path', () => {
  assert.deepStrictEqual(heard[0].via, { kind: 'direct', digi: '' });
  assert.deepStrictEqual(heard[3].via, { kind: 'direct', digi: '' }); // WIDE1-1,WIDE2-1 unused: heard from the sender itself
});

test('via a named digipeater: the call that repeated it', () => {
  assert.deepStrictEqual(heard[1].via, { kind: 'digi', digi: 'KB1XYZ-1' });
  assert.deepStrictEqual(heard[4].via, { kind: 'digi', digi: 'N2DEF-3' });
});

test('via a digipeater that left only its alias (WIDE1*): a digipeater, no call', () => {
  assert.deepStrictEqual(heard[2].via, { kind: 'digi', digi: '' });
});

test('the phase 1 parser reads each line: positions, Mic-E with a binary byte, an object', () => {
  const p = heard.map((h) => P.parse(h.line));
  assert.strictEqual(p[0].from, 'W1AW-9');
  assert.ok(Math.abs(p[0].lat - 41.6667) < 0.001 && Math.abs(p[0].lon + 72.7167) < 0.001);
  assert.strictEqual(p[1].from, 'K3SBP-7');
  assert.ok(Math.abs(p[1].lat - 39.97017) < 0.001);
  assert.strictEqual(p[3].format, 'mic-e');
  assert.ok(p[3].lat != null && p[3].lon != null);
  assert.strictEqual(p[4].type, 'object');
  assert.strictEqual(p[4].name, 'LEADER');
});

test('packet() hands the parser\'s packet back marked as heard on the radio', () => {
  const pk = RF.packet(frames[1], P.parse);
  assert.strictEqual(pk.from, 'K3SBP-7');
  assert.deepStrictEqual(pk.rf, { kind: 'digi', digi: 'KB1XYZ-1' });
});

test('Dire Wolf\'s own transmissions (T), connected-mode frames and non-APRS PIDs are not APRS', () => {
  const t = { ...frames[0], datakind: 'T' };
  assert.strictEqual(RF.fromMonitorFrame(t), null);
  const s = { ...frames[0], datakind: 'S', data: Buffer.from(' 1:Fm W5AUY-10 To N5XHI <UA pid=F0 Len=0 F=1 >[18:07:23]\r\0', 'latin1') };
  assert.strictEqual(RF.fromMonitorFrame(s), null);
  const notAprs = { ...frames[0], data: Buffer.from(' 1:Fm W1AW To ID <UI pid=CF Len=4 PF=0 >[00:00:01]\rNETR\r\0', 'latin1') };
  assert.strictEqual(RF.fromMonitorFrame(notAprs), null);
});

test('garbage never throws', () => {
  assert.strictEqual(RF.fromMonitorFrame(null), null);
  assert.strictEqual(RF.fromMonitorFrame({ datakind: 'U', data: Buffer.from('nonsense') }), null);
  assert.strictEqual(RF.packet({ datakind: 'U', data: Buffer.alloc(0) }, P.parse), null);
});

test('the via rule on TNC2 paths', () => {
  assert.deepStrictEqual(RF.viaOf([]), { kind: 'direct', digi: '' });
  assert.deepStrictEqual(RF.viaOf(['WIDE1-1', 'WIDE2-1']), { kind: 'direct', digi: '' });
  assert.deepStrictEqual(RF.viaOf(['W3XYZ-1*', 'WIDE2-1']), { kind: 'digi', digi: 'W3XYZ-1' });
  assert.deepStrictEqual(RF.viaOf(['WIDE2*']), { kind: 'digi', digi: '' });
  assert.deepStrictEqual(RF.viaOf(['W3XYZ-1', 'WIDE2*']), { kind: 'digi', digi: 'W3XYZ-1' });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
