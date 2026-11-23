'use strict';
// The app windows' permissions, navigation and new-window rules
// (lib/window-security.js) and their wiring in main.js. Before this, the
// default session granted every permission to every page and any link could
// take a window away from the app or open a new in-app browser window.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const WS = require('../lib/window-security');

const ROOT = path.join(__dirname, '..');
const main = readSrc(path.join(ROOT, 'main.js'));

// A Windows install and a Linux dev checkout.
const WIN_ROOT = 'C:\\Program Files\\POTACAT\\resources\\app.asar';
const WIN_PAGE = 'file:///C:/Program%20Files/POTACAT/resources/app.asar/renderer/index.html';
const NIX_ROOT = '/home/op/potacat';
const NIX_PAGE = 'file:///home/op/potacat/renderer/jtcat-popout.html?theme=dark';
const win = (o) => ({ appRoot: WIN_ROOT, platform: 'win32', ...o });
const nix = (o) => ({ appRoot: NIX_ROOT, platform: 'linux', ...o });

test('every permission a POTACAT feature uses is allowed for the app\'s own pages', () => {
  for (const permission of ['media', 'midi', 'midiSysex', 'hid', 'clipboard-sanitized-write', 'speaker-selection', 'fullscreen']) {
    assert.strictEqual(WS.permissionVerdict(win({ permission, requestingUrl: WIN_PAGE, webContentsUrl: WIN_PAGE })).allow, true, permission);
    assert.strictEqual(WS.permissionVerdict(nix({ permission, requestingUrl: NIX_PAGE, requestingOrigin: 'file://' })).allow, true, permission + ' (check handler)');
  }
  // Microphone / sound card: audio requests and audio checks.
  assert.ok(WS.permissionVerdict(win({ permission: 'media', requestingUrl: WIN_PAGE, mediaTypes: ['audio'] })).allow);
  assert.ok(WS.permissionVerdict(win({ permission: 'media', requestingUrl: WIN_PAGE, mediaTypes: [] })).allow, 'enumerateDevices');
  assert.ok(WS.permissionVerdict(win({ permission: 'media', requestingUrl: WIN_PAGE, mediaType: 'audio' })).allow);
  // What Electron 39 passes in practice (scratch run 2026-11-23): the page in the
  // origin field, a bare file origin with no webContents (WebHID), or only an embedding origin.
  assert.ok(WS.permissionVerdict(win({ permission: 'media', mediaType: 'audio', requestingOrigin: WIN_PAGE, webContentsUrl: WIN_PAGE, requestingUrl: WIN_PAGE, securityOrigin: 'file:///' })).allow);
  assert.ok(WS.permissionVerdict(win({ permission: 'hid', requestingOrigin: 'file:///', securityOrigin: 'file:///' })).allow, 'CM108 WebHID check has no webContents');
  assert.ok(WS.permissionVerdict(win({ permission: 'media', mediaType: 'audio', requestingOrigin: '', requestingUrl: '', webContentsUrl: '', embeddingOrigin: WIN_PAGE })).allow, 'before the page has a URL');
  // Drive letter and folder case differ between Electron's URL and __dirname on Windows.
  assert.ok(WS.isAppUrl('file:///c:/program files/potacat/resources/app.asar/renderer/x.html', WIN_ROOT, 'win32'));
  assert.ok(WS.isAppUrl('file:///D:/Projects/potacat/desktop/renderer/index.html', 'D:\\Projects\\potacat\\desktop', 'win32'));
});

test('unknown and unused permissions are refused', () => {
  for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'serial', 'usb', 'display-capture',
    'openExternal', 'pointerLock', 'keyboardLock', 'idle-detection', 'window-management', 'storage-access', 'unknown', '', 'made-up']) {
    const v = WS.permissionVerdict(win({ permission, requestingUrl: WIN_PAGE, webContentsUrl: WIN_PAGE }));
    assert.strictEqual(v.allow, false, permission);
  }
  assert.strictEqual(WS.permissionVerdict(win({ permission: 'media', requestingUrl: WIN_PAGE, mediaTypes: ['audio', 'video'] })).allow, false, 'no camera');
  assert.strictEqual(WS.permissionVerdict(win({ permission: 'media', requestingUrl: WIN_PAGE, mediaType: 'video' })).allow, false, 'no camera check');
  assert.strictEqual(WS.permissionVerdict(win({ permission: 'media' })).allow, false, 'no page, no permission');
});

test('a page that is not the app\'s own is refused, even for a used permission', () => {
  const foreign = [
    'https://example.com/', 'http://127.0.0.1:8080/form.html', 'https://potacat.com/', 'about:blank', 'data:text/html,x',
    'file:///C:/Users/op/Downloads/evil.html', // a file, but outside the app
    'file:///C:/Program%20Files/POTACAT/resources/app.asar.evil/x.html', // a lookalike folder
    'file:///C:/Program%20Files/POTACAT/resources/app.asar/../../evil.html',
    'file:///C:/Program%20Files/POTACAT/resources/app.asar/%2e%2e/%2e%2e/evil.html',
    'file://attacker-host/share/app.asar/renderer/index.html', // UNC
  ];
  for (const u of foreign) {
    assert.strictEqual(WS.permissionVerdict(win({ permission: 'media', requestingUrl: u })).allow, false, u);
    assert.strictEqual(WS.permissionVerdict(win({ permission: 'midi', requestingUrl: WIN_PAGE, webContentsUrl: u })).allow, false, 'window navigated to ' + u);
  }
  assert.strictEqual(WS.permissionVerdict(win({ permission: 'hid', requestingUrl: WIN_PAGE, requestingOrigin: 'https://example.com' })).allow, false);
  assert.strictEqual(WS.permissionVerdict(win({ permission: 'hid', requestingOrigin: 'https://example.com' })).allow, false, 'web origin, no page');
  assert.strictEqual(WS.permissionVerdict(win({ permission: 'midi', requestingOrigin: 'null' })).allow, false, 'opaque origin, nothing to check');
  assert.strictEqual(WS.permissionVerdict(win({ permission: 'midi', embeddingOrigin: 'https://example.com', requestingOrigin: 'file:///' })).allow, false, 'embedded in a web page');
  // Linux paths are case-sensitive.
  assert.strictEqual(WS.isAppUrl('file:///home/op/POTACAT/renderer/index.html', NIX_ROOT, 'linux'), false);
});

test('navigation: the app\'s pages only; web links go to open-external, the rest is dropped', () => {
  assert.deepStrictEqual(WS.navigationVerdict(WIN_PAGE, WIN_ROOT, 'win32'), { allow: true, external: null });
  assert.deepStrictEqual(WS.navigationVerdict('file:///C:/Program%20Files/POTACAT/resources/app.asar/renderer/log-popout.html?theme=x', WIN_ROOT, 'win32').allow, true);
  assert.deepStrictEqual(WS.navigationVerdict('https://rbn.telegraphy.de', WIN_ROOT, 'win32'), { allow: false, external: 'https://rbn.telegraphy.de/' });
  assert.deepStrictEqual(WS.navigationVerdict('https://evil.example/phish', WIN_ROOT, 'win32'), { allow: false, external: 'https://evil.example/phish' }, 'the allowlist decides, not the guard');
  for (const u of ['file:///C:/Windows/System32/', 'javascript:alert(1)', 'data:text/html,x', 'ms-settings:privacy', 'smb://host/share', 'not a url']) {
    assert.deepStrictEqual(WS.navigationVerdict(u, WIN_ROOT, 'win32'), { allow: false, external: null }, u);
  }
});

test('window.open: never a new window; http(s) and mailto go to open-external, anything else is dropped', () => {
  assert.deepStrictEqual(WS.windowOpenVerdict('https://tailscale.com/download'), { action: 'deny', external: 'https://tailscale.com/download' });
  assert.deepStrictEqual(WS.windowOpenVerdict('https://www.sotadata.org.uk'), { action: 'deny', external: 'https://www.sotadata.org.uk/' }, 'bare host gains its slash so the allowlist matches');
  assert.deepStrictEqual(WS.windowOpenVerdict('mailto:k3sbp@potacat.com'), { action: 'deny', external: 'mailto:k3sbp@potacat.com' });
  for (const u of ['', 'about:blank', WIN_PAGE, 'file:///C:/x.html', 'javascript:void(0)', 'ftp://x/']) {
    assert.deepStrictEqual(WS.windowOpenVerdict(u), { action: 'deny', external: null }, u);
  }
});

test('denials are logged once per permission', () => {
  const lines = [];
  const d = WS.createDenialLog((m) => lines.push(m));
  assert.strictEqual(d('geolocation', 'not used by POTACAT', 'file:///x'), true);
  assert.strictEqual(d('geolocation', 'not used by POTACAT', 'file:///y'), false);
  d('notifications', 'not used by POTACAT');
  assert.strictEqual(lines.length, 2);
  assert.ok(/refused permission "geolocation"/.test(lines[0]));
});

// A fake Electron: app, default session, a partitioned session, webContents.
function fakeElectron() {
  const listeners = {};
  const app = { on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); } };
  const mkSession = () => ({ setPermissionRequestHandler(fn) { this.req = fn; }, setPermissionCheckHandler(fn) { this.check = fn; } });
  const session = mkSession();
  const mkContents = (ses, url) => {
    const ev = {};
    return {
      session: ses, url, ev, openHandler: null,
      getURL() { return this.url; },
      on(name, fn) { (ev[name] = ev[name] || []).push(fn); },
      setWindowOpenHandler(fn) { this.openHandler = fn; },
      emit(name, url) { let prevented = false; const e = { url, preventDefault: () => { prevented = true; } }; (ev[name] || []).forEach((f) => f(e, url)); return prevented; },
    };
  };
  const create = (contents) => (listeners['web-contents-created'] || []).forEach((f) => f({}, contents));
  return { app, session, mkSession, mkContents, create };
}

test('install: the default session gets the rules and every app window the guards', () => {
  const E = fakeElectron();
  const opened = []; const logs = [];
  WS.install({ app: E.app, session: E.session, appRoot: WIN_ROOT, platform: 'win32', openExternal: (u) => opened.push(u), log: (m) => logs.push(m) });
  const wc = E.mkContents(E.session, WIN_PAGE);
  E.create(wc);

  let got;
  E.session.req(wc, 'media', (v) => { got = v; }, { requestingUrl: WIN_PAGE, mediaTypes: ['audio'] });
  assert.strictEqual(got, true, 'mic for the app page');
  E.session.req(wc, 'midi', (v) => { got = v; }, { requestingUrl: WIN_PAGE });
  assert.strictEqual(got, true, 'MIDI paddles');
  E.session.req(wc, 'geolocation', (v) => { got = v; }, { requestingUrl: WIN_PAGE });
  assert.strictEqual(got, false, 'location refused');
  E.session.req(wc, 'geolocation', (v) => { got = v; }, { requestingUrl: WIN_PAGE });
  assert.strictEqual(logs.filter((l) => /geolocation/.test(l)).length, 1, 'logged once');
  E.session.req(wc, 'openExternal', (v) => { got = v; }, { requestingUrl: WIN_PAGE, externalURL: 'ms-settings:' });
  assert.strictEqual(got, false);
  assert.strictEqual(E.session.check(wc, 'hid', 'file://', { requestingUrl: WIN_PAGE }), true, 'CM108 WebHID check');
  assert.strictEqual(E.session.check(wc, 'media', 'file://', { requestingUrl: WIN_PAGE, mediaType: 'audio' }), true);
  assert.strictEqual(E.session.check(wc, 'media', 'file://', { requestingUrl: WIN_PAGE, mediaType: 'video' }), false);
  assert.strictEqual(E.session.check(wc, 'hid', 'https://evil.example', { requestingUrl: 'https://evil.example/' }), false);

  // Navigation away is prevented; a web link goes to open-external.
  assert.strictEqual(wc.emit('will-navigate', 'file:///C:/Program%20Files/POTACAT/resources/app.asar/renderer/index.html#x'), false, 'own page allowed');
  assert.strictEqual(wc.emit('will-navigate', 'https://rbn.telegraphy.de'), true);
  assert.strictEqual(wc.emit('will-redirect', 'https://evil.example/'), true);
  assert.strictEqual(wc.emit('will-navigate', 'file:///C:/Users/op/evil.html'), true);
  assert.deepStrictEqual(opened, ['https://rbn.telegraphy.de/', 'https://evil.example/']);
  assert.strictEqual(wc.emit('will-attach-webview', 'x'), true, 'no webviews');

  // window.open
  assert.deepStrictEqual(wc.openHandler({ url: 'https://tailscale.com/download' }), { action: 'deny' });
  assert.deepStrictEqual(wc.openHandler({ url: 'about:blank' }), { action: 'deny' });
  assert.deepStrictEqual(opened.slice(2), ['https://tailscale.com/download']);
});

test('install: a window on its own session (Winlink forms) keeps its own handlers', () => {
  const E = fakeElectron();
  WS.install({ app: E.app, session: E.session, appRoot: WIN_ROOT, platform: 'win32', openExternal: () => {}, log: () => {} });
  const formSession = E.mkSession();
  const wc = E.mkContents(formSession, 'http://127.0.0.1:8080/api/forms/x.html');
  E.create(wc);
  assert.strictEqual(wc.openHandler, null, 'no central window-open handler on the form window');
  assert.strictEqual(wc.emit('will-navigate', 'http://127.0.0.1:8080/api/forms/y.html'), false, 'no central navigation guard on the form window');
  assert.strictEqual(formSession.req, undefined, 'its session handlers are its own');
});

test('the Winlink forms window still sets its own navigation, window-open and permission rules', () => {
  const i = main.indexOf('async function openWinlinkFormWindow(');
  assert.ok(i > 0);
  const w = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/session\.fromPartition\(partition/.test(w), 'its own session, so the central guard skips it');
  assert.ok(/ses\.setPermissionRequestHandler\(\(_wc, permission, cb\) => cb\(WinlinkForms\.permissionAllowed\(permission, geo\)\)\);/.test(w));
  assert.ok(/wc\.setWindowOpenHandler\([\s\S]*?return \{ action: 'deny' \};/.test(w));
  assert.ok(/wc\.on\('will-frame-navigate', \(e\) => guard\(e, e\.url\)\);/.test(w));
});

test('main.js: the rules are installed before the first window; no window grants everything', () => {
  assert.ok(/const WindowSecurity = require\('\.\/lib\/window-security'\);/.test(main));
  const inst = main.indexOf('WindowSecurity.install({');
  const first = main.indexOf('\n  createWindow();');
  assert.ok(inst > 0 && first > 0 && inst < first, 'installed before createWindow()');
  const call = main.slice(inst, main.indexOf('\n    });', inst));
  assert.ok(/session: session\.defaultSession/.test(call), 'on the default session');
  assert.ok(/appRoot: __dirname/.test(call));
  assert.ok(/openExternal: \(u\) => \{ if \(!openExternalIfAllowed\(u\)\) securityLog\(/.test(call), 'links go through the open-external allowlist; a refused one is logged');
  assert.ok(/const securityLog = \(m\) => appendSessionLog\(/.test(main.slice(inst - 200, inst)) && /log: securityLog/.test(call), 'denials reach the session log');
  // No allow-all handler anywhere.
  assert.ok(!/setPermissionRequestHandler\([^)]*\)\s*=>\s*cb\(true\)\)/.test(main), 'no cb(true) permission handler');
  assert.ok(!/setPermissionCheckHandler\(\(\)\s*=>\s*true\)/.test(main), 'no allow-all check handler');
  assert.strictEqual((main.match(/setPermissionRequestHandler\(/g) || []).length, 1, 'only the Winlink forms session sets its own');
  // The IPC and the guard share one allowlist.
  assert.ok(/ipcMain\.on\('open-external', \(_e, url\) => \{ openExternalIfAllowed\(url\); \}\);/.test(main));
  assert.ok(/function openExternalIfAllowed\(url\) \{/.test(main));
});

test('every hard-coded web link in the app\'s pages passes the open-external allowlist', () => {
  const at = main.indexOf('function openExternalIfAllowed(url) {');
  const block = main.slice(main.indexOf('const allowed = [', at), main.indexOf('];', main.indexOf('const allowed = [', at)));
  const allowed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(allowed.length > 10);
  const dir = path.join(ROOT, 'renderer');
  const bad = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(html|js)$/.test(f) || /^remote[.-]/.test(f)) continue; // remote* is ECHOCAT Web, served to browsers
    const src = readSrc(path.join(dir, f));
    for (const m of src.matchAll(/href="(https?:\/\/[^"$]+)"/g)) {
      const u = WS.externalUrlOf(m[1]);
      if (!u || !allowed.some((p) => u.startsWith(p))) bad.push(f + ': ' + m[1]);
    }
  }
  assert.deepStrictEqual(bad, []);
});
