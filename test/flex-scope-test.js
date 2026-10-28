#!/usr/bin/env node
'use strict';
/**
 * The Flex's own panadapter as POTACAT's band scope (Flex Direct only;
 * Casey 2026-10-28), against a REAL FLEX-8600 v4 capture
 * (test/fixtures/flex-pan/8600-capture.txt, POTACAT_FLEX_FFT_CAPTURE).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../lib/flex-scope');
const { SmartSdrClient } = require('../lib/smartsdr');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const capture = fs.readFileSync(path.join(__dirname, 'fixtures/flex-pan/8600-capture.txt'), 'utf8').split(/\r?\n/);
const packets = (stream) => capture
  .filter((l) => l.includes(`UDP stream=${stream} class=0x8003`))
  .map((l) => Buffer.from(/hex=([0-9a-f]+)/.exec(l)[1], 'hex'));
const pan0 = packets('0x40000000');

console.log('The packet (real 8600)');
check('a 850-bin frame is two packets: 670 + 180', () => {
  const big = pan0.map(F.parseFftPacket).filter((p) => p && p.total === 850);
  assert.ok(big.length >= 6, 'frames captured: ' + big.length);
  const a = big.find((p) => p.start === 0);
  const b = big.find((p) => p.start === 670);
  assert.strictEqual(a.num, 670);
  assert.strictEqual(b.num, 180);
  assert.strictEqual(a.streamId, 0x40000000);
});
check('not an FFT packet: null', () => {
  const meter = Buffer.alloc(40); meter[0] = 0x38; meter.writeUInt16BE(0x8002, 14);
  assert.strictEqual(F.parseFftPacket(meter), null);
  assert.strictEqual(F.parseFftPacket(Buffer.alloc(10)), null);
});

console.log('Frames');
check('whole frames come out as 850 levels; the junk after the resize is dropped', () => {
  const asm = new F.PanFrameAssembler();
  const frames = [];
  asm.on('frame', (f) => frames.push(f));
  for (const b of pan0) asm.feed(F.parseFftPacket(b));
  assert.ok(frames.length >= 3, 'frames: ' + frames.length);
  assert.ok(asm.dropped >= 1, 'the out-of-range frames were dropped');
  for (const f of frames) {
    assert.strictEqual(f.wf1.length, 850);
    assert.ok(f.aligned && f.kind === 0);
  }
  // A quiet band sits near the bottom of the pan: low levels, all in range.
  const sorted = Array.from(frames[0].wf1).sort((x, y) => x - y);
  const median = sorted[425];
  assert.ok(median > 30 && median < 120, 'median level ' + median);
});
check('a pixel row maps to a level: top = strongest', () => {
  assert.strictEqual(F.levelFromPixel(0), 255);
  assert.strictEqual(F.levelFromPixel(255), 0);
  assert.strictEqual(F.levelFromPixel(190), 65);
});

console.log('Axis');
check('the pan\'s own centre and span, from its status line', () => {
  const line = capture.find((l) => /\|display pan 0x40000000 .*center=/.test(l)).replace(/^.*?TCP /, '');
  const g = F.parsePanGeometry(line);
  assert.strictEqual(g.panId, '0x40000000');
  assert.strictEqual(g.centerHz, 14100000);
  assert.strictEqual(g.spanHz, 200000);
  assert.strictEqual(F.parsePanGeometry('S1|display pan 0x40000000 wnb=0'), null, 'no geometry in the line');
});
check('the pan is recentred only when the dial leaves the view', () => {
  assert.strictEqual(F.recentreFor(14074000, 14100000, 200000), null, 'inside: leave it');
  assert.strictEqual(F.recentreFor(14250000, 14100000, 200000), 14250000, 'outside: follow');
});
check('the size the source asks for', () => {
  assert.strictEqual(F.panSizeCommand('0x40000000', 15), 'display pan set 0x40000000 xpixels=850 ypixels=256 fps=15');
});

console.log('The Flex client');
check('Flex Direct sizes OUR pan and turns its packets into pan-frame events; bound mode never does', () => {
  const c = new SmartSdrClient();
  const sent = [];
  c._send = (x) => sent.push(x);
  c._slicePan = { 0: '0x40000000' };
  c._ourSliceIndex = 0;
  c._guiMode = 'bound';
  assert.strictEqual(c.startPanScope(15), null, 'bound: SmartSDR\'s pan is not ours');
  assert.strictEqual(sent.length, 0);
  c._guiMode = 'self';
  assert.strictEqual(c.startPanScope(15), '0x40000000');
  assert.deepStrictEqual(sent, ['display pan set 0x40000000 xpixels=850 ypixels=256 fps=15']);
  const frames = [];
  c.on('pan-frame', (f) => frames.push(f));
  for (const b of pan0) c._parseUdpPacket(b);
  assert.ok(frames.length >= 3 && frames[0].panId === '0x40000000');
  for (const b of packets('0x40000001')) c._parseUdpPacket(b);
  assert.ok(frames.every((f) => f.panId === '0x40000000'), 'another pan is not ours to show');
  c.setPanCenter(14250000);
  assert.strictEqual(sent[1], 'display pan set 0x40000000 center=14.250000');
  c.stopPanScope();
  const n = frames.length;
  for (const b of pan0) c._parseUdpPacket(b);
  assert.strictEqual(frames.length, n, 'stopped: no frames');
});

check('the slice\'s AGC is read back, on change only, into the rig state (Casey 2026-10-28)', () => {
  const c = new SmartSdrClient();
  const ev = [];
  c.on('slice-agc', (e) => ev.push(e));
  c._handleLine('S1A2B|slice 0 in_use=1 RF_frequency=14.074000 mode=USB agc_mode=med client_handle=0x1A2B');
  c._handleLine('S1A2B|slice 0 agc_mode=med');
  c._handleLine('S1A2B|slice 0 agc_mode=FAST');
  assert.deepStrictEqual(ev, [{ index: 0, mode: 'med' }, { index: 0, mode: 'fast' }]);
  const m = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(/smartSdr\.on\('slice-agc'[\s\S]{0,300}_currentAgcMode = mode;\s*\r?\n\s*broadcastRigState\(\);/.test(m));
});

console.log('main.js wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
check('the source is chosen only in Flex Direct; a radio\'s own scope wins over an SDR unless preferred', () => {
  assert.ok(/return !!\(smartSdr && smartSdr\.connected && smartSdr\.mode === 'self'\);/.test(main));
  assert.ok(/if \(sdr\.enabled && \(sdr\.preferSdr \|\| \(!native && !flex\)\)\) return 'sdr';/.test(main));
  assert.ok(/if \(!caps\.nativeScope && flexScopeAvailable\(\)\) caps\.nativeScope = 'flex';/.test(main));
});
check('always centred on the dial (Casey): anchor center, the pan follows at most 10x a second', () => {
  const fn = main.slice(main.indexOf('function yaesuScopeNoteFrequency('), main.indexOf('function startYaesuScope('));
  assert.ok(/if \(flexScopeOn\) \{[\s\S]{0,600}yaesuScopeState\.centerHz = hz;\s+flexScopeQueueCenter\(hz\);/.test(fn));
  const start = main.slice(main.indexOf('function startFlexScope('), main.indexOf('function stopFlexScope('));
  assert.ok(/anchor: 'center'/.test(start) && /smartSdr\.setPanCenter\(_currentFreqHz\)/.test(start));
  const q = main.slice(main.indexOf('function flexScopeQueueCenter('), main.indexOf('function flexScopeQueueCenter(') + 500);
  assert.ok(/setTimeout\([\s\S]*\}, 100\);/.test(q), 'coalesced to 100 ms');
});
check('zoom: the steps, the command, remembered per source, on the wire', () => {
  assert.deepStrictEqual(F.SPANS, [5000, 10000, 25000, 50000, 100000, 200000, 500000, 1000000]);
  assert.strictEqual(F.nearestSpan(180000), 200000);
  assert.strictEqual(F.nearestSpan(0), null);
  const c = new SmartSdrClient(); const sent = []; c._send = (x) => sent.push(x);
  c._slicePan = { 0: '0x40000000' }; c._ourSliceIndex = 0; c._guiMode = 'self';
  c.startPanScope(15); c.setPanBandwidth(50000);
  assert.strictEqual(sent[1], 'display pan set 0x40000000 bandwidth=0.050000');
  const set = main.slice(main.indexOf('function setScopeSpan('), main.indexOf('function setScopeSpan(') + 2000);
  assert.ok(/settings\.flexScopeSpanHz = span;/.test(set) && /smartSdr\.setPanBandwidth\(span\)/.test(set));
  assert.ok(/spans: scopeSpans\(\),/.test(main), 'scope-state carries the steps');
  const rs = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
  assert.ok(/capabilities: \[[\s\S]*'scope-span'/.test(rs) && /case 'scope-span':/.test(rs));
  assert.ok(require('../lib/echocat-protocol').MESSAGES['scope-span']);
});

check('a calibrated scale for the phone: the pan\'s dBm range, the frame spacing, the S-meter in dBm', () => {
  const line = capture.find((l) => /\|display pan 0x40000000 .*min_dbm=/.test(l)).replace(/^.*?TCP /, '');
  const g = F.parsePanGeometry(line);
  assert.strictEqual(g.dbmMin, -125);
  assert.strictEqual(g.dbmMax, -40);
  const cal = main.slice(main.indexOf('function scopeCalibration('), main.indexOf('function scopeRemoteFrameMs('));
  assert.ok(/s\.source !== 'flex'/.test(cal), 'only the Flex pan is calibrated');
  assert.ok(/\.\.\.scopeCalibration\(\),\s*frameMs: scopeRemoteFrameMs\(false\),\s*frameMsCloud: scopeRemoteFrameMs\(true\),/.test(main));
  assert.ok(/this\.emit\('smeter', scaled, Math\.round\(dbm \* 10\) \/ 10\);/.test(fs.readFileSync(path.join(ROOT, 'lib/smartsdr.js'), 'utf8')));
  assert.ok(/\.\.\.\(_currentSmeterDbm != null \? \{ smeterDbm: _currentSmeterDbm \} : \{\}\),/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
