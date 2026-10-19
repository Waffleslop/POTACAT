'use strict';
// A page whose session ends for good — another device took the rig, the
// device was revoked, the web sign-in ended — must end its audio call too.
// WebRTC is peer to peer and outlives the WebSocket, so a kicked tab kept its
// microphone live into the shack (KF0U 2026-10-17: two ECHOCAT tabs, FT-710
// keyed at 0 W until one tab was closed).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const JS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
test('endAudioWithSession stops the call, the mic and the peer connection', () => {
  assert.ok(/function endAudioWithSession\(\) \{\n\s*try \{ if \(audioEnabled \|\| pc \|\| localAudioStream\) stopAudio\(\);/.test(JS));
  const s = JS.indexOf('function stopAudio() {');
  const body = JS.slice(s, JS.indexOf('\n  }\n', s));
  assert.ok(/pc\.close\(\)/.test(body) && /getTracks\(\)\.forEach\(t => t\.stop\(\)\)/.test(body));
});
test('every final session end calls it: kicked, revoked, signed out, session ended', () => {
  const kicked = JS.slice(JS.indexOf("case 'kicked':"), JS.indexOf("case 'kicked':") + 900);
  assert.ok(/endAudioWithSession\(\);/.test(kicked), 'kicked');
  const n = (JS.match(/wasKicked = true;[^\n]*\n(\s*\/\/[^\n]*\n)*\s*endAudioWithSession\(\);/g) || []).length;
  assert.strictEqual(n, 4, 'all four wasKicked sites end the audio');
});
console.log(`\nECHOCAT kicked audio: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
