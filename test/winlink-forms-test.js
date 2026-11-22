// Winlink forms through Pat (#346 phase 1): the picker's catalog, a filled
// form back to the compose pane and into the Outbox with Pat's form cookie,
// a received form viewed, and the window that shows Pat's own form page.
//
// Pat v1.0.1 source (github.com/la5nta/pat at 2ad31e8) for every wire fact:
// api/api.go 96 and 116-121 (the routes), internal/forms/forms.go (catalog,
// PostFormDataHandler / GetFormDataHandler and the "forminstance" cookie,
// UpdateFormTemplates), api/mailbox.go (attachmentHandler ?rendertohtml=true,
// postOutboundMessageHandler adding the form XML for that cookie).
//
// Every form in this test is made up here; no Winlink form text is in the repo.
// A real Pat runs at the end when assets/pat has one (or POTACAT_TEST_PAT
// names one), offline: it never connects, and the forms are fixtures.
// Run: node test/winlink-forms-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readSrc } = require('./_src');
const F = require('../lib/winlink-forms');
const { WinlinkClient } = require('../lib/winlink-client');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0, skip = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const ORIGIN = 'http://127.0.0.1:8591';
const ID = 'a'.repeat(32);

// ── the catalog ────────────────────────────────────────────────────────────
// The shape of Pat's GET /api/formcatalog (forms.go FormFolder), Windows paths.
const CATALOG = {
  name: 'forms', path: 'C:\\x\\forms', version: '1.1.22.0', form_count: 6,
  forms: [],
  folders: [
    { name: 'General Forms', path: 'C:\\x\\forms\\General Forms', version: '', form_count: 2, folders: [],
      forms: [{ name: 'Winlink Check-in', template_path: 'General Forms\\Winlink Check-in.txt' }, { name: 'Bulletin', template_path: 'General Forms\\Bulletin.txt' }] },
    { name: 'ICS USA Forms', path: 'C:\\x\\forms\\ICS USA Forms', version: '', form_count: 2, folders: [],
      forms: [{ name: 'ICS213 General Message', template_path: 'ICS USA Forms\\ICS213 General Message.txt' }, { name: 'ICS205 Radio Plan', template_path: 'ICS USA Forms\\ICS205 Radio Plan.txt' }] },
    { name: 'Mapping', path: 'C:\\x\\forms\\Mapping', version: '', form_count: 2,
      forms: [{ name: 'Winlink Check-in', template_path: 'Mapping\\Winlink Check-in.txt' }],
      folders: [{ name: 'Sub', path: '', version: '', form_count: 1, folders: [], forms: [{ name: 'Deep Form', template_path: 'Mapping\\Sub\\Deep Form.txt' }] }] },
  ],
};

test('Pat\'s version is read from its web UI line', () => {
  assert.strictEqual(F.patVersionFromUi('<div><p id="version">Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3</p></div>'), 'Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3');
  assert.strictEqual(F.formsAllowed(F.patVersionFromUi('<p id="version">Pat v1.0.1 (2ad31e8) linux/amd64 - go1.26</p>')).ok, true);
  assert.strictEqual(F.formsAllowed(F.patVersionFromUi('<p id="version">Pat v1.0.0 (2e6a8d1) linux/amd64 - go1.24</p>')).ok, false);
  for (const h of ['', null, '<p>Pat v1.0.1</p>', '<html>nothing</html>']) assert.strictEqual(F.patVersionFromUi(h), '', String(h));
  assert.strictEqual(F.formsAllowed(F.patVersionFromUi('<html></html>')).ok, false, 'no version line: no forms');
});

test('the catalog: one sorted list, paths kept as Pat gave them, folders shown with "/"', () => {
  const c = F.flattenCatalog(CATALOG);
  assert.strictEqual(c.version, '1.1.22.0');
  assert.strictEqual(c.count, 6);
  assert.deepStrictEqual(c.forms.map((f) => f.folder + '|' + f.name), [
    'General Forms|Bulletin', 'General Forms|Winlink Check-in', 'ICS USA Forms|ICS205 Radio Plan', 'ICS USA Forms|ICS213 General Message', 'Mapping|Winlink Check-in', 'Mapping/Sub|Deep Form',
  ]);
  assert.strictEqual(c.forms.find((f) => f.name === 'Deep Form').path, 'Mapping\\Sub\\Deep Form.txt', 'sent back to Pat untouched');
  assert.deepStrictEqual(F.flattenCatalog({ name: 'forms', version: 'unknown', forms: [], folders: [] }), { version: '', count: 0, forms: [] }, 'Pat says "unknown" with no forms');
  assert.deepStrictEqual(F.flattenCatalog(null), { version: '', count: 0, forms: [] });
  assert.strictEqual(F.flattenCatalog({ forms: [{ name: 'Linux', template_path: 'General Forms/Linux.txt' }] }).forms[0].folder, 'General Forms');
});

test('favourites: the same folder first, then the same name anywhere, else a search for it', () => {
  const forms = F.flattenCatalog(CATALOG).forms;
  const fav = F.resolveFavourites(forms);
  assert.deepStrictEqual(fav.map((f) => f.path), ['General Forms\\Winlink Check-in.txt', 'ICS USA Forms\\ICS213 General Message.txt'], 'the General Forms check-in, not the Mapping copy');
  const moved = forms.filter((f) => f.folder !== 'General Forms');
  assert.strictEqual(F.resolveFavourites(moved)[0].path, 'Mapping\\Winlink Check-in.txt', 'moved to another folder: still found by name');
  const gone = F.resolveFavourites(forms.filter((f) => !/ICS213/.test(f.name)));
  assert.deepStrictEqual(gone[1], { name: 'ICS213 General Message', folder: 'ICS USA Forms', missing: true, search: 'ICS213 General Message' });
  assert.deepStrictEqual(F.FAVOURITE_FORMS.map((f) => f.name), ['Winlink Check-in', 'ICS213 General Message'], 'Winlink Check-in and ICS-213 are pinned');
});

test('search: every word, any case, name before folder matches; nothing for an empty query', () => {
  const forms = F.flattenCatalog(CATALOG).forms;
  assert.deepStrictEqual(F.searchForms(forms, 'ics 213').map((f) => f.name), ['ICS213 General Message'], 'words, in any order of the name');
  assert.deepStrictEqual(F.searchForms(forms, 'ICS213').map((f) => f.name), ['ICS213 General Message']);
  assert.deepStrictEqual(F.searchForms(forms, 'check-in').map((f) => f.folder), ['General Forms', 'Mapping']);
  assert.deepStrictEqual(F.searchForms(forms, 'ics').map((f) => f.name), ['ICS205 Radio Plan', 'ICS213 General Message'], 'a name starting with the query first');
  assert.deepStrictEqual(F.searchForms(forms, 'sub deep').map((f) => f.name), ['Deep Form'], 'the folder counts');
  assert.deepStrictEqual(F.searchForms(forms, '   '), []);
  assert.strictEqual(F.searchForms(forms, 'e', 2).length, 2, 'limit');
});

test('shapeCatalog: no forms yet means not installed and no favourites', () => {
  const none = F.shapeCatalog({ name: 'forms', version: 'unknown', forms: [], folders: [] });
  assert.deepStrictEqual([none.installed, none.count, none.favourites.length, none.version], [false, 0, 0, '']);
  const some = F.shapeCatalog(CATALOG);
  assert.deepStrictEqual([some.installed, some.count, some.favourites.length, some.version], [true, 6, 2, '1.1.22.0']);
});

test('Get the standard forms: Pat\'s answer and its errors in plain words', () => {
  assert.deepStrictEqual(F.formsUpdateMessage({ newestVersion: '1.1.22.0', action: 'update' }), { ok: true, text: 'Got the Winlink Standard Forms, version 1.1.22.0.', version: '1.1.22.0' });
  assert.strictEqual(F.formsUpdateMessage({ newestVersion: '1.1.22.0', action: 'none' }).text, 'You have the newest Winlink Standard Forms (1.1.22.0).');
  // forms.go getLatestFormsInfo: "can't fetch winlink forms version page: %w" as Pat's 500 body.
  const off = F.formsUpdateMessage(null, new Error('get forms: HTTP 500 — can\'t fetch winlink forms version page: Get "https://api.getpat.io/v1/forms/standard-templates/latest": dial tcp: lookup api.getpat.io: no such host'));
  assert.strictEqual(off.ok, false);
  assert.ok(/could not reach getpat\.io/.test(off.text) && /internet connection/.test(off.text), off.text);
  assert.ok(/in time/.test(F.formsUpdateMessage(null, new Error('get forms: Pat did not answer within 120 s')).text));
  assert.ok(/^Pat could not get the forms: get forms: HTTP 500 — can't unzip/.test(F.formsUpdateMessage(null, new Error('get forms: HTTP 500 — can\'t unzip forms update: disk full')).text));
  assert.strictEqual(F.formsUpdateMessage({}).ok, false);
});

// ── a filled form ──────────────────────────────────────────────────────────

test('the form instance id and its cookie (forms.go: "forminstance")', () => {
  assert.strictEqual(F.FORM_COOKIE, 'forminstance');
  const id = F.newFormInstanceId(crypto.randomBytes);
  assert.ok(/^[0-9a-f]{32}$/.test(id), id);
  assert.notStrictEqual(id, F.newFormInstanceId(crypto.randomBytes));
  assert.strictEqual(F.newFormInstanceId(() => Buffer.from([0, 1, 255, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), '0001ff10' + '0'.repeat(24));
  assert.strictEqual(F.formCookieHeader(ID), 'forminstance=' + ID);
  for (const bad of ['', 'abc', ID + ';x=1', ID.toUpperCase(), null, 42, 'g'.repeat(32)]) assert.strictEqual(F.formCookieHeader(bad), '', String(bad));
});

test('a template\'s "Readonly: True" locks the body; Pat itself ignores the line', () => {
  assert.strictEqual(F.templateReadOnly('Form: a.html,b.html\nTo: <var MsgTo>\nSubject: x\nReadonly:True\nMsg:\nbody'), true);
  assert.strictEqual(F.templateReadOnly('\uFEFFForm: a.html\r\nReadonly: yes\r\nMsg:\r\n'), true, 'BOM, CRLF, Yes');
  assert.strictEqual(F.templateReadOnly('Form: a.html\nReadonly: False\nMsg:\n'), false);
  assert.strictEqual(F.templateReadOnly('Form: a.html\nMsg:\nReadonly: True'), false, 'after Msg: it is body text');
  assert.strictEqual(F.templateReadOnly(''), false);
  assert.strictEqual(F.bodyChanged('a\nb', 'a\r\nb'), false);
  assert.strictEqual(F.bodyChanged('a\nb', 'a\nB'), true);
});

test('GET /api/form\'s answer goes to the compose pane as it is', () => {
  assert.deepStrictEqual(F.formResultToCompose({ msg_to: ' N0CALL ', msg_cc: '', msg_subject: ' Check-in ', msg_body: 'line 1\nline 2\n' }, { readOnly: true }),
    { to: 'N0CALL', cc: '', subject: 'Check-in', body: 'line 1\nline 2\n', readOnly: true });
  assert.deepStrictEqual(F.formResultToCompose(null), { to: '', cc: '', subject: '', body: '', readOnly: false });
});

test('a received form attachment, by Pat\'s own file-name rule', () => {
  assert.deepStrictEqual(F.formAttachment([{ name: 'photo.jpg' }, { name: 'RMS_Express_Form_ICS213_Viewer.xml', size: 900 }]), { file: 'RMS_Express_Form_ICS213_Viewer.xml', form: 'ICS213_Viewer' });
  assert.deepStrictEqual(F.formAttachment([{ name: 'RMS_Express_Form_Winlink Check In Viewer-2.xml' }]), { file: 'RMS_Express_Form_Winlink Check In Viewer-2.xml', form: 'Winlink Check In Viewer' });
  for (const n of ['form.xml', 'RMS_Express_Form_.xml', 'RMS_Express_Form_x.xml.exe', 'RMS_Express_Form_../x.xml']) assert.strictEqual(F.formAttachment([{ name: n }]), null, n);
  assert.strictEqual(F.formAttachment(undefined), null);
});

// ── the form window: what it may load ─────────────────────────────────────

test('the URLs POTACAT opens: a form to fill in, a received form', () => {
  assert.strictEqual(F.patOrigin(8591), ORIGIN);
  assert.strictEqual(F.patOrigin(0), '');
  assert.strictEqual(F.fillUrl(ORIGIN, 'General Forms\\Winlink Check-in.txt'), ORIGIN + '/api/forms?template=General%20Forms%5CWinlink%20Check-in.txt');
  assert.strictEqual(F.fillUrl(ORIGIN, ''), '');
  assert.strictEqual(F.viewUrl(ORIGIN, 'in', 'ABC123DEF456', 'RMS_Express_Form_ICS213_Viewer.xml'), ORIGIN + '/api/mailbox/in/ABC123DEF456/RMS_Express_Form_ICS213_Viewer.xml?rendertohtml=true');
  assert.strictEqual(F.viewUrl(ORIGIN, 'in', '../out', 'RMS_Express_Form_a.xml'), '', 'never a path');
  assert.strictEqual(F.viewUrl(ORIGIN, 'in', 'ABC', 'secret.txt'), '', 'only a form attachment');
});

test('navigation: Pat\'s form pages only; a web page goes to the browser after a confirm; nothing else', () => {
  const nav = (u, o) => F.navigationVerdict(u, ORIGIN, o);
  for (const u of [ORIGIN + '/api/forms?template=a.txt', ORIGIN + '/api/forms/General%20Forms/style.css', ORIGIN + '/api/form?template=a.txt', ORIGIN + '/api/mailbox/in/ABC/RMS_Express_Form_x.xml?rendertohtml=true']) {
    assert.strictEqual(nav(u).allow, true, u);
  }
  assert.deepStrictEqual(nav('https://what3words.com/x'), { allow: false, kind: 'external', external: 'https://what3words.com/x' });
  for (const u of [ORIGIN + '/ui', ORIGIN + '/api/connect?url=telnet', ORIGIN + '/api/mailbox/in/ABC/RMS_Express_Form_x.xml', ORIGIN + '/api/forms', ORIGIN + '/api/form',
    'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'about:blank', 'http://127.0.0.1:8592/api/forms?template=a.txt']) {
    const v = nav(u);
    if (/:8592/.test(u)) { assert.strictEqual(v.kind, 'external', 'another port is not Pat'); continue; }
    assert.deepStrictEqual([v.allow, v.external], [false, undefined], u);
  }
  assert.strictEqual(nav(ORIGIN + '/api/form?template=a.txt', { submit: false }).allow, false, 'a received form never posts');
});

test('requests: only Pat\'s form pages reach Pat; never its API, never the web', () => {
  const ok = (url, method = 'GET', resourceType = 'mainFrame', o) => F.requestAllowed({ url, method, resourceType }, ORIGIN, o);
  assert.ok(ok(ORIGIN + '/api/forms?template=a.txt'));
  assert.ok(ok(ORIGIN + '/api/forms/General%20Forms/logo.png', 'GET', 'image'));
  assert.ok(ok(ORIGIN + '/api/form?template=a.txt', 'POST'));
  assert.ok(ok(ORIGIN + '/api/mailbox/in/ABC/RMS_Express_Form_x.xml?rendertohtml=true'));
  assert.ok(ok(ORIGIN + '/dist/js/template.js', 'GET', 'script'), 'Pat\'s text-only form editor loads /dist');
  assert.ok(ok('data:image/png;base64,AAAA', 'GET', 'image') && ok('blob:null/1234', 'GET', 'other'));
  // Pat's unauthenticated API: a form page's fetch would still be SENT (the sandbox only hides the answer).
  for (const [u, m] of [['/api/connect?url=telnet', 'GET'], ['/api/mailbox/out', 'POST'], ['/api/mailbox/in/ABC', 'DELETE'], ['/api/mailbox/in/ABC', 'GET'],
    ['/api/config', 'PUT'], ['/api/reload', 'POST'], ['/api/formsUpdate', 'POST'], ['/api/form', 'GET'], ['/api/qsy', 'POST'], ['/api/posreport', 'POST'], ['/ws', 'GET'],
    ['/api/forms?template=a.txt', 'POST'], ['/api/form?template=a.txt', 'GET'], ['/ui', 'GET']]) {
    assert.strictEqual(ok(ORIGIN + u, m, 'xhr'), false, `${m} ${u}`);
  }
  assert.strictEqual(ok('ws://127.0.0.1:8591/ws', 'GET', 'webSocket'), false);
  assert.strictEqual(ok(ORIGIN + '/api/mailbox/in/ABC/RMS_Express_Form_x.xml?rendertohtml=true', 'GET', 'xhr'), false, 'a received form is the page, never fetched by a page');
  assert.strictEqual(ok(ORIGIN + '/api/mailbox/in/ABC/photo.jpg', 'GET', 'image'), false, 'other attachments are not reachable');
  assert.strictEqual(ok(ORIGIN + '/api/form?template=a.txt', 'POST', 'mainFrame', { submit: false }), false, 'a received form never posts');
  for (const u of ['https://assets.what3words.com/sdk/v3/what3words.js', 'http://example.com/pixel.gif', 'file:///C:/x', 'http://127.0.0.1:8592/api/forms?template=a.txt']) {
    assert.strictEqual(ok(u, 'GET', 'script'), false, u);
  }
});

// ── geolocation, from the grid ────────────────────────────────────────────

test('geolocation is the centre of the grid in Settings; no grid, no answer', () => {
  assert.deepStrictEqual(F.geolocationFromGrid('FN20'), { latitude: 40.5, longitude: -75, accuracy: 100000 });
  const six = F.geolocationFromGrid('fn20xr');
  assert.deepStrictEqual(six, { latitude: 40.72917, longitude: -74.04167, accuracy: 5000 });
  assert.strictEqual(F.geolocationFromGrid('FN20xr45').accuracy, 1000);
  assert.deepStrictEqual([F.geolocationFromGrid('FN20xr45').latitude, F.geolocationFromGrid('FN20xr45').longitude], [six.latitude, six.longitude], 'the 6-character centre');
  for (const g of ['', null, undefined, 'FN2', 'ZZ99', 'FN20YY', 'hello', 'FN20xr4']) assert.strictEqual(F.geolocationFromGrid(g), null, String(g));
});

test('permissions: geolocation only, and only with an answer from the grid', () => {
  const geo = F.geolocationFromGrid('FN20');
  assert.strictEqual(F.permissionAllowed('geolocation', geo), true);
  assert.strictEqual(F.permissionAllowed('geolocation', null), false);
  for (const p of ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'openExternal', 'fullscreen', 'midi', 'pointerLock', 'window-management', 'display-capture', 'hid', 'serial', 'usb']) {
    assert.strictEqual(F.permissionAllowed(p, geo), false, p);
  }
});

// ── the client ─────────────────────────────────────────────────────────────

function fakePat() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie || '', type: req.headers['content-type'] || '', body });
      if (req.url === '/ui') { res.end('<html><p id="version">Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3</p></html>'); return; }
      if (req.url === '/api/formcatalog') { res.end(JSON.stringify(CATALOG)); return; }
      if (req.url === '/api/formsUpdate' && req.method === 'POST') { res.end(JSON.stringify({ newestVersion: '1.1.22.0', action: 'update' })); return; }
      if (req.url === '/api/form' && req.method === 'GET') {
        if (req.headers.cookie !== 'forminstance=' + ID) { res.statusCode = 400; res.end('http: named cookie not present'); return; }
        res.end(JSON.stringify({ msg_to: 'N0CALL', msg_cc: '', msg_subject: 'S', msg_body: 'B' })); return;
      }
      if (req.url === '/api/mailbox/out' && req.method === 'POST') { res.statusCode = 201; res.end('Message posted (1.00 kB)'); return; }
      res.statusCode = 404; res.end('404 page not found');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('the client: version, catalog, formsUpdate, formData with the cookie, send with the cookie', async () => {
  const { server, port, seen } = await fakePat();
  const c = new WinlinkClient({ port });
  try {
    assert.strictEqual(await c.patVersion(), 'Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3');
    assert.strictEqual(F.shapeCatalog(await c.formCatalog()).count, 6);
    assert.deepStrictEqual(await c.formsUpdate(), { newestVersion: '1.1.22.0', action: 'update' });
    assert.deepStrictEqual(await c.formData(ID), { msg_to: 'N0CALL', msg_cc: '', msg_subject: 'S', msg_body: 'B' });
    await assert.rejects(() => c.formData('nope'), /not a form instance id/);
    await c.send({ to: 'N0CALL', subject: 'S', body: 'B', date: '2026-11-19T00:00:00Z' }, [], { formInstance: ID });
    await c.send({ to: 'N0CALL', subject: 'Plain', body: 'B', date: '2026-11-19T00:00:00Z' });
    await assert.rejects(() => c.send({ to: 'N0CALL' }, [], { formInstance: 'x;y' }), /not a form instance id/);
    const posts = seen.filter((s) => s.url === '/api/mailbox/out');
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(posts[0].cookie, 'forminstance=' + ID, 'a form\'s message carries its cookie, so Pat adds the XML');
    assert.ok(/multipart\/form-data/.test(posts[0].type) && /name="subject"\r\n\r\nS\r\n/.test(posts[0].body));
    assert.strictEqual(posts[1].cookie, '', 'a plain message carries none');
    assert.deepStrictEqual(await c.probe('/api/forms?template=x'), { status: 404, text: '404 page not found' });
    assert.strictEqual(seen.find((s) => s.url === '/api/formsUpdate').method, 'POST');
  } finally { c.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

// ── main.js: the gate, the window, the send path ──────────────────────────

const main = readSrc(path.join(ROOT, 'main.js'));
function fnBody(name) {
  const i = main.indexOf(`function ${name}(`);
  assert.ok(i > 0, name);
  return main.slice(i, main.indexOf('\n}\n', i));
}

test('no forms unless Pat says it is 1.0.1 or newer: the gate comes first everywhere', () => {
  const gate = fnBody('winlinkFormsGate');
  assert.ok(/patClient\.patVersion\(\)/.test(gate) && /WinlinkForms\.formsAllowed\(_patVersionSeen\.text\)/.test(gate));
  assert.ok(/_patVersionSeen\.port !== _patHttpPort/.test(gate), 'a restarted Pat (a new port) is asked again');
  for (const f of ['winlinkFormsCatalog', 'winlinkFormsUpdate', 'winlinkFormOpen']) {
    const b = fnBody(f);
    const g = b.indexOf('await winlinkFormsGate()');
    assert.ok(g > 0, `${f} asks the gate`);
    assert.ok(/if \(!g\.ok\) return/.test(b.slice(g, g + 200)), `${f} stops when forms are not allowed`);
    assert.ok(b.indexOf('patClient.', g) > g, `${f} talks to Pat only after the gate`);
  }
  assert.ok(/if \(!g\.ok\) return \{ ok: true, allowed: false, why: g\.why \};/.test(fnBody('winlinkFormsCatalog')), 'the picker gets the one sentence why');
});

test('the form window: sandboxed, isolated, no Node, no preload, web security, a fresh in-memory session', () => {
  const w = fnBody('openWinlinkFormWindow');
  assert.ok(/const partition = `winlink-form-\$\{id\}`;/.test(w), 'one partition per form');
  assert.ok(!/persist:/.test(w), 'in memory, never persisted');
  const opts = w.slice(w.indexOf('new BrowserWindow({'), w.indexOf('});', w.indexOf('new BrowserWindow({')));
  for (const re of [/sandbox: true/, /contextIsolation: true/, /nodeIntegration: false/, /webSecurity: true/, /partition,/, /backgroundColor: getThemeWindowBg\(\)/]) assert.ok(re.test(opts), re.source);
  assert.ok(!/preload/.test(opts), 'no preload');
  assert.ok(/rememberWindowPlace\(winlinkFormWin, 'winlinkFormBounds'/.test(w));
  assert.ok(/ses\.clearStorageData\(\)/.test(w), 'its storage goes when it closes');
  assert.ok(/wc\.insertCSS\('html \{ background-color: #ffffff; color-scheme: light; \}', \{ cssOrigin: 'user' \}\)/.test(w),
    'a form keeps a browser\'s white page, never the theme colour behind its black text');
  assert.ok(/if \(w === winlinkFormWin\) continue;/.test(fnBody('broadcastAppTheme')), 'a theme change never scripts Pat\'s page');
  assert.ok(/wc\.on\('dom-ready', \(\) => \{[\s\S]*?wc\.executeJavaScript\(WinlinkForms\.PROMPT_SHIM\)/.test(w), 'Electron has no prompt(): the forms need one to Submit');
});

test('prompt() in a form takes what the form suggests, or is Cancel with no suggestion', () => {
  const window = {};
  new Function('window', F.PROMPT_SHIM)(window);
  assert.strictEqual(window.prompt('Message Subject:', 'Winlink Check-in EXERCISE - N0CALL - Home'), 'Winlink Check-in EXERCISE - N0CALL - Home');
  assert.strictEqual(window.prompt('Date time:', 20261119), '20261119');
  assert.strictEqual(window.prompt('Enter Agency/Group Title'), null, 'no suggestion: Cancel, the form keeps what it had');
  assert.strictEqual(window.prompt('x', ''), '');
  assert.ok(!/require|process|ipc|fetch|XMLHttpRequest/.test(F.PROMPT_SHIM), 'it gives the page nothing else');
});

test('the form window: every request filtered, every navigation checked, pop-ups denied, web pages after a confirm', () => {
  const w = fnBody('openWinlinkFormWindow');
  assert.ok(/ses\.webRequest\.onBeforeRequest\(\(d, cb\) => \{\s*const ok = WinlinkForms\.requestAllowed\(\{ url: d\.url, method: d\.method, resourceType: d\.resourceType \}, origin, \{ submit \}\);[\s\S]*?cb\(\{ cancel: !ok \}\);/.test(w));
  assert.ok(/ses\.webRequest\.onBeforeSendHeaders\(\{ urls: \[`\$\{origin\}\/\*`\] \}, \(d, cb\) => cb\(\{ requestHeaders: \{ \.\.\.d\.requestHeaders, Cookie: cookie \} \}\)\);/.test(w), 'the form cookie only to Pat');
  assert.ok(/wc\.on\('will-frame-navigate', \(e\) => guard\(e, e\.url\)\);/.test(w) && /wc\.on\('will-redirect'/.test(w));
  assert.ok(/const v = WinlinkForms\.navigationVerdict\(u, origin, \{ submit \}\);\s*if \(v\.allow\) return;\s*e\.preventDefault\(\);\s*if \(v\.external\) winlinkFormAskExternal\(w, v\.external\);/.test(w));
  assert.ok(/wc\.setWindowOpenHandler\([\s\S]*?return \{ action: 'deny' \};/.test(w), 'never a new window');
  assert.ok(/wc\.on\('will-attach-webview', \(e\) => e\.preventDefault\(\)\);/.test(w));
  const ask = fnBody('winlinkFormAskExternal');
  assert.ok(/dialog\.showMessageBox\(/.test(ask) && /if \(r\.response === 0\) await require\('electron'\)\.shell\.openExternal\(url\);/.test(ask), 'the browser, after a yes');
  assert.ok(/cancelId: 1/.test(ask) && /defaultId: 1/.test(ask), 'Cancel is the default');
});

test('the form window: permissions refused except geolocation, answered from the grid, never the OS', () => {
  const w = fnBody('openWinlinkFormWindow');
  assert.ok(/let geo = WinlinkForms\.geolocationFromGrid\(settings\.grid\);/.test(w));
  assert.ok(/ses\.setPermissionRequestHandler\(\(_wc, permission, cb\) => cb\(WinlinkForms\.permissionAllowed\(permission, geo\)\)\);/.test(w));
  assert.ok(/ses\.setPermissionCheckHandler\(\(_wc, permission\) => WinlinkForms\.permissionAllowed\(permission, geo\)\);/.test(w));
  assert.ok(/ses\.setDevicePermissionHandler\(\(\) => false\);/.test(w));
  // The grid's centre replaces the location provider before the page loads; if that fails, location is refused.
  const o = w.indexOf("sendCommand('Emulation.setGeolocationOverride', geo)");
  assert.ok(o > 0 && o < w.indexOf('w.loadURL(url)'), 'set before the page loads');
  assert.ok(/catch \(e\) \{\s*geo = null;/.test(w), 'no override, no location');
});

test('Submit: what Pat built comes back to the compose pane; the window closes', () => {
  const w = fnBody('openWinlinkFormWindow');
  assert.ok(/if \(submit\) \{\s*ses\.webRequest\.onCompleted\(\{ urls: \[`\$\{origin\}\/api\/form\*`\] \}, \(d\) => \{\s*if \(d\.method === 'POST' && d\.statusCode === 200 && d\.resourceType === 'mainFrame' && WinlinkForms\.formUrlKind\(d\.url, origin\) === 'submit'\) winlinkFormSubmitted\(id\);/.test(w));
  const s = fnBody('winlinkFormSubmitted');
  assert.ok(/patClient\.formData\(id\)/.test(s) && /winlinkPopoutSend\('winlink-form-result', msg\)/.test(s) && /winlinkFormWin\.close\(\)/.test(s));
  assert.ok(/if \(_winlinkPendingFormResult\) \{ winlinkPopoutSend\('winlink-form-result', _winlinkPendingFormResult\);/.test(main), 'a Mail window opened later still gets it');
});

test('the send path: the form\'s cookie goes with its message; a read-only body cannot be changed', () => {
  const one = fnBody('winlinkSendOne');
  assert.ok(/const form = formId \? _winlinkFormIds\.get\(String\(formId\)\) : null;/.test(one));
  assert.ok(/if \(formId && !form\) return \{ ok: false/.test(one), 'an unknown form id is refused, not sent without its XML');
  assert.ok(/if \(form && form\.readOnly && WinlinkForms\.bodyChanged\(form\.body, body\)\)/.test(one));
  assert.ok(/await patClient\.send\(c\.fields, files, form \? \{ formInstance: String\(formId\) \} : \{\}\);/.test(one));
  assert.ok(/async function winlinkSend\(\{ to, cc, subject, body, p2p, attachments, formId \} = \{\}\)/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-form-open'/.test(main) && /ipcMain\.handle\('winlink-forms-catalog'/.test(main) && /ipcMain\.handle\('winlink-forms-update'/.test(main));
});

test('the Mail window: a Forms button, the picker, View form, and the form\'s message in compose', () => {
  const html = readSrc(path.join(ROOT, 'renderer/winlink-popout.html'));
  const js = readSrc(path.join(ROOT, 'renderer/winlink-popout.js'));
  const pre = readSrc(path.join(ROOT, 'preload-winlink-popout.js'));
  assert.ok(/id="wl-tpl-btn"[^\n]*\n\s*<button class="wl-btn" id="wl-forms-btn"[^>]*>Forms<\/button>/.test(html), 'Forms beside Templates');
  assert.ok(/<script src="\.\.\/lib\/winlink-forms\.js"><\/script>/.test(html));
  assert.ok(/id="wl-forms-get" hidden>Get the standard forms<\/button>/.test(html));
  for (const k of ['formsCatalog', 'formsUpdate', 'formOpen', 'onFormResult']) assert.ok(new RegExp(k + ': ').test(pre), k);
  // Not allowed: the status line is the one sentence why, and nothing else is offered.
  assert.ok(/var status = !c\.allowed && c\.why \? c\.why/.test(js));
  assert.ok(/\$\('wl-forms-get'\)\.hidden = !usable;/.test(js) && /\$\('wl-forms-find-row'\)\.hidden = !\(usable && c\.installed\);/.test(js) && /var favs = usable && c\.installed/.test(js));
  assert.ok(/window\.WinlinkForms\.formAttachment\(m\.attachments\)/.test(js) && />View form<\/button>/.test(js));
  assert.ok(/formId: composeForm \? composeForm\.id : undefined/.test(js));
  assert.ok(/\$\('wl-c-body'\)\.readOnly = !!\(composeForm && composeForm\.readOnly\);/.test(js));
});

test('nothing of Winlink\'s forms is bundled: Pat downloads them on the operator\'s machine', () => {
  const pkg = JSON.parse(readSrc(path.join(ROOT, 'package.json')));
  assert.ok(!JSON.stringify(pkg.build || {}).match(/Standard_Forms|winlink[\\/]+forms/i), 'no forms in the installer');
  assert.ok(!fs.existsSync(path.join(ROOT, 'assets', 'winlink-forms')) && !fs.existsSync(path.join(ROOT, 'third_party', 'winlink-forms')));
  assert.ok(/formsDir: p\.forms/.test(main), 'Pat is started with the profile\'s own forms folder');
});

// ── a real Pat, offline, with made-up forms (skipped when there is none) ──

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
// A made-up form: a template with an input page and a viewer (forms.go readTemplate: "Form: <input>,<display>").
function writeFixtureForms(dir) {
  fs.mkdirSync(path.join(dir, 'Test Forms'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Test Forms', 'Potacat Test.txt'), 'Form: Potacat_Test_Input.html,Potacat_Test_Viewer.html\nTo: N0CALL\nSubject: Test from <var Name>\nReadonly: True\nMsg:\nName: <var Name>\n');
  fs.writeFileSync(path.join(dir, 'Test Forms', 'Potacat_Test_Input.html'), '<html><body><form method="post" enctype="multipart/form-data" action="http://{FormServer}:{FormPort}"><input name="Name"><input type="submit"></form></body></html>');
  fs.writeFileSync(path.join(dir, 'Test Forms', 'Potacat_Test_Viewer.html'), '<html><body><p id="name">{var Name}</p></body></html>');
  fs.writeFileSync(path.join(dir, 'Standard_Forms_Version.dat'), '0.0.0.1');
}

test('a real Pat (offline): version, catalog, a form filled, posted with its cookie, Pat adds the XML, and it renders back', async () => {
  const WinlinkPat = require('../lib/winlink-pat');
  const bin = process.env.POTACAT_TEST_PAT || path.join(ROOT, 'assets', 'pat', WinlinkPat.patBinaryName());
  if (!fs.existsSync(bin)) { skip++; return 'skip'; }
  const { patTestEnv } = require('./modem-loopback/pat-env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-forms-'));
  const port = await freePort();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(WinlinkPat.buildPatConfig({ mycall: 'N0CALL', httpPort: port }), null, 2));
  const mbox = path.join(dir, 'mailbox');
  const forms = path.join(dir, 'forms');
  fs.mkdirSync(mbox, { recursive: true });
  writeFixtureForms(forms);
  const args = WinlinkPat.buildPatArgs({ configPath: cfgPath, mboxDir: mbox, logPath: path.join(dir, 'pat.log'), eventLogPath: path.join(dir, 'pat-events.json'), formsDir: forms });
  const proc = spawn(bin, args, { stdio: 'ignore', env: patTestEnv(dir, ['N0CALL']), windowsHide: true });
  const c = new WinlinkClient({ port });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { await c.status(); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    assert.ok(up, 'Pat answered');
    const ver = await c.patVersion();
    assert.ok(F.parsePatVersion(ver), 'Pat says its version: ' + ver);
    assert.strictEqual(F.formsAllowed(ver).ok, F.comparePatVersions(F.parsePatVersion(ver), F.parsePatVersion('1.0.1')) >= 0);
    const cat = F.shapeCatalog(await c.formCatalog());
    assert.strictEqual(cat.count, 1);
    assert.strictEqual(cat.version, '0.0.0.1');
    const form = cat.forms[0];
    assert.deepStrictEqual([form.name, form.folder], ['Potacat Test', 'Test Forms']);
    const origin = F.patOrigin(port);
    const fill = F.fillUrl(origin, form.path);
    assert.strictEqual((await c.probe(fill.slice(origin.length))).status, 200);
    assert.strictEqual((await c.probe('/api/forms?template=' + encodeURIComponent('Test Forms/Missing.txt'))).status, 404, 'a missing form: the picker says so in words');
    // The page's Submit, as the form window sends it: the submit target Pat wrote into the page, multipart, with our cookie.
    const page = await (await fetch(fill)).text();
    const action = (page.match(/action="([^"]+)"/) || [])[1];
    assert.ok(action && action.startsWith('/api/form?'), 'Pat rewrote the submit target: ' + action);
    assert.strictEqual(F.formUrlKind(origin + action.replace(/&amp;/g, '&'), origin), 'submit');
    const id = F.newFormInstanceId(crypto.randomBytes);
    const fd = new FormData(); fd.append('Name', 'Casey');
    const posted = await fetch(origin + action.replace(/&amp;/g, '&'), { method: 'POST', body: fd, headers: { cookie: F.formCookieHeader(id) } });
    assert.strictEqual(posted.status, 200);
    assert.ok(/window\.close\(\)/.test(await posted.text()));
    const back = F.formResultToCompose(await c.formData(id), { readOnly: F.templateReadOnly(fs.readFileSync(path.join(forms, F.slashPath(form.path)), 'utf8')) });
    assert.deepStrictEqual([back.to, back.subject, back.readOnly], ['N0CALL', 'Test from Casey', true]);
    assert.ok(/Name: Casey/.test(back.body));
    const fields = WinlinkPat.composeFields({ to: back.to, subject: back.subject, body: back.body });
    await c.send(fields.fields, [], { formInstance: id });
    const [queued] = await c.mailbox('out');
    const att = F.formAttachment(queued.attachments);
    assert.ok(att, 'Pat added the form XML: ' + JSON.stringify(queued.attachments));
    assert.strictEqual(att.file, 'RMS_Express_Form_Potacat_Test_Viewer.xml');
    // View: Pat renders it with the viewer page.
    const view = F.viewUrl(origin, 'out', queued.mid, att.file);
    const shown = await fetch(view);
    assert.strictEqual(shown.status, 200);
    assert.ok(/<p id="name">Casey<\/p>/.test(await shown.text()), 'the viewer shows the value');
    assert.ok(/sandbox allow-forms/.test(shown.headers.get('content-security-policy') || ''), 'Pat 1.0.1 sends it sandboxed');
  } finally {
    c.close();
    try { proc.kill(); } catch {}
  }
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(ROOT, 'scripts', 'run-tests.js')).includes("'test/winlink-forms-test.js'"));
});

(async () => {
  console.log('Winlink forms through Pat (#346 phase 1)');
  for (const [name, fn] of queue) {
    try {
      const r = await fn();
      if (r === 'skip') console.log('  skip ' + name + ' (no Pat binary: assets/pat or POTACAT_TEST_PAT)');
      else { pass++; console.log('  ok  ' + name); }
    } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  // exitCode, not exit(): exiting under a just-closed fetch socket trips a libuv assert on Windows (Node 24).
  process.exitCode = fail ? 1 : 0;
})();
