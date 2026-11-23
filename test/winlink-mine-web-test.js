#!/usr/bin/env node
'use strict';
/**
 * #585 phase 4: My own gateways in ECHOCAT Web, the shack's `winlink-mine`
 * capability, and the rules around them (plan docs/winlink-custom-gateways-plan.md 3.5, 3.6).
 *
 *   web       the web Mail tab draws "My own gateways" (tag Mine) above Pat's
 *             rows; Add a gateway, Edit and Remove with the desktop's fields,
 *             labels, dial line and error words; Save goes over winlink-favourite
 *   fallback  the shack's hello lists winlink-mine; without it the Add form (web
 *             and the desktop window driving a shack) says the shack needs an update
 *   main      the typed-gateway rule (no band checks) is read from the saved
 *             entry, never from a request; the shack checks a Mine entry itself
 *   guest     a Guest Pass cannot add, change or remove the owner's gateways
 *   registry  the protocol rows and the doc
 *   server    remote-server passes only the declared fields (127.0.0.1 harness)
 *
 * Run: node test/winlink-mine-web-test.js
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { loadMail, state, REMOTE, HTML } = require('./_web-mail-harness');
const Mine = require('../lib/winlink-my-gateways');
const WinlinkFav = require('../lib/winlink-favourites');
const RemoteShack = require('../lib/winlink-remote-shack');
const RemoteBridge = require('../lib/remote-bridge');
const protocol = require('../lib/echocat-protocol');
const Authority = require('../lib/guest-pass-authority');
const { RemoteServer } = require('../lib/remote-server');

const ROOT = path.join(__dirname, '..');
const SERVER = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
const MAIN = readSrc(path.join(ROOT, 'main.js'));
const POP_JS = readSrc(path.join(ROOT, 'renderer', 'winlink-popout.js'));
const POP_HTML = readSrc(path.join(ROOT, 'renderer', 'winlink-popout.html'));
const CSS = readSrc(path.join(ROOT, 'renderer', 'remote.css'));
const DOC = readSrc(path.join(ROOT, 'docs', 'echocat-protocol.md'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const open = src.indexOf(') {', i) + 2;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

const CAPS = ['winlink', 'winlink-mine'];
const MODES = [
  { id: 'telnet', label: 'Internet (telnet)', available: true, reason: '' },
  { id: 'ardop', label: 'ARDOP (radio)', available: true, reason: '' },
  { id: 'packet', label: 'Packet (VHF/UHF radio)', available: true, reason: '' },
  { id: 'vara', label: 'VARA HF (radio)', available: false, reason: 'VARA is not set up' },
];
const K4SPB = { call: 'K4SPB', mode: 'ardop', khz: 7099.9, dialKhz: 7099.9, url: '', band: '40m', savedAt: 2, lastGoodAt: 0, mine: true, note: 'club net Tuesdays', bw: 500 };
const W2XYZ = { call: 'W2XYZ-10', mode: 'packet', khz: 145050, dialKhz: 145050, url: '', band: '2m', savedAt: 3, lastGoodAt: 0, mine: true, via: ['W2ABC-1'] };
const STARRED = { call: 'W4EDX-10', mode: 'ardop', khz: 7101.2, dialKhz: 7101.2, url: 'ardop:///W4EDX-10?freq=7101.2', band: '40m', savedAt: 1, lastGoodAt: 0 };
const GATEWAYS = [
  { call: 'KY4RY', dialKhz: 7103.5, url: 'ardop:///KY4RY?freq=7103.5', qualityWord: 'Good', quality: 80, distKm: 412 },
  { call: 'W4EDX-10', dialKhz: 7101.2, url: 'ardop:///W4EDX-10?freq=7101.2', qualityWord: 'Fair', quality: 44, distKm: 588 },
];
const st = (over) => state(Object.assign({ modes: MODES, favourites: [K4SPB, W2XYZ, STARRED] }, over || {}));

/** The Mail tab on Send / Receive in ARDOP with Pat's list in; the shack has `caps`. */
function openArdop(over, caps, list) {
  const p = loadMail();
  p.ws._serverCapabilities = caps === undefined ? CAPS : caps;
  p.mailOnMessage(st(over));
  p.mailOnOpen();
  p.$('mail-open-connect').click();
  const seg = p.$('mail-mode').querySelector('[data-mode="ardop"]');
  if (seg.getAttribute('aria-pressed') !== 'true') seg.click();
  const ask = p.sent.filter((m) => m.type === 'winlink-gateways-get').pop();
  p.mailOnMessage({ type: 'winlink-gateways', mode: 'ardop', band: '', list: list || GATEWAYS, predicted: true, note: '', leftOut: 0, reqId: ask.reqId });
  p.take();
  return p;
}
const cards = (p) => p.$('mail-gateway').children;
const card = (p, call) => p.$('mail-gateway').querySelectorAll('.mail-gw').find((b) => b.querySelector('.mail-row-who').textContent === call);
const texts = (els) => els.map((e) => e.textContent);
function fill(p, f) {
  for (const k of Object.keys(f)) {
    const el = p.$('mail-add-' + k);
    el.value = f[k];
    el.dispatch(k === 'mode' || k === 'bw' ? 'change' : 'input');
  }
}
const errs = (p) => ['call', 'mode', 'freq', 'bw', 'via', 'note'].reduce((o, k) => { const t = p.$('mail-add-' + k + '-err').textContent; if (t) o[k] = t; return o; }, {});

console.log('#585 phase 4: My own gateways in ECHOCAT Web, the winlink-mine capability');

// ── web: the module reaches the page ───────────────────────────────────────
test('web: lib/winlink-my-gateways.js is inlined into the page, after lib/freq-dots.js', () => {
  assert.ok(/<!-- winlink-my-gateways-js -->/.test(HTML));
  assert.ok(HTML.indexOf('<!-- freq-dots-js -->') < HTML.indexOf('<!-- winlink-my-gateways-js -->'));
  assert.ok(/\['winlink-my-gateways-js', 'winlink-my-gateways\.js'\]/.test(SERVER));
  assert.ok(/var Mine = window\.WinlinkMine;/.test(REMOTE));
});

// ── web: the list ───────────────────────────────────────────────────────────
test('web: "My own gateways" first, each row tagged Mine with its dial and note; then Pat\'s rows; the best path stays picked', () => {
  const p = openArdop();
  const kids = cards(p);
  assert.strictEqual(kids[0].textContent, 'My own gateways');
  assert.ok(kids[0].classList.contains('mail-gw-group'));
  const k = card(p, 'K4SPB');
  assert.deepStrictEqual(texts(k.querySelectorAll('.mail-row-who,.mail-row-line,.mail-tag')), ['K4SPB', '7.099.90 MHz · club net Tuesdays', 'Mine']);
  assert.ok(k.querySelector('.mail-tag').classList.contains('mail-tag-mine'));
  assert.ok(!card(p, 'W2XYZ-10'), 'a packet Mine entry is not in the ARDOP list');
  assert.deepStrictEqual(p.$('mail-gateway').querySelectorAll('.mail-gw').map((b) => b.querySelector('.mail-row-who').textContent), ['K4SPB', 'KY4RY', 'W4EDX-10']);
  assert.ok(!card(p, 'W4EDX-10').querySelector('.mail-tag-mine'), 'a starred gateway is not Mine');
  assert.strictEqual(card(p, 'KY4RY').getAttribute('aria-pressed'), 'true', 'Pat\'s best path is picked, not a Mine row');
  assert.strictEqual(p.$('mail-connect').textContent, 'Connect to KY4RY');
});

test('web: a Mine entry Pat also lists shows once, in the Mine group; the band chips filter Mine rows too', () => {
  const p = openArdop(null, CAPS, GATEWAYS.concat([{ call: 'K4SPB', dialKhz: 7099.9, url: 'ardop:///K4SPB?freq=7099.9' }]));
  assert.strictEqual(p.$('mail-gateway').querySelectorAll('.mail-gw').filter((b) => b.querySelector('.mail-row-who').textContent === 'K4SPB').length, 1);
  assert.ok(card(p, 'K4SPB').querySelector('.mail-tag-mine'));
  p.$('mail-band').querySelector('[data-band="80m"]').click();
  const ask = p.sent.filter((m) => m.type === 'winlink-gateways-get').pop();
  p.mailOnMessage({ type: 'winlink-gateways', mode: 'ardop', band: '80m', list: [{ call: 'N4AAA', dialKhz: 3590, url: 'ardop:///N4AAA?freq=3590' }], predicted: true, reqId: ask.reqId });
  assert.ok(!card(p, 'K4SPB'), 'a 40 m Mine entry is not under 80 m');
});

test('web: Mine rows show even when Pat lists nothing on the band', () => {
  const p = openArdop(null, CAPS, []);
  assert.strictEqual(cards(p)[0].textContent, 'My own gateways');
  assert.ok(card(p, 'K4SPB'));
  assert.strictEqual(card(p, 'K4SPB').getAttribute('aria-pressed'), 'true', 'with no Pat row the Mine row is the pick');
});

test('web: a Mine row tunes with its call (the shack reads the typed rule from its own list); Connect sends no url', () => {
  const p = openArdop();
  assert.ok(p.$('mail-mine-edit').hidden && p.$('mail-mine-remove').hidden, 'Edit and Remove only for a Mine row');
  card(p, 'K4SPB').click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-qsy', dialKhz: 7099.9, mode: 'ardop', gateway: 'K4SPB' }]);
  assert.ok(!p.$('mail-mine-edit').hidden && !p.$('mail-mine-remove').hidden);
  p.mailOnMessage({ type: 'winlink-result', op: 'qsy', ok: true });
  p.$('mail-connect').click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-connect', mode: 'ardop', gateway: 'K4SPB', dialKhz: 7099.9 }]);
  card(p, 'KY4RY').click();
  assert.ok(p.$('mail-mine-edit').hidden, 'a listed row has no Edit');
});

// ── web: the form ───────────────────────────────────────────────────────────
test('web: Add a gateway opens the desktop\'s fields; Mode lists the radio modes available now', () => {
  const p = openArdop();
  assert.strictEqual(p.$('mail-gw-add').textContent, 'Add a gateway');
  assert.ok(p.$('mail-add-card').hidden);
  p.$('mail-gw-add').click();
  assert.ok(!p.$('mail-add-card').hidden);
  assert.strictEqual(p.$('mail-add-title').textContent, 'Add a gateway');
  assert.deepStrictEqual(p.$('mail-add-mode').children.map((o) => o.value + ':' + o.textContent), ['ardop:ARDOP', 'packet:Packet']);
  assert.strictEqual(p.$('mail-add-mode').value, 'ardop', 'the mode in use');
  assert.strictEqual(p.$('mail-add-freq-label').textContent, 'Center frequency');
  assert.ok(!p.$('mail-add-bw-row').hidden && p.$('mail-add-via-row').hidden);
  assert.ok(p.$('mail-add-older').hidden, 'a current shack: no update line');
  fill(p, { freq: '7101.4' });
  assert.strictEqual(p.$('mail-add-dial').textContent, 'The radio dial will be 7.099.90 MHz, 1.5 kHz below the center frequency.');
  fill(p, { mode: 'packet', freq: '145.05' });
  assert.strictEqual(p.$('mail-add-freq-label').textContent, 'Channel frequency');
  assert.ok(p.$('mail-add-bw-row').hidden && !p.$('mail-add-via-row').hidden);
  assert.strictEqual(p.$('mail-add-dial').textContent, 'The radio dial will be 145.050.00 MHz.');
  p.$('mail-add-cancel').click();
  assert.ok(p.$('mail-add-card').hidden);
  assert.deepStrictEqual(p.take(), [], 'opening, typing and Cancel send nothing');
});

test('web: the labels, hints and buttons are the desktop window\'s words', () => {
  const lab = (src, id) => { const m = new RegExp('<label[^>]*for="' + id + '"[^>]*>([^<]*)<').exec(src); return m && m[1]; };
  const want = { 'mail-add-call': 'Call', 'mail-add-mode': 'Mode', 'mail-add-freq': 'Center frequency', 'mail-add-bw': 'ARDOP bandwidth', 'mail-add-via': 'Via (optional)', 'mail-add-note': 'Note (optional)' };
  for (const id of Object.keys(want)) {
    const got = id === 'mail-add-freq' ? (/id="mail-add-freq-label"[^>]*>([^<]*)</.exec(HTML) || [])[1] : lab(HTML, id);
    assert.strictEqual(got, want[id], id);
    assert.ok(POP_HTML.includes('>' + want[id] + '<'), 'the desktop says ' + want[id]);
  }
  for (const words of ['My own setting', 'The widest this gateway takes. POTACAT never goes wider than your own setting.', 'Up to two digipeaters, in order.', '>Save<', '>Cancel<', '>Add a gateway<', '>Edit<', '>Remove<', 'placeholder="W2XYZ-10"', 'placeholder="club net Tuesdays"', 'maxlength="60"']) {
    assert.ok(HTML.includes(words), 'web: ' + words);
    assert.ok(POP_HTML.includes(words), 'desktop: ' + words);
  }
  for (const bw of ['200', '500', '1000', '2000']) assert.ok(HTML.includes('<option value="' + bw + '">' + bw + ' Hz</option>'));
});

test('web: the error words are the desktop\'s, under their fields; nothing is sent', () => {
  const p = openArdop();
  p.$('mail-gw-add').click();
  p.$('mail-add-save').click();
  assert.deepStrictEqual(errs(p), { call: Mine.TEXT.call, freq: Mine.TEXT.freq });
  assert.strictEqual(Mine.TEXT.call, "That is not a callsign. Use the gateway's call, with -10 or similar if it has one.");
  fill(p, { call: 'w2xyz-10', mode: 'packet', freq: '145.05', via: 'W2ABC-1 W2ABC-2 W2ABC-3', note: 'x'.repeat(61) });
  p.$('mail-add-save').click();
  assert.deepStrictEqual(errs(p), { via: 'Via takes up to two digipeater calls, for example W2ABC-1.', note: 'Keep the note to 60 characters or fewer.' });
  assert.deepStrictEqual(p.take(), []);
});

test('web: Save sends winlink-favourite with the fields; it tunes only once the shack has saved it', () => {
  const p = openArdop();
  p.$('mail-gw-add').click();
  fill(p, { call: 'k4spb', freq: '7101.4', bw: '500', note: 'club net Tuesdays' });
  p.$('mail-add-save').click();
  const out = p.take();
  assert.strictEqual(out.length, 1);
  assert.ok(/^fav\d+$/.test(out[0].reqId));
  const { reqId, ...msg } = out[0];
  assert.deepStrictEqual(msg, { type: 'winlink-favourite', op: 'add', call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, mine: true, note: 'club net Tuesdays', bw: 500 });
  assert.ok(protocol.validate(out[0], protocol.Dir.C2S).ok, 'the registry accepts it');
  assert.ok(p.$('mail-add-save').disabled, 'one Save at a time');
  p.mailOnMessage({ type: 'winlink-result', op: 'favourite', ok: true, reqId });
  assert.ok(p.$('mail-add-card').hidden, 'the form closes');
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-qsy', dialKhz: 7099.9, mode: 'ardop', gateway: 'K4SPB' }], 'picked and tuned, as a favourite pick');
  p.mailOnMessage(st());
  assert.strictEqual(card(p, 'K4SPB').getAttribute('aria-pressed'), 'true', 'the saved gateway is the pick');
  assert.ok(!p.sent.some((m) => m.type === 'winlink-connect'), 'nothing transmits from the form');
});

test('web: a packet gateway sends its via path; a gateway in another mode switches the mode first', () => {
  const p = openArdop();
  p.$('mail-gw-add').click();
  fill(p, { call: 'N2AAA-10', mode: 'packet', freq: '145.07', via: 'w2abc-1, w2abc-2' });
  p.$('mail-add-save').click();
  const { reqId, ...msg } = p.take()[0];
  assert.deepStrictEqual(msg, { type: 'winlink-favourite', op: 'add', call: 'N2AAA-10', mode: 'packet', dialKhz: 145070, mine: true, via: ['W2ABC-1', 'W2ABC-2'] });
  p.mailOnMessage({ type: 'winlink-result', op: 'favourite', ok: true, reqId });
  const after = p.take();
  assert.ok(after.some((m) => m.type === 'winlink-set-mode' && m.mode === 'packet'));
  assert.ok(after.some((m) => m.type === 'winlink-qsy' && m.mode === 'packet' && m.dialKhz === 145070 && m.gateway === 'N2AAA-10'));
});

test('web: the shack\'s refusal shows in the form, which stays open; nothing tunes', () => {
  const p = openArdop();
  p.$('mail-gw-add').click();
  fill(p, { call: 'K4SPB', freq: '7101.4' });
  p.$('mail-add-save').click();
  const { reqId } = p.take()[0];
  p.mailOnMessage({ type: 'winlink-result', op: 'favourite', ok: false, error: Mine.TEXT.call, reqId });
  assert.ok(!p.$('mail-add-card').hidden);
  assert.strictEqual(p.$('mail-add-msg').textContent, Mine.TEXT.call);
  assert.ok(!p.$('mail-add-save').disabled);
  assert.deepStrictEqual(p.take(), []);
  assert.deepStrictEqual(p.toasts, [], 'said once, in the form');
});

test('web: Edit fills the form from the entry (the center, not the dial) and sends op edit with was', () => {
  const p = openArdop();
  card(p, 'K4SPB').click();
  p.take();
  p.$('mail-mine-edit').click();
  assert.strictEqual(p.$('mail-add-title').textContent, 'Change K4SPB');
  assert.deepStrictEqual(['call', 'mode', 'freq', 'bw', 'note'].map((k) => p.$('mail-add-' + k).value), ['K4SPB', 'ardop', '7101.4', '500', 'club net Tuesdays']);
  fill(p, { note: 'club net Thursdays' });
  p.$('mail-add-save').click();
  const { reqId, ...msg } = p.take()[0];
  assert.deepStrictEqual(msg, { type: 'winlink-favourite', op: 'edit', call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, mine: true, note: 'club net Thursdays', bw: 500, was: { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 } });
  assert.ok(reqId);
});

test('web: Remove asks once ("Remove K4SPB? Click again"), then sends op remove', () => {
  const p = openArdop();
  card(p, 'K4SPB').click();
  p.take();
  p.$('mail-mine-remove').click();
  assert.strictEqual(p.$('mail-mine-remove').textContent, 'Remove K4SPB? Click again');
  assert.ok(p.$('mail-mine-remove').classList.contains('mail-link-danger'));
  assert.deepStrictEqual(p.take(), []);
  p.$('mail-mine-remove').click();
  const { reqId, ...msg } = p.take()[0];
  assert.deepStrictEqual(msg, { type: 'winlink-favourite', op: 'remove', call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 });
  assert.ok(reqId);
  assert.strictEqual(p.$('mail-mine-remove').textContent, 'Remove');
  assert.ok(!p.$('mail-mine-remove').classList.contains('mail-link-danger'));
});

test('web: the Mail markup and rules stay inside the W0 contract', () => {
  const block = CSS.slice(CSS.indexOf('/* ── Mail tab (Winlink)')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/\.mail-link \{[^}]*min-height: 44px;/.test(block), 'links are 44 px tap targets');
  assert.ok(/\.mail-tag-mine \{[^}]*background: var\(--m-tint-subtle\);[^}]*color: var\(--m-tint\);/.test(block));
  assert.ok(/\.mail-add-err \{[^}]*font-size: 16px;/.test(block));
  const markup = HTML.slice(HTML.indexOf('id="mail-gw-links"'), HTML.indexOf('id="mail-connect-bar"'));
  assert.ok(markup.length > 500 && !/\sstyle="/.test(markup));
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(markup), 'no emoji');
});

// ── fallback: the capability ────────────────────────────────────────────────
test('fallback: the shack\'s hello lists winlink-mine', () => {
  const hello = SERVER.slice(SERVER.indexOf('protocol.buildServerHello({'), SERVER.indexOf('protocol.buildServerHello({') + 12000);
  assert.ok(/'winlink-mine',/.test(hello));
  assert.strictEqual(Mine.CAPABILITY, 'winlink-mine');
  assert.ok(Mine.shackHasMine(['winlink', 'winlink-mine']) && !Mine.shackHasMine(['winlink']) && !Mine.shackHasMine(undefined));
});

test('fallback: the page keeps the shack\'s hello capabilities', () => {
  const h = REMOTE.slice(REMOTE.indexOf("      case 'hello':"), REMOTE.indexOf("      case 'hello':") + 3000);
  assert.ok(/ws\._serverCapabilities = Array\.isArray\(msg\.capabilities\) \? msg\.capabilities : \[\];/.test(h));
  assert.ok(/Mine\.shackHasMine\(ws && ws\._serverCapabilities\)/.test(REMOTE), 'the Add form reads them');
});

test('fallback: web against an older shack: the Add form says so in one line, and still saves a plain favourite', () => {
  const p = openArdop(null, ['winlink']);
  p.$('mail-gw-add').click();
  assert.ok(!p.$('mail-add-older').hidden);
  assert.strictEqual(p.$('mail-add-older').textContent, Mine.OLDER_SHACK);
  assert.strictEqual(Mine.OLDER_SHACK, 'The shack is on an older POTACAT: it saves this as a plain favorite, without the Mine tag or the note. Update POTACAT on the shack to keep them.');
  fill(p, { call: 'K4SPB', freq: '7101.4', note: 'club' });
  p.$('mail-add-save').click();
  assert.strictEqual(p.take()[0].type, 'winlink-favourite', 'still sent: the older shack keeps call, mode and dial');
});

test('fallback: what an older shack does with the message: drops the new fields, saves a plain favourite', () => {
  const msg = Mine.favouriteMessage('add', { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, note: 'club', bw: 500 });
  const oldSpec = Object.keys(protocol.MESSAGES['winlink-favourite'].fields).filter((k) => !['mine', 'note', 'via', 'bw', 'was'].includes(k));
  const req = {};
  for (const k of oldSpec) if (k !== 'reqId' && msg[k] !== undefined) req[k] = msg[k];
  const r = WinlinkFav.add([], { call: req.call, mode: req.mode, khz: req.dialKhz });
  assert.ok(r.ok);
  assert.deepStrictEqual([r.list[0].call, r.list[0].khz, r.list[0].mine, r.list[0].note], ['K4SPB', 7099.9, undefined, undefined]);
});

test('fallback: the desktop window driving a shack is told when the shack lacks winlink-mine', () => {
  assert.strictEqual(RemoteShack.windowState({ type: 'winlink-state', enabled: true }, ['winlink']).shackLacksMine, true);
  assert.strictEqual(RemoteShack.windowState({ type: 'winlink-state', enabled: true }, CAPS).shackLacksMine, undefined);
  assert.strictEqual(RemoteShack.windowState({ type: 'winlink-state', enabled: true }).shackLacksMine, undefined, 'unknown caps: no claim');
  const out = RemoteBridge.IN['winlink-state']({ type: 'winlink-state', enabled: true }, { serverCaps: ['winlink'] });
  assert.strictEqual(out[0][1].shackLacksMine, true);
  assert.ok(/_remoteBridgeState\.serverCaps = /.test(fnBody(MAIN, 'bridgeInboundFromShack')), 'main hands the bridge the shack\'s hello capabilities');
  assert.ok(/id="wl-add-older"/.test(POP_HTML));
  assert.ok(/\$\('wl-add-older'\)\.textContent = state && state\.shackLacksMine \? WinlinkMine\.OLDER_SHACK : '';/.test(POP_JS));
});

// ── main: the typed rule comes from the shack's own list ───────────────────
test('main: a request\'s mine never reaches the reach rule; QSY and Connect look the gateway up in settings', () => {
  const h = fnBody(MAIN, 'winlinkHandleRemote');
  const qsy = h.slice(h.indexOf("case 'winlink-qsy':"), h.indexOf('return;', h.indexOf("case 'winlink-qsy':")));
  assert.ok(/winlinkPreviewQsy\(\{ dialKhz: req\.dialKhz, mode: req\.mode, gateway: req\.gateway \}\)/.test(qsy));
  const con = h.slice(h.indexOf("case 'winlink-connect':"), h.indexOf('return;', h.indexOf("case 'winlink-connect':")));
  assert.ok(!/mine/.test(qsy) && !/mine/.test(con), 'no mine from the request');
  assert.strictEqual((h.match(/req\.mine/g) || []).length, 0);
  assert.ok(/const mine = winlinkMineGateway\(/.test(fnBody(MAIN, 'winlinkPreviewQsy')));
  assert.ok(/WinlinkFav\.findMine\(settings\.winlinkFavourites/.test(fnBody(MAIN, 'winlinkMineGateway')));
});

test('main: the shack checks a Mine entry before saving it, with the form\'s words', () => {
  const b = fnBody(MAIN, 'winlinkFavourite');
  assert.ok(/if \(\(op === 'add' \|\| op === 'edit'\) && g\.mine\) \{\s*const chk = WinlinkMine\.checkSaved\(g\);\s*if \(!chk\.ok\) return \{ ok: false, error: chk\.error \};/.test(b));
  assert.ok(/const WinlinkMine = require\('\.\/lib\/winlink-my-gateways'\);/.test(MAIN));
  assert.deepStrictEqual(Mine.checkSaved({ call: 'K4SPB', mode: 'ardop', khz: 7099.9, note: 'club', bw: 500 }), { ok: true });
  assert.deepStrictEqual(Mine.checkSaved({ call: 'NOT A CALL', mode: 'ardop', khz: 7099.9 }), { ok: false, error: Mine.TEXT.call });
  assert.deepStrictEqual(Mine.checkSaved({ call: 'K4SPB', mode: 'pactor', khz: 7099.9 }), { ok: false, error: Mine.TEXT.mode });
  assert.deepStrictEqual(Mine.checkSaved({ call: 'K4SPB', mode: 'ardop', khz: 0 }), { ok: false, error: Mine.TEXT.freq });
  assert.deepStrictEqual(Mine.checkSaved({ call: 'K4SPB', mode: 'ardop', khz: 7099.9, note: 'x'.repeat(61) }), { ok: false, error: Mine.TEXT.note });
  assert.deepStrictEqual(Mine.checkSaved({ call: 'W2XYZ-10', mode: 'packet', khz: 145050, via: ['A', 'B', 'C'] }), { ok: false, error: Mine.TEXT.via });
  assert.deepStrictEqual(Mine.checkSaved({ call: 'K4SPB', mode: 'ardop', khz: 7099.9, bw: 300 }), { ok: false, error: Mine.TEXT.bw });
  assert.deepStrictEqual(Mine.checkSaved({ call: 'K4SPB', mode: 'ardop', khz: 432100 }), { ok: true }, 'no band check, ever');
});

// ── guest ───────────────────────────────────────────────────────────────────
test('guest: winlink-favourite is the owner\'s: outside the Guest Pass allowlist', () => {
  assert.ok(!Authority.GUEST_TYPES.has('winlink-favourite'));
  assert.ok(Authority.GUEST_REFUSED_INSIDE.has('winlink-favourite') || Authority.GUEST_DENIED_TYPES.has('winlink-favourite'));
});

function fakeWs(guest) {
  const ws = { readyState: 1, _authenticated: true, sent: [], _socket: { remoteAddress: '127.0.0.1' }, _clientId: 'c9', _clientCapabilities: [] };
  ws.send = (wire) => ws.sent.push(JSON.parse(wire));
  ws.close = () => { ws.readyState = 3; };
  if (guest) ws._passSession = { code: 'otter-newt-mosaic-rooster', sessionId: 'x'.repeat(64) };
  return ws;
}
function serverWith(ws) {
  const rs = new RemoteServer();
  rs._client = ws;
  rs._clients.add(ws);
  const got = [];
  rs.on('winlink-request', (e) => got.push(e));
  return { rs, got, send: (m) => rs._handleMessage(ws, m, {}) };
}

test('guest: a Guest Pass cannot add, change or remove the owner\'s gateways; main hears nothing', () => {
  const ws = fakeWs(true);
  const s = serverWith(ws);
  for (const op of ['add', 'edit', 'remove']) s.send(Object.assign(Mine.favouriteMessage(op, { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, note: 'x' }, { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 }), { reqId: 'g' + op }));
  assert.strictEqual(s.got.length, 0);
  assert.ok(ws.sent.length >= 3 && ws.sent.every((m) => /refused$/.test(m.type)), JSON.stringify(ws.sent));
});

// ── server: only the declared fields reach main ─────────────────────────────
test('server: an owner\'s winlink-favourite reaches main with the declared fields only, and its reply carries the reqId', () => {
  const ws = fakeWs(false);
  const s = serverWith(ws);
  s.send({ type: 'winlink-favourite', op: 'add', call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, mine: true, note: 'club', bw: 500, via: ['W2ABC-1'], typed: true, reach: 'any', reqId: 'r1' });
  assert.strictEqual(s.got.length, 1);
  assert.deepStrictEqual(s.got[0].req, { op: 'add', call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, mine: true, note: 'club', bw: 500, via: ['W2ABC-1'] });
  assert.strictEqual(s.got[0].clientId, 'c9');
  s.got[0].reply({ type: 'winlink-result', op: 'favourite', ok: true });
  assert.deepStrictEqual(ws.sent.pop(), { type: 'winlink-result', op: 'favourite', ok: true, reqId: 'r1' });
  s.send({ type: 'winlink-qsy', dialKhz: 432100, mode: 'ardop', gateway: 'K4SPB', mine: true, reqId: 'r2' });
  assert.deepStrictEqual(s.got[1].req, { dialKhz: 432100, mode: 'ardop', gateway: 'K4SPB' }, 'a qsy never carries mine to main');
});

// ── registry and doc ────────────────────────────────────────────────────────
test('registry: winlink-favourite rows; the handoff\'s examples validate', () => {
  const f = protocol.MESSAGES['winlink-favourite'].fields;
  for (const k of ['op', 'call', 'mode', 'dialKhz', 'url', 'mine', 'note', 'via', 'bw', 'was', 'reqId']) assert.ok(f[k], k);
  const ok = (m) => assert.ok(protocol.validate(m, protocol.Dir.C2S).ok, JSON.stringify(m));
  ok(Mine.favouriteMessage('add', { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, note: 'club net Tuesdays', bw: 500 }));
  ok(Mine.favouriteMessage('add', { call: 'W2XYZ-10', mode: 'packet', dialKhz: 145050, via: ['W2ABC-1'] }));
  ok(Mine.favouriteMessage('edit', { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 }, { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 }));
  ok(Mine.favouriteMessage('remove', { call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 }));
  assert.ok(!protocol.validate({ type: 'winlink-favourite', op: 'add', call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9, mine: 'yes' }, protocol.Dir.C2S).ok, 'mine is a boolean');
  assert.deepStrictEqual(Mine.favouriteMessage('remove', K4SPB), { type: 'winlink-favourite', op: 'remove', call: 'K4SPB', mode: 'ardop', dialKhz: 7099.9 });
  assert.ok(/capability 'winlink-mine'/.test(readSrc(path.join(ROOT, 'lib', 'echocat-protocol.js'))), 'the registry names the capability');
});

test('doc: the capability, the older-shack fallback and the web form are in docs/echocat-protocol.md', () => {
  assert.ok(/`winlink-mine`/.test(DOC));
  const sec = DOC.slice(DOC.indexOf('### My own gateways'));
  assert.ok(sec.length > 400, 'a My own gateways section');
  assert.ok(/plain favourite/.test(sec) && /`was`/.test(sec) && /40/.test(sec) && /60 characters/.test(sec));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
