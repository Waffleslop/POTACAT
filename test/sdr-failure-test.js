// An offline WebSDR looked selectable in the VFO window and its button did
// nothing (#390, Discord 2026-11-11). Main logged "[WebSDR] Error: ..." and
// sent kiwi-status {connected:false, error}, which the VFO window ignored.
// lib/sdr-failure.js turns the raw error into plain words; the window shows
// them with Try again and marks the receiver in the list for the session.
// No background pinging of receivers (agreed in the thread).
// Run: node test/sdr-failure-test.js
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const F = require('../lib/sdr-failure');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
const root = path.join(__dirname, '..');
const html = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const main = readSrc(path.join(root, 'main.js'));
const kiwi = readSrc(path.join(root, 'lib', 'kiwisdr.js'));

console.log('SDR failure words');

test('a dead receiver "did not answer", whatever the socket said', () => {
  for (const raw of [
    'Opening handshake has timed out',
    'connect ETIMEDOUT 203.0.113.9:8073',
    'connect ECONNREFUSED 127.0.0.1:8073',
    'getaddrinfo ENOTFOUND kiwi.example.net',
    'Unexpected server response: 502',
    'read ECONNRESET',
    'socket hang up',
  ]) assert.strictEqual(F.message('Twente', raw), 'Twente did not answer.', raw);
});

test('every error lib/kiwisdr.js emits has plain words', () => {
  assert.strictEqual(F.classify('KiwiSDR connected but no audio received within 8s — server may be full (no audio slot available). Try a different station.').kind, 'full');
  assert.strictEqual(F.classify('This KiwiSDR limits sessions for users without its password (2 public slots taken) — it granted a short preview, then bumped us.').kind, 'full');
  assert.strictEqual(F.classify('KiwiSDR bad password').kind, 'password');
  assert.strictEqual(F.classify('KiwiSDR auth rejected (badp=3)').kind, 'password');
  assert.strictEqual(F.classify('KiwiSDR identification required (set your callsign in Settings → Station)').kind, 'callsign');
  assert.strictEqual(F.classify("This KiwiSDR's owner does not allow apps to listen, only its own web page.").kind, 'apps');
  // The strings above are the ones kiwisdr.js sends today.
  for (const s of ['server may be full', 'public slot', 'bad password', 'auth rejected (badp=', 'identification required', 'does not allow apps']) {
    assert.ok(kiwi.includes(s), 'kiwisdr.js still says "' + s + '"');
  }
});

test('the three sentences the issue asks for', () => {
  assert.strictEqual(F.message('Bucks', 'Opening handshake has timed out'), 'Bucks did not answer.');
  assert.strictEqual(F.message('Bucks', 'too_busy=1'), 'Bucks is full.');
  assert.strictEqual(F.message('Bucks', 'KiwiSDR bad password'), 'Bucks needs a password.');
  assert.strictEqual(F.message('', 'something new'), 'The receiver could not be reached.');
});

test('list marks are short', () => {
  assert.strictEqual(F.mark('no-answer'), 'did not answer');
  assert.strictEqual(F.mark('other'), 'did not answer');
  assert.strictEqual(F.mark('full'), 'full');
  assert.strictEqual(F.mark('password'), 'needs a password');
});

test('the same receiver however its address is written', () => {
  assert.ok(F.sameHost('kiwi.example.net:8073', 'kiwi.example.net'));
  assert.ok(F.sameHost('secret@kiwi.example.net:8073', 'kiwi.example.net:8073'));
  assert.ok(F.sameHost('http://Kiwi.Example.net:8073/', 'kiwi.example.net:8073'));
  assert.ok(!F.sameHost('kiwi.example.net:8074', 'kiwi.example.net:8073'));
  assert.ok(!F.sameHost('', ''));
});

test('main says which receiver failed', () => {
  assert.ok(/wc\.send\('kiwi-status', \{ connected: false, error: msg, host: kiwiFullHost \}\)/.test(main), 'the error carries the host');
});

test('the VFO window shows the error with Try again, and marks the receiver in the list', () => {
  assert.ok(html.includes('<script src="../lib/sdr-failure.js"></script>'), 'loads the module');
  assert.ok(/id="kiwi-fail"[^>]*role="status"/.test(html), 'a status line under the SDR row');
  assert.ok(/id="kiwi-fail-retry"[^>]*>Try again</.test(html), 'Try again');
  assert.ok(/if \(s\.error\) kiwiNoteFailure\(/.test(html), 'the kiwi-status handler reads s.error');
  assert.ok(/kiwiFailed\.get\(/.test(html) && html.includes("item.className += ' failed'") && html.includes('window.SdrFailure.mark(failedKind)'), 'the dropdown marks a failed receiver');
  assert.ok(!/setInterval\([^)]*kiwiConnect/.test(html), 'no background pinging');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
