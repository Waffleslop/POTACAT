#!/usr/bin/env node
'use strict';
// Gateway history and My gateways (#254). History is read from Pat's own
// event log; My gateways is the operator's saved list.
// Run: node test/winlink-history-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const H = require('../lib/winlink-history');
const F = require('../lib/winlink-favourites');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

// The shapes Pat v1.0.0 writes (taken from a real pat-events.json, 2026-11-11).
const EV = [
  '{"error":"aborted while waiting for clear channel","freq":{"khz":7102},"log_time":"2026-10-22T20:00:11-04:00","operation":"connect ardop:///N3HYM-10?bw=2000MAX&freq=7102","success":false,"what":"connect"}',
  '{"error":"Connect timeout","log_time":"2026-10-22T20:01:06-04:00","operation":"connect ardop:///KG4OCM?bw=2000MAX&freq=10146.5","success":false,"what":"connect"}',
  '{"log_time":"2026-10-22T20:03:14-04:00","operation":"connect telnet://K3SBP:CMSTelnet@cms.winlink.org:8772/wl2k","success":true,"what":"connect"}',
  '{"log_time":"2026-10-22T20:03:30-04:00","success":true,"what":"exchange","targetcall":"","sent":[],"received":[]}',
  '{"error":"connect timeout","log_time":"2026-11-11T17:00:00-05:00","operation":"connect varahf:///NA3MD?bw=2750&freq=7100","success":false,"what":"connect"}',
  '{"error":"port closed","freq":{"khz":14074},"log_time":"2026-11-11T12:47:00-05:00","operation":"connect ax25:///W9OU-10?freq=149090","success":false,"what":"connect"}',
  '{"error":"Connect timeout","log_time":"2026-10-22T21:52:00-04:00","operation":"connect ardop:///KY4RY?bw=2000MAX&freq=7100.5","success":false,"what":"connect"}',
  'not json',
  '{"freq":{"khz":7100.5},"log_time":"2026-11-11T17:20:59-05:00","operation":"connect ardop:///KY4RY?bw=2000MAX&freq=7100.5","remote_addr":"KY4RY","success":true,"what":"connect"}',
  '{"log_time":"2026-11-11T17:23:26-05:00","network":"ardop","received":[],"remote_addr":"KY4RY","sent":["2TM5TD7YKKGH"],"success":true,"targetcall":"KY4RY","what":"exchange"}',
].join('\n');

console.log('Winlink gateway history and My gateways (#254)');

test('Pat\'s connect URL gives the mode, gateway and dial', () => {
  assert.deepStrictEqual(H.parseOperation('connect ardop:///KY4RY?bw=2000MAX&freq=7100.5'), { mode: 'ardop', call: 'KY4RY', khz: 7100.5, url: 'ardop:///KY4RY?bw=2000MAX&freq=7100.5' });
  assert.deepStrictEqual(H.parseOperation('connect varahf:///NA3MD?bw=2750&freq=7100'), { mode: 'vara', call: 'NA3MD', khz: 7100, url: 'varahf:///NA3MD?bw=2750&freq=7100' });
  assert.deepStrictEqual(H.parseOperation('connect ax25:///W9OU-10?freq=149090'), { mode: 'packet', call: 'W9OU-10', khz: 149090, url: 'ax25:///W9OU-10?freq=149090' });
  assert.strictEqual(H.parseOperation('connect telnet://K3SBP:x@cms.winlink.org:8772/wl2k'), null, 'internet sessions have no gateway');
});

test('every radio attempt, with the exchange joined to its connect', () => {
  const a = H.parseEvents(EV);
  assert.strictEqual(a.length, 6, 'telnet and the bad line are left out');
  const good = a[a.length - 1];
  assert.strictEqual(good.call, 'KY4RY');
  assert.ok(good.connected && good.exchanged);
  assert.strictEqual(good.sent, 1); assert.strictEqual(good.received, 0);
  assert.strictEqual(good.result, 'Mail exchanged (1 sent, 0 received)');
  assert.strictEqual(good.band, '40m');
});

test('results in plain words', () => {
  const a = H.parseEvents(EV);
  const by = (c) => a.find((x) => x.call === c);
  assert.strictEqual(by('N3HYM-10').result, 'Stopped: the channel was busy');
  assert.strictEqual(by('KG4OCM').result, 'Did not answer');
  assert.strictEqual(by('NA3MD').result, 'Did not answer');
  assert.strictEqual(by('W9OU-10').result, 'The modem was not running');
  assert.strictEqual(H.resultText({ connected: true }), 'Connected, but the mail exchange failed');
});

test('one row per gateway, mode and dial, newest first, counting tries and good sessions', () => {
  const g = H.gateways(H.parseEvents(EV));
  assert.strictEqual(g[0].call, 'KY4RY');
  assert.strictEqual(g[0].tries, 2); assert.strictEqual(g[0].good, 1);
  assert.ok(g[0].lastOk && g[0].lastGoodAt === g[0].lastAt);
  assert.ok(g.every((x, i) => i === 0 || g[i - 1].lastAt >= x.lastAt), 'newest first');
  assert.strictEqual(new Set(g.map((x) => H.gatewayKey(x.call, x.mode, x.khz))).size, g.length);
});

test('My gateways: save, de-duplicate, newest first, at most MAX', () => {
  let r = F.add([], { call: 'ky4ry', mode: 'ardop', dialKhz: 7100.5 }, 1000);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.list[0], { call: 'KY4RY', mode: 'ardop', khz: 7100.5, dialKhz: 7100.5, url: '', band: '40m', savedAt: 1000, lastGoodAt: 0 });
  r = F.add(r.list, { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }, 2000);
  assert.strictEqual(r.list.length, 1, 'saving twice keeps one');
  assert.strictEqual(r.list[0].savedAt, 1000, 'and keeps when it was first saved');
  r = F.add(r.list, { call: 'W4RJG', mode: 'ardop', khz: 7100.4 }, 3000);
  assert.deepStrictEqual(r.list.map((g) => g.call), ['W4RJG', 'KY4RY']);
  assert.ok(F.has(r.list, { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }));
  assert.ok(!F.has(r.list, { call: 'KY4RY', mode: 'vara', khz: 7100.5 }), 'another mode is another entry');
  assert.deepStrictEqual(F.remove(r.list, { call: 'W4RJG', mode: 'ardop', khz: 7100.4 }).map((g) => g.call), ['KY4RY']);
  let many = [];
  for (let i = 0; i < F.MAX + 5; i++) many = F.add(many, { call: 'K' + (100 + i) + 'AB', mode: 'ardop', khz: 7100 + i / 10 }).list;
  assert.strictEqual(many.length, F.MAX);
});

test("a saved or History gateway keeps Winlink's URL, so it is called at the bandwidth it offers", () => {
  // Without it Pat falls back to ARDOP 500 Hz, a quarter of the speed (ECHOCAT, 2026-11-11).
  const g = H.gateways(H.parseEvents(EV))[0];
  assert.strictEqual(g.url, 'ardop:///KY4RY?bw=2000MAX&freq=7100.5');
  const r = F.add([], { call: 'KY4RY', mode: 'ardop', dialKhz: 7100.5, url: g.url });
  assert.strictEqual(r.list[0].url, 'ardop:///KY4RY?bw=2000MAX&freq=7100.5');
  assert.strictEqual(F.add([], { call: 'KY4RY', mode: 'ardop', khz: 7100.5, url: 'ardop:///W4RJG?bw=2000MAX' }).list[0].url, '', "another station's URL is dropped");
  assert.strictEqual(F.add([], { call: 'KY4RY', mode: 'ardop', khz: 7100.5, url: 'telnet://K3SBP:pw@cms.winlink.org:8772/wl2k' }).list[0].url, '', 'never a host part or credentials');
  assert.strictEqual(F.add(r.list, { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }).list[0].url, g.url, 'saving again without one keeps it');
});

test('My gateways refuses what cannot be called', () => {
  assert.ok(!F.add([], { call: '', mode: 'ardop', khz: 7100 }).ok);
  assert.ok(!F.add([], { call: 'KY4RY', mode: 'telnet', khz: 7100 }).ok);
  assert.ok(!F.add([], { call: 'KY4RY', mode: 'ardop', khz: 0 }).ok);
  assert.deepStrictEqual(F.normalize([null, 5, { call: 'x' }, { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }]).map((g) => g.call), ['KY4RY']);
});

test('a good session with a saved gateway records when, without reordering', () => {
  const list = F.add(F.add([], { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }).list, { call: 'W4RJG', mode: 'ardop', khz: 7100.4 }).list;
  const r = F.markGood(list, { call: 'KY4RY', mode: 'ardop', khz: 7100.5 }, 5000);
  assert.ok(r.changed);
  assert.deepStrictEqual(r.list.map((g) => g.call), ['W4RJG', 'KY4RY']);
  assert.strictEqual(r.list[1].lastGoodAt, 5000);
  assert.ok(!F.markGood(list, { call: 'N0NE', mode: 'ardop', khz: 7000 }).changed);
});

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const html = readSrc(path.join(root, 'renderer', 'winlink-popout.html'));
const js = readSrc(path.join(root, 'renderer', 'winlink-popout.js'));

test('a good radio session ends with a result the card offers to save; a saved gateway records it', () => {
  const i = main.indexOf('function winlinkEndSession(');
  const end = main.slice(i, main.indexOf('\nfunction ', i + 10));
  assert.ok(/if \(state === 'done' && radio && s\.gateway && s\.dialKhz\)/.test(end));
  assert.ok(/WinlinkFav\.markGood\(settings\.winlinkFavourites, g\)/.test(end));
  assert.ok(/prompt: null, result \}\);/.test(end), 'every end sets result (null for a failure)');
  assert.ok(/url: radio \? url : ''/.test(main) && /url: s\.url \|\| ''/.test(main), 'the session keeps the URL it dialled and the card offers it');

  assert.ok(/id="wl-done-save"[^>]*>[\s\S]*Add to favorites<\/button>/.test(html));
  assert.ok(/window\.api\.favourite\('add', \{ call: r\.call, mode: r\.mode, dialKhz: r\.dialKhz, url: r\.url \}\)/.test(js));
});

test('My gateways and history reach every surface the same way', () => {
  assert.ok(/favourites: WinlinkFav\.normalize\(settings\.winlinkFavourites\)/.test(main), 'the list rides winlink-state');
  assert.ok(/case 'winlink-history-get':/.test(main) && /case 'winlink-favourite':/.test(main));
  const proto = readSrc(path.join(root, 'lib', 'echocat-protocol.js'));
  assert.ok(/'winlink-history-get': \{ dir: Dir\.C2S/.test(proto) && /'winlink-history': \{ dir: Dir\.S2C/.test(proto) && /'winlink-favourite': \{ dir: Dir\.C2S/.test(proto));
  assert.ok(/leftOut: f\.optNumber/.test(proto));
  const rs = readSrc(path.join(root, 'lib', 'remote-server.js'));
  assert.ok(/case 'winlink-history-get':\n\s*case 'winlink-favourite':/.test(rs.replace(/\r\n/g, '\n')), 'routed with the other Winlink requests (a Guest Pass is refused there)');
  const gp = readSrc(path.join(root, 'lib', 'guest-pass-authority.js'));
  assert.ok(/'winlink-history-get', 'winlink-favourite'/.test(gp));
});

test('the mail window: History above Settings, the dial beside the gateway, buttons that fit', () => {
  assert.ok(html.indexOf('id="wl-history-btn"') > 0 && html.indexOf('id="wl-history-btn"') < html.indexOf('id="wl-settings"'));
  assert.ok(/id="wl-dial"/.test(html) && /id="wl-retune"/.test(html));
  assert.ok(/winlinkPopoutWin\.webContents\.send\('cat-frequency', hz\)/.test(main), 'the dial is the radio\'s own reading');
  assert.ok(/\.wl-folders \{ width: 150px/.test(html) && /\.wl-folders \.wl-btn \{ box-sizing: border-box; width: calc\(100% - 20px\)/.test(html), 'Position report fits its column');
  assert.ok(!/id="wl-gw-note"[^>]*>[^<]+</.test(html));
  assert.ok(/id="wl-forward">Forward/.test(js) && !/id=\\?"wl-fwd\\?">Forward/.test(js), 'Forward no longer shares the PWR meter\'s id');
});

test('theme colours only in the new styles', () => {
  const rules = html.match(/\.(wl-favs?|wl-fav-[a-z]+|wl-star|wl-done-[a-z]+|wl-hist-[a-z]+|wl-history|wl-pill|wl-dial[a-z-]*|wl-predict[a-z-]*|wl-field)[^{]*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 20, 'rules found: ' + rules.length);
  for (const r of rules) {
    const bare = r.replace(/var\([^)]*\)/g, '').replace(/rgba\(0,0,0,0\.35\)/g, '');
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(bare), 'a colour outside a theme token: ' + r.slice(0, 80));
  }
});

// Casey 2026-11-11, second pass: favorites live in the gateway list, a
// Templates button replaces the column of buttons, frequencies use dots.
const T = require('../lib/winlink-templates');

test('favorites: starred in the gateway list in its ranking, a star beside it, no strip', () => {
  assert.ok(!/id="wl-favs"/.test(html) && !/function renderFavs\(/.test(js), 'the My gateways strip is gone');
  assert.ok(/id="wl-fav"[^>]*aria-pressed="false"/.test(html), 'the star beside the gateway list');
  assert.ok(/window\.api\.favourite\(isFav\(g, m\) \? 'remove' : 'add', \{ call: g\.call, mode: m, dialKhz: g\.dialKhz, url: g\.url \|\| '' \}\)/.test(js));
  assert.ok(/var parts = \[\(isFav\(g\) \? '\\u2605 ' : ''\) \+ g\.call\];/.test(js), 'a favorite is starred where Pat ranked it');
  assert.ok(/'<optgroup label="Favorites not in this list">'/.test(js), 'a favorite Pat did not list is still there');
  assert.ok(/if \(sig === favSig\) \{ renderFavBtn\(\); return; \}/.test(js), 'the list is rebuilt only when the favorites change, not on every push');
});

test('frequencies the way the VFO writes them: dots, never a comma', () => {
  const i = js.indexOf('function fmtDial(khz)');
  const body = js.slice(i, js.indexOf('\n  }\n', i) + 4);
  const fmtDial = new Function(body + '; return fmtDial;')();
  assert.strictEqual(fmtDial(7100.5), '7.100.50');
  assert.strictEqual(fmtDial(14105), '14.105.00');
  assert.strictEqual(fmtDial(149090), '149.090.00');
  assert.strictEqual(fmtDial(0), '');
  assert.ok(!/toLocaleString\('en-US'/.test(js), 'no grouping commas in the mail window');
  assert.ok(/<span class="wl-dial-unit">MHz<\/span>/.test(html));
});

test('Templates: one button, built-ins and the operator\'s own, Add new template', () => {
  assert.ok(/id="wl-tpl-btn"[^>]*>Templates<\/button>/.test(html));
  assert.ok(!/id="wl-pos"/.test(html) && !/id="wl-pota-spot"/.test(html), 'Position report and POTA spot moved into it');
  assert.ok(/data-tpl="pos"/.test(js) && /data-tpl="pota"/.test(js) && /\+ Add new template/.test(js));
  assert.ok(/id="wl-c-save-tpl"[^>]*>Save as template<\/button>/.test(html), 'a message being written can become one');
  assert.ok(/templates: WinlinkTemplates\.normalize\(settings\.winlinkTemplates\)/.test(main) && /case 'winlink-template':/.test(main));
  const gp = readSrc(path.join(root, 'lib', 'guest-pass-authority.js'));
  assert.ok(/'winlink-template'/.test(gp), 'refused for a Guest Pass');
});

test('working radio sound says nothing; only a device to choose or a fault is said', () => {
  assert.ok(!/Radio sound: via POTACAT/.test(js), 'the "via POTACAT" line is gone (Casey 2026-11-11)');
  assert.ok(/Radio sound not set · <a id="wl-sound-change">Choose<\/a>/.test(js) && /b\.state === 'error'/.test(js), 'the actionable cases stay');
});

test('compose reads like a mail program: rows of its own, the actions in one bar (Casey 2026-11-11)', () => {
  assert.ok(/\.wl-connbar \.wl-field \{ display: flex; flex-direction: column;/.test(html), 'the top bar\'s column rule never reaches the compose rows');
  assert.ok(!/^\s*\.wl-field \{/m.test(html), 'no bare .wl-field rule');
  assert.ok(/<div class="wl-c-row"><label for="wl-c-to-in">To<\/label>/.test(html) && /\.wl-c-row label \{ flex: 0 0 \d+px; text-align: left;/.test(html));
  // Each field is a box you can see is a field (Casey 2026-11-11, She's On Frequency).
  assert.ok(/\.wl-compose \.wl-c-row input \{[^}]*border: 1px solid var\(--border-primary\);[^}]*background: var\(--bg-primary\)/.test(html));
  assert.ok(/<div class="wl-c-head">/.test(html) && /\.wl-c-head \{ background: var\(--bg-secondary\)/.test(html));
  const bar = (html.match(/<div class="wl-c-actions">[\s\S]*?<\/div>/) || [''])[0];
  assert.ok(/id="wl-c-attach"/.test(bar) && /id="wl-c-cancel"/.test(bar) && /id="wl-c-send"/.test(bar), 'Attach, Cancel and Put in Outbox on one row');
});

test('template instructions sit in their own panel, never inside the message body', () => {
  assert.ok(/<div class="wl-c-hint" id="wl-c-hint" role="note" hidden><\/div>/.test(html));
  assert.ok(/\$\('wl-c-hint'\)\.textContent = pre\.note \|\| '';/.test(js) && /\$\('wl-c-err'\)\.textContent = '';/.test(js));
  // The POTA spot itself is now a form (test/winlink-contacts-test.js); the hint panel serves any other template note.
  assert.ok(/function composeSpot\(t\) \{\s*if \(!t \|\| !t\.to\) return;\s*openSpotForm\(t\);/.test(js));
});

test('the prediction progress sits right of Abort and never adds a row', () => {
  const abortAt = html.indexOf('id="wl-abort"');
  const predictAt = html.indexOf('id="wl-predict"');
  assert.ok(abortAt > 0 && predictAt > abortAt, 'after the Abort button in the bar');
  assert.ok(/\.wl-predict \{[^}]*flex: 1 1 \d+px; min-width: \d+px; max-width: \d+px;/.test(html), 'starts small so the bar never wraps for it');
});

test('a POTA spot from the mail window uses where the radio was before Winlink moved it', () => {
  const i = main.indexOf('function winlinkPotaSpotTemplate(');
  const fn = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/const before = _winlinkPreviewReturnTo \|\| \(winlinkState\.session && winlinkState\.session\.returnTo\)/.test(fn));
  assert.ok(/away \? before\.freqHz \/ 1000/.test(fn), 'never the Winlink gateway\'s dial');
});

test('a short window never pushes the folder buttons over the waterfall', () => {
  assert.ok(/\.wl-folders \{[^}]*min-height: 0; overflow-y: auto; \}/.test(html));
});

test('templates: a name, unique, edited in place, at most MAX', () => {
  let r = T.save([], { name: 'Net check-in', to: 'w1aw', subject: 'Check-in', body: 'K3SBP FN20' });
  assert.ok(r.ok && r.id);
  assert.deepStrictEqual(r.list.map((t) => t.name), ['Net check-in']);
  assert.ok(!T.save(r.list, { name: 'net CHECK-IN' }).ok, 'names are unique, case aside');
  const id = r.id;
  r = T.save(r.list, { id, name: 'Net check-in', subject: 'Check-in 2' });
  assert.strictEqual(r.list.length, 1);
  assert.strictEqual(r.list[0].subject, 'Check-in 2', 'the same id edits it in place');
  assert.ok(!T.save(r.list, { name: '  ' }).ok, 'a name is needed');
  assert.deepStrictEqual(T.remove(r.list, id), []);
  let many = [];
  for (let i = 0; i < T.MAX + 3; i++) { const s = T.save(many, { name: 'T' + i }); if (s.ok) many = s.list; }
  assert.strictEqual(many.length, T.MAX);
  assert.strictEqual(T.clean({ name: 'x', subject: 'y'.repeat(500) }).subject.length, T.LIMITS.subject);
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/winlink-history-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
