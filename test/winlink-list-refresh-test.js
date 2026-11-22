// Gateway-list refresh (on Refresh and daily) and Other service codes:
// docs/winlink-custom-gateways-plan.md phases 1-2 (Casey's request 2026-11-22).
// Run: node test/winlink-list-refresh-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const W = require('../lib/winlink-pat');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const H = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const base = { codes: ['PUBLIC'], lastCodes: 'PUBLIC', now: NOW };

console.log('when to download a fresh list');
test('the daily rule: under 24 h no download, over 24 h a download', () => {
  assert.strictEqual(W.LIST_MAX_AGE_MS, 24 * H);
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - 1 * H }), '');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - 23.9 * H }), '');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - 24.1 * H }), 'daily');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - 30 * 24 * H }), 'daily');
  assert.strictEqual(W.listNeedsDownload({ ...base, fetchedAt: NOW - 25 * H }), true);
  assert.strictEqual(W.listNeedsDownload({ ...base, fetchedAt: NOW - 2 * H }), false);
});
test('never downloaded on this profile: a download', () => {
  assert.strictEqual(W.listDownloadReason({ ...base }), 'first');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: 0 }), 'first');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: 'junk' }), 'first');
});
test('a time in the future (the clock was wrong then) counts as stale', () => {
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW + 48 * H }), 'daily');
});
test('Refresh always downloads, even a minute after the last one or after a failure', () => {
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - 60000, refresh: true }), 'refresh');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW, refresh: true, failedAt: NOW - 1000 }), 'refresh');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW, refresh: 'yes' }), '', 'only true');
});
test('a code change downloads once; the same codes again do not', () => {
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - H, codes: ['PUBLIC', 'LICLUB'] }), 'codes');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - H, codes: ['PUBLIC', 'LICLUB'], lastCodes: 'PUBLIC,LICLUB' }), '');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - H, codes: ['PUBLIC'], lastCodes: 'PUBLIC,LICLUB' }), 'codes');
});
test('a failed download waits an hour before the automatic reasons try again (no internet in the field)', () => {
  assert.strictEqual(W.LIST_RETRY_MS, H);
  assert.strictEqual(W.listDownloadReason({ ...base, failedAt: NOW - 10 * 60000 }), '');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - 48 * H, failedAt: NOW - 59 * 60000 }), '');
  assert.strictEqual(W.listDownloadReason({ ...base, codes: ['PUBLIC', 'X'], failedAt: NOW - 59 * 60000 }), '');
  assert.strictEqual(W.listDownloadReason({ ...base, fetchedAt: NOW - 48 * H, failedAt: NOW - 61 * 60000 }), 'daily');
});
test('without a time only the code change counts (the old listNeedsDownload)', () => {
  assert.strictEqual(W.listNeedsDownload({ codes: ['PUBLIC'], lastCodes: undefined }), false);
  assert.strictEqual(W.listNeedsDownload({ codes: ['PUBLIC', 'MERCURY'], lastCodes: undefined }), true);
});
test('a forced download that failed asks Pat again for its own list, unless Pat never answered', () => {
  assert.strictEqual(W.listFallsBackToCache('gateway list: Pat 500: Post "https://api.winlink.org/gateway/status.json": dial tcp: lookup api.winlink.org: no such host'), true);
  assert.strictEqual(W.listFallsBackToCache('gateway list: Pat did not answer within 120 s'), false);
});
test('the log line says why and how many codes, never the codes', () => {
  const a = W.listDownloadLogLine('refresh', { ok: true, codeCount: 3 });
  assert.ok(/Refresh pressed/.test(a) && /3 service codes/.test(a), a);
  const b = W.listDownloadLogLine('daily', { ok: true, codeCount: 1, fetchedAt: NOW - 26 * H, now: NOW });
  assert.ok(/26 h ago/.test(b) && /1 service code\)/.test(b), b);
  const c = W.listDownloadLogLine('codes', { ok: false, codeCount: 2, error: 'no such host', fellBack: true });
  assert.ok(/could not download/.test(c) && /no such host/.test(c) && /list Pat already has/.test(c), c);
  assert.ok(/no download recorded/.test(W.listDownloadLogLine('first', {})));
});

console.log('Other service codes');
test('normalised: upper-cased, commas or spaces, deduped, letters digits hyphen, length cap', () => {
  assert.deepStrictEqual(W.normalizeServiceCodes('liclub, emcomm  LICLUB;ny-ares'), ['LICLUB', 'EMCOMM', 'NY-ARES']);
  assert.deepStrictEqual(W.normalizeServiceCodes('ok bad_code bad.code b@d ' + 'A'.repeat(21) + ' ' + 'B'.repeat(20)), ['OK', 'B'.repeat(20)]);
  assert.deepStrictEqual(W.normalizeServiceCodes(''), []);
  assert.deepStrictEqual(W.normalizeServiceCodes(null), []);
  assert.deepStrictEqual(W.normalizeServiceCodes(undefined), []);
  assert.deepStrictEqual(W.normalizeServiceCodes(['a', 'b a']), ['A', 'B']);
  assert.strictEqual(W.normalizeServiceCodes('a b c d e f g h i j k l m').length, 10, 'at most 10');
});
test('PUBLIC and MERCURY never come from the field', () => {
  assert.deepStrictEqual(W.normalizeServiceCodes('public Mercury club'), ['CLUB']);
});
test('saved as text the field shows again', () => {
  assert.strictEqual(W.serviceCodesText(' liclub,emcomm '), 'LICLUB EMCOMM');
  assert.strictEqual(W.serviceCodesText(''), '');
});
test('order: PUBLIC first, then the operator\'s codes, then MERCURY when chosen', () => {
  assert.deepStrictEqual(W.patServiceCodes({}), ['PUBLIC']);
  assert.deepStrictEqual(W.patServiceCodes({ extra: 'liclub emcomm' }), ['PUBLIC', 'LICLUB', 'EMCOMM']);
  assert.deepStrictEqual(W.patServiceCodes({ extra: 'liclub', mercury: true }), ['PUBLIC', 'LICLUB', 'MERCURY']);
  assert.deepStrictEqual(W.patServiceCodes({ mercury: true }), ['PUBLIC', 'MERCURY']);
});
test('the codes reach Pat\'s config', () => {
  assert.deepStrictEqual(W.buildPatConfig({ mycall: 'N0CALL', httpPort: 8591, serviceCodes: 'liclub, public' }).service_codes, ['PUBLIC', 'LICLUB']);
  assert.deepStrictEqual(W.buildPatConfig({ mycall: 'N0CALL', httpPort: 8591, shimPort: 4532, mercury: true, serviceCodes: 'emcomm' }).service_codes, ['PUBLIC', 'EMCOMM', 'MERCURY']);
  assert.deepStrictEqual(W.buildPatConfig({ mycall: 'N0CALL', httpPort: 8591 }).service_codes, ['PUBLIC'], 'none typed: as before');
  assert.strictEqual(W.buildPatConfig({ mycall: 'N0CALL', httpPort: 8591 }).http_addr.startsWith('127.0.0.1:'), true, 'Pat listens on 127.0.0.1 only');
});

console.log('wiring');
const ROOT = path.join(__dirname, '..');
const main = readSrc(path.join(ROOT, 'main.js'));
test('main: one list request at a time, forced by the rule, the time recorded per profile, one log line', () => {
  const gw = main.slice(main.indexOf('async function winlinkGateways('), main.indexOf('let _winlinkGatewaysLogged'));
  assert.ok(gw.length > 100, 'winlinkGateways found');
  assert.ok(/async function winlinkGateways\(mode, band, \{ refresh = false \} = \{\}\)/.test(gw), 'takes refresh');
  assert.ok(gw.includes('WinlinkPat.listDownloadReason('), 'asks the rule');
  assert.ok(gw.includes('fetchedAt: settings.winlinkListFetchedAt'), 'from the time last downloaded');
  assert.ok(gw.includes('settings.winlinkListFetchedAt = Date.now()'), 'recorded when a forced download succeeds');
  assert.ok(gw.includes('WinlinkPat.listDownloadLogLine('), 'one log line');
  assert.ok(!gw.includes('patClient.rmslist('), 'never around winlinkRmslistSafe: its chain keeps requests one at a time');
  assert.ok(!/winlinkLog\([^)]*winlinkListCodes/.test(gw) && !/winlinkLog\([^)]*_patServiceCodes\.join/.test(gw), 'the codes are never written to the log');
});
test('main: Refresh reaches winlinkGateways from the mail window and from ECHOCAT', () => {
  assert.ok(main.includes("ipcMain.handle('winlink-cmd-gateways', (_e, { mode, band, refresh } = {}) => winlinkGateways(String(mode || 'ardop'), band ? String(band) : '', { refresh: refresh === true }));"), 'IPC passes refresh');
  const at = main.indexOf("case 'winlink-gateways-get': {");
  assert.ok(main.slice(at, at + 300).includes('refresh: req.refresh === true'), 'remote message passes refresh');
});
test('main: the codes reach Pat\'s config and a change relaunches Pat', () => {
  const wpc = main.slice(main.indexOf('function writePatConfig('), main.indexOf('function killPat()'));
  assert.ok(wpc.includes('serviceCodes: settings.winlinkServiceCodes'), 'writePatConfig passes the codes');
  const save = main.slice(main.indexOf('const winlinkChanged ='), main.indexOf('const winlinkAutoCheckChanged'));
  assert.ok(save.includes("'winlinkServiceCodes'"), 'a change relaunches Pat with its new config');
  assert.ok(main.includes('newSettings.winlinkServiceCodes = WinlinkPat.serviceCodesText(newSettings.winlinkServiceCodes)'), 'saved normalised');
});
test('mail window: the Refresh button asks for a fresh list', () => {
  const pre = readSrc(path.join(ROOT, 'preload-winlink-popout.js'));
  assert.ok(pre.includes("gateways: (mode, band, refresh) => ipcRenderer.invoke('winlink-cmd-gateways', { mode, band, refresh: refresh === true })"), 'preload');
  const pop = readSrc(path.join(ROOT, 'renderer', 'winlink-popout.js'));
  assert.ok(pop.includes("$('wl-gw-refresh').addEventListener('click', function () { loadGateways(true); });"), 'the button');
  assert.ok(pop.includes('function loadGateways(refresh)'), 'takes refresh');
  assert.ok(pop.includes('window.api.gateways(m.id, band, refresh === true)'), 'passes it');
});
test('Settings: the field, its label and help, loaded and saved', () => {
  const html = readSrc(path.join(ROOT, 'renderer', 'index.html'));
  const at = html.indexOf('id="set-winlink-service-codes"');
  assert.ok(at > 0, 'the field');
  const around = html.slice(at - 300, at + 900);
  assert.ok(around.includes('Other service codes'), 'labelled');
  assert.ok(/keeps its gateways off the public list/.test(around), 'says what a code is');
  assert.ok(/PUBLIC gateways are always listed/.test(around), 'says PUBLIC is always included');
  const wl = html.slice(html.indexOf('<legend>Winlink (email over radio)</legend>'), html.indexOf('<legend>WebSDR</legend>'));
  assert.ok(wl.includes('id="set-winlink-service-codes"'), 'in Settings > Station > Winlink');
  const app = readSrc(path.join(ROOT, 'renderer', 'app.js'));
  assert.ok(app.includes("setWinlinkServiceCodes.value = s.winlinkServiceCodes || ''"), 'loaded');
  assert.ok(app.includes('winlinkServiceCodes: setWinlinkServiceCodes.value'), 'saved');
});
test('ECHOCAT protocol documents the optional refresh', () => {
  const doc = readSrc(path.join(ROOT, 'docs', 'echocat-protocol.md'));
  const row = doc.split('\n').find((l) => l.startsWith('| `winlink-gateways-get`'));
  assert.ok(row && row.includes('refresh?'), row);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
