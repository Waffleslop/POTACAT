#!/usr/bin/env node
'use strict';
// lib/k4-pan.js: the Elecraft K4's network panadapter (GitHub #396).
// Every frame here is built from the layout documented at the top of
// lib/k4-pan.js; no capture from a POTACAT owner exists yet. When one does
// (k4-pan-frame.bin from the log's "[K4] saved one raw panadapter frame"),
// it goes under test/fixtures/k4-pan/ and gets its own section below.
// Run: node test/k4-pan-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const K = require('../lib/k4-pan');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

/** A PAN payload as the K4 sends it, from the documented layout. */
function panPayload({ type = 0x02, version = 1, seq = 7, panType = 0, receiver = 0, centerHz = 14074000, widthKhz = 48,
  noiseTenths = -1320, bins = null, binCount = 1024, declared = null } = {}) {
  const b = bins || new Uint8Array(binCount).fill(30);           // 30 - 162 = -132 dBm noise
  const buf = Buffer.alloc(27 + b.length);
  buf[0] = type; buf[1] = version; buf[2] = seq; buf[3] = panType; buf[4] = receiver;
  buf.writeUInt16LE(declared == null ? b.length : declared, 5);
  buf.writeBigInt64LE(BigInt(centerHz), 11);
  buf.writeInt32LE(widthKhz, 19);
  buf.writeInt32LE(noiseTenths, 23);
  Buffer.from(b).copy(buf, 27);
  return buf;
}

console.log('Parsing the PAN header');
t('every header field is read from its documented offset', () => {
  const p = K.parsePanPayload(panPayload({ seq: 200, panType: 1, centerHz: 7074000, widthKhz: 96, noiseTenths: -1285 }));
  assert.strictEqual(p.type, 0x02);
  assert.strictEqual(p.mini, false);
  assert.strictEqual(p.version, 1);
  assert.strictEqual(p.seq, 200);
  assert.strictEqual(p.panType, 1);
  assert.strictEqual(p.receiver, 0);
  assert.strictEqual(p.binCount, 1024);
  assert.strictEqual(p.centerHz, 7074000);
  assert.strictEqual(p.spanHz, 96000);
  assert.strictEqual(p.tierKnown, true);
  assert.strictEqual(p.noiseFloorDbm, -128.5);
  assert.strictEqual(p.bins.length, 1024);
});
t('a centre above 4.29 GHz survives (the field is 64-bit)', () => {
  const p = K.parsePanPayload(panPayload({ centerHz: 10368100000 }));
  assert.strictEqual(p.centerHz, 10368100000);
});
t('all five tiers are known; any other width is flagged, not refused', () => {
  for (const k of [24, 48, 96, 192, 384]) assert.ok(K.parsePanPayload(panPayload({ widthKhz: k })).tierKnown, k);
  const odd = K.parsePanPayload(panPayload({ widthKhz: 50 }));
  assert.strictEqual(odd.spanHz, 50000);
  assert.strictEqual(odd.tierKnown, false);
});
t('the Sub receiver is told apart from the Main', () => {
  assert.strictEqual(K.parsePanPayload(panPayload({ receiver: 1 })).receiver, 1);
});
t('a MiniPAN reads its span from the same field and its own dBm offset, with no noise floor', () => {
  const p = K.parsePanPayload(panPayload({ type: 0x03, widthKhz: 3, centerHz: 10000500 }));
  assert.strictEqual(p.mini, true);
  assert.strictEqual(p.spanHz, 3000);
  assert.strictEqual(p.noiseFloorDbm, null);
  assert.strictEqual(p.dbmOffset, 118);
});

console.log('What is refused');
t('a CAT or audio payload is not a PAN', () => {
  assert.strictEqual(K.parsePanPayload(Buffer.concat([Buffer.from([0x00, 0, 0]), Buffer.from('FA00014074000;'.repeat(3))])), null);
  assert.strictEqual(K.parsePanPayload(panPayload({ type: 0x01 })), null);
});
t('a frame shorter than the bin count it states is dropped', () => {
  assert.strictEqual(K.parsePanPayload(panPayload({ declared: 2000 })), null);
});
t('a header with no centre or no width cannot be drawn on an axis', () => {
  assert.strictEqual(K.parsePanPayload(panPayload({ centerHz: 0 })), null);
  assert.strictEqual(K.parsePanPayload(panPayload({ widthKhz: 0 })), null);
  assert.strictEqual(K.parsePanPayload(panPayload({ widthKhz: 5000 })), null);
});
t('a header alone, or nothing, is null', () => {
  assert.strictEqual(K.parsePanPayload(Buffer.alloc(27)), null);
  assert.strictEqual(K.parsePanPayload(null), null);
});

console.log('Levels: one byte per bin, dBm = byte - 162');
t('the byte-to-dBm offset is 162 for PAN', () => {
  const p = K.parsePanPayload(panPayload());
  assert.strictEqual(K.binDbm(p, 89), -73);   // S9
  assert.strictEqual(K.binDbm(p, 30), -132);
});
t('POTACAT levels span DBM_MIN..DBM_MAX and clamp outside it', () => {
  assert.strictEqual(K.levelFor(K.DBM_MIN), 0);
  assert.strictEqual(K.levelFor(K.DBM_MAX), 255);
  assert.strictEqual(K.levelFor(-200), 0);
  assert.strictEqual(K.levelFor(0), 255);
  assert.ok(K.levelFor(-73) > K.levelFor(-132));
});
t('the median bin is the radio\'s noise, close to the floor it reports', () => {
  const p = K.parsePanPayload(panPayload({ noiseTenths: -1320 }));
  assert.strictEqual(K.medianDbm(p), -132);
});

console.log('The 850-point scope frame');
t('1024 bins become the 850 levels every surface draws', () => {
  const f = K.toScopeFrame(K.parsePanPayload(panPayload()), { seq: 3 });
  assert.strictEqual(f.wf1.length, 850);
  assert.strictEqual(f.seq, 3);
  assert.strictEqual(f.kind, 0);
  assert.strictEqual(f.aligned, true);
});
t('a one-bin carrier survives the resampling (peak held) and lands where it is', () => {
  const bins = new Uint8Array(1024).fill(30);
  bins[700] = 120;                                  // -42 dBm carrier in one bin
  const f = K.toScopeFrame(K.parsePanPayload(panPayload({ bins })));
  const peakAt = f.wf1.indexOf(Math.max(...f.wf1));
  assert.strictEqual(f.wf1[peakAt], K.levelFor(120 - 162));
  assert.ok(Math.abs(peakAt - Math.round(700 * 850 / 1024)) <= 1, 'peak at ' + peakAt);
  assert.strictEqual(f.wf1.filter((v) => v === f.wf1[peakAt]).length, 1, 'one bin wide');
});
t('the noise maps to one flat level', () => {
  const f = K.toScopeFrame(K.parsePanPayload(panPayload()));
  assert.ok(f.wf1.every((v) => v === K.levelFor(-132)));
});

console.log('Axis');
t('the axis is the packet\'s own centre and width, anchored fixed (never assumed from the dial)', () => {
  const ax = K.axisFor(K.parsePanPayload(panPayload({ centerHz: 14074500, widthKhz: 24 })));
  assert.deepStrictEqual(ax, { anchor: 'fixed', centerHz: 14074500, spanHz: 24000 });
  const ScopeAxis = require('../lib/scope-axis');
  const a = ScopeAxis.scopeAxis({ centerHz: ax.centerHz, spanHz: ax.spanHz, anchor: ax.anchor });
  assert.strictEqual(a.known, true, 'click-to-tune works on a fixed axis');
  assert.strictEqual(a.startHz, 14062500);
  assert.strictEqual(a.endHz, 14086500);
});
t('the first-frame log line says what an owner\'s frame looked like', () => {
  const s = K.describePan(K.parsePanPayload(panPayload({ widthKhz: 48 })));
  assert.match(s, /PAN v1, Main, 1024 bins, centre 14\.074000 MHz, 48 kHz wide \(a known tier\), radio noise floor -132\.0 dBm, median bin -132 dBm/);
});

console.log('Wiring');
const cat = readSrc(path.join(__dirname, '..', 'lib', 'cat.js'));
const main = readSrc(path.join(__dirname, '..', 'main.js'));
t('lib/cat.js hands PAN and MiniPAN payloads on instead of dropping them', () => {
  assert.ok(/K4_TYPE_PAN\s*=\s*0x02/.test(cat));
  assert.ok(/K4_TYPE_MINIPAN\s*=\s*0x03/.test(cat));
  assert.ok(cat.includes("this.emit('k4-pan', Buffer.from(payload))"));
  assert.ok(!/0x02 full pan, 0x03 mini pan\) ignored/.test(cat), 'the old "ignored" line is gone');
});
t('main.js: a K4 over the network is a scope source, offered while its frames arrive, and writes nothing to the radio', () => {
  assert.ok(main.includes("cat.on('k4-pan', k4ScopeOnPan);"));
  assert.ok(main.includes("if (!caps.nativeScope && k4ScopeAvailable()) caps.nativeScope = 'k4';"));
  assert.ok(main.includes("if (kind === 'k4') { startK4Scope(); return; }"));
  assert.ok(main.includes('if (k4ScopeOn) { stopK4Scope(why); return; }'));
  const block = main.slice(main.indexOf('function startK4Scope'), main.indexOf('function stopK4Scope') + 400);
  assert.ok(!/sendRaw|transport\.write|queryRaw/.test(block), 'the K4 scope must not write to the radio');
  assert.ok(main.includes("fs.writeFileSync(framePath, Buffer.from(payload));"), 'the first frame is saved for an owner\'s report');
});
t('the pop-out hides the FT-710-only rows for a K4', () => {
  const pop = readSrc(path.join(__dirname, '..', 'renderer', 'scope-popout.js'));
  assert.ok(pop.includes("const yaesuSource = !state.source || state.source === 'radio' || state.source === 'sculan10';"));
});

const fixtureDir = path.join(__dirname, 'fixtures', 'k4-pan');
const fixtures = fs.existsSync(fixtureDir) ? fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.bin')) : [];
console.log('Owner captures');
if (!fixtures.length) console.log('  skip no owner capture yet (test/fixtures/k4-pan/*.bin)');
for (const f of fixtures) {
  t('owner capture ' + f + ' parses as a Main PAN with a known tier', () => {
    const p = K.parsePanPayload(fs.readFileSync(path.join(fixtureDir, f)));
    assert.ok(p && !p.mini && p.tierKnown);
  });
}

console.log(`\nK4 pan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
