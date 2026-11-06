#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// dcxweaver 2026-11-03: the "JTCAT FT8" COMMENT on every JTCAT contact is a
// setting (settings.jtcatLogComment, Settings > Logging), default ON so
// nothing changes for anyone who never touches it.
// Run: node test/jtcat-log-comment-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => readSrc(path.join(__dirname, '..', p)).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const main = read('main.js'), app = read('renderer/app.js'), html = read('renderer/index.html');
console.log('JTCAT log comment setting');
test('main: the standard comment follows the setting, default on', () => {
  assert.ok(main.includes("comment: settings.jtcatLogComment !== false ? 'JTCAT ' + mode : '',"));
  assert.ok(!main.includes("comment: 'JTCAT ' + mode,"));
});
test('main: the Field Day comment follows it too', () => {
  assert.ok(/if \(settings\.jtcatLogComment !== false\) qsoData\.comment = `JTCAT FD /.test(main));
});
test('Settings > Logging has the checkbox, checked by default', () => {
  assert.ok(/<input type="checkbox" id="set-jtcat-log-comment" checked>/.test(html));
});
test('renderer loads it default-on and saves it', () => {
  assert.ok(app.includes('setJtcatLogComment.checked = s.jtcatLogComment !== false'));
  assert.ok(app.includes('jtcatLogComment: setJtcatLogComment ? setJtcatLogComment.checked : true,'));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
