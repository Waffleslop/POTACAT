// test/voice-tx-check-test.js — "FT8 works, voice is silent" (KD9OUT, KD9WJY,
// thecoffeepotcodger FT-710; KJ5CHK IC-7300 MK II): a voice over with 0 W and
// no ALC gets one hint naming the radio's audio-input menu.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decideVoiceTxHint } = require('../lib/voice-tx-check');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const silent = { keyedMs: 4000, fwdEvents: 8, peakW: 0, alcEvents: 8, peakAlc: 0, mode: 'USB' };

console.log('voice TX check:');
t('Yaesu, 0 W and no ALC: SSB MOD SOURCE = REAR, REAR SELECT = USB, and the sound device', () => {
  const d = decideVoiceTxHint({ ...silent, brand: 'Yaesu' });
  assert.ok(d && /SSB MOD SOURCE to REAR and REAR SELECT to USB/.test(d.hint) && /USB Audio CODEC/.test(d.hint), d && d.hint);
});
t('Icom voice in USB names DATA OFF MOD; in USB-D it names DATA MOD (IC-7300 MK II has a MOD Input level)', () => {
  assert.ok(/Connectors > MOD Input > DATA OFF MOD = USB/.test(decideVoiceTxHint({ ...silent, brand: 'Icom', model: 'IC-7300 MK II' }).hint));
  assert.ok(/Connectors > MOD Input > DATA MOD = USB/.test(decideVoiceTxHint({ ...silent, brand: 'Icom', model: 'IC-7300 MK II', mode: 'USB-D' }).hint));
});
t('original IC-7300: no "MOD Input" step (Full Manual rev 12b p.126: the items sit under Connectors)', () => {
  const v = decideVoiceTxHint({ ...silent, brand: 'Icom', model: 'IC-7300' }).hint;
  const d = decideVoiceTxHint({ ...silent, brand: 'Icom', model: 'IC-7300', mode: 'USB-D' }).hint;
  assert.ok(/MENU > SET > Connectors > DATA OFF MOD = USB/.test(v), v);
  assert.ok(/MENU > SET > Connectors > DATA MOD = USB/.test(d), d);
  assert.ok(!/MOD Input/.test(v + d));
});
t('IC-7610 names DATA1 MOD for data; IC-7100 goes through SET on the controller', () => {
  assert.ok(/MOD Input > DATA1 MOD = USB/.test(decideVoiceTxHint({ ...silent, brand: 'Icom', model: 'IC-7610', mode: 'USB-D' }).hint));
  assert.ok(/MOD Input > DATA OFF MOD = USB/.test(decideVoiceTxHint({ ...silent, brand: 'Icom', model: 'IC-7610' }).hint));
  assert.ok(/push SET on the controller, then Connectors > DATA OFF MOD = USB/.test(decideVoiceTxHint({ ...silent, brand: 'Icom', model: 'IC-7100' }).hint));
});
t('an Icom with no verified path gets the item name and no menu path', () => {
  for (const model of ['IC-705', 'IC-9700', 'IC-7851', undefined]) {
    const h = decideVoiceTxHint({ ...silent, brand: 'Icom', model }).hint;
    assert.ok(/in the Connectors settings, set DATA OFF MOD to USB/.test(h), h);
    assert.ok(!/MENU >|MOD Input/.test(h), h);
  }
});
t('every Icom path in the table is a model POTACAT knows', () => {
  const { ICOM_MOD_INPUT_PATHS } = require('../lib/rig-setup-notes');
  const { RIG_MODELS } = require('../lib/rig-models');
  for (const m of Object.keys(ICOM_MOD_INPUT_PATHS)) assert.ok(RIG_MODELS[m], m);
});
t('voice-tx-check.js holds no Icom menu path of its own (they live in rig-setup-notes.js)', () => {
  const src = readSrc(path.join(__dirname, '..', 'lib', 'voice-tx-check.js'));
  assert.ok(!/MENU > SET/.test(src.replace(/^\s*\/\/.*$/gm, '')));
});
t('no hint when power or ALC moved, when the over was a blip, or when the radio reports no power at all', () => {
  assert.strictEqual(decideVoiceTxHint({ ...silent, brand: 'Yaesu', peakW: 12 }), null);
  assert.strictEqual(decideVoiceTxHint({ ...silent, brand: 'Yaesu', peakAlc: 40 }), null);
  assert.strictEqual(decideVoiceTxHint({ ...silent, brand: 'Yaesu', keyedMs: 800 }), null);
  assert.strictEqual(decideVoiceTxHint({ ...silent, brand: 'Yaesu', fwdEvents: 0 }), null);
});
t('a radio with a wattmeter and no ALC reading still gets the hint on 0 W', () => {
  assert.ok(decideVoiceTxHint({ ...silent, brand: 'Kenwood', alcEvents: 0 }));
});
t('main.js: voice key-downs on a CAT radio are measured and judged at key-up; data routes are not', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
  assert.ok(/if \(!state\) voiceTxCheckEnd\(\);\n(\s*\/\/[^\n]*\n)*\s*else if \(!isFlexRig && cat && cat\.connected && !opts\.emission/.test(main));
  assert.ok(/if \(_voiceTxCheck\) \{\n    _voiceTxCheck\.fwdEvents\+\+;/.test(main), 'power feeds it');
  assert.ok(/_voiceTxCheck\.alcEvents\+\+;/.test(main), 'ALC feeds it');
  assert.ok(main.includes("remoteServer.sendToClient({ type: 'voice-tx-hint', key: d.key, text: d.hint })"));
  const P = require('../lib/echocat-protocol');
  assert.ok(JSON.stringify(P).includes('voice-tx-hint') || readSrc(path.join(__dirname, '..', 'lib', 'echocat-protocol.js')).includes("'voice-tx-hint'"));
});
console.log('\nvoice TX check: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
