#!/usr/bin/env node
'use strict';
/**
 * #1100 SDR-only tuning (Casey 2026-11-26). With the radio switched off or its
 * CAT link down, a connected SDR kept playing the radio's last frequency and
 * every desktop tune (a spot click, the VFO window's dial or a typed
 * frequency) was refused, while the same tune from ECHOCAT went to the SDR
 * (#329). Now the desktop tune goes to the connected SDR, nothing goes to the
 * radio, and the VFO window says "Radio off: SDR only".
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const L = require('../lib/listen-source');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const KIWI = { connected: true, reach: L.KIWI_REACH, manual: false };
const KIWI_CHOSEN = { connected: true, reach: L.KIWI_REACH, manual: true };
const RIG_HF = [[30e3, 54e6]];

console.log('The decision (lib/listen-source.js desktopTune)');
check('radio off + SDR connected: the tune goes to the SDR', () => {
  assert.strictEqual(typeof L.desktopTune, 'function', 'desktopTune exists');
  assert.strictEqual(L.desktopTune(14.074e6, false, null, KIWI), 'sdr');
  assert.strictEqual(L.desktopTune(7.2e6, false, null, KIWI_CHOSEN), 'sdr');
  // An SDR whose reach is not known yet (greeting pending) is given the benefit of the doubt.
  assert.strictEqual(L.desktopTune(14.074e6, false, null, { connected: true, reach: null, manual: false }), 'sdr');
});
check('radio on: unchanged, the radio and the arbiter take it (SDR or not)', () => {
  assert.strictEqual(L.desktopTune(14.074e6, true, RIG_HF, KIWI), 'rig');
  assert.strictEqual(L.desktopTune(14.074e6, true, RIG_HF, KIWI_CHOSEN), 'rig');
  assert.strictEqual(L.desktopTune(162.55e6, true, RIG_HF, null), 'rig');
});
check('no SDR connected: today\'s refusal (a listed SDR is not brought up from a desktop tune)', () => {
  assert.strictEqual(L.desktopTune(14.074e6, false, null, null), 'refuse');
  assert.strictEqual(L.desktopTune(14.074e6, false, null, { connected: false, reach: L.KIWI_REACH, manual: false }), 'refuse');
});
check('a connected SDR that cannot hear it: refused (a Kiwi on 2 m)', () => {
  assert.strictEqual(L.desktopTune(145.5e6, false, null, KIWI), 'refuse');
});
check('a radio with no CAT control that hears it: set by hand as before; out of its reach, the SDR', () => {
  assert.strictEqual(L.desktopTune(14.074e6, false, RIG_HF, KIWI), 'refuse');
  assert.strictEqual(L.desktopTune(14.074e6, false, RIG_HF, KIWI_CHOSEN), 'sdr');
});

console.log('The indication (sdrOnly, SDR_ONLY_TEXT)');
check('the words are exactly "Radio off: SDR only"', () => {
  assert.strictEqual(L.SDR_ONLY_TEXT, 'Radio off: SDR only');
});
check('shown only with no radio link and a connected SDR', () => {
  assert.strictEqual(L.sdrOnly({ rigLinked: false, sdrConnected: true }), true);
  assert.strictEqual(L.sdrOnly({ rigLinked: true, sdrConnected: true }), false);
  assert.strictEqual(L.sdrOnly({ rigLinked: false, sdrConnected: false }), false);
  assert.strictEqual(L.sdrOnly({ rigLinked: false, sdrConnected: true, noCat: true }), false, 'a no-CAT radio is on, not off');
  assert.strictEqual(L.sdrOnly({ rigLinked: false, sdrConnected: true, remote: true }), false, 'the shack decides on a remote client');
  assert.strictEqual(L.sdrOnly(null), false);
});

const main = readSrc(path.join(ROOT, 'main.js'));
const fnBody = (name) => {
  const at = main.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' exists');
  const end = main.indexOf('\n}\n', at);
  return main.slice(at, end);
};

console.log('main.js glue');
check('the desktop tune handler asks desktopTune before the refusal and returns with nothing sent to the radio', () => {
  const at = main.indexOf("ipcMain.on('tune', (_e, { frequency, mode, bearing, slicePort, origin, pickSideband }) => {");
  assert.ok(at > 0, 'tune handler');
  const h = main.slice(at, main.indexOf("// --- Rig Control Panel IPC ---", at));
  const dead = h.indexOf('if (!((smartSdr && smartSdr.canTune) || (cat && cat.connected) || tciRigLinked())) {');
  const ask = h.indexOf("ListenSource.desktopTune(sdrHz, false, rigReachNow(), listenSdrState()) === 'sdr'");
  const refusal = h.indexOf('CatGate.tuneRefusal(');
  const noCat = h.indexOf("_e.sender.send('tune-blocked', `No CAT control");
  assert.ok(dead > 0 && ask > dead, 'inside the no-link branch');
  assert.ok(ask < refusal && ask < noCat, 'before both refusals');
  assert.ok(ask < h.indexOf('tuneRadio('), 'before tuneRadio');
  const branch = h.slice(ask, h.indexOf('return;', ask) + 'return;'.length);
  assert.ok(/listenSdrTakeWithoutRig\(sdrHz, mode, /.test(branch), 'the SDR takes it');
  assert.ok(!/\bcat\.|tuneRadio|smartSdr\.|tciRig|setTransmit|Ptt/i.test(branch.replace(/catTarget/g, '')), 'nothing to CAT or PTT in the SDR-only branch');
});
check('the SDR-only take sends nothing to the radio and holds every readout', () => {
  const b = fnBody('listenSdrTakeWithoutRig');
  assert.ok(/listenSdr\.withoutRig = true;/.test(b));
  assert.ok(/if \(listenSdr\.live\) listenSdr\.auto = true;/.test(b), 'a chosen SDR holds the dial while the radio is away');
  assert.ok(/listenSdrTake\(hz, mode, why\);/.test(b));
  assert.ok(!/\bcat\.|tuneRadio|smartSdr\.|setTransmit/.test(b), 'no radio call');
  const take = fnBody('listenSdrTake');
  assert.ok(!/\bcat\.|tuneRadio|smartSdr\.|setTransmit/.test(take), 'listenSdrTake moves only the SDR');
});
check('ECHOCAT\'s tune without a rig uses the same take (one path for both)', () => {
  const at = main.indexOf("remoteServer.on('tune', ({ freqKhz, mode, bearing, channelId");
  const h = main.slice(at, at + 4000);
  assert.ok(/if \(route === 'sdr'\) \{ listenSdrTakeWithoutRig\(hz, mode, why\); return; \}/.test(h));
});
check('the radio back: SDR-only ends, the radio is NOT tuned to the SDR\'s frequency', () => {
  const b = fnBody('listenSdrRadioBack');
  assert.ok(/if \(!listenSdr\.withoutRig\) return;/.test(b));
  assert.ok(!/tuneRadio|\bcat\.|smartSdr\.|setTransmit/.test(b), 'the radio keeps its own dial');
  assert.ok(/kiwiGoIdle\('the radio is back'\)/.test(b), 'an SDR brought in only for SDR-only goes idle');
  const s = main.slice(main.indexOf('function sendCatStatus('), main.indexOf("sendCatLog('[CAT] Radio link restored.')"));
  assert.ok(/listenSdrRadioBack\(\);/.test(s.slice(s.lastIndexOf('} else {'))), 'called on the link-up transition');
});
check('the flag clears with the SDR (disconnect, error, idle)', () => {
  assert.ok((main.match(/listenSdr\.withoutRig = false;/g) || []).length >= 4);
  assert.ok(/listenSdr\.withoutRig = false;/.test(fnBody('kiwiGoIdle')));
});
check('the state rides on vfo-radio-state and kiwi-status (the phone gets it too)', () => {
  assert.ok(/sdrOnly: sdrOnlyNow\(\),/.test(fnBody('sendVfoState')));
  assert.ok(/sdrOnly: sdrOnlyNow\(\)/.test(fnBody('broadcastKiwiStatus')));
  const s = fnBody('sdrOnlyNow');
  assert.ok(/ListenSource\.sdrOnly\(/.test(s) && /rigLinked: rigTuneLinked\(\)/.test(s));
  const st = main.slice(main.indexOf('function sendCatStatus('), main.indexOf("sendCatLog('[CAT] Radio link restored.')"));
  assert.ok(st.includes('if (kiwiClient && kiwiClient.connected) broadcastKiwiStatus(listenSdr.live'), 'a link change re-sends kiwi-status');
  const r = fnBody('rigTuneLinked');
  assert.ok(r.includes('(smartSdr && smartSdr.canTune) || (cat && cat.connected) || tciRigLinked()'), 'the tune handler\'s own test');
});

console.log('VFO window');
const vfo = readSrc(path.join(ROOT, 'renderer', 'vfo-popout.html'));
check('the chip says "Radio off: SDR only", hidden until main says so', () => {
  assert.ok(vfo.includes('<span class="chip sdr-only" id="sdr-only-badge" style="display:none"'));
  assert.ok(vfo.includes('>' + L.SDR_ONLY_TEXT + '</span>'));
  assert.ok(/\.chip\.sdr-only \{ background: var\(--amber\); color: var\(--on-amber\);/.test(vfo), 'theme tokens: each theme\'s own text colour on its warning colour');
  assert.ok(/--on-amber: var\(--ds-on-warn\);/.test(vfo), 'design-system themes use --ds-on-warn');
  assert.ok(/'kiwi-rx-badge', 'sdr-only-badge'/.test(vfo), 'goes with the mode chips into the Small VFO');
});
check('it follows main\'s sdrOnly from both channels; the SDR going away clears it', () => {
  assert.ok(/if \(s && s\.sdrOnly !== undefined\) setSdrOnly\(s\.sdrOnly\);/.test(vfo));
  assert.ok(/if \(s\.sdrOnly !== undefined\) setSdrOnly\(s\.sdrOnly\);\s*else if \(!s\.connected\) setSdrOnly\(false\);/.test(vfo));
});
check('the dial shows the SDR\'s frequency while SDR-only, not dashes', () => {
  assert.ok(/renderFreqDisplay\(radioLinkUp \|\| sdrOnly \? currentFreqHz : 0\);/.test(vfo));
});
check('no emoji in the new words', () => {
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(L.SDR_ONLY_TEXT));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
