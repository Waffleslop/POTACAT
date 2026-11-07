// GitHub #186: "Check for Updates just returns to the main screen" on Windows,
// both three versions behind and on the latest. The link lives in the Settings
// footer: clicking it closed Settings and gave no "checking" feedback; the
// result (if any) was a ~2 s toast; the GitHub-API fallback swallowed network
// and parse errors outright, and a rate-limited 403 (no tag_name) was reported
// as "You're up to date!".
//
// Rule this file guards: every outcome of a MANUAL check produces a visible
// message — checking, up to date (with the version), update found (and what to
// do next), or the error in plain words plus the download page — and a check
// that never answers times out into a message instead of nothing.
// No network here: the GitHub response is passed in as data.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const {
  interpretLatestRelease, describeUpdateError, manualCheckMessage, RELEASES_URL,
} = require('../lib/update-feedback');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }

const rel = (tag, extra) => JSON.stringify(Object.assign({ tag_name: tag, html_url: 'https://github.com/Waffleslop/POTACAT/releases/tag/' + tag, name: tag }, extra));

console.log('interpretLatestRelease()');

t('a newer release is an update', () => {
  const r = interpretLatestRelease({ statusCode: 200, body: rel('v1.14.2'), currentVersion: '1.14.0' });
  assert.strictEqual(r.outcome, 'available');
  assert.strictEqual(r.version, '1.14.2');
  assert.ok(/releases\/tag\/v1\.14\.2/.test(r.url));
});

t('the same release is up to date, naming the latest version', () => {
  const r = interpretLatestRelease({ statusCode: 200, body: rel('v1.14.0'), currentVersion: '1.14.0' });
  assert.strictEqual(r.outcome, 'up-to-date');
  assert.strictEqual(r.version, '1.14.0');
});

t('a rate-limited 403 is an ERROR, never "up to date"', () => {
  const r = interpretLatestRelease({ statusCode: 403, body: JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }), currentVersion: '1.14.0' });
  assert.strictEqual(r.outcome, 'error');
  assert.ok(/limit/i.test(r.message), r.message);
});

t('a server error, unparseable body, or missing tag is an error', () => {
  for (const input of [
    { statusCode: 500, body: 'oops' },
    { statusCode: 200, body: '<html>captive portal</html>' },
    { statusCode: 200, body: JSON.stringify({}) },
  ]) {
    const r = interpretLatestRelease(Object.assign({ currentVersion: '1.14.0' }, input));
    assert.strictEqual(r.outcome, 'error', JSON.stringify(input));
    assert.ok(r.message && r.message.length > 10, 'plain-words message');
  }
});

console.log('describeUpdateError()');

t('offline / DNS / timeout read as a connection problem', () => {
  for (const e of [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND github.com' },
                   { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' },
                   new Error('net::ERR_INTERNET_DISCONNECTED')]) {
    assert.ok(/internet|connect|reach/i.test(describeUpdateError(e)), describeUpdateError(e));
  }
});

t('a missing latest.yml (404) and a rate limit are explained, not dumped', () => {
  assert.ok(/not.*published|isn.t ready|not available yet/i.test(describeUpdateError(new Error('Cannot find latest.yml in the latest release artifacts (https://github.com/...): HttpError: 404'))));
  assert.ok(/limit/i.test(describeUpdateError(new Error('HttpError: 403 Forbidden "rate limit exceeded"'))));
});

t('anything else still says something, and never a stack trace', () => {
  const msg = describeUpdateError(new Error('weird thing\n    at Foo (bar.js:1:1)'));
  assert.ok(msg.length > 0 && !/\n\s+at /.test(msg), msg);
  assert.ok(describeUpdateError(null).length > 0);
});

console.log('manualCheckMessage()');

t('every outcome produces visible text', () => {
  for (const outcome of ['checking', 'available', 'up-to-date', 'error']) {
    const m = manualCheckMessage(outcome, { currentVersion: '1.14.0', latestVersion: '1.14.2', message: 'Could not reach GitHub.', canAutoInstall: true });
    assert.ok(m && typeof m.text === 'string' && m.text.length > 5, outcome);
  }
  assert.throws(() => manualCheckMessage('bogus', {}));
});

t('up to date names the running version and stays on screen', () => {
  const m = manualCheckMessage('up-to-date', { currentVersion: '1.14.0', latestVersion: '1.14.0' });
  assert.ok(/1\.14\.0/.test(m.text) && /up to date/i.test(m.text), m.text);
  assert.ok(m.durationMs >= 6000 || m.sticky);
});

t('update found says the version and the next step', () => {
  const a = manualCheckMessage('available', { currentVersion: '1.13.9', latestVersion: '1.14.2', canAutoInstall: true });
  assert.ok(/1\.14\.2/.test(a.text) && /Upgrade/.test(a.text), a.text);
  const b = manualCheckMessage('available', { currentVersion: '1.13.9', latestVersion: '1.14.2', canAutoInstall: false });
  assert.ok(/Download/.test(b.text), b.text);
});

t('an error gives the reason in words plus the download page, and stays until dismissed', () => {
  const m = manualCheckMessage('error', { currentVersion: '1.14.0', message: 'Could not reach GitHub.' });
  assert.ok(/Could not reach GitHub/.test(m.text), m.text);
  assert.ok(/download page/i.test(m.text), m.text);
  assert.strictEqual(m.openUrl, RELEASES_URL);
  assert.ok(m.sticky && m.warn);
});

t('checking stays up until the answer replaces it', () => {
  const m = manualCheckMessage('checking', { currentVersion: '1.14.0' });
  assert.ok(m.sticky && /checking/i.test(m.text) && /1\.14\.0/.test(m.text));
});

console.log('source guards');
const main = readSrc('main.js');
const preload = readSrc('preload.js');
const app = readSrc('renderer/app.js');

t('the menu/hotkey IPC runs a MANUAL check', () => {
  assert.ok(/ipcMain\.on\('check-for-updates',[^\n]*checkForUpdates\(\{\s*manual:\s*true\s*\}\)/.test(main));
});

t('every updater outcome reports a pending manual check', () => {
  for (const ev of ['update-available', 'update-not-available', 'error']) {
    const i = main.indexOf(`autoUpdater.on('${ev}'`);
    assert.ok(i > 0, ev);
    const body = main.slice(i, main.indexOf('\n});', i));
    assert.ok(/reportManualCheck\(/.test(body), ev + ' handler must call reportManualCheck');
  }
});

t('a manual check that never answers times out into a message', () => {
  assert.ok(/MANUAL_CHECK_TIMEOUT_MS/.test(main) && /reportManualCheck\('error'/.test(main));
});

t('the GitHub fallback no longer swallows errors', () => {
  const i = main.indexOf('function checkForUpdatesManual(');
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(!/silently ignore/.test(body), 'fallback still silently ignores failures');
  assert.ok(/interpretLatestRelease\(/.test(body));
  assert.ok(/reportManualCheck\(/.test(body));
});

t('the renderer shows the status the main process sends', () => {
  assert.ok(/onUpdateCheckStatus:/.test(preload));
  const i = app.indexOf('window.api.onUpdateCheckStatus(');
  assert.ok(i > 0);
  assert.ok(/showLogToast\(/.test(app.slice(i, i + 800)));
});

console.log(`\n${passed} passed`);
