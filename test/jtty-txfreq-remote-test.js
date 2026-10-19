'use strict';
// A TX frequency set from ECHOCAT must reach the JTCAT pop-out, whose JTTY and
// PSK31 panes otherwise push their own stale copy back to the engine on every
// mode change and save it on every Send (K3SBP 2026-10-19: every JTTY
// transmission went out at 1500 Hz however the mobile device moved it).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pop = fs.readFileSync(path.join(root, 'renderer', 'jtcat-popout.js'), 'utf8');
const pre = fs.readFileSync(path.join(root, 'preload-jtcat-popout.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); }
}

const remote = main.slice(main.indexOf("remoteServer.on('jtcat-set-tx-freq'"));
const remoteBody = remote.slice(0, remote.indexOf('remoteServer.on(', 10));

t('remote set-tx-freq logs and tells the pop-out', () => {
  assert(/\[JTCAT\] TX freq -> /.test(remoteBody), 'log line');
  assert(/jtcatPopoutWin\.webContents\.send\('jtcat-tx-freq-set'/.test(remoteBody), 'pop-out push');
});
t('preload exposes the channel', () => {
  assert(/onJtcatTxFreqSet:.*'jtcat-tx-freq-set'/.test(pre));
});
t('pop-out adopts the pushed frequency in keyboard modes', () => {
  const i = pop.indexOf('onJtcatTxFreqSet(function');
  assert(i > 0, 'handler');
  const body = pop.slice(i, pop.indexOf('});', i));
  assert(/jpTxFreqHz = hz/.test(body), 'sets jpTxFreqHz');
  assert(!/isKeyboardMode\(\)\) return/.test(body), 'must not skip keyboard modes');
});
t('mode change restores the keyboard mode\'s own frequency before syncing', () => {
  const i = pop.indexOf("modeSelect.addEventListener('change'");
  const body = pop.slice(i, pop.indexOf('jttySyncFreq()', i));
  assert(/kbFreqHz\[modeSelect\.value\]/.test(body));
});
t('PSK31 operator moves persist pskAudioCenter', () => {
  const i = main.indexOf('function rememberJtcatTxFreq');
  assert(/settings\.pskAudioCenter = eng\._txFreq/.test(main.slice(i, i + 800)));
});

console.log(`\nJTTY TX freq from ECHOCAT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
