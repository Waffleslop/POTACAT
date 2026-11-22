#!/usr/bin/env node
'use strict';
// A potacat://tune link that launches POTACAT used to tune after a fixed 2 s,
// before most radios are connected. lib/tune-link-pending.js holds it until the
// radio link is up and a frequency has been read back, tunes it once, and drops
// it after 60 s with "Could not tune: the radio did not connect". Only the
// latest link counts. Run: node test/tune-link-pending-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/tune-link-pending');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const T0 = 1000000;

console.log('tune link waits for the radio');
test('the link frequency is parsed like handleProtocolUrl does', () => {
  assert.strictEqual(P.tuneLinkFreqKhz('potacat://tune/14074/USB'), 14074);
  assert.strictEqual(P.tuneLinkFreqKhz('potacat://tune/7074.5/FT8'), 7074.5);
  assert.strictEqual(P.tuneLinkFreqKhz('potacat:///tune/14074/USB'), 14074);
  assert.ok(Number.isNaN(P.tuneLinkFreqKhz('potacat://tune/abc/USB')));
  assert.ok(Number.isNaN(P.tuneLinkFreqKhz('potacat://tune/')));
  assert.ok(Number.isNaN(P.tuneLinkFreqKhz('potacat://pass/ABC123')));
  assert.ok(Number.isNaN(P.tuneLinkFreqKhz('not a url')));
});
test('the defaults: 60 s and the notice text', () => {
  assert.strictEqual(P.TUNE_LINK_WAIT_MS, 60000);
  assert.strictEqual(P.GIVE_UP_NOTICE, 'Could not tune: the radio did not connect');
});
test('no radio configured: the link tunes now (as before)', () => {
  const h = P.createPendingTuneLink();
  assert.deepStrictEqual(h.offer('L1', T0, false), { action: 'tune', link: 'L1' });
  assert.strictEqual(h.pending, null);
});
test('radio not ready: the link is held', () => {
  const h = P.createPendingTuneLink();
  const r = h.offer('L1', T0, true);
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(r.waitMs, 60000);
  assert.strictEqual(h.pending, 'L1');
});
test('link up alone is not ready (a port can open before the radio answers)', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  assert.strictEqual(h.noteLinkUp(true), null);
  assert.strictEqual(h.pending, 'L1');
});
test('a frequency before the link is up does not count', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  assert.strictEqual(h.noteFrequency(14074000), null);
  assert.strictEqual(h.noteLinkUp(true), null);
  assert.strictEqual(h.pending, 'L1');
});
test('link up, then a readback: tunes once', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  h.noteLinkUp(true);
  assert.deepStrictEqual(h.noteFrequency(14074000), { action: 'tune', link: 'L1' });
  assert.strictEqual(h.pending, null);
  assert.strictEqual(h.noteFrequency(14074000), null, 'once only');
  assert.strictEqual(h.check(T0 + 120000), null, 'no give-up after it tuned');
});
test('a zero frequency is not a readback', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  h.noteLinkUp(true);
  assert.strictEqual(h.noteFrequency(0), null);
  assert.strictEqual(h.pending, 'L1');
});
test('only the latest link counts', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  const r = h.offer('L2', T0 + 5000, true);
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.replaced, true);
  h.noteLinkUp(true);
  assert.deepStrictEqual(h.noteFrequency(7074000), { action: 'tune', link: 'L2' });
});
test('a link replacing another restarts the 60 s', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  h.offer('L2', T0 + 30000, true);
  assert.strictEqual(h.check(T0 + 60000), null);
  assert.deepStrictEqual(h.check(T0 + 90000), { action: 'give-up', link: 'L2' });
});
test('60 s without ready: give up, once, and nothing tunes later', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  assert.strictEqual(h.check(T0 + 59999), null);
  assert.deepStrictEqual(h.check(T0 + 60000), { action: 'give-up', link: 'L1' });
  assert.strictEqual(h.check(T0 + 70000), null);
  h.noteLinkUp(true);
  assert.strictEqual(h.noteFrequency(14074000), null, 'the dropped link never tunes');
});
test('the radio already ready when the link arrives: tunes now', () => {
  const h = P.createPendingTuneLink();
  h.noteLinkUp(true);
  h.noteFrequency(14074000);
  assert.deepStrictEqual(h.offer('L1', T0, true), { action: 'tune', link: 'L1' });
});
test('once ready, later links go straight through even if the link drops', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  h.noteLinkUp(true);
  h.noteFrequency(14074000);
  assert.strictEqual(h.ready, true);
  h.noteLinkUp(false);
  assert.deepStrictEqual(h.offer('L2', T0 + 1000, true), { action: 'tune', link: 'L2' });
});
test('a link that drops before the readback must read back again', () => {
  const h = P.createPendingTuneLink();
  h.offer('L1', T0, true);
  h.noteLinkUp(true);
  h.noteLinkUp(false);
  assert.strictEqual(h.noteFrequency(14074000), null);
  h.noteLinkUp(true);
  assert.deepStrictEqual(h.noteFrequency(14074000), { action: 'tune', link: 'L1' });
});
test('a custom timeout is honoured', () => {
  const h = P.createPendingTuneLink({ timeoutMs: 5000 });
  assert.strictEqual(h.offer('L1', T0, true).waitMs, 5000);
  assert.deepStrictEqual(h.check(T0 + 5000), { action: 'give-up', link: 'L1' });
});

console.log('tune link waits for the radio: main.js wiring');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const hStart = main.indexOf('function handleProtocolUrl(');
const hBody = main.slice(hStart, main.indexOf('\n}\n', hStart));
test('handleProtocolUrl holds a tune link before it tunes', () => {
  const hold = hBody.indexOf('tuneLinkHold(');
  const tune = hBody.indexOf('tuneRadio(');
  assert.ok(hold > 0 && tune > 0 && hold < tune);
  assert.ok(/if \(tuneLinkHold\(url\)\) return;/.test(hBody), 'a held link returns before tuneRadio');
});
test('sendCatStatus feeds the link state, sendCatFrequency the readback (never the tune echo)', () => {
  const cs = main.indexOf('function sendCatStatus(');
  const csBody = main.slice(cs, main.indexOf('\n}\n', cs));
  assert.ok(/tuneLinkPendingNoteLinkUp\(!!\(s && s\.connected\)\)/.test(csBody));
  const cf = main.indexOf('function sendCatFrequency(');
  const cfBody = main.slice(cf, main.indexOf('\n}\n', cf));
  assert.ok(/!_jtcatTuneEcho[^\n]*tuneLinkPendingNoteFrequency\(hz\)/.test(cfBody));
});
test('the give-up reaches the main window and the CAT log', () => {
  const r = main.indexOf('function tuneLinkPendingRun(');
  const rBody = main.slice(r, main.indexOf('\n}\n', r));
  assert.ok(/'app-notice'[^\n]*GIVE_UP_NOTICE/.test(rBody));
  assert.ok(/sendCatLog\([^\n]*GIVE_UP_NOTICE/.test(rBody));
  assert.ok(/setImmediate\(\(\) => handleProtocolUrl\(r\.link\)\)/.test(rBody), 'a ready link re-enters handleProtocolUrl');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
