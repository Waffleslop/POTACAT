// test/voice-tx-check-test.js — "FT8 works, voice is silent" (KD9OUT, KD9WJY,
// thecoffeepotcodger FT-710; KJ5CHK IC-7300 MK II): a voice over with 0 W and
// no ALC gets one hint naming the radio's audio-input menu.
'use strict';
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
t('Icom voice in USB names DATA OFF MOD; in USB-D it names DATA MOD', () => {
  assert.ok(/MOD Input > DATA OFF MOD = USB/.test(decideVoiceTxHint({ ...silent, brand: 'Icom' }).hint));
  assert.ok(/MOD Input > DATA MOD = USB/.test(decideVoiceTxHint({ ...silent, brand: 'Icom', mode: 'USB-D' }).hint));
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
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/if \(!state\) voiceTxCheckEnd\(\);\n(\s*\/\/[^\n]*\n)*\s*else if \(!isFlexRig && cat && cat\.connected && !opts\.emission/.test(main));
  assert.ok(/if \(_voiceTxCheck\) \{\n    _voiceTxCheck\.fwdEvents\+\+;/.test(main), 'power feeds it');
  assert.ok(/_voiceTxCheck\.alcEvents\+\+;/.test(main), 'ALC feeds it');
  assert.ok(main.includes("remoteServer.sendToClient({ type: 'voice-tx-hint', key: d.key, text: d.hint })"));
  const P = require('../lib/echocat-protocol');
  assert.ok(JSON.stringify(P).includes('voice-tx-hint') || fs.readFileSync(path.join(__dirname, '..', 'lib', 'echocat-protocol.js'), 'utf8').includes("'voice-tx-hint'"));
});
console.log('\nvoice TX check: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
