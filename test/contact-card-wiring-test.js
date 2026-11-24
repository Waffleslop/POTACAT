#!/usr/bin/env node
'use strict';
// Contact details: where it opens from, and that it only shows.
//  - The Logbook: a "Details" button on every row opens the window for that
//    row's QSO, named by its identity (lib/qso-identity.js, #988), never by
//    its row position alone.
//  - Log QSO: "+ More info" beside the QRZ button opens it for the call being
//    typed, and a one-line summary sits under the call field.
// One window (renderer/contact-popout.html) serves both and follows the window
// rules (theme, remembered place). Nothing here writes the log.
// Run: node test/contact-card-wiring-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const CC = require('../lib/contact-card');
const QsoIdentity = require('../lib/qso-identity');

const root = path.join(__dirname, '..');
const read = (p) => readSrc(path.join(root, p));
const main = read('main.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('Contact details: opening it');

// ---- the request each surface sends, and the QSO it names ----

test('openRequest: a call (upper case, trimmed), the row and its identity; junk is dropped', () => {
  assert.deepStrictEqual(CC.openRequest({ call: ' w1xyz ' }), { call: 'W1XYZ', idx: null, identity: null });
  const id = { APP_POTACAT_UUID: '0b7c6f0e-1d1a-4c55-9a43-5b8f3e2f7a10', CALL: 'W1XYZ', QSO_DATE: '20260720' };
  assert.deepStrictEqual(CC.openRequest({ call: 'W1XYZ', idx: 7, identity: id }), { call: 'W1XYZ', idx: 7, identity: id });
  assert.strictEqual(CC.openRequest({ call: '' }), null);
  assert.strictEqual(CC.openRequest(null), null);
  assert.strictEqual(CC.openRequest({ call: '<script>' }), null, 'not a callsign');
  assert.strictEqual(CC.openRequest({ call: 'W1XYZ', idx: 'x' }).idx, null);
  assert.strictEqual(CC.openRequest({ call: 'W1XYZ', identity: [] }).identity, null);
});

test('recordFor: the identity wins over a stale row number', () => {
  const qsos = [
    { CALL: 'K1AAA', QSO_DATE: '20260101', TIME_ON: '1200', BAND: '20M', MODE: 'SSB' },
    { CALL: 'W1XYZ', QSO_DATE: '20260720', TIME_ON: '1432', BAND: '20M', MODE: 'SSB', NAME: 'Jane' },
  ];
  const identity = QsoIdentity.of(qsos[1]);
  assert.strictEqual(CC.recordFor(qsos, { call: 'W1XYZ', idx: 1, identity }), qsos[1]);
  assert.strictEqual(CC.recordFor(qsos, { call: 'W1XYZ', idx: 0, identity }), qsos[1], 'row 0 is another QSO now: found by identity');
  assert.strictEqual(CC.recordFor(qsos, { call: 'W1XYZ', idx: 0, identity: null }), null, 'no identity: no record, never the row alone');
  assert.strictEqual(CC.recordFor(qsos, { call: 'W1XYZ', idx: null, identity: { CALL: 'N0NE' } }), null);
  assert.strictEqual(CC.recordFor(qsos, { call: 'K1AAA', idx: 1, identity }), null, 'a record for another call is never shown');
});

// ---- the Logbook ----

const qp = read('renderer/qso-popout.js');
const qpHtml = read('renderer/qso-popout.html');
const qpPreload = read('preload-qso-popout.js');

test('Logbook: every row has a Details button', () => {
  const build = qp.slice(qp.indexOf('buildRow(q) {'), qp.indexOf('invalidate()', qp.indexOf('buildRow(q) {')));
  assert.ok(/className = 'log-details-btn'/.test(build), 'a .log-details-btn in buildRow');
  assert.ok(/textContent = 'Details'/.test(build), 'labelled Details');
});

test('Logbook: Details sends the call, the row and the identity of that QSO', () => {
  const i = qp.indexOf("const btn = e.target.closest('.log-details-btn');");
  assert.ok(i > 0, 'a click handler for the Details button');
  const h = qp.slice(i, i + 900);
  assert.ok(/window\.api\.openContactCard\(\{\s*call: qso\.CALL, idx, identity: QsoIdentity\.of\(qso\)\s*\}\)/.test(h), h);
  assert.ok(/allQsos\.find\(\(?q\)? => q\.idx === idx\)/.test(h), 'the QSO comes from the loaded log, by its idx');
});

test('Logbook: Details does not select the row or start an edit', () => {
  const sel = qp.slice(qp.indexOf('// --- Row selection'), qp.indexOf('// --- Delete (two-click)'));
  assert.ok(/closest\('\.log-details-btn'\)/.test(sel), 'row selection skips the Details button');
  // Inline edit starts only on a td.editable; the button sits in the action cell, which has none.
  const build = qp.slice(qp.indexOf('buildRow(q) {'), qp.indexOf('invalidate()', qp.indexOf('buildRow(q) {')));
  const actions = build.slice(build.indexOf("const tdDel = document.createElement('td');"));
  assert.ok(!/editable/.test(actions), 'the action cell is not editable');
});

test('Logbook: preload exposes openContactCard on the contact-card-open channel', () => {
  assert.ok(/openContactCard: \(req\) => ipcRenderer\.send\('contact-card-open', req\)/.test(qpPreload));
  assert.ok(/\.log-details-btn/.test(qpHtml), 'the button is styled in the Logbook page');
});

// ---- the Log QSO window ----

const lp = read('renderer/log-popout.js');
const lpHtml = read('renderer/log-popout.html');
const lpPreload = read('preload-log-popout.js');

test('Log QSO: "+ More info" sits right after the QRZ button in the callsign row', () => {
  const row = lpHtml.slice(lpHtml.indexOf('<div class="lp-call-row">'), lpHtml.indexOf('<div id="lp-identity">'));
  assert.ok(/id="lp-qrz-link"[^>]*>QRZ&#8599;<\/button>\s*<button id="lp-contact-details" type="button"[^>]*>\+ More info<\/button>/.test(row), row);
});

test('Log QSO: the one-line summary under the call comes from main (ContactCard.summaryLine)', () => {
  const i = main.indexOf("ipcMain.handle('log-popout-callsign-info'");
  const h = main.slice(i, main.indexOf('\n  });', i));
  assert.ok(/const summary = ContactCard\.summaryLine\(/.test(h) && /workedMatrix, summary \}/.test(h), 'the lookup answer carries the summary');
  assert.ok(/identityEl\.textContent = result\.summary/.test(lp), 'the logger shows it under the call');
});

test('Log QSO: it opens the window for the call in the field, and is off with no call', () => {
  const i = lp.indexOf("getElementById('lp-contact-details')");
  assert.ok(i > 0);
  const h = lp.slice(i, i + 1200);
  assert.ok(/window\.api\.openContactCard\(\{ call: (raw|call) \}\)/.test(h), h);
  assert.ok(/callInput\.value\.trim\(\)\.toUpperCase\(\)/.test(h), 'the call field, as typed');
  assert.ok(/contactBtn\.classList\.(add|toggle)\('active'/.test(lp), 'enabled with the QRZ button once a call is typed');
  assert.ok(/openContactCard: \(req\) => ipcRenderer\.send\('contact-card-open', req\)/.test(lpPreload));
});

// ---- the window ----

test('main: one contact window, opened by contact-card-open, in the theme and remembering its place', () => {
  assert.ok(/ipcMain\.on\('contact-card-open', \(_e, req\) => openContactCard\(req\)\)/.test(main));
  assert.ok(/contactCardWin = new BrowserWindow\(\{/.test(main));
  assert.ok(/rememberWindowPlace\(contactCardWin, 'contactCardBounds'/.test(main));
  assert.ok(/contactCardWin\.loadFile\(path\.join\(__dirname, 'renderer', 'contact-popout\.html'\), \{ query: themeQuery\(\) \}\)/.test(main));
  const html = read('renderer/contact-popout.html');
  assert.ok(html.indexOf('<script src="popout-theme-boot.js"></script>') < html.indexOf('<link rel="stylesheet"'));
});

test('main: the card uses the QRZ detail lookup, the log history and the clicked QSO by identity', () => {
  const i = main.indexOf('async function contactCardData(');
  assert.ok(i > 0, 'contactCardData()');
  const f = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/qrz\.lookupDetails\(/.test(f), 'QRZ through lookupDetails');
  assert.ok(/lookupPastQsos\(/.test(f), 'the log history');
  assert.ok(/ContactCard\.recordFor\(/.test(f), 'the clicked QSO by identity');
  assert.ok(/ContactCard\.build\(/.test(f));
  assert.ok(!/mutateLog|logContact\(|appendQso|writeFileSync/.test(f), 'it only reads');
});

test('main: weather is on unless the operator turned it off (Casey, 2026-11-23)', () => {
  const i = main.indexOf('async function contactCardData(');
  const f = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/settings\.contactWeather !== false/.test(f), 'on to begin with, a setting turns it off');
  assert.ok(/contactWeather\.current\(ContactCard\.where\(/.test(f), 'only the grid-square centre is asked about');
  assert.ok(/<input type="checkbox" id="set-contact-weather">/.test(read('renderer/index.html')), 'Settings has the switch');
  const app = read('renderer/app.js');
  assert.ok(/setContactWeather\.checked = s\.contactWeather !== false/.test(app));
  assert.ok(/contactWeather: setContactWeather\.checked/.test(app));
});

test('main: Refresh asks QRZ again for that call', () => {
  assert.ok(/ipcMain\.on\('contact-card-refresh', \(\) => contactCardRefresh\(\{ fresh: true \}\)\)/.test(main));
  assert.ok(/refresh: \(\) => ipcRenderer\.send\('contact-card-refresh'\)/.test(read('preload-contact-popout.js')));
});

test('Copy mailing address goes to the clipboard only', () => {
  const js = read('renderer/contact-popout.js');
  assert.ok(/api\.copyText\(vm\.qsl\.address\.copy\)/.test(js));
  assert.ok(!/logContact|saveQso|updateQso/.test(js + read('preload-contact-popout.js')), 'the window has no way to write the log');
});

test('Open QRZ page goes through the open-external allowlist (lib/external-url.js, #1015) and the page never navigates', () => {
  const ExternalUrl = require('../lib/external-url');
  const vm = CC.build({ call: 'W1XYZ/P', qrz: { call: 'W1XYZ' }, qrzState: 'subscriber', history: [] });
  assert.strictEqual(ExternalUrl.checked(vm.qrzUrl), vm.qrzUrl, 'qrz.com/db is on the allowlist');
  const js = read('renderer/contact-popout.js');
  const html = read('renderer/contact-popout.html');
  assert.ok(/api\.openExternal\(vm\.qrzUrl\)/.test(js), 'the button asks main');
  assert.ok(/openExternal: \(url\) => ipcRenderer\.send\('open-external', url\)/.test(read('preload-contact-popout.js')), 'main\'s openExternalIfAllowed handles it');
  assert.ok(!/window\.open\(|location\.(href|assign|replace)|<a\s/.test(js + html), 'no links, window.open or navigation in the page (lib/window-security.js, #1019)');
  // Nothing the page does needs a permission: the copy is main's clipboard, images need none.
  assert.ok(!/navigator\.(clipboard|mediaDevices|geolocation|permissions)|Notification\./.test(js), 'no permission-gated browser API');
});

test('the photo may come only from QRZ (the page CSP)', () => {
  const html = read('renderer/contact-popout.html');
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  assert.ok(/img-src 'self' https:\/\/\*\.qrz\.com https:\/\/qrz\.com/.test(csp), csp);
  assert.ok(!/connect-src[^;]*https/.test(csp), 'the page fetches nothing itself: main does');
});

test('these tests are in the list CI runs', () => {
  const list = read('scripts/run-tests.js');
  assert.ok(list.includes("'test/contact-card-wiring-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
