#!/usr/bin/env node
'use strict';
/**
 * The WSPR beacon runs as long as the operator says (K2BDE 2026-10-30: a 1 W
 * overnight beacon was stopped by the old 30-minute watchdog). Default:
 * until stopped. Asked once the first time Beacon TX is turned on; the
 * answer is the Run select beside it, editable any time.
 * Also K5LEB (IC-718 + Digirig, 2026-10-21): a PTT port's default pin is RTS.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const pop = fs.readFileSync(path.join(ROOT, 'renderer/jtcat-popout.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/jtcat-popout.html'), 'utf8');
const rs = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');

console.log('WSPR beacon run time');
check('the 30-minute watchdog is gone from the beacon; the run time comes from the setting, 0 = until stopped', () => {
  const tick = main.slice(main.indexOf('function wsprBeaconTick()'), main.indexOf('function setWsprBeacon('));
  assert.ok(!/JTCAT_FULL_AUTO_CQ_WATCHDOG_MS/.test(tick), 'no 30-min cap in the beacon tick');
  assert.ok(/const runMin = wsprBeaconRunMin\(\);\s+if \(runMin > 0 && Date\.now\(\) - jtcatWsprBeaconArmedAt > runMin \* 60000\)/.test(tick));
  const fn = main.slice(main.indexOf('function wsprBeaconRunMin()'), main.indexOf('function wsprRunLabel('));
  assert.ok(/return Number\.isFinite\(v\) && v > 0 \? Math\.min\(v, 7 \* 24 \* 60\) : 0;/.test(fn), 'default 0, capped at a week');
});
check('the operator sets it (desktop and phone) and the answer is remembered as asked', () => {
  assert.ok(/if \(opts\.runMin != null\) \{ const v = Number\(opts\.runMin\); settings\.wsprBeaconRunMin = /.test(main));
  assert.ok(/if \(opts\.runAsked\) settings\.wsprBeaconRunAsked = true;/.test(main));
  assert.ok(/runMin: msg\.runMin, runAsked: msg\.runAsked/.test(rs), 'ECHOCAT jtcat-wspr-beacon carries it');
  assert.ok((main.match(/\.\.\.wsprBeaconStateExtra\(\)/g) || []).length >= 3, 'runMin rides every beacon-state push');
});
check('the ARMED log line no longer promises a watchdog', () => {
  assert.ok(!/Attended only \(30-min watchdog\)/.test(main));
  assert.ok(/It runs until you stop it\./.test(main));
});
check('the pop-out: a Run select next to Beacon TX, asked once the first time it is turned on', () => {
  assert.ok(/id="jp-wspr-run"/.test(html) && /<option value="0" selected>until I stop it<\/option>/.test(html));
  assert.ok(/id="jp-wspr-run-ask"/.test(html) && /How long should the beacon run\?/.test(html));
  assert.ok(/if \(wsprTxEnable\.checked && !wsprRunAsked && wsprRunAsk\) \{/.test(pop));
  assert.ok(/wsprBeaconSend\(\{ runAsked: true \}\);/.test(pop));
  assert.ok(/runMin: wsprRunEl \? parseInt\(wsprRunEl\.value, 10\) \|\| 0 : 0,/.test(pop));
  assert.ok(/wsprRunAsked = !!s\.wsprBeaconRunAsked;/.test(pop), 'hydrated from settings');
});

console.log('Digirig PTT pin (K5LEB)');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
check('a PTT port keys on RTS unless the operator says DTR', () => {
  assert.ok(/const pttType = \(target\.pttType \|\| 'RTS'\)\.toUpperCase\(\);/.test(main));
  assert.ok(/\(savedTarget && savedTarget\.pttType\) \|\| 'RTS'/.test(app));
  assert.ok(/\(setRigPttType && setRigPttType\.value\) \|\| 'RTS'/.test(app));
  const sel = index.slice(index.indexOf('id="set-rig-ptt-type"'), index.indexOf('</select>', index.indexOf('id="set-rig-ptt-type"')));
  assert.ok(/<option value="RTS" selected>RTS<\/option>/.test(sel), 'RTS is the selected default');
  assert.ok(/A Digirig keys PTT on <b>RTS<\/b>/.test(index));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
