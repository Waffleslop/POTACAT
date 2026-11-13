'use strict';
// #246 (electricfalcon, 1.14.2, 2026-11-10): on a POTACAT driving a remote
// shack, CW and SOTA rows and map markers vanished and came back on every
// refresh; POTA did not. The main window's 'spots' list had two writers: this
// PC's own merged list (sendMergedSpots) and the shack's relayed list
// (remoteClient.on('spots')), and each replaced the other. The shack drops
// CW/RBN and SOTA spots past their max age before it relays (POTA is exempt,
// its feed expires them), so exactly those flickered. One writer at a time:
// the shack's while the link is up, this PC's while it is down.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const main = readSrc(path.join(__dirname, '..', 'main.js'));
let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

function fnBody(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' not found');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(name + ' has no end');
}

test('this PC sends its own spot list to the main window only while no shack link is up', () => {
  const body = fnBody(main, 'sendMergedSpots');
  const sends = body.match(/win\.webContents\.send\('spots', merged\)/g) || [];
  assert.strictEqual(sends.length, 1, 'one send of the local list');
  assert.ok(/if \(!isRemoteLinked\(\)\) win\.webContents\.send\('spots', merged\);/.test(body), 'the local list is held back while the shack link is up');
});

test('the shack\'s relayed list is the one the main window gets while linked', () => {
  const at = main.indexOf("remoteClient.on('spots', (data) => {");
  assert.ok(at > 0, 'the relay is gone');
  assert.ok(/win\.webContents\.send\('spots', data\)/.test(main.slice(at, at + 200)));
});

test('the link test is the live link, not the remote mode (a dropped link falls back to this PC\'s spots)', () => {
  const linked = fnBody(main, 'isRemoteLinked');
  assert.ok(/remoteClient\.state\(\)\.authed/.test(linked));
});

test('the shack still ages CW/RBN and SOTA before relaying, and exempts POTA (why only those flickered)', () => {
  const body = fnBody(main, 'sendMergedSpots');
  assert.ok(/else if \(s\.source === 'sota'\) limit = sotaMaxAgeMs;/.test(body));
  assert.ok(/spotAgeExempt\(s\)\) limit = Infinity/.test(body));
  assert.ok(/remoteServer\.broadcastSpots\(echoSpots\)/.test(body));
});

console.log(`\nRemote spots, one writer (#246): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
