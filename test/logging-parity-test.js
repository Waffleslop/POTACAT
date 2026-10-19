'use strict';
// Every log surface logs a contact the same way: it sends what the operator
// entered to logContact (main.js), and lib/qso-expand.js decides the records.
// Surfaces that built their own records drifted apart — the Log QSO window
// did not split multi-op callsigns or use the park's location (W9TEF),
// JTCAT/WSJT-X forwarded every multi-park copy, ECHOCAT Web re-spotted once
// per operator (logging parity audit 2026-10-19). These guards fail if a
// surface starts building records again. The rules themselves are tested in
// test/qso-expand-test.js.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const main = R('main.js');
const app = R('renderer/app.js');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function body(src, startPat) {
  const i = src.indexOf(startPat);
  assert.ok(i >= 0, 'not found: ' + startPat);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(i, j + 1);
}

test('desktop forms send ONE contact to logContact and never write records themselves', () => {
  const surfaces = {
    'Log QSO dialog': body(app, "logSaveBtn.addEventListener('click', async () => {"),
    'bottom bar': body(app, 'async function saveBannerQso() {'),
    'activation logger': body(app, 'async function activatorLogContact() {'),
    'Log QSO window': body(R('renderer/log-popout.js'), 'async function doSave() {'),
    'Logbook New QSO': body(R('renderer/qso-popout.js'), "document.getElementById('qso-new-save').addEventListener('click', async () => {"),
  };
  for (const [name, b] of Object.entries(surfaces)) {
    assert.strictEqual((b.match(/window\.api\.logContact\(/g) || []).length, 1, name + ': one logContact call');
    assert.ok(!/window\.api\.saveQso\(/.test(b), name + ': no saveQso');
    assert.ok(!/skipLogbookForward/.test(b), name + ': forwarding is logContact\'s');
    assert.ok(!/mySig\s*:/.test(b) && !/activationMyRefs\(\)/.test(b), name + ': activation refs are logContact\'s');
  }
});

test('main-side paths log through logContact: JTCAT, the WSJT-X bridge, ECHOCAT', () => {
  assert.ok(/const res = await logContact\(qsoData, \{ origin: 'jtcat-engine' \}\);/.test(body(main, 'async function jtcatAutoLog(qso, opts) {')));
  const wsx = main.slice(main.indexOf("wsjtx.on('logged-adif'"), main.indexOf("wsjtx.on('qso-logged'"));
  assert.ok(/await logContact\(qsoData, \{ origin: 'wsjtx-bridge' \}\);/.test(wsx));
  assert.ok(!/saveQsoRecord\(/.test(wsx), 'the bridge writes no record itself');
  const echo = main.slice(main.indexOf("remoteServer.on('log-qso'"), main.indexOf('// --- JTCAT remote control'));
  assert.ok(/await logContact\(entry, \{ origin: 'ws-log-qso' \}\);/.test(echo));
  assert.ok(!/saveQsoRecord\(/.test(echo), 'ECHOCAT writes no record itself');
  const jtr = main.slice(main.indexOf("remoteServer.on('jtcat-log-qso'"), main.indexOf("remoteServer.on('signal-from-client'"));
  assert.ok(/await jtcatAutoLog\(q, \{ manual: true \}\);/.test(jtr), 'a JTCAT log from the device is the automatic one');
});

test('nothing outside lib/qso-expand.js sets skipLogbookForward', () => {
  for (const f of ['main.js', 'renderer/app.js', 'renderer/log-popout.js', 'renderer/qso-popout.js', 'renderer/remote.js']) {
    const code = R(f).replace(/^\s*\/\/.*$/gm, ''); // comments may mention it
    const sets = (code.match(/skipLogbookForward\s*[:=](?!=)/g) || []);
    assert.deepStrictEqual(sets, [], f + ' sets skipLogbookForward');
  }
});

test('a comma list reaching saveQsoRecord is a contact, handed to logContact', () => {
  const save = body(main, 'async function saveQsoRecord(qsoData, opts) {');
  assert.ok(/return logContact\(qsoData, opts\);/.test(save));
});

test('ECHOCAT Web sends one contact per log, comma lists included, and keeps the time offline', () => {
  const web = R('renderer/remote.js');
  assert.strictEqual((web.match(/data: Object\.assign\(\{\}, baseData, \{ callsign: calls\.join\(','\) \}\)/g) || []).length, 2, 'Log tab + log sheet');
  assert.ok(!/additionalParks/.test(web), 'refs ride as one comma list');
  assert.ok(/offlineQueue\.push\(\{ \.\.\.data, qsoAt: now\.getTime\(\)/.test(web), 'queued QSOs keep their time');
});

test('the Log QSO window no longer snapshots an activation or sends stale QRZ fields', () => {
  const lp = R('renderer/log-popout.js');
  assert.ok(!/activationCtx/.test(lp));
  const build = body(lp, 'function buildQsoData() {');
  assert.ok(!/lastQrzInfo|qrzDisplayName/.test(build));
  assert.ok(!/activationCtx/.test(app), 'the main window stopped sending one');
});

test('logContact resolves QRZ, parks and the live activation for qso-expand', () => {
  const lc = body(main, 'async function logContact(entry, opts) {');
  assert.ok(/QsoExpand\.expandContact\(/.test(lc));
  assert.ok(/liveActivationMyRefs\(\)/.test(lc) && /entry\.activation === false/.test(lc));
  assert.ok(/parkInfoFor\(ref\)/.test(lc) && /qrzStationInfo\(c\)/.test(lc));
});

console.log(`\nLogging parity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
