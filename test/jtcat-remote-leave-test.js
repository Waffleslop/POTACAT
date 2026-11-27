'use strict';
// #1120: leaving a remote shack or a Guest Pass puts an open FT8 window back
// on this PC's radio. The window enters remote mode once (jtcat-popout.js)
// and has no way back, so main reloads it when the session ends.
// Run: node test/jtcat-remote-leave-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const at = main.indexOf('function tearDownRemoteClient()');
const end = main.indexOf('\n}\n', at);
const body = main.slice(at, end);

test('tearDownRemoteClient exists', () => {
  assert.ok(at > 0 && end > at);
});
test('a JTCAT window that drove the shack is reloaded once back on the local radio', () => {
  const m = body.match(/if \(!isRemoteMode\(\) && _remoteJtcatMode\) \{([\s\S]*?)\n  \}/);
  assert.ok(m, 'tearDownRemoteClient must check !isRemoteMode() && _remoteJtcatMode');
  assert.match(m[1], /_remoteJtcatMode = ''/, 'the remote JTCAT mode is cleared');
  assert.match(m[1], /jtcatPopoutWin\.webContents\.reload\(\)/, 'the FT8 window is reloaded');
});
test('every way back to the local radio clears activeTargetId before tearDownRemoteClient', () => {
  // The reload is gated on !isRemoteMode(); a switch to another shack keeps
  // activeTargetId set and must not reload the window onto local audio.
  for (const marker of ["remoteClient.on('pass-ended'", "remoteClient.on('revoked'", "ipcMain.handle('connection-targets-activate'"]) {
    const i = main.indexOf(marker);
    assert.ok(i > 0, marker);
    const seg = main.slice(i, main.indexOf('tearDownRemoteClient()', i));
    assert.match(seg, /settings\.activeTargetId = null/, marker + ' clears activeTargetId first');
  }
});
test('the window still enters remote mode only from get-settings remoteShack', () => {
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8');
  assert.match(pop, /if \(s\.remoteShack\) enterRemoteShackMode\(\);/);
  assert.match(main, /remoteShack: isRemoteMode\(\)/);
});

console.log(`jtcat-remote-leave: ${passed} passed`);
