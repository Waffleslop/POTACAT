'use strict';
// The JTCAT "plain USB for digital" setting never moves a Winlink radio session out of the data
// mode (an FTDX10 on flrig went DATA-U -> USB for VARA HF, 2026-11-15).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { plainSsbForDigital } = require('../lib/plain-ssb-for-digital');
const flrig = require('../lib/codecs/flrig-codec');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); } }

console.log('=== plainSsbForDigital ===');
t('setting on: DIGU stays', () => assert.strictEqual(plainSsbForDigital('DIGU', { useDataMode: true }), 'DIGU'));
t('setting off: JTCAT DIGU -> USB', () => assert.strictEqual(plainSsbForDigital('DIGU', { useDataMode: false }), 'USB'));
t('setting off: FT8 -> USB', () => assert.strictEqual(plainSsbForDigital('FT8', { useDataMode: false }), 'USB'));
t('setting off: PSK31 -> USB', () => assert.strictEqual(plainSsbForDigital('PSK31', { useDataMode: false }), 'USB'));
t('setting off: DIGL -> LSB', () => assert.strictEqual(plainSsbForDigital('DIGL', { useDataMode: false }), 'LSB'));
t('setting off: Winlink DIGU stays DIGU', () => assert.strictEqual(plainSsbForDigital('DIGU', { useDataMode: false, purpose: 'winlink' }), 'DIGU'));
t('setting off: FreeDV left to its own setting', () => assert.strictEqual(plainSsbForDigital('DIGU', { useDataMode: false, freedv: true }), 'DIGU'));
t('setting off: CW untouched', () => assert.strictEqual(plainSsbForDigital('CW', { useDataMode: false }), 'CW'));
t('no mode stays undefined', () => assert.strictEqual(plainSsbForDigital(undefined, { useDataMode: false }), undefined));

console.log('=== flrig sends the FTDX10\'s own data-mode name for a Winlink tune ===');
t('DIGU -> rig.set_mode "DATA-U" when flrig lists DATA-U', () => {
  const sent = [];
  const c = new flrig.FlrigCodec({}, (x) => sent.push(String(x)));
  c._radioModes = ['LSB', 'USB', 'CW-U', 'FM', 'AM', 'RTTY-L', 'CW-L', 'DATA-L', 'RTTY-U', 'DATA-FM', 'FM-N', 'DATA-U', 'AM-N', 'PSK', 'DATA-FMN'];
  assert.strictEqual(c.resolveMode('DIGU', 7101000), 'PKTUSB');
  assert.strictEqual(c.radioModeFor('PKTUSB'), 'DATA-U');
  c.setMode('DIGU', 7101000);
  const body = sent.join('\n');
  assert.ok(/rig\.set_mode/.test(body), 'rig.set_mode was sent');
  assert.ok(/<value><string>DATA-U<\/string><\/value>|DATA-U/.test(body), 'with DATA-U');
  assert.ok(!/<string>USB<\/string>/.test(body), 'never plain USB');
});

console.log('=== main.js wiring ===');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
t('both Winlink tunes say purpose: winlink', () => {
  assert.ok(/origin: 'Winlink session', purpose: 'winlink'/.test(main));
  assert.ok(/origin: 'Winlink gateway pick', purpose: 'winlink'/.test(main));
});
t('tuneRadio applies the rule through the helper only', () => {
  assert.ok(/PlainSsbForDigital\.plainSsbForDigital\(mode, \{ useDataMode: settings\.jtcatUseDataMode !== false, purpose/.test(main));
  assert.ok(!/settings\.jtcatUseDataMode === false && mode && !isFreedvMode/.test(main), 'the old inline rewrite is gone');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
