// What POTACAT offers of Mercury while it is experimental (Casey, 2026-11-22,
// docs/mercury-winlink-modem-plan.md decisions 5 and 6):
// - the 2750 bandwidth is hidden: Mercury runs BW2750 at 2300's speed today,
//   so the picker must not promise more;
// - the July chat window (More > Mercury HF Data) is hidden behind a setting
//   that defaults off, until Mercury has been used on the air. Its code stays.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MercuryOffer = require('../lib/mercury-offer');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

test('bandwidths offered are 500 and 2300 only', () => {
  assert.deepStrictEqual(MercuryOffer.BANDWIDTHS, [500, 2300]);
  assert.strictEqual(MercuryOffer.DEFAULT_BANDWIDTH, 2300);
});

test('a saved 2750 (or junk) reads back as 2300', () => {
  assert.strictEqual(MercuryOffer.bandwidthChoice(2750), 2300);
  assert.strictEqual(MercuryOffer.bandwidthChoice('2750'), 2300);
  assert.strictEqual(MercuryOffer.bandwidthChoice(undefined), 2300);
  assert.strictEqual(MercuryOffer.bandwidthChoice('abc'), 2300);
  assert.strictEqual(MercuryOffer.bandwidthChoice(500), 500);
  assert.strictEqual(MercuryOffer.bandwidthChoice('500'), 500);
  assert.strictEqual(MercuryOffer.bandwidthChoice(2300), 2300);
});

test('chat window entry is off by default, even with Mercury enabled', () => {
  assert.strictEqual(MercuryOffer.chatWindowOffered({}), false);
  assert.strictEqual(MercuryOffer.chatWindowOffered(null), false);
  assert.strictEqual(MercuryOffer.chatWindowOffered({ enableMercury: true }), false);
  assert.strictEqual(MercuryOffer.chatWindowOffered({ mercuryChatWindow: true }), false);
  assert.strictEqual(MercuryOffer.chatWindowOffered({ enableMercury: true, mercuryChatWindow: true }), true);
  assert.strictEqual(MercuryOffer.chatWindowOffered({ enableMercury: true, mercuryChatWindow: 'yes' }), false);
});

function selectOptions(html, id) {
  const m = html.match(new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>'));
  assert.ok(m, 'select #' + id + ' not found');
  return [...m[1].matchAll(/<option value="(\d+)"/g)].map((x) => Number(x[1]));
}

test('Settings > Mercury bandwidth offers no 2750', () => {
  assert.deepStrictEqual(selectOptions(read('renderer/index.html'), 'set-mercury-bw'), [500, 2300]);
});

test('the chat window bandwidth offers no 2750', () => {
  assert.deepStrictEqual(selectOptions(read('renderer/mercury-popout.html'), 'mq-bw'), [500, 2300]);
});

test('VARA HF keeps its 2750 (it is a different modem)', () => {
  assert.ok(selectOptions(read('renderer/index.html'), 'set-winlink-vara-bw').includes(2750));
});

test('main accepts only the offered Mercury bandwidths', () => {
  const main = read('main.js');
  assert.ok(!/mercuryBw,\s*\[500,\s*2300,\s*2750\]/.test(main), 'Winlink session still picks 2750 for Mercury');
  assert.ok(!/n === 2750\) \{ settings\.mercuryBw/.test(main), 'chat window IPC still stores 2750');
  assert.ok(/MercuryOffer\.bandwidthChoice\(settings\.mercuryBw\)/.test(main), 'session bandwidth goes through MercuryOffer');
});

test('the More menu button follows MercuryOffer.chatWindowOffered, not enableMercury alone', () => {
  const app = read('renderer/app.js');
  assert.ok(!/mercuryBtn\.classList\.toggle\('hidden', !settings\.enableMercury\)/.test(app), 'startup still shows the button on enableMercury');
  assert.ok(!/mercuryViewBtn\.classList\.toggle\('hidden', !setMercuryEnable\.checked\)/.test(app), 'Save still shows the button on enableMercury');
  const uses = app.match(/MercuryOffer\.chatWindowOffered\(/g) || [];
  assert.ok(uses.length >= 2, 'startup and Save both ask MercuryOffer (found ' + uses.length + ')');
  assert.ok(/id="view-mercury-btn"/.test(read('renderer/index.html')), 'the entry stays in the page, hidden');
  assert.ok(/<script src="\.\.\/lib\/mercury-offer\.js"><\/script>/.test(read('renderer/index.html')), 'index.html loads lib/mercury-offer.js');
});

test('the settings copy no longer points at More > Mercury HF Data', () => {
  const html = read('renderer/index.html');
  const fs0 = html.indexOf('<legend>Mercury (HF data)</legend>');
  assert.ok(fs0 > 0);
  const block = html.slice(fs0, html.indexOf('</fieldset>', fs0));
  assert.ok(!/Open it from More &rarr; Mercury HF Data/.test(block));
  assert.ok(/experimental/i.test(block), 'Mercury is called experimental');
});

console.log(passed + ' passed');
