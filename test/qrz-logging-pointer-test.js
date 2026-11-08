'use strict';
// #202: QRZ logbook upload lives under Settings > Station (it needs the QRZ
// login and an XML subscription), but users look for it under Logging next
// to Club Log and LoTW. The Logging tab carries a pointer that opens the
// Station tab at the existing QRZ upload control. The QRZ settings stay put.
const path = require('path');
const assert = require('assert');
const { readSrc } = require('./_src');
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
const html = R('renderer/index.html');
const app = R('renderer/app.js');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
// Fieldset that contains a given marker.
function fieldsetAround(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'not found: ' + marker);
  const s = src.lastIndexOf('<fieldset', i);
  const e = src.indexOf('</fieldset>', i);
  return src.slice(s, e);
}

test('the pointer sits in a Logging-tab fieldset beside the other uploads', () => {
  const fs = fieldsetAround(html, 'id="qrz-logging-pointer"');
  assert.match(fs, /data-settings-tab="logging"/);
  assert.ok(fs.includes('id="set-clublog-enable"'), 'should be in the same fieldset as Club Log');
});

test('the pointer names the real tab labels', () => {
  assert.match(html, /class="settings-tab" data-tab="station">Station</);
  const i = html.indexOf('id="qrz-logging-pointer"');
  const line = html.slice(html.lastIndexOf('<div', i), html.indexOf('</div>', i));
  assert.match(line, /QRZ/);
  assert.match(line, /Station/);
  assert.doesNotMatch(line, /Help|File menu/);
});

test('the QRZ upload control still lives on the Station tab', () => {
  const fs = fieldsetAround(html, 'id="set-qrz-logbook"');
  assert.match(fs, /data-settings-tab="station"/);
});

test('clicking the pointer switches to Station and targets the QRZ upload control', () => {
  const i = app.indexOf("getElementById('qrz-logging-pointer')");
  assert.ok(i >= 0, 'pointer handler missing in app.js');
  const block = app.slice(i, i + 1500);
  assert.match(block, /switchSettingsTab\('station'\)/);
  assert.match(block, /qrz-logbook-section|set-qrz-logbook/);
  assert.match(block, /scrollIntoView/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
