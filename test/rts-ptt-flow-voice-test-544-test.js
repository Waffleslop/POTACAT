#!/usr/bin/env node
'use strict';
// #544 (W5PLC, FTDX10, 1.14.4): Station Setup's voice test said "The radio was
// keyed in USB, but POTACAT cannot measure power" when PTT had failed and the
// radio never transmitted; PTT on RTS could be chosen together with RTS/CTS
// flow control; and the RTS/CTS auto-trial looked only at the brand.
// Run: node test/rts-ptt-flow-voice-test-544-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rtsConflict, pttFlowConflict, applyFix } = require('../lib/ptt-flow-conflict');
const { trialApplies, trialSkipReason, pttRtsSkipLine } = require('../lib/serial-hs-trial');
const { getModel, RIG_MODELS, getModelList } = require('../lib/rig-models');
const StationSetup = require('../lib/station-setup');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

// ── 1. The conflict, per port ────────────────────────────────────────────
test('the conflict is detected only on the same port', () => {
  assert.ok(rtsConflict({ flowPort: 'COM5', flow: 'hardware', pttPort: 'COM5', pttLine: 'rts' }));
  assert.ok(rtsConflict({ flowPort: 'com5', flow: 'hardware', pttPort: ' COM5 ', pttLine: 'rts' }), 'port names compare as Windows does');
  assert.strictEqual(rtsConflict({ flowPort: 'COM5', flow: 'hardware', pttPort: 'COM6', pttLine: 'rts' }), null, 'RTS keys another port: no conflict');
  assert.strictEqual(rtsConflict({ flowPort: '/dev/ttyUSB0', flow: 'hardware', pttPort: '/dev/ttyUSB1', pttLine: 'rts' }), null);
  assert.strictEqual(rtsConflict({ flowPort: 'COM5', flow: 'hardware', pttPort: 'COM5', pttLine: 'dtr' }), null, 'DTR keying is free');
  assert.strictEqual(rtsConflict({ flowPort: 'COM5', flow: 'none', pttPort: 'COM5', pttLine: 'rts' }), null, 'RTS held low is free');
  assert.ok(rtsConflict({ flowPort: 'COM5', flow: 'asserted', pttPort: 'COM5', pttLine: 'rts' }), 'RTS held high is the same trap');
});

test('a serial CAT rig: PTT "RTS on the CAT port" with RTS/CTS is a conflict, with the plain message and two fixes', () => {
  const c = pttFlowConflict({ type: 'serial', path: 'COM7', ptt: 'rts', serialHandshake: 'hardware' });
  assert.ok(c);
  assert.strictEqual(c.source, 'rig');
  assert.strictEqual(c.port, 'COM7');
  assert.strictEqual(c.message, "PTT on RTS can't work while RTS/CTS flow control is on for this port. Turn one off.");
  assert.deepStrictEqual(c.fixes.map((f) => f.id), ['rts-held-low', 'ptt-over-cat']);
  assert.ok(pttFlowConflict({ type: 'serial', path: '', ptt: 'rts', serialHandshake: 'hardware' }), 'said before a port is picked');
});

test('"Auto" follows the model: a TS-590 on Auto with PTT on RTS conflicts, an FTDX10 on Auto does not', () => {
  const ts590 = pttFlowConflict({ type: 'serial', path: 'COM3', ptt: 'rts', serialHandshake: 'auto' }, RIG_MODELS['TS-590S/SG'].serialHandshake);
  assert.ok(ts590 && ts590.source === 'model');
  assert.strictEqual(pttFlowConflict({ type: 'serial', path: 'COM3', ptt: 'rts', serialHandshake: 'auto' }, getModel('FTDX10').serialHandshake), null);
  const ken = getModelList().find((g) => g.brand === 'Kenwood');
  assert.ok(ken.rtsCts && ken.rtsCts.length, 'the model list tells the rig editor which models default to RTS/CTS');
  assert.ok(!getModelList().find((g) => g.brand === 'Icom').rtsCts, 'only brands that have one');
});

test('no conflict: PTT over CAT, DTR, the audio interface, RTS held low, or not a serial CAT rig', () => {
  for (const ptt of [undefined, 'dtr', 'vox']) {
    assert.strictEqual(pttFlowConflict({ type: 'serial', path: 'COM7', ptt, serialHandshake: 'hardware' }), null, String(ptt));
  }
  assert.strictEqual(pttFlowConflict({ type: 'serial', path: 'COM7', ptt: 'rts', serialHandshake: 'none' }), null);
  assert.strictEqual(pttFlowConflict({ type: 'icom', path: 'COM7', ptt: 'rts' }, 'hardware'), null);
  assert.strictEqual(pttFlowConflict(null), null);
});

test('the fixes change only what they say, and only when applied', () => {
  const t = { type: 'serial', path: 'COM7', ptt: 'rts', serialHandshake: 'hardware', baudRate: 38400 };
  assert.deepStrictEqual(applyFix(t, 'rts-held-low'), { ...t, serialHandshake: 'none' });
  const cat = applyFix(t, 'ptt-over-cat');
  assert.ok(!('ptt' in cat), 'Over CAT is saved as no ptt field');
  assert.strictEqual(cat.serialHandshake, 'hardware');
  assert.deepStrictEqual(applyFix(t, 'nonsense'), t);
  assert.strictEqual(t.serialHandshake, 'hardware', 'the original is untouched');
  assert.strictEqual(pttFlowConflict(applyFix(t, 'rts-held-low')), null);
  assert.strictEqual(pttFlowConflict(applyFix(t, 'ptt-over-cat')), null);
});

test('the rig editor and Station Setup both show it, and nothing changes a setting unasked', () => {
  const html = read('renderer/index.html');
  assert.ok(html.includes('<script src="../lib/ptt-flow-conflict.js"></script>'));
  assert.ok(html.includes('id="serialcat-ptt-conflict"'));
  const app = read('renderer/app.js');
  assert.ok(app.includes('PttFlowConflict.pttFlowConflict(target, serialcatModelHandshake())'));
  const r = StationSetup.evaluateChecklist({
    rig: { id: 'r', model: 'FTDX10', radioType: 'serialcat', inputDeviceId: 'in', outputDeviceId: 'out' },
    modelInfo: getModel('FTDX10'),
    live: { catConnected: true, txDeviceTest: { ok: true }, txTest: null,
      pttConflict: pttFlowConflict({ type: 'serial', path: 'COM7', ptt: 'rts', serialHandshake: 'hardware' }) },
  });
  const step = r.steps.find((s) => s.id === 'ptt-line');
  assert.ok(step, 'a Transmit (PTT) step appears');
  assert.strictEqual(step.state, 'needs');
  assert.match(step.detail, /PTT on RTS can't work while RTS\/CTS flow control is on for this port/);
  assert.deepStrictEqual(step.actions.filter((a) => a.id === 'ptt-flow-fix').map((a) => a.step), ['rts-held-low', 'ptt-over-cat']);
  assert.strictEqual(r.steps.find((s) => s.id === 'tx-test').state, 'blocked', 'no transmit test that cannot key');
  const clean = StationSetup.evaluateChecklist({ rig: { id: 'r', model: 'FTDX10', radioType: 'serialcat' }, live: { catConnected: true } });
  assert.ok(!clean.steps.some((s) => s.id === 'ptt-line'), 'no step without the conflict');
  const main = read('main.js');
  assert.ok(main.includes("pttConflict: PttFlowConflict.pttFlowConflict(ct, info && info.serialHandshake)"));
  assert.ok(main.includes("case 'ptt-flow-fix': {"), 'the fix runs only from its button');
});

// ── 2. The RTS/CTS trial never raises RTS where RTS keys PTT ─────────────
test('the trial is skipped when RTS keys PTT on that port', () => {
  const ftdx10 = getModel('FTDX10');
  assert.strictEqual(trialApplies(ftdx10), true, 'brand alone still qualifies');
  assert.strictEqual(trialApplies(ftdx10, { path: 'COM7', ptt: 'rts' }), false);
  assert.strictEqual(trialSkipReason(ftdx10, { path: 'COM7', ptt: 'rts' }), 'ptt-rts');
  assert.strictEqual(trialApplies(getModel('TS-480'), { ptt: 'rts' }), false, 'Kenwood too');
  assert.strictEqual(trialApplies(ftdx10, { ptt: 'dtr' }), true, 'DTR keying does not stop it');
  assert.strictEqual(trialApplies(ftdx10, {}), true);
  assert.strictEqual(trialSkipReason(getModel(null, 'icom'), { ptt: 'rts' }), 'model', 'the brand rule comes first');
  assert.match(pttRtsSkipLine('COM7'), /^\[CAT\] Not trying RTS\/CTS flow control on COM7: RTS on this port keys PTT/);
});

test('both trial sites (connect and Test Connection) check the PTT line and log one plain line', () => {
  const main = read('main.js');
  assert.ok(main.includes("SerialHsTrial.trialSkipReason(model, target) === 'ptt-rts'"), 'connect');
  assert.ok(main.includes("sendCatLog(SerialHsTrial.pttRtsSkipLine(target.path))"));
  assert.ok(main.includes("SerialHsTrial.trialApplies(model, target)) armSerialHandshakeNoAnswerTrial"));
  assert.ok(main.includes("SerialHsTrial.trialSkipReason(model, trialTarget) === 'ptt-rts'"), 'Test Connection');
  assert.ok(!/SerialHsTrial\.trialApplies\(model\)\)/.test(main), 'no call site asks by brand alone');
  assert.ok(read('renderer/app.js').includes('window.api.testSerialCat({ portPath, baudRate, dtrOff, serialHandshake, model, ptt })'));
});

// ── 3. The test transmit says "keyed" only with evidence ─────────────────
const J = StationSetup.judgeTxTest;
test('never "keyed" after a refused key or a late PTT line error', () => {
  const refused = J({ pttAccepted: false, fwdEvents: 3, peakW: 5 });
  assert.strictEqual(refused.result, 'not-keyed');
  assert.strictEqual(refused.keyed, false);
  const lineError = { line: 'RTS', port: 'COM7', message: 'Access denied' };
  const late = J({ pttAccepted: true, lineError, txSeen: true, fwdEvents: 0 });
  assert.strictEqual(late.result, 'not-keyed', 'a line error inside the window beats everything after it');
  assert.strictEqual(late.keyed, false);
  assert.deepStrictEqual(late.lineError, lineError);
});

test('no reading at all (W5PLC): not "unmeasured" but "could not confirm"', () => {
  const r = J({ pttAccepted: true, fwdEvents: 0, alcEvents: 0, txSeen: false });
  assert.strictEqual(r.result, 'unconfirmed');
  assert.strictEqual(r.keyed, false);
  // 0 W readings with no TX state: not "keyed with no power".
  const zero = J({ pttAccepted: true, fwdEvents: 4, peakW: 0 });
  assert.strictEqual(zero.result, 'no-power');
  assert.strictEqual(zero.keyed, false);
  // An ALC of 0 is no evidence either.
  assert.strictEqual(J({ pttAccepted: true, alcEvents: 3, peakAlc: 0 }).result, 'unconfirmed');
});

test('"keyed" with power, TX-state or ALC evidence', () => {
  const ok = J({ pttAccepted: true, fwdEvents: 5, peakW: 5.04, peakSwr: 1.32 });
  assert.deepStrictEqual([ok.result, ok.keyed, ok.evidence, ok.watts, ok.swr], ['ok', true, 'power', 5, 1.3]);
  assert.strictEqual(J({ pttAccepted: true, fwdEvents: 5, peakW: 5, peakSwr: 3.4 }).result, 'swr-high');
  const tx = J({ pttAccepted: true, txSeen: true, fwdEvents: 0 });
  assert.deepStrictEqual([tx.result, tx.keyed, tx.evidence], ['unmeasured', true, 'tx-state']);
  const alc = J({ pttAccepted: true, alcEvents: 2, peakAlc: 40 });
  assert.deepStrictEqual([alc.result, alc.keyed, alc.evidence], ['unmeasured', true, 'alc']);
  const silent = J({ pttAccepted: true, txSeen: true, fwdEvents: 3, peakW: 0 });
  assert.deepStrictEqual([silent.result, silent.keyed], ['no-power', true], 'keyed per the radio, no power out');
});

test('the checklist words each result plainly, and never says keyed without evidence', () => {
  const voice = (voiceTest) => StationSetup.evaluateChecklist({
    rig: { id: 'r', model: 'FTDX10', radioType: 'serialcat', inputDeviceId: 'in', outputDeviceId: 'out' },
    modelInfo: getModel('FTDX10'),
    live: { catConnected: true, txDeviceTest: { ok: true }, txTest: { result: 'ok', watts: 5 }, voiceTest },
  }).steps.find((s) => s.id === 'voice-tx');
  const tx = (txTest) => StationSetup.evaluateChecklist({
    rig: { id: 'r', model: 'FTDX10', radioType: 'serialcat', inputDeviceId: 'in', outputDeviceId: 'out' },
    modelInfo: getModel('FTDX10'),
    live: { catConnected: true, txDeviceTest: { ok: true }, txTest },
  }).steps.find((s) => s.id === 'tx-test');
  const keyedWords = /keyed in USB|was keyed|keyed but|keyed in/i;
  for (const res of [
    J({ pttAccepted: false }),
    J({ pttAccepted: true, lineError: { line: 'RTS', port: 'COM7', message: 'Access denied' } }),
    J({ pttAccepted: true }),
    J({ pttAccepted: true, fwdEvents: 2, peakW: 0 }),
  ]) {
    for (const st of [voice(res), tx(res)]) {
      assert.strictEqual(st.state, 'needs', res.result);
      assert.ok(!keyedWords.test(st.detail) || /not keyed|was not keyed|Either it was not keyed/.test(st.detail), `${res.result}: ${st.detail}`);
      assert.ok(JSON.stringify(st.instructions).includes('Transmit (PTT)'), `${res.result} says what to check`);
    }
  }
  const late = voice(J({ pttAccepted: true, lineError: { line: 'RTS', port: 'COM7', message: 'Access denied' } }));
  assert.match(late.detail, /^The radio was not keyed: POTACAT could not switch RTS on COM7 \(Access denied\)\.$/);
  assert.match(voice(J({ pttAccepted: true })).detail, /^POTACAT could not confirm that the radio transmitted/);
  assert.match(voice(J({ pttAccepted: true, txSeen: true })).detail, /reported that it transmitted in USB/);
  assert.strictEqual(voice(J({ pttAccepted: true, fwdEvents: 3, peakW: 5 })).state, 'ok');
});

test('main judges the test by judgeTxTest, reads late line errors, and counts the radio TX state and ALC', () => {
  const main = read('main.js');
  assert.ok(main.includes('const judged = StationSetup.judgeTxTest({ pttAccepted: keyed, lineError, ...meas });'));
  assert.ok(main.includes("if (err && state) _pttLineError = { at: Date.now(), line, port: t.path || 'the CAT port', message: err.message };"));
  assert.ok(main.includes('const lineError = _pttLineError && _pttLineError.at >= tuneStartedAt ? _pttLineError : null;'));
  assert.ok(main.includes("if (cat && cat._codecTxSeen === true && (cat._codecTxSeenAt || 0) >= m.startedAt) m.txSeen = true;"));
  assert.ok(main.includes('_stationSetupTxTest.alcEvents++;'));
  assert.ok(!main.includes("if (meas.fwdEvents === 0) result = 'unmeasured';"), 'the old no-reading = keyed rule is gone');
});

console.log(`\n#544 PTT on RTS / RTS/CTS / voice test evidence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
