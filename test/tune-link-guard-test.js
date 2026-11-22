#!/usr/bin/env node
'use strict';
// A potacat://tune link (a web page: potacat.com, a Cloud on-air page) moves
// the radio. Anything JTCAT was transmitting on its own (Run, Hunt, the WSPR
// beacon, a Spot Target call, a QSO in progress, TX left enabled, Tune) must
// stop BEFORE the tune, or it carries on, unattended, on the new frequency.
// lib/tune-link-guard.js decides what stops and what the operator is told;
// main.js handleProtocolUrl runs the stop, then tunes. Spot clicks and every
// other tune keep their behaviour. Run: node test/tune-link-guard-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/tune-link-guard');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const IDLE = { run: false, hunt: false, wsprBeacon: false, spotTarget: false, qso: false, tx: false, tune: false };
const plan = (patch) => G.tuneLinkPlan({ ...IDLE, ...(patch || {}) });

console.log('tune link: what stops');
test('nothing automatic running: no halt, no notice', () => {
  const p = plan();
  assert.strictEqual(p.halt, false);
  assert.strictEqual(p.clearSpotTarget, false);
  assert.deepStrictEqual(p.stopped, []);
  assert.strictEqual(G.tuneLinkNotice(14074, p), '');
});
test('a missing snapshot is treated as idle', () => {
  const p = G.tuneLinkPlan();
  assert.strictEqual(p.halt, false);
  assert.deepStrictEqual(p.stopped, []);
});
test('Hunt running: halt, named Hunt', () => {
  const p = plan({ hunt: true });
  assert.strictEqual(p.halt, true);
  assert.deepStrictEqual(p.stopped, ['Hunt']);
});
test('Run (full auto CQ) running: halt, named Run', () => {
  const p = plan({ run: true });
  assert.strictEqual(p.halt, true);
  assert.deepStrictEqual(p.stopped, ['Run']);
});
test('the WSPR beacon armed: halt, named', () => {
  const p = plan({ wsprBeacon: true });
  assert.strictEqual(p.halt, true);
  assert.deepStrictEqual(p.stopped, ['the WSPR beacon']);
});
test('a Spot Target armed alone: cleared (it would auto-call), no TX halt needed', () => {
  const p = plan({ spotTarget: true });
  assert.strictEqual(p.halt, false);
  assert.strictEqual(p.clearSpotTarget, true);
  assert.deepStrictEqual(p.stopped, ['the Spot Target call']);
});
test('a QSO in progress: halted (nothing new is logged by the guard)', () => {
  const p = plan({ qso: true, tx: true });
  assert.strictEqual(p.halt, true);
  assert.deepStrictEqual(p.stopped, ['the QSO in progress']);
  assert.strictEqual('log' in p, false);
});
test('TX enabled or on the air with nothing else named: halted as TX', () => {
  assert.deepStrictEqual(plan({ tx: true }).stopped, ['TX']);
  assert.strictEqual(plan({ tx: true }).halt, true);
});
test('TX is not named separately when Run, Hunt, the beacon or a QSO explains it', () => {
  assert.deepStrictEqual(plan({ hunt: true, tx: true }).stopped, ['Hunt']);
  assert.deepStrictEqual(plan({ run: true, tx: true }).stopped, ['Run']);
  assert.deepStrictEqual(plan({ wsprBeacon: true, tx: true }).stopped, ['the WSPR beacon']);
});
test('the JTCAT tune carrier: halted, named', () => {
  const p = plan({ tune: true });
  assert.strictEqual(p.halt, true);
  assert.deepStrictEqual(p.stopped, ['the tune carrier']);
});
test('everything at once, in a fixed order', () => {
  const p = plan({ run: true, hunt: true, wsprBeacon: true, spotTarget: true, qso: true, tx: true, tune: true });
  assert.strictEqual(p.halt, true);
  assert.strictEqual(p.clearSpotTarget, true);
  assert.deepStrictEqual(p.stopped, ['Run', 'Hunt', 'the WSPR beacon', 'the Spot Target call', 'the QSO in progress', 'the tune carrier']);
});

console.log('tune link: the notice');
test('one mode: "was stopped"', () => {
  assert.strictEqual(G.tuneLinkNotice(14074, plan({ hunt: true })),
    'A tune link moved your radio to 14.074 MHz. Hunt was stopped so nothing transmits on the new frequency.');
});
test('two modes: "X and Y were stopped"', () => {
  assert.strictEqual(G.tuneLinkNotice(14074, plan({ run: true, hunt: true })),
    'A tune link moved your radio to 14.074 MHz. Run and Hunt were stopped so nothing transmits on the new frequency.');
});
test('three or more: commas and "and"; the first word is capitalised', () => {
  assert.strictEqual(G.tuneLinkNotice(7074, plan({ wsprBeacon: true, spotTarget: true, qso: true })),
    'A tune link moved your radio to 7.074 MHz. The WSPR beacon, the Spot Target call and the QSO in progress were stopped so nothing transmits on the new frequency.');
});
test('frequency: at least three decimals, no trailing noise', () => {
  assert.strictEqual(G.formatLinkMhz(14074), '14.074');
  assert.strictEqual(G.formatLinkMhz(14074.5), '14.0745');
  assert.strictEqual(G.formatLinkMhz(146520), '146.520');
  assert.strictEqual(G.formatLinkMhz(3573), '3.573');
  assert.strictEqual(G.formatLinkMhz(10136.25), '10.13625');
});
test('the CAT log line names the link and what stopped', () => {
  assert.strictEqual(G.tuneLinkLogLine(14074, 'FT8', plan({ run: true, hunt: true })),
    '[tune-link] potacat://tune to 14.074 MHz FT8: stopping Run, Hunt before tuning so nothing transmits on the new frequency');
  assert.strictEqual(G.tuneLinkLogLine(14074, '', plan({ hunt: true })),
    '[tune-link] potacat://tune to 14.074 MHz: stopping Hunt before tuning so nothing transmits on the new frequency');
  assert.strictEqual(G.tuneLinkLogLine(14074, 'FT8', plan()), '');
});
test('no emoji or symbols in anything the operator reads', () => {
  const all = plan({ run: true, hunt: true, wsprBeacon: true, spotTarget: true, qso: true, tx: true, tune: true });
  const text = G.tuneLinkNotice(14074, all) + G.tuneLinkLogLine(14074, 'FT8', all);
  assert.ok(/^[\x20-\x7e]*$/.test(text), text);
});

console.log('tune link: the automatic ATU tune');
// "Auto-tune ATU on band change" (settings.enableAtu) keys a carrier. A tune
// link must never start it: a click on a web page must not key the radio.
test("a link that changes band skips the band-change tune", () => {
  assert.deepStrictEqual(G.tuneLinkAutoAtu({ origin: 'link', action: 'tune' }), { start: false, linkSkipped: true });
});
test('spot clicks and every other origin keep today\'s band-change tune', () => {
  assert.deepStrictEqual(G.tuneLinkAutoAtu({ origin: undefined, action: 'tune' }), { start: true, linkSkipped: false });
  assert.deepStrictEqual(G.tuneLinkAutoAtu({ origin: 'Error\n at spot click', action: 'tune' }), { start: true, linkSkipped: false });
  assert.deepStrictEqual(G.tuneLinkAutoAtu({ action: 'tune' }), { start: true, linkSkipped: false });
});
test('nothing to skip when no tune was due (same band, setting off, WSPR receive-only hop)', () => {
  assert.deepStrictEqual(G.tuneLinkAutoAtu({ origin: 'link', action: 'none' }), { start: false, linkSkipped: false });
  assert.deepStrictEqual(G.tuneLinkAutoAtu({ origin: 'link', action: 'skip' }), { start: false, linkSkipped: false });
  assert.deepStrictEqual(G.tuneLinkAutoAtu({ origin: undefined, action: 'none' }), { start: false, linkSkipped: false });
  assert.deepStrictEqual(G.tuneLinkAutoAtu(), { start: false, linkSkipped: false });
});
test('the CAT log line for a skipped tune', () => {
  assert.strictEqual(G.tuneLinkAtuLogLine('20m'),
    '[ATU] Tune link to 20m: the automatic ATU tune was skipped; press Tune if you need it');
  assert.strictEqual(G.tuneLinkAtuLogLine(''),
    '[ATU] Tune link: the automatic ATU tune was skipped; press Tune if you need it');
});
test('the notice gains one clause when the tune was skipped, only when the notice is shown', () => {
  assert.strictEqual(G.tuneLinkNotice(14074, plan({ hunt: true }), { atuSkipped: true }),
    'A tune link moved your radio to 14.074 MHz. Hunt was stopped so nothing transmits on the new frequency.'
    + ' The automatic ATU tune was skipped; press Tune if you need it.');
  assert.strictEqual(G.tuneLinkNotice(14074, plan({ hunt: true }), { atuSkipped: false }),
    'A tune link moved your radio to 14.074 MHz. Hunt was stopped so nothing transmits on the new frequency.');
  assert.strictEqual(G.tuneLinkNotice(14074, plan(), { atuSkipped: true }), '', 'no notice of its own: the CAT log line is enough');
  const t = G.tuneLinkNotice(14074, plan({ run: true }), { atuSkipped: true }) + G.tuneLinkAtuLogLine('20m');
  assert.ok(/^[\x20-\x7e]*$/.test(t), t);
});

console.log('tune link: main.js wiring');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const hStart = main.indexOf('function handleProtocolUrl(');
const hBody = main.slice(hStart, main.indexOf('\n}\n', hStart));
test('handleProtocolUrl exists', () => assert.ok(hStart > 0));
test('the tune path stops automatic TX BEFORE tuneRadio', () => {
  const stop = hBody.indexOf('tuneLinkStopAutoTx(');
  const tune = hBody.indexOf('tuneRadio(');
  assert.ok(stop > 0, 'handleProtocolUrl must call tuneLinkStopAutoTx');
  assert.ok(tune > 0, 'handleProtocolUrl must call tuneRadio');
  assert.ok(stop < tune, 'the stop must come before the tune');
});
test("the link's tune carries origin 'link'", () => {
  assert.ok(/tuneRadio\([^;]*origin:\s*'link'/.test(hBody), "tuneRadio(..., { origin: 'link' })");
});
const sStart = main.indexOf('function tuneLinkStopAutoTx(');
const sBody = main.slice(sStart, main.indexOf('\n}\n', sStart));
test('the stop uses the existing Halt TX path and the Spot Target clear, nothing hand-rolled', () => {
  assert.ok(sStart > 0, 'tuneLinkStopAutoTx defined');
  assert.ok(/TuneLinkGuard\.tuneLinkPlan\(/.test(sBody), 'decides with lib/tune-link-guard.js');
  assert.ok(/jtcatHaltTxNow\(/.test(sBody), 'halts through jtcatHaltTxNow');
  assert.ok(/clearSpotTarget\(/.test(sBody), 'clears the Spot Target through clearSpotTarget');
  assert.ok(!/keepAuto/.test(sBody), 'never keeps Run / Hunt / the beacon');
});
const nStart = main.indexOf('function tuneLinkNotify(');
const nBody = main.slice(nStart, main.indexOf('\n}\n', nStart));
test('the notice reaches the main window and the JTCAT window on existing channels', () => {
  assert.ok(nStart > 0, 'tuneLinkNotify defined');
  assert.ok(/'app-notice'/.test(nBody), 'main window app-notice');
  assert.ok(/'jtcat-qso-notice'/.test(nBody), 'JTCAT window jtcat-qso-notice');
  assert.ok(/TuneLinkGuard\.tuneLinkNotice\([^)]*atuSkipped/.test(nBody), 'the notice carries the skipped-ATU clause');
  assert.ok(/sendCatLog\(/.test(sBody), 'CAT log line');
});
test('the notice goes out after tuneRadio, so it knows whether the ATU tune was skipped', () => {
  const tune = hBody.indexOf('tuneRadio(');
  const reset = hBody.indexOf('_tuneLinkAtuSkipped = false');
  const notify = hBody.indexOf('tuneLinkNotify(');
  assert.ok(reset > 0 && reset < tune, 'the skipped flag is cleared before the tune');
  assert.ok(notify > tune, 'tuneLinkNotify runs after tuneRadio');
  assert.ok(/tuneLinkNotify\([^;]*_tuneLinkAtuSkipped/.test(hBody), 'tuneLinkNotify is told about the skipped tune');
});

console.log('tune link: the automatic ATU tune, main.js wiring');
const tStart = main.indexOf('function tuneRadio(');
const aStart = main.indexOf('function bandChangeAtuTune(');
const tBody = main.slice(tStart, aStart);
const aBody = main.slice(aStart, main.indexOf('\n}\n', aStart));
test('every band-change tune call in tuneRadio passes the origin', () => {
  const calls = tBody.match(/bandChangeAtuTune\([^,]+,\s*\{[^}]*\}/g) || [];
  assert.strictEqual(calls.length, 3, 'three tune paths');
  for (const c of calls) assert.ok(/\borigin\b/.test(c) && /\bpurpose\b/.test(c), c);
});
test('bandChangeAtuTune checks the origin through lib/tune-link-guard.js before it can start a tune', () => {
  assert.ok(/function bandChangeAtuTune\(freqMhz,\s*\{\s*purpose,\s*origin\s*\}/.test(aBody), 'takes { purpose, origin }');
  const check = aBody.indexOf('TuneLinkGuard.tuneLinkAutoAtu(');
  const startCall = aBody.indexOf('start(');
  assert.ok(check > 0, 'decides with TuneLinkGuard.tuneLinkAutoAtu');
  assert.ok(check < startCall, 'decided before start() can run');
  assert.ok(/linkSkipped[\s\S]*sendCatLog\(TuneLinkGuard\.tuneLinkAtuLogLine\(/.test(aBody), 'a skipped tune is logged');
  assert.ok(/_tuneLinkAtuSkipped = true/.test(aBody), 'a skipped tune is reported to the notice');
  assert.ok(/_atuOwedTune = null/.test(aBody.slice(check)), 'a link drops a WSPR owed tune (the radio left that band)');
});
test('only the protocol link calls the stop (spot clicks and other tunes unchanged)', () => {
  const calls = main.split('tuneLinkStopAutoTx(').length - 1;
  assert.strictEqual(calls, 2, 'one definition + one call in handleProtocolUrl');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
