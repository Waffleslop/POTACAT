#!/usr/bin/env node
'use strict';
/**
 * "No CAT control (VOX)" radio type — N4FFF's Pebble HF, 2026-10-04: a uSDX
 * kit with no CAT port, VOX-keyed, that POTACAT could only be told about by
 * leaving the rig unset or lying about a (tr)uSDX. Two things had to hold:
 *
 *  1. The type exists end to end: rig editor radio -> catTarget {type:'none'}
 *     -> main connects nothing, keys nothing, refuses nothing, and says so in
 *     plain words (no "Radio not connected", no "PTT FAILED"); the status pill
 *     is neutral; the setup checklist calls the control step satisfied.
 *  2. The FT8/JTTY wrong-band guard only trusts a LIVE dial: with no CAT the
 *     tracked frequency was the previous rig's and blocked every Send with
 *     nothing visible in a keyboard-mode pane — and the dial is cleared when
 *     a rig is dropped.
 *
 * Run: node test/nocat-rig-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RigFamily = require('../lib/rig-family');
const { radioTypeFromCatTarget } = require('../lib/rig-setup-notes');
const SS = require('../lib/station-setup');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
console.log('No CAT control (VOX) rig type');

test('the type maps consistently: radio "nocat" <-> catTarget {type:"none"} <-> family "none"', () => {
  assert.strictEqual(RigFamily.familyFromRadioType('nocat'), 'none');
  assert.strictEqual(RigFamily.familyFromCatTarget({ type: 'none' }), 'none');
  assert.strictEqual(RigFamily.rigFamily({ catTarget: { type: 'none' } }), 'none');
  assert.strictEqual(radioTypeFromCatTarget({ type: 'none' }), 'nocat');
});

test('the setup checklist treats no-CAT as satisfied, and skips the measured transmit test instead of blocking it', () => {
  const live = { callsign: 'N4FFF', grid: 'EM73', catConnected: false, clock: { level: 'ok', offsetMs: 10 }, rxTest: { result: 'ok', dbfs: -30 }, txDeviceTest: { ok: true } };
  const r = SS.evaluateChecklist({
    rig: { id: 'r1', name: 'Pebble HF', model: '', radioType: 'nocat', audioSource: 'local', inputDeviceId: 'card-in', outputDeviceId: 'card-out', active: true },
    modelInfo: null, platform: 'win32', notes: [], live, prefs: {},
  });
  const step = (id) => r.steps.find((s) => s.id === id);
  assert.strictEqual(step('radio-control').state, 'ok');
  assert.ok(/No CAT control/.test(step('radio-control').detail), step('radio-control').detail);
  assert.deepStrictEqual(step('radio-control').actions, [], 'nothing to fix');
  assert.strictEqual(step('tx-test').state, 'unknown', 'not blocked — provable with the tune tone');
  assert.ok(/VOX/.test(step('tx-test').detail));
  assert.ok(step('tx-test').actions.some((a) => a.id === 'tune-tone'));
  assert.ok(!r.steps.some((s) => /not connected/i.test(s.detail || '')), 'never "not connected"');
  // A serial rig with a dead link still says needs — the choice is per type.
  const r2 = SS.evaluateChecklist({ rig: { id: 'r2', name: 'x', model: 'FT-891', radioType: 'serialcat', inputDeviceId: 'a', outputDeviceId: 'b', active: true }, modelInfo: null, platform: 'win32', notes: [], live, prefs: {} });
  assert.strictEqual(r2.steps.find((s) => s.id === 'radio-control').state, 'needs');
});

test('rig editor: the radio button, its panel, the saved target and the load-side mapping', () => {
  const html = read('renderer/index.html');
  assert.ok(html.includes('<input type="radio" name="radio-type" value="nocat"> No CAT control (VOX)'), 'radio button');
  assert.ok(html.includes('id="nocat-config"') && /Pebble HF/.test(html), 'help panel names the kit');
  const app = read('renderer/app.js');
  assert.ok(app.includes("} else if (radioType === 'nocat') {") && app.includes("return { type: 'none' };"), 'saves a real target, not null');
  assert.ok(/\} else if \(currentTarget\.type === 'none'\) \{\s*setRadioType\('nocat'\);/.test(app), 'reopening the rig selects the radio');
  assert.ok(app.includes("nocatConfig.classList.toggle('hidden', type !== 'nocat')"), 'panel toggles with the others');
  assert.ok(app.includes("onCatStatus(({ connected, error, wsjtxMode, noCat })") && app.includes("catStatusEl.className = 'status';"), 'neutral status pill, no red');
});

test('main: connects nothing, keys nothing, refuses nothing — and says what to set by hand', () => {
  const main = read('main.js');
  assert.ok(main.includes("if (target.type === 'none') {") && main.includes("sendCatStatus({ connected: false, noCat: true });"), 'connectCat branch');
  assert.ok(main.includes("[CAT] No CAT control for this radio: tune it by hand"), 'one plain log line');
  assert.ok(main.includes("if (target && target.type === 'none') {") && main.includes("no CAT control, the radio's VOX keys on the audio"), 'PTT is a quiet log, not PTT FAILED');
  assert.strictEqual((main.match(/No CAT control — set the radio to \$\{mhz\} MHz by hand/g) || []).length, 2, 'both tune paths (desktop IPC + ECHOCAT) say the frequency');
});

test('Pebble HF is a real model: no CAT, 20 m, 5 W — and the picker selects the no-CAT type for it', () => {
  const { RIG_MODELS, getModelList } = require('../lib/rig-models');
  const m = RIG_MODELS['Pebble HF'];
  assert.ok(m, 'in RIG_MODELS');
  assert.strictEqual(m.protocol, 'none');
  assert.strictEqual(m.noCat, true);
  assert.deepStrictEqual(m.bands, ['20m']);
  assert.strictEqual(m.maxPower, 5);
  assert.ok(Object.values(m.caps).every((v) => v === false), 'no CAT capability claimed');
  const group = getModelList().find((g) => g.brand === 'Ham Radio Duo');
  assert.ok(group && group.models.includes('Pebble HF'), 'listed under its maker');
  assert.deepStrictEqual(group.noCat, ['Pebble HF'], 'the list tells the editor which models have no CAT');
  assert.deepStrictEqual(getModelList().find((g) => g.brand === 'Yaesu').noCat, ['FTM-510D'], 'Yaesu carries its one no-CAT mobile');
  assert.ok(!getModelList().find((g) => g.brand === 'Icom').noCat, 'a brand with no such model carries no noCat list');
  const app = read('renderer/app.js');
  assert.ok(app.includes("if (noCat) setRadioType('nocat');"), 'picking the model picks the type');
  // Setup notes: the one note the Pebble needs, under the audio feature.
  const { resolveSetupNotes } = require('../lib/rig-setup-notes');
  const notes = resolveSetupNotes({ model: 'Pebble HF', modelInfo: m, radioType: 'nocat', platform: 'win32', done: [] });
  const pebble = notes.find((n) => n.id === 'pebble-vox-audio');
  assert.ok(pebble, 'note resolves for the model');
  assert.strictEqual(pebble.level, 'required');
  assert.ok(pebble.steps.some((s) => /VOX/.test(s)) && pebble.steps.some((s) => /20 m/.test(s)));
  assert.ok(!resolveSetupNotes({ model: 'FT-891', modelInfo: RIG_MODELS['FT-891'], radioType: 'serialcat', platform: 'win32', done: [] }).some((n) => n.id === 'pebble-vox-audio'), 'not shown for other radios');
});

test('FTM-510D (2026-10-23): a no-CAT 2 m / 70 cm mobile keyed through its DATA jack, with a serial PTT line as the third no-CAT keying path', () => {
  const { RIG_MODELS } = require('../lib/rig-models');
  const m = RIG_MODELS['FTM-510D'];
  assert.ok(m, 'in RIG_MODELS');
  assert.strictEqual(m.brand, 'Yaesu');
  assert.strictEqual(m.protocol, 'none');
  assert.strictEqual(m.noCat, true);
  assert.deepStrictEqual(m.bands, ['2m', '70cm']);
  assert.strictEqual(m.maxPower, 50);
  assert.ok(Object.values(m.caps).every((v) => v === false), 'no CAT capability claimed');
  // The setup note quotes the manual's DATA menus and names the PTT choices.
  const { resolveSetupNotes } = require('../lib/rig-setup-notes');
  const note = resolveSetupNotes({ model: 'FTM-510D', modelInfo: m, radioType: 'nocat', platform: 'win32', done: [] }).find((n) => n.id === 'ftm510-data-jack');
  assert.ok(note && note.level === 'required', 'note resolves for the model');
  assert.ok(note.steps.some((s) => /70 DATA BAND/.test(s)) && note.steps.some((s) => /71 DATA SPEED/.test(s)) && note.steps.some((s) => /PKS/.test(s)));
  assert.ok(!resolveSetupNotes({ model: 'Pebble HF', modelInfo: RIG_MODELS['Pebble HF'], radioType: 'nocat', platform: 'win32', done: [] }).some((n) => n.id === 'ftm510-data-jack'), 'not shown for the Pebble');
  // Rig editor: the serial option, its row, save and load.
  const html = read('renderer/index.html');
  assert.ok(html.includes('<option value="serial">') && html.includes('id="nocat-serial-row"') && html.includes('id="set-nocat-ptt-port"') && html.includes('id="set-nocat-ptt-line"'), 'serial PTT row');
  assert.ok(/FTM-510D/.test(html), 'help panel names the mobile');
  const app = read('renderer/app.js');
  assert.ok(app.includes("return { type: 'none', ptt: 'serial', pttPort, pttLine };"), 'saves the port and line');
  assert.ok(app.includes("currentTarget.ptt === 'serial' ? 'serial' : 'vox'") && app.includes("pp.value = currentTarget.pttPort || ''"), 'reopening the rig restores them');
  assert.ok(app.includes("if (pttDl) pttDl.appendChild(opt.cloneNode(true));"), 'the port list is the same one the CW Key Port offers');
  // main: the dispatcher's third path, lines dropped at open, closed on rig change and quit.
  const main = read('main.js');
  assert.ok(main.includes("if (target.ptt === 'serial') {\n      nocatSerialPtt(!!state, target);\n      return;\n    }"), 'handleRemotePtt routes to the serial line');
  assert.ok(main.includes("function nocatSerialPtt(state, target)") && main.includes("port.set({ dtr: false, rts: false }, () => {"), 'both lines dropped at open');
  assert.ok(main.includes("hupcl: true"), 'lines drop on close');
  assert.ok((main.match(/closeNocatPttPort\(\);/g) || []).length >= 3, 'closed on a rig change (both branches) and at quit');
  assert.ok(/try \{ disconnectCwKeyPort\(\); \} catch \{\}\s*try \{ closeNocatPttPort\(\); \} catch \{\}/.test(main), 'gracefulCleanup closes it');
  assert.ok(main.includes("is also the CW Key Port. One port cannot be both"), 'refuses to share the CW Key Port');
});

test('IC-7410 (2026-10-23): CI-V 80h, Preamp 1/2 ladder, internal ATU, no RIT command', () => {
  const { RIG_MODELS, getModelList } = require('../lib/rig-models');
  const { ICOM_PREAMP_1_2 } = require('../lib/rig-gain-steps');
  const m = RIG_MODELS['IC-7410'];
  assert.ok(m, 'in RIG_MODELS');
  assert.strictEqual(m.brand, 'Icom');
  assert.strictEqual(m.protocol, 'civ');
  assert.strictEqual(m.civAddr, 0x80);
  assert.strictEqual(m.preampSteps, ICOM_PREAMP_1_2);
  assert.strictEqual(m.caps.atu, true);
  assert.strictEqual(m.caps.rit, false, 'its CI-V table has no 0x21');
  assert.strictEqual(m.cw.text, 'civ', '0x17 send-CW is in its table');
  assert.strictEqual(m.maxPower, 100);
  assert.ok(!Object.entries(RIG_MODELS).some(([k, v]) => k !== 'IC-7410' && v.civAddr === 0x80), 'no other model claims 80h');
  assert.ok(getModelList().find((g) => g.brand === 'Icom').models.includes('IC-7410'), 'in the picker');
});

test('the checklist can still prove a no-CAT radio transmits: tune tone, then the operator says it keyed', () => {
  const live = { callsign: 'N4FFF', grid: 'EM73', catConnected: false, clock: { level: 'ok', offsetMs: 10 }, rxTest: { result: 'ok', dbfs: -30 }, txDeviceTest: { ok: true } };
  const rig = { id: 'r1', name: 'Pebble HF', model: 'Pebble HF', radioType: 'nocat', audioSource: 'local', inputDeviceId: 'a', outputDeviceId: 'b', active: true };
  const ev = (txTest) => SS.evaluateChecklist({ rig, modelInfo: null, platform: 'win32', notes: [], live: { ...live, txTest }, prefs: {} }).steps.find((s) => s.id === 'tx-test');
  const before = ev(undefined);
  assert.strictEqual(before.state, 'unknown');
  assert.deepStrictEqual(before.actions.map((a) => a.id), ['tune-tone', 'tx-test-confirm']);
  const toned = ev({ result: 'tune-tone', at: 1 });
  assert.strictEqual(toned.state, 'unknown', 'the tone alone proves nothing');
  const confirmed = ev({ result: 'ok', byOperator: true, at: Date.UTC(2026, 9, 5) });
  assert.strictEqual(confirmed.state, 'confirmed');
  assert.ok(/2026-10-05/.test(confirmed.detail));
  const main = read('main.js');
  assert.ok(main.includes("case 'tune-tone': {") && main.includes("startJtcatTune({ toneHz: 1500 });"), 'the action sends the tone down the FT8 route');
  const ss = read('renderer/station-setup.js');
  assert.ok(ss.includes("case 'tune-tone':") && ss.includes("const tone = confirmTx.action === 'tune-tone'"), 'the tone gets the antenna warning, worded for VOX');
});

test('the welcome wizard offers the type, and a single-band radio says so on a spot click', () => {
  const html = read('renderer/index.html');
  assert.ok(html.includes('<input type="radio" name="welcome-radio-type" value="nocat"> No CAT control (VOX)') && html.includes('id="welcome-nocat-config"'));
  const app = read('renderer/app.js');
  assert.ok(app.includes("} else if (type === 'nocat') {\n    return { type: 'none' };") || /type === 'nocat'\) \{\s*return \{ type: 'none' \};/.test(app), 'welcome builder');
  assert.ok(app.includes("wNocat.classList.toggle('hidden', type !== 'nocat')"), 'welcome panel toggles');
  const main = read('main.js');
  assert.ok(main.includes('function noCatBandNote(mhz)') && (main.match(/noCatBandNote\(parseFloat\(mhz\)\)/g) || []).length === 2, 'both tune refusals carry the band note');
});

test('the wrong-band TX guard trusts only a live dial, and a dropped rig takes its dial with it', () => {
  const main = read('main.js');
  assert.ok(main.includes("const dialLive = !!((cat && cat.connected) || (smartSdr && smartSdr.canTune && smartSdr.connected));"), 'live-link predicate');
  assert.ok(main.includes("if (dialLive && _jtcatExpectedDialHz > 0 && _currentFreqHz > 0 &&"), 'guard gated on it');
  // connectCat clears the previous rig's frequency before the next rig speaks.
  assert.ok(/cat\.disconnect\(\);\s*_icomNetworkTransport = null;[\s\S]{0,300}_currentFreqHz = 0;/.test(main), 'dial cleared on teardown');
});

console.log(`\nNo CAT control: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
