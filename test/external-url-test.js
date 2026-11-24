#!/usr/bin/env node
'use strict';
/**
 * lib/external-url.js: the open-external gate parses the URL and compares the
 * host exactly, so a lookalike host, a user:pass@ prefix or a trailing dot is
 * refused, and every real link the app shows still opens. A file:// link may
 * reveal only a file inside POTACAT's own folders.
 *
 * Run: node test/external-url-test.js
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const E = require('../lib/external-url');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('lookalike hosts are refused', () => {
  const bad = [
    'https://tailscale.com.evil.example/',
    'https://tailscale.com.evil.example',
    'https://worldradioleague.com.evil',
    'https://worldradioleague.com.evil/path',
    'https://potacat.com.evil.example/',
    'https://evilpotacat.com/',
    'https://www.qrz.com.evil.example/db/K3SBP',
    'https://discord.gg.evil.example/',
    'https://TailScale.com.Evil.Example/', // mixed case does not hide the extra labels
    'https://POTACAT.COM.evil.example/',
    'http://rx.linkfanel.net.evil.example/',
    'https://login.tailscale.com.evil.example/admin/',
  ];
  for (const u of bad) assert.strictEqual(E.allowed(u), false, u);
});

test('user:pass@ (userinfo) tricks are refused', () => {
  for (const u of [
    'https://potacat.com@evil.example',
    'https://potacat.com@evil.example/',
    'https://potacat.com:443@evil.example/',
    'https://tailscale.com@evil.example/',
    'https://worldradioleague.com:pw@evil.example/',
    'https://user:pass@potacat.com/',
    'https://user@potacat.com/',
    'https://:@potacat.com/',
    'https://www.qrz.com%2f@evil.example/',
  ]) assert.strictEqual(E.allowed(u), false, u);
});

test('a trailing dot, another port, another scheme or a stray character is refused', () => {
  for (const u of [
    'https://tailscale.com./',
    'https://potacat.com./guides/',
    'https://potacat.com:8443/',
    'http://potacat.com/', // https entries stay https
    'ftp://potacat.com/',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///etc/passwd',
    'https://potacat.com\\@evil.example/',
    'https://potacat.com/\nhttps://evil.example/',
    ' https://potacat.com/',
    'https://potacat.com/ ',
    'https://evil.example/https://potacat.com/',
    'https://evil.example/?u=https://potacat.com/',
  ]) assert.strictEqual(E.allowed(u), false, JSON.stringify(u));
});

test('unparseable input and non-strings are refused', () => {
  for (const u of ['', 'not a url', 'https://', 'https:// potacat.com/', 'https://[bad/', null, undefined, 42, {}, ['https://potacat.com/']]) {
    assert.strictEqual(E.allowed(u), false, String(u));
  }
});

test('a path entry stays a path rule: same page or beneath it, never a longer name', () => {
  assert.ok(E.allowed('https://www.arrl.org/tqsl-download'));
  assert.ok(E.allowed('https://buymeacoffee.com/potacat'));
  assert.ok(E.allowed('https://buymeacoffee.com/potacat/'));
  assert.strictEqual(E.allowed('https://www.arrl.org/tqsl-download-evil'), false);
  assert.strictEqual(E.allowed('https://buymeacoffee.com/potacatevil'), false);
  assert.strictEqual(E.allowed('https://buymeacoffee.com/someoneelse'), false);
  assert.strictEqual(E.allowed('https://github.com/evil/'), false);
  assert.strictEqual(E.allowed('https://github.com/Waffleslop/POTACAT-evil/'), false);
  assert.strictEqual(E.allowed('https://www.arrl.org/'), false);
});

test('mailto matches the one address; query parameters may follow', () => {
  assert.ok(E.allowed('mailto:k3sbp@potacat.com'));
  assert.ok(E.allowed('mailto:k3sbp@potacat.com?subject=POTACAT%20setup%3A%20IC-7300&body=Radio%20model%3A%20IC-7300'));
  assert.strictEqual(E.allowed('mailto:evil@example.com'), false);
  assert.strictEqual(E.allowed('mailto:k3sbp@potacat.com,evil@example.com'), false);
  assert.strictEqual(E.allowed('mailto:k3sbp@potacat.com.evil.example'), false);
});

test('every allowlist entry is accepted, with a page beneath it', () => {
  assert.ok(E.ALLOWED.length > 30);
  for (const entry of E.ALLOWED) {
    assert.ok(E.allowed(entry), entry);
    if (/^https?:/.test(entry)) assert.ok(E.allowed(entry.replace(/\/?$/, '/') + 'some/page?x=1#y'), entry + ' + page');
  }
});

test('entries without a trailing slash (whole sites) accept their own host only', () => {
  assert.ok(E.allowed('https://tailscale.com'));
  assert.ok(E.allowed('https://tailscale.com/kb/1153/enabling-https'));
  assert.ok(E.allowed('https://worldradioleague.com/'));
  assert.strictEqual(E.allowed('https://login.tailscale.com/'), false, 'login.tailscale.com is its own entry, /admin/ only');
  assert.ok(E.allowed('https://login.tailscale.com/admin/dns'));
  assert.ok(E.allowed('http://kiwisdr.com/public/'));
  assert.ok(E.allowed('https://kiwisdr.com/public/'), 'an http entry also opens over https');
});

test('the real links the windows open are accepted', () => {
  const real = [
    'https://potacat.com/guides/vara-on-mac/',
    'https://potacat.com/badge/',
    'https://api.potacat.com/embed/map/K3SBP',
    'https://docs.potacat.com/',
    'https://www.qrz.com/db/K3SBP',
    'https://www.qrz.com/db/EA8%2FK3SBP',
    'https://discord.gg/cuNQpES38C',
    'https://docs.google.com/spreadsheets/d/1fg6ZX9DokyThbvHO4VXKcKhKsscy7RYidmERrOB1inc/edit?usp=sharing',
    'https://github.com/Waffleslop/POTACAT/releases/latest',
    'https://pota.app/#/park/US-1234',
    'https://pota.app/adifupload',
    'https://www.sotadata.org.uk/en/summit/W7O/CN-001',
    'https://wwff.co/directory/?showRef=KFF-0001',
    'https://llota.app/lighthouse/US-0001',
    'https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-97/subpart-B/section-97.119',
    'https://www.arrl.org/tqsl-download',
    'https://lotw.arrl.org/lotwuser/default',
    'https://clublog.org/edituser.php',
    'https://getpat.io/',
    'https://github.com/la5nta/pat/releases',
    'https://github.com/pflarue/ardop/releases',
    'https://rosmodem.wordpress.com/',
    'https://vb-audio.com/Cable/',
    'http://js8call.com/',
    'https://sourceforge.net/projects/fldigi/files/flrig/',
    'https://apps.apple.com/app/id0000000000',
    'https://play.google.com/store/apps/details?id=com.potacat.echocat',
    'https://buymeacoffee.com/potacat',
    'https://login.potacat.com/',
  ];
  for (const u of real) assert.ok(E.allowed(u), u);
});

test('a mixed-case spelling of an allowed host is that host, and the OS gets the parsed form', () => {
  assert.strictEqual(E.checked('https://PotaCat.COM/guides/'), 'https://potacat.com/guides/');
  assert.strictEqual(E.checked('https://potacat.com'), 'https://potacat.com/');
  assert.strictEqual(E.checked('https://tailscale.com.evil.example/'), null);
});

test('an entry with "*." allows that host and its subdomains, nothing else', () => {
  const rules = [E.parseRule('https://*.example.org/')];
  assert.ok(E.checked('https://example.org/x', rules));
  assert.ok(E.checked('https://a.b.example.org/x', rules));
  assert.strictEqual(E.checked('https://evilexample.org/', rules), null);
  assert.strictEqual(E.checked('https://example.org.evil.example/', rules), null);
  assert.strictEqual(E.checked('https://a.example.org@evil.example/', rules), null);
});

test('every data-external link in the windows passes', () => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'renderer');
  const bad = [];
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    for (const m of readSrc(path.join(dir, f)).matchAll(/<a\b[^>]*>/g)) {
      if (!/\bdata-external\b/.test(m[0])) continue;
      const href = (m[0].match(/href="([^"]+)"/) || [])[1];
      if (!href || !/^https?:|^mailto:/.test(href)) continue;
      n++;
      if (!E.allowed(href.replace(/&amp;/g, '&'))) bad.push(f + ': ' + href);
    }
  }
  assert.ok(n > 5, 'found the links');
  assert.deepStrictEqual(bad, []);
});

test('main routes open-external through the lib and opens the checked form', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  // The IPC and the window guards (lib/window-security.js) share one gate.
  assert.ok(/ipcMain\.on\('open-external', \(_e, url\) => \{ openExternalIfAllowed\(url\); \}\);/.test(main));
  const at = main.indexOf('function openExternalIfAllowed(url) {');
  assert.ok(at > 0, 'openExternalIfAllowed exists');
  const block = main.slice(at, main.indexOf('\n  }\n', at));
  assert.ok(/const known = ExternalUrl\.checked\(url\);\s*if \(known\) \{ shell\.openExternal\(known\); return true; \}/.test(block));
  assert.ok(!/startsWith\(/.test(block), 'no prefix test left in the handler');
  assert.ok(/ExternalUrl\.fileRevealPath\(url, externalRevealRoots\(\)\)/.test(block), 'file links go through the folder rule');
  assert.ok(!/showItemInFolder\(url|replace\('file:\/\/'/.test(block), 'no raw path reveal');
});

// --- file:// ---------------------------------------------------------------
const WIN_ROOTS = ['C:\\Users\\op\\AppData\\Roaming\\potacat', 'C:\\Users\\op\\AppData\\Roaming\\potacat\\logs', 'D:\\Ham\\Logs'];
const NIX_ROOTS = ['/home/op/.config/potacat', '/home/op/Pictures/POTACAT'];

test('file:// inside the app folders is revealed (Windows)', () => {
  const W = (u) => E.fileRevealPath(u, WIN_ROOTS, 'win32');
  assert.strictEqual(W('file://C:\\Users\\op\\AppData\\Roaming\\potacat\\potacat_qso_log.adi'), 'C:\\Users\\op\\AppData\\Roaming\\potacat\\potacat_qso_log.adi');
  assert.strictEqual(W('file://c:\\users\\OP\\appdata\\roaming\\POTACAT\\potacat_qso_log.adi'), 'c:\\users\\OP\\appdata\\roaming\\POTACAT\\potacat_qso_log.adi', 'Windows paths compare without case');
  assert.strictEqual(W('file:///C:/Users/op/AppData/Roaming/potacat/logs/session.log'), 'C:\\Users\\op\\AppData\\Roaming\\potacat\\logs\\session.log');
  assert.strictEqual(W('file://D:\\Ham\\Logs\\my%20log.adi'), 'D:\\Ham\\Logs\\my log.adi');
  assert.strictEqual(W('file://D:\\Ham\\Logs'), 'D:\\Ham\\Logs');
});

test('file:// outside the app folders is refused (Windows)', () => {
  const W = (u) => E.fileRevealPath(u, WIN_ROOTS, 'win32');
  for (const u of [
    'file://C:\\Windows\\System32\\cmd.exe',
    'file://C:\\Users\\op\\AppData\\Roaming\\potacat-evil\\x.exe',
    'file://C:\\Users\\op\\AppData\\Roaming\\potacat\\..\\..\\Local\\x.exe',
    'file://\\\\evil.example\\share\\x.adi',
    'file:////evil.example/share/x.adi',
    'file://\\\\?\\C:\\Users\\op\\AppData\\Roaming\\potacat\\x',
    'file://relative\\x.adi',
    'file://D:\\Ham\\Logs2\\x.adi',
    'file://',
    'https://potacat.com/',
  ]) assert.strictEqual(W(u), null, u);
});

test('file:// inside the app folders is revealed, outside refused (Linux/macOS)', () => {
  const X = (u) => E.fileRevealPath(u, NIX_ROOTS, 'linux');
  assert.strictEqual(X('file:///home/op/.config/potacat/potacat_qso_log.adi'), '/home/op/.config/potacat/potacat_qso_log.adi');
  assert.strictEqual(X('file:///home/op/Pictures/POTACAT/SSTV-RX/a.png'), '/home/op/Pictures/POTACAT/SSTV-RX/a.png');
  for (const u of [
    'file:///etc/passwd',
    'file:///home/op/.config/potacat/../../.ssh/id_rsa',
    'file:///home/op/.config/potacat-evil/x',
    'file:///home/op/.config/POTACAT/x', // POSIX paths keep their case
    'file:////evil.example/share/x',
    'file://relative/x',
  ]) assert.strictEqual(X(u), null, u);
  assert.strictEqual(E.fileRevealPath('file:///home/op/x', [], 'linux'), null, 'no roots, no reveal');
  assert.strictEqual(E.fileRevealPath('file:///home/op/x', ['relative/root', '', null], 'linux'), null, 'relative roots are ignored');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
