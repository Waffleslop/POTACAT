'use strict';
// ECHOCAT Web could leave the shack keyed after the operator let go (K4DZC
// report, FT-710, #935): Space held while the window lost focus, Space let go
// while a text box had focus, a PTT press the browser cancelled, and a release
// made while the socket was down (dropped, never resent). lib/ptt-release.js
// decides when to let go and whether the shack still needs to hear it;
// renderer/remote.js wires the page's events to it.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const PttRelease = require('../lib/ptt-release');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('  FAIL', name, '-', e.message.split('\n')[0]); }
}
const read = (p) => readSrc(path.join(__dirname, '..', p));
const space = (extra) => Object.assign({ code: 'Space', repeat: false }, extra || {});

// --- holds ---

t('a gesture that holds lets go once', () => {
  const r = PttRelease.create();
  assert.strictEqual(r.release('pointer'), false, 'nothing held: nothing to stop');
  r.press('pointer');
  assert.strictEqual(r.holding('pointer'), true);
  assert.strictEqual(r.release('pointer'), true);
  assert.strictEqual(r.release('pointer'), false, 'a second release is a no-op');
});

t('blur / hidden / pagehide let go of every gesture hold', () => {
  const r = PttRelease.create();
  assert.strictEqual(r.releaseAll(), false, 'nothing held');
  r.press('space');
  assert.strictEqual(r.holding(), true);
  assert.strictEqual(r.releaseAll(), true);
  assert.strictEqual(r.holding(), false);
  assert.strictEqual(r.release('space'), false, 'the late keyup after blur does nothing more');
  r.press('pointer');
  assert.strictEqual(r.releaseAll(), true);
});

t('unknown sources are ignored', () => {
  const r = PttRelease.create();
  r.press('bluetooth');
  assert.strictEqual(r.holding(), false, 'a headset toggle is not a gesture hold');
  assert.strictEqual(r.release('bluetooth'), false);
});

// --- Space ---

t('Space starts PTT only outside a text box, never on a repeat', () => {
  const r = PttRelease.create();
  assert.strictEqual(r.spaceStarts(space(), false), true);
  assert.strictEqual(r.spaceStarts(space(), true), false, 'typing a space in a box never keys');
  assert.strictEqual(r.spaceStarts(space({ repeat: true }), false), false);
  assert.strictEqual(r.spaceStarts({ code: 'KeyA', repeat: false }, false), false);
});

t('Space up lets go while Space holds, even if a text box took focus', () => {
  const r = PttRelease.create();
  r.press('space');
  assert.strictEqual(r.spaceReleases(space(), true), true, 'focus moved to a box during the hold');
  assert.strictEqual(r.spaceReleases(space(), false), true);
});

t('Space up outside a text box still stops PTT (the old release stays)', () => {
  const r = PttRelease.create();
  assert.strictEqual(r.spaceReleases(space(), false), true);
  assert.strictEqual(r.spaceReleases(space(), true), false, 'typing in a box, Space never held: leave PTT alone');
  assert.strictEqual(r.spaceReleases({ code: 'Enter' }, false), false);
});

t('typing targets', () => {
  assert.strictEqual(PttRelease.isTypingTarget(null), false);
  assert.strictEqual(PttRelease.isTypingTarget({ tagName: 'INPUT' }), true);
  assert.strictEqual(PttRelease.isTypingTarget({ tagName: 'textarea' }), true);
  assert.strictEqual(PttRelease.isTypingTarget({ tagName: 'SELECT' }), true);
  assert.strictEqual(PttRelease.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.strictEqual(PttRelease.isTypingTarget({ tagName: 'BUTTON' }), false);
});

// --- off owed ---

t('a release on a closed socket is owed and sent once after auth-ok', () => {
  const r = PttRelease.create();
  r.offSent(false);
  assert.strictEqual(r.offOwed(), true);
  assert.strictEqual(r.takeOwed(), true);
  assert.strictEqual(r.takeOwed(), false, 'sent once');
});

t('a release on an open socket that answers is not owed', () => {
  const r = PttRelease.create();
  r.offSent(true);
  r.heard();
  r.socketClosed();
  assert.strictEqual(r.takeOwed(), false);
});

t('a release on a socket that dies before answering is owed (dead socket still read OPEN)', () => {
  const r = PttRelease.create();
  r.offSent(true);
  r.socketClosed();
  assert.strictEqual(r.takeOwed(), true);
});

t('the owed off stays owed across failed reconnects', () => {
  const r = PttRelease.create();
  r.offSent(false);
  r.socketClosed();
  r.socketClosed();
  assert.strictEqual(r.offOwed(), true);
  assert.strictEqual(r.takeOwed(), true);
});

t('a close with no release outstanding owes nothing', () => {
  const r = PttRelease.create();
  r.socketClosed();
  assert.strictEqual(r.takeOwed(), false);
});

t('nothing in the module can start PTT', () => {
  const src = read('lib/ptt-release.js');
  assert.ok(!/state:\s*true/.test(src), 'no ptt-on message');
  assert.ok(!/\bsend\(/.test(src), 'no socket access');
});

// --- the page wiring ---

t('ECHOCAT Web inlines the module', () => {
  assert.ok(read('renderer/remote.html').includes('<!-- ptt-release-js -->'));
  assert.ok(read('lib/remote-server.js').includes("['ptt-release-js', 'ptt-release.js']"));
  assert.ok(read('renderer/remote.js').includes('PttRelease.create('));
});

// The PTT section of remote.js, from the marker to the Bluetooth section.
function pttSection() {
  const js = read('renderer/remote.js');
  const a = js.indexOf('// --- PTT ---');
  const b = js.indexOf('// --- Bluetooth PTT');
  assert.ok(a > 0 && b > a, 'PTT section markers present');
  return js.slice(a, b);
}

t('window blur, page hidden and pagehide let go of PTT', () => {
  const s = pttSection();
  assert.ok(/window\.addEventListener\('blur'/.test(s), 'blur');
  assert.ok(/addEventListener\('visibilitychange'[\s\S]{0,200}hidden/.test(s), 'visibilitychange to hidden');
  assert.ok(/window\.addEventListener\('pagehide'/.test(s), 'pagehide');
  assert.ok(/releaseAll\(\)/.test(s), 'they use the gesture release');
});

t('the PTT buttons use pointer events with capture and every cancel path', () => {
  const s = pttSection();
  for (const ev of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave', 'touchcancel']) {
    assert.ok(s.includes("'" + ev + "'"), ev + ' wired');
  }
  assert.ok(/setPointerCapture\(/.test(s), 'setPointerCapture');
  const js = read('renderer/remote.js');
  assert.ok(!/pttBtn\.addEventListener\('mouse(down|up|leave)'/.test(js), 'no mouse-only wiring on the main PTT button');
  assert.ok(!/vfPttBtn\.addEventListener\('mouse(down|up|leave)'/.test(js), 'no mouse-only wiring on the VFO PTT button');
  assert.ok(/wirePttHoldButton\(pttBtn/.test(js), 'main PTT button uses the shared wiring');
  assert.ok(/wirePttHoldButton\(vfPttBtn/.test(js), 'VFO PTT button uses the shared wiring');
});

t('Space keyup releases whatever has focus; keydown keeps the no-typing rule', () => {
  const s = pttSection();
  assert.ok(/spaceStarts\(e, PttRelease\.isTypingTarget\(document\.activeElement\)\)/.test(s));
  assert.ok(/spaceReleases\(e, PttRelease\.isTypingTarget\(document\.activeElement\)\)/.test(s));
  assert.ok(!/keyup[\s\S]{0,120}!isInputFocused\(\)/.test(s), 'the keyup is no longer gated on focus');
});

t('a release on a socket that is not open is remembered and sent after auth-ok, first', () => {
  const js = read('renderer/remote.js');
  const s = pttSection();
  assert.ok(/pttRelease\.offSent\(/.test(s), 'pttStop records the release');
  assert.ok(/pttRelease\.heard\(\)/.test(js), 'inbound messages confirm the socket');
  assert.ok(/function onWsClosed\(\) \{[\s\S]{0,200}pttRelease\.socketClosed\(\)/.test(js), 'a closed socket is noted');
  const authOk = js.indexOf("case 'auth-ok':");
  assert.ok(authOk > 0);
  const next = js.slice(authOk, authOk + 400);
  assert.ok(/^case 'auth-ok':\s*\n\s*flushOwedPttOff\(\);/.test(next), 'the owed off is the first thing on auth-ok');
  assert.ok(/function flushOwedPttOff\(\) \{[\s\S]{0,300}takeOwed\(\)[\s\S]{0,300}type: 'ptt', state: false/.test(js), 'flush sends ptt off');
});

t('no new path keys: ptt state:true is sent only by pttStart and the SSB macro player', () => {
  const js = read('renderer/remote.js');
  const n = (js.match(/type: 'ptt', state: true/g) || []).length;
  assert.strictEqual(n, 2, 'pttStart + playSsbMacro, as before');
});

console.log(`ptt-release: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
