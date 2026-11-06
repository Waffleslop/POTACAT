// test/hound-log-call-test.js — level_death (2026-11-04): answering
// 6W/IK2HKT transmitted and LOGGED IK2HKT. A hound calls the fox's base call
// on the air (WSJT-X DXpedition rule, kept), but the contact is with the call
// the fox sent: 6W/ is Senegal, IK2HKT is Italy.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../renderer/jtcat-parser.js');
const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('hound log call:');
t('the base call is what goes on the air to a fox', () => {
  assert.strictEqual(P.normalizeCall('6W/IK2HKT'), 'IK2HKT');
});
t('both reply paths remember the full call and set it as logCall', () => {
  assert.ok(main.includes("const houndFullCall = (houndReply && data.call) ? String(data.call).replace(/[<>]/g, '') : '';"), 'window');
  assert.ok(main.includes("const houndFullCall = (houndReply && call) ? String(call).replace(/[<>]/g, '') : '';"), 'phone');
  assert.strictEqual((main.match(/popoutJtcatQso\.logCall = houndFullCall/g) || []).length, 2);
  assert.strictEqual((main.match(/remoteJtcatQso\.logCall = houndFullCall/g) || []).length, 2);
  // the full call is taken BEFORE the base call replaces it
  for (const v of ['data.call', 'call']) {
    const i = main.indexOf(`const houndFullCall = (houndReply && ${v})`);
    const j = main.indexOf(`if (houndReply && ${v}) ${v} = JtcatParser.normalizeCall(${v})`, i);
    assert.ok(i > 0 && j > i, v);
  }
});
t('the log record uses logCall when there is one', () => {
  assert.ok(main.includes('callsign: String(q.logCall || q.call).toUpperCase(),'));
});
console.log('\nhound log call: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
