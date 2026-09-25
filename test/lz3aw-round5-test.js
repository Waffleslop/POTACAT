// LZ3AW's 1.10.18 retest (2026-09-19) — the five items he still had.
//
//  1. "TX PWR meter — on POTACAT there is a bargraph, but not moving. On WEB
//     I don't see a bargraph at all."  RigController never forwarded the
//     codec's `powerMeter` event, so main.js's wattmeter fan-out (added in
//     1.10.18) had no source on any direct-serial or rigctld rig; and the
//     web's meter strip, which holds the PWR bar, hides behind a checkbox
//     that was labelled "Show S-Meter / SWR".
//  2. "TinyMidi paddle — not fixed."  The server's paddle watchdog re-armed
//     only when a paddle MESSAGE arrived. A held contact sends exactly one,
//     so the keyer was stopped 1.5 s into any squeeze or long string.
//  3. "Custom slider — works, but not visible in VFO pane."  Both VFO
//     surfaces dropped slider-type slots.
//  4. "On WEB on phone — at SPOTS, button Spots ... does nothing and the whole
//     bar line stucks."  Opening a dropdown flipped the scrolling toolbar to
//     overflow-x:visible, which resets scrollLeft: the bar jumped and froze.
//  5. "Callsign between < > can't be called on JTCAT."  The web client's hunt
//     matcher kept its own callsign scraper, which did not strip the hash
//     brackets the shared parser strips.
//
// Also pinned here: a CW hold no longer STACKS per paddle edge (that left a
// rig flagged as transmitting for minutes after an over, which holds PTT and
// exempts a genuinely dead link from the staleness watchdog).
//
// Run: node test/lz3aw-round5-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { RemoteServer } = require('../lib/remote-server');
const { MESSAGES } = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const asyncQueue = [];
function queueAsync(name, fn) { asyncQueue.push([name, fn]); }
async function atest(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TS480 = RIG_MODELS['TS-480'];
function rig480() {
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new KenwoodCodec(TS480, (d) => writes.push(String(d)));
  const rig = new RigController(TS480, transport, codec);
  rig.connected = true;
  rig._target = { path: 'COM9' };
  rig._lastReadOkMs = Date.now();
  return { rig, codec, writes };
}

// ---------------------------------------------------------------- 1. meter
console.log('=== #1 measured power reaches the meters ===');

test('the controller forwards the codec powerMeter event (it swallowed it)', () => {
  const { rig, codec } = rig480();
  const seen = [];
  rig.on('powerMeter', (w) => seen.push(w));
  rig._transmitting = true;
  codec.getPowerMeter();           // arms the "this SM reply is watts" flag
  codec.onData('SM00010;');        // TS-480: full scale 20 → 10/20 of 100 W
  assert.deepStrictEqual(seen, [50], 'watts reached the controller\'s listeners');
});

test('a power reply counts as a live read for the staleness watchdog', () => {
  const { rig, codec } = rig480();
  rig._transmitting = false;
  rig._lastReadOkMs = Date.now() - 60000;
  codec.getPowerMeter();
  codec.onData('SM00010;');
  assert.ok(Date.now() - rig._lastReadOkMs < 1000, 'watchdog basis refreshed');
});

test('the poll loop carries that counter, and the web label names every meter', () => {
  const rc = R('lib/rig-controller.js');
  assert.ok(/this\._txMeterAsked = \(this\._txMeterAsked \|\| 0\) \+ 1;/.test(rc));
  assert.ok(/no meter reply while transmitting/.test(rc));
  const html = R('renderer/remote.html');
  assert.ok(/id="echo-show-meter"> Show meters \(S, SWR, ALC, power, TX audio\)/.test(html),
    'the PWR bar lives in this strip; the old label named only two of its meters');
});

// ---------------------------------------------------------------- 2. paddle
console.log('\n=== #2 a held paddle keeps keying ===');

function cwServer() {
  const rs = new RemoteServer();
  rs._cwEnabled = true;
  rs._cwPaddleAvailable = true;
  rs._initCwKeyer();
  const keys = [];
  rs._cwKeyerOutput = (evt) => keys.push({ down: !!evt.down, at: Date.now() });
  return { rs, keys };
}
// Authenticated client stub: _handleMessage gates everything past hello on it.
function cwClient(rs) { const ws = { _authenticated: true, readyState: 3, send() {} }; rs._client = ws; return ws; }
const paddle = (rs, ws, contact, state, hold) => rs._handleMessage(ws, { type: 'paddle', contact, state, ...(hold ? { hold: true } : {}) }, {});

queueAsync('a contact held past the watchdog window keeps keying (legacy client, no keepalive)', async () => {
  const { rs, keys } = cwServer();
  const ws = cwClient(rs);
  const t0 = Date.now();
  paddle(rs, ws, 'dit', 1);
  await sleep(2400);
  const late = keys.filter((k) => k.at - t0 > 1800);
  assert.ok(late.length > 0, 'still keying 1.8 s in — it stopped at 1.5 s before this fix');
  paddle(rs, ws, 'dit', 0);
  rs._destroyCwKeyer();
});

queueAsync('a client that sends hold keepalives keeps the strict 1.5 s release', async () => {
  const { rs, keys } = cwServer();
  const ws = cwClient(rs);
  paddle(rs, ws, 'dit', 1, true);          // marks the client keepalive-aware
  await sleep(300);
  const t = Date.now();
  // Client goes silent mid-press (tab killed): no more messages, no key-up.
  await sleep(2200);
  const late = keys.filter((k) => k.at - t > 1900);
  assert.strictEqual(late.length, 0, 'keyer released on the strict window');
  assert.strictEqual(rs._cwPaddleHoldAware, true);
  rs._destroyCwKeyer();
});

test('the web client repeats a held contact, and stops repeating on release', () => {
  const js = R('renderer/remote.js');
  assert.ok(/ws\.send\(JSON\.stringify\(\{ type: 'paddle', contact: contact, state: 1, hold: true \}\)\);/.test(js));
  // Round 6: the keepalive ticks from a worker (page timers are clamped to
  // 1/s, then 1/min, when the window is hidden), with page timers as fallback.
  assert.ok(/new Worker\(URL\.createObjectURL\(new Blob\(/.test(js), 'hold keepalive runs on a worker timer');
  assert.ok(/_paddleHoldTimer\[contact\] = setInterval\(/.test(js), 'page-timer fallback kept');
  const release = js.slice(js.indexOf('_paddleReleaseTimer[contact] = setTimeout'), js.indexOf('_paddleReleaseTimer[contact] = setTimeout') + 600);
  assert.ok(/_stopPaddleHold\(contact\)/.test(release), 'the 8 s release safety stops the keepalive too');
  const stop = js.slice(js.indexOf('function _stopPaddleHold('), js.indexOf('function _stopPaddleHold(') + 400);
  assert.ok(/_paddleHoldActive\[contact\] = false/.test(stop) && /start: false/.test(stop) && /clearInterval\(_paddleHoldTimer\[contact\]\)/.test(stop),
    'stopping a hold stops the worker tick, the fallback timer, and any tick already in flight');
  assert.ok(MESSAGES.paddle.fields.contact && MESSAGES.paddle.fields.state && MESSAGES.paddle.fields.hold,
    'the registry documents what paddle actually carries');
});

test('a CW hold extends to cover the estimate; only a buffer queue stacks', () => {
  const { rig } = rig480();
  rig.noteTransmitting(2000);
  const first = rig._cwHoldUntil;
  rig.noteTransmitting(2000);          // a second paddle edge
  assert.ok(rig._cwHoldUntil <= first + 50, 'paddle edges do not stack: ' + (rig._cwHoldUntil - first) + ' ms added');
  rig._cancelCwHold();
  rig.noteTransmitting(2000, { queue: true });
  const q1 = rig._cwHoldUntil;
  rig.noteTransmitting(2000, { queue: true });
  assert.ok(rig._cwHoldUntil > q1 + 1500, 'buffered text stacks — the radio sends it one character at a time');
  rig._cancelCwHold();
});

// ---------------------------------------------------------------- 3. slider
console.log('\n=== #3 custom slider in the VFO panes ===');

test('desktop VFO pop-out draws a slider slot and debounces what it sends', () => {
  const vfo = R('renderer/vfo-popout.html');
  assert.ok(!/b\.type !== 'slider'/.test(vfo), 'sliders are no longer filtered out');
  assert.ok(/function customSliderCommand\(template, value\)/.test(vfo), 'same template contract as the other surfaces');
  assert.ok(/window\.api\.sendCustomCat\(customSliderCommand\(b\.command, \+range\.value\)\)/.test(vfo));
  assert.ok(/setTimeout\(\(\) => \{[\s\S]{0,200}?customSliderTimers\[key\] = null;/.test(vfo), 'debounced');
});

test('web VFO pane mirrors slider slots, not just buttons', () => {
  const js = R('renderer/remote.js');
  const fn = js.slice(js.indexOf('function renderVfCustomCat()'), js.indexOf('function renderVfCustomCat()') + 2600);
  assert.ok(/Array\.from\(src\.children\)/.test(fn), 'walks every slot, not just <button>');
  assert.ok(/slot\.querySelector\('input\[type="range"\]'\)/.test(fn));
  assert.ok(/srcRange\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/.test(fn),
    'drives the source control so debounce and template live in one place');
});

// ------------------------------------------------------------- 4. toolbar
console.log('\n=== #4 the phone toolbar ===');

test('opening a dropdown never touches the toolbar\'s overflow (that reset its scroll)', () => {
  const js = R('renderer/remote.js');
  assert.ok(!/_filterScroll\.style\.overflowX/.test(js), 'no overflow flipping left anywhere');
  assert.ok(/function openDropdownPanel\(btn, panel\)/.test(js));
  assert.ok(/if \(panel\.parentNode !== document\.body\) document\.body\.appendChild\(panel\);/.test(js),
    'the open panel is moved out of the scrolling bar so nothing can clip it');
  assert.ok(/left \+ width > window\.innerWidth - margin/.test(js), 'kept inside a phone screen');
  const css = R('renderer/remote.css');
  assert.ok(/\.rc-dropdown-menu\.rc-open,\n\.rc-spots-panel\.rc-open \{ display: block; \}/.test(css),
    'a panel on <body> is shown by its own class');
});

// ------------------------------------------------------------- 5. brackets
console.log('\n=== #5 a hash-bracketed call can be hunted from the web ===');

test('the web hunt matcher uses the shared parser, brackets and all', () => {
  const js = R('renderer/remote.js');
  const fn = js.slice(js.indexOf('// Auto-reply runs regardless of filter'), js.indexOf('// Auto-reply runs regardless of filter') + 1800);
  assert.ok(/JtcatParser\.parseCq\(upper\)/.test(fn), 'shared parser strips the <...> a resolved hash wears');
  assert.ok(/JtcatParser\.normalizeCall\(call\) === JtcatParser\.normalizeCall\(ft8HuntCall\)/.test(fn),
    'a portable or hashed rendering of the hunted station still counts');
});

test('the shared parser answers every bracketed shape (the behaviour the web now inherits)', () => {
  const P = require('../renderer/jtcat-parser.js');
  assert.strictEqual(P.parseCq('CQ <SP9ABC/P> KO02').call, 'SP9ABC/P');
  assert.strictEqual(P.inferReplyStep({ text: 'LZ3AW <SP9ABC/P> -12' }, 'LZ3AW').call, 'SP9ABC/P');
  assert.strictEqual(P.inferReplyStep({ text: 'DL1ABC <SP9ABC/P> RR73' }, 'LZ3AW').call, 'SP9ABC/P');
  assert.strictEqual(P.parseCq('CQ <...> KO02').call, '', 'an unresolved hash is still refused');
});

async function main() {
  for (const [name, fn] of asyncQueue) await atest(name, fn);
  console.log(`
LZ3AW round 5: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
