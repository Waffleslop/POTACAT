#!/usr/bin/env node
'use strict';
// APRS phase 4: the APRS idle mode and the iGate, as wired in main.js, the
// Settings window and the APRS window (source-text guards; CRLF and LF both
// pass). The rules themselves are tested in test/aprs-igate-test.js.
// Run: node test/aprs-idle-igate-wiring-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const html = read('renderer/index.html');
const app = read('renderer/app.js');
const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j);
};

test('Idle Mode lists APRS, next to the others, in Settings and the welcome screen', () => {
  assert.ok(/IDLE_RX_MODES = \['sstv', 'wspr', 'psk31', 'js8', 'jtty', 'aprs'\]/.test(main));
  const sel = html.slice(html.indexOf('id="set-idle-rx-mode"'), html.indexOf('</select>', html.indexOf('id="set-idle-rx-mode"')));
  assert.ok(/<option value="js8">JS8<\/option>\s*<option value="aprs">APRS<\/option>/.test(sel), 'Settings');
  const wel = html.slice(html.indexOf('id="welcome-idle-rx-mode"'), html.indexOf('</select>', html.indexOf('id="welcome-idle-rx-mode"')));
  assert.ok(/<option value="aprs">APRS<\/option>/.test(wel), 'welcome');
  // load and save keep 'aprs' (every list of idle modes in app.js names it)
  const lists = app.match(/\['wspr', 'psk31', 'js8', 'jtty'[^\]]*\]/g) || [];
  assert.ok(lists.length >= 4, 'idle mode lists found');
  for (const l of lists) assert.ok(l.includes("'aprs'"), l);
});

test('on idle, APRS starts the window\'s listen path (2 m, else 30 m) without the window', () => {
  const t = fnBody(main, 'triggerAutoSstv');
  const i = t.indexOf("idleMode === 'aprs'");
  assert.ok(i > 0 && i < t.indexOf("idleMode === 'js8'"), 'an APRS branch');
  const branch = t.slice(i, t.indexOf('return;', i));
  assert.ok(/autoIdleAprsActive = true/.test(branch));
  assert.ok(/autoIdleAprsOwnsListen = !aprsListen\.on/.test(branch), 'the operator\'s own switch stays theirs');
  assert.ok(/aprsListenSet\(true\)/.test(branch));
  // the band choice is the listen path's (AprsListen.chooseBand): one rule for both
  assert.ok(/aprsListen\.band = AprsListen\.chooseBand\(bands, aprsListen\.bandWanted\)/.test(fnBody(main, 'aprsListenStart')));
});

test('any radio use ends it at once and the radio goes back, as the other idle modes', () => {
  assert.ok(/if \(autoSstvActive && !\(opts && opts\.selfDriven\)\) cancelAutoSstv\(\);/.test(fnBody(main, 'markUserActive')));
  const c = fnBody(main, 'cancelAutoSstv');
  const i = c.indexOf('if (autoIdleAprsActive)');
  assert.ok(i > 0, 'an APRS teardown');
  const branch = c.slice(i, c.indexOf('return;', i));
  assert.ok(/if \(owned\) aprsListenStop\(/.test(branch), 'listening stops');
  // aprsListenStop sends the radio back (lib/aprs-radio-return.js)
  assert.ok(/aprsReturn\.end\(_currentFreqHz\)/.test(fnBody(main, 'aprsListenStop')));
  // starting JTCAT ends it too (it is not an engine idle mode)
  assert.ok(/if \(autoSstvActive && !autoIdleJtcatActive && !autoIdleJs8Active\) cancelAutoSstv\(\);/.test(main));
  // the switch and the band chips in the window are the operator
  assert.ok(/ipcMain\.on\('aprs-listen-set', \(_e, on\) => \{ markUserActive\(\); aprsListenSet/.test(main));
  assert.ok(/ipcMain\.on\('aprs-listen-band', \(_e, band\) => \{ markUserActive\(\);/.test(main));
});

test('the SSTV day/night band switch never retunes an APRS idle session', () => {
  assert.ok(/if \(mayRetune && autoSstvActive && !autoIdleJtcatActive && !autoIdleJs8Active && !autoIdleAprsActive\) \{\n\s*const newBand = getSstvAutoFreq\(\);/.test(main));
});

test('closing the APRS window leaves an idle session listening', () => {
  assert.ok(/if \(!\(autoIdleAprsActive && autoIdleAprsOwnsListen\)\) aprsListenStop\('the APRS window closed'\);/.test(main));
});

test('ECHOCAT: an APRS idle session is its own kind, never SSTV or an FT8-engine receive', () => {
  assert.ok(/if \(autoIdleAprsActive\) return 'aprs';/.test(fnBody(main, 'autoRxKind')));
  // jtcat-status.idleRx never names aprs: starting JTCAT ends an APRS idle session first.
  assert.ok(/if \(autoSstvActive && !autoIdleJtcatActive && !autoIdleJs8Active\) cancelAutoSstv\(\);/.test(fnBody(main, 'startJtcat')));
});

test('the iGate setting: its own switch, off by default, saved as aprsIgate', () => {
  assert.ok(/<input type="checkbox" id="set-aprs-igate"> Report what I hear to APRS-IS \(iGate\)<\/label>/.test(html));
  assert.ok(/getElementById\('set-aprs-igate'\)\.checked = s\.aprsIgate === true/.test(app));
  assert.ok(/aprsIgate: document\.getElementById\('set-aprs-igate'\)\.checked/.test(app));
  assert.ok(/return settings\.aprsIgate === true && aprsListen\.on/.test(fnBody(main, 'aprsIgateWanted')));
  assert.ok(!/aprsIgate:\s*true/.test(main), 'no default on');
});

test('RF frames reach the iGate; it sends through the one uplink, verified only', () => {
  assert.ok(/aprsIgateOfferRf\(heard\.line\)/.test(fnBody(main, 'aprsOnMonitorFrame')));
  const offer = fnBody(main, 'aprsIgateOfferRf');
  assert.ok(/if \(!aprsIgateWanted\(\) \|\| !aprsUplink\) return;/.test(offer));
  assert.ok(/send: \(l\) => !!\(aprsUplink && aprsUplink\.send\(l\)\)/.test(offer));
});

test('one APRS-IS connection: the JS8 gateway, the iGate and the beacon share it', () => {
  assert.strictEqual((main.match(/new AprsIsClient\(/g) || []).length, 1);
  assert.ok(/aprsUplinkWant\('js8', true\)/.test(main));
  assert.ok(/aprsUplinkWant\('igate', want\)/.test(main));
  assert.ok(!/\baprsGate\b(?!:|Up)/.test(main.replace(/js8AprsGate/g, '')), 'the old JS8-only client is gone');
  // its login is the Settings callsign with -10, refused for a placeholder
  assert.ok(/const login = AprsIgate\.uplinkLogin\(settings\.myCallsign\);/.test(fnBody(main, 'aprsUplinkWant')));
});

test('the dev server override exists only in a dev build; recorded frames never reach the real APRS-IS', () => {
  assert.ok(/if \(app\.isPackaged \|\| !process\.env\.POTACAT_APRS_IS_SERVER\) return null;/.test(main));
  assert.ok(/if \(!app\.isPackaged && process\.env\.POTACAT_APRS_DEV_FRAMES\) return null;/.test(fnBody(main, 'aprsIsServer')));
});

test('small marks, no pop-ups: the APRS window and Settings', () => {
  const pop = read('renderer/aprs-popout.html');
  assert.ok(/id="aprs-igate"/.test(pop));
  assert.ok(/id="idle-aprs-igate-marks"/.test(html));
  const bar = read('renderer/aprs-listen-bar.js');
  assert.ok(!/alert\(|confirm\(|showMessageBox/.test(bar));
  assert.ok(!/showMessageBox|dialog\./.test(fnBody(main, 'aprsIgateOfferRf') + fnBody(main, 'aprsUplinkWant')));
});

console.log(`\nAPRS idle mode and iGate wiring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
