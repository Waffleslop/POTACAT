#!/usr/bin/env node
'use strict';
/**
 * ECHOCAT Web's Mail tab (#425): web items W1, W2, W4 and the W0 layout.
 *
 *   W1  the radio goes back after a look at a gateway: leaving the tab, closing
 *       the page, or going back to the internet sends winlink-qsy-restore;
 *       never while a session runs, and not after one has run (the shack puts
 *       the radio back itself when a session ends)
 *   W2  a finished session leaves a card: "Mail exchanged with ..." or the
 *       not-finished card, whose Try again re-sends winlink-connect with the
 *       session's gateway, dial, mode and url
 *   W4  a mode not offered says why; the account card has Try again; a gateway
 *       list that did not load says so with Try again; prediction progress and
 *       the list's order note; Winlink off on the shack says where to turn it on
 *   W0  the layout: screens (list, read, compose, connect), folder segments
 *       with counts, message rows and gateway cards, band chips, the bottom
 *       bars; no inline style in the Mail markup and no colour literal in the
 *       Mail rules
 *
 * The Mail section of renderer/remote.js is run here as it is in the page,
 * against a stand-in document parsed from the Mail markup in remote.html, with
 * stand-in winlink-* messages. lib/winlink-mail-view.js, lib/freq-dots.js and
 * lib/rig-bands.js are the real modules.
 *
 * Run: node test/remote-web-mail-test.js
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const MailView = require('../lib/winlink-mail-view');
const FreqDots = require('../lib/freq-dots');
const RigBands = require('../lib/rig-bands');
const { RemoteServer } = require('../lib/remote-server');
const WinlinkOutcome = require('../lib/winlink-outcome');

const ROOT = path.join(__dirname, '..');
const REMOTE = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
const HTML = readSrc(path.join(ROOT, 'renderer', 'remote.html'));
const CSS = readSrc(path.join(ROOT, 'renderer', 'remote.css'));
const SERVER = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
const MAIL_HTML = HTML.slice(HTML.indexOf('    <div id="mail-view"'), HTML.indexOf('    <div id="bottom-bar">'));
const MAIL_CSS = CSS.slice(CSS.indexOf('/* ── Mail tab (Winlink)'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// ── a stand-in document: the Mail markup as a tree, just enough DOM ──────────
class El {
  constructor(tag, attrs) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parent = null;
    this._text = '';
    this._value = undefined;
    this.style = {};
    this._on = {};
    this.disabled = false;
    const self = this;
    this.classList = {
      add(...c) { const s = self._cls(); c.forEach((x) => s.add(x)); self._setCls(s); },
      remove(...c) { const s = self._cls(); c.forEach((x) => s.delete(x)); self._setCls(s); },
      contains(c) { return self._cls().has(c); },
      toggle(c, on) { const s = self._cls(); const want = on === undefined ? !s.has(c) : !!on; if (want) s.add(c); else s.delete(c); self._setCls(s); return want; },
    };
  }
  _cls() { return new Set(String(this.attrs.class || '').split(/\s+/).filter(Boolean)); }
  _setCls(s) { this.attrs.class = [...s].join(' '); }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = String(v); }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get type() { return this.attrs.type || ''; }
  set type(v) { this.attrs.type = String(v); }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v == null ? '' : v); }
  get innerHTML() { throw new Error('innerHTML is not used in the Mail tab'); }
  set innerHTML(v) { throw new Error('innerHTML is not used in the Mail tab'); }
  get value() { return this._value === undefined ? '' : this._value; }
  set value(v) { this._value = String(v); }
  get hidden() { for (let e = this; e; e = e.parent) if (e._cls().has('hidden')) return true; return false; }
  get firstChild() { return this.children[0] || null; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); }
  dispatch(type, ev) {
    const e = Object.assign({ target: this, type }, ev || {});
    if (typeof this['on' + type] === 'function') this['on' + type](e);
    (this._on[type] || []).forEach((fn) => fn(e));
    return e;
  }
  click() { const e = this.dispatch('click'); if (this.doc) this.doc.dispatch('click', { target: this }); return e; }
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
  matches(sel) {
    const m = /^([a-z0-9]*)((?:[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(sel.trim());
    if (!m) throw new Error('selector not supported here: ' + sel);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const part of m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || []) {
      if (part[0] === '.' && !this._cls().has(part.slice(1))) return false;
      if (part[0] === '#' && this.id !== part.slice(1)) return false;
      if (part[0] === '[') {
        const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        if (this.getAttribute(a[1]) === null) return false;
        if (a[2] !== undefined && this.getAttribute(a[1]) !== a[2]) return false;
      }
    }
    return true;
  }
  querySelectorAll(sel) { return this.all().filter((e) => sel.split(',').some((s) => e.matches(s))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches && e.matches(sel)) return e; return null; }
}

const VOID = new Set(['input', 'br', 'img', 'meta', 'hr']);
/** The Mail markup of remote.html as an element tree, plus the tab button. */
function buildDocument() {
  assert.ok(MAIL_HTML.length > 200, 'the Mail markup is in remote.html');
  const doc = new El('document');
  const root = new El('body');
  doc.appendChild(root);
  const stack = [root];
  const src = MAIL_HTML.replace(/<!--[\s\S]*?-->/g, '')
    + (/<button[^>]*id="mail-tab-btn"[^>]*>[\s\S]*?<\/button>/.exec(HTML) || [''])[0];
  const re = /<\/?([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) { if (m[4].trim()) { const t = new El('#text'); t._text = m[4].replace(/\s+/g, ' ').trim(); top.appendChild(t); } continue; }
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') { while (stack.length > 1 && stack.pop().tagName !== tag.toUpperCase()) { /* unwind */ } continue; }
    const attrs = {};
    for (const a of m[2].matchAll(/([\w-:]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    const el = new El(tag, attrs);
    el.doc = doc;
    top.appendChild(el);
    if (!(VOID.has(tag) || m[3] === '/')) stack.push(el);
  }
  doc.getElementById = (id) => root.all().find((e) => e.id === id) || null;
  // The page's switchTab shows #mail-view when the tab opens; here it is open.
  doc.getElementById('mail-view').classList.remove('hidden');
  doc.createElement = (tag) => { const el = new El(tag); el.doc = doc; return el; };
  doc.body = root;
  return doc;
}

/** The Mail section of remote.js, run as it is in the page. */
function loadMail(opts) {
  opts = opts || {};
  const a = REMOTE.indexOf('  // ── Winlink mail (the shack\'s Pat; owner only)');
  const b = REMOTE.indexOf('  // Auto-connect on page load (or bootstrap popout view)');
  assert.ok(a > 0 && b > a, 'the Mail section is found in remote.js');
  const section = REMOTE.slice(a, b);
  const doc = buildDocument();
  const sent = [];
  const toasts = [];
  const win = new El('window');
  win.WinlinkMailView = MailView;
  win.RigBands = RigBands;
  const ws = { readyState: 1, send: (w) => sent.push(JSON.parse(w)) };
  const clock = { now: Date.parse('2026-11-12T20:00:00Z') };
  const timers = [];
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const fn = new Function('window', 'document', 'ws', 'WebSocket', 'showToast', 'esc', 'FreqDots', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'webRigBands',
    section + '\n  return { mailOnMessage: mailOnMessage, mailOnLeave: mailOnLeave, mailOnOpen: mailOnOpen, mailRenderBands: mailRenderBands };');
  const api = fn(win, doc, ws, { OPEN: 1 }, (text) => toasts.push(text), (s) => String(s), FreqDots,
    () => 1, () => {},   // setTimeout: nothing in these tests waits for one to fire
    (f) => { timers.push(f); return timers.length; }, (id) => { if (id) timers[id - 1] = null; }, FakeDate, opts.rigBands || null);
  const $ = (id) => { const el = doc.getElementById(id); assert.ok(el, 'element #' + id + ' exists'); return el; };
  const screen = () => $('mail-view').getAttribute('data-screen');
  return Object.assign(api, { doc, $, sent, toasts, win, ws, clock, screen, tick: () => timers.forEach((f) => f && f()), take: () => sent.splice(0) });
}

const MODES = [
  { id: 'telnet', label: 'Internet (telnet)', available: true, reason: '' },
  { id: 'ardop', label: 'ARDOP (radio)', available: true, reason: '' },
  { id: 'packet', label: 'Packet (VHF/UHF radio)', available: true, reason: '' },
];
function state(over) {
  return Object.assign({ type: 'winlink-state', enabled: true, patReady: true, patStarted: true, hasPassword: true, noticeAccepted: true, mycall: 'K3SBP', mode: 'telnet', modes: MODES, session: { state: 'idle' }, predictionOn: true, predictMs: {} }, over || {});
}
const GATEWAYS = [
  { call: 'KY4RY', dialKhz: 7103.5, url: 'ardop:///KY4RY?freq=7103.5', qualityWord: 'Good', quality: 80, distKm: 412 },
  { call: 'W4EDX-10', dialKhz: 7101.2, url: 'ardop:///W4EDX-10?freq=7101.2', qualityWord: 'Fair', quality: 44, distKm: 588 },
];
const seg = (p, id) => p.$('mail-mode').querySelector('[data-mode="' + id + '"]');
const chip = (p, band) => p.$('mail-band').querySelector('[data-band="' + band + '"]');
const gwCard = (p, i) => p.$('mail-gateway').querySelector('[data-i="' + i + '"]');
function lastAsk(p) { return p.sent.filter((m) => m.type === 'winlink-gateways-get').pop(); }
/** Open the tab, then Send / Receive in ARDOP with the list loaded; returns the page. */
function openOnArdop(over) {
  const p = loadMail();
  p.mailOnMessage(state(over));
  p.mailOnOpen();
  p.$('mail-open-connect').click();
  if (p.$('mail-mode').querySelector('[aria-pressed="true"]').getAttribute('data-mode') !== 'ardop') seg(p, 'ardop').click();
  const ask = lastAsk(p);
  p.mailOnMessage({ type: 'winlink-gateways', mode: 'ardop', band: '', list: GATEWAYS, predicted: true, note: 'Best predicted path first, for right now', leftOut: 0, reqId: ask.reqId });
  p.take();
  return p;
}
/** Pick the second gateway; the shack answers that it tuned there. */
function pickGateway(p) {
  gwCard(p, 1).click();
  const q = p.take();
  assert.deepStrictEqual(q, [{ type: 'winlink-qsy', dialKhz: 7101.2, mode: 'ardop' }]);
  p.mailOnMessage({ type: 'winlink-result', op: 'qsy', ok: true });
}
const RESTORE = [{ type: 'winlink-qsy-restore' }];

console.log('ECHOCAT Web Mail tab: frequency restore, end cards, first-run texts, layout (W1, W2, W4, W0)');

// ── wiring: the page runs this section, and the module reaches the page ──────

test('the page hands every winlink-* message to the Mail section and tells it when the tab is left', () => {
  const sw = REMOTE.slice(REMOTE.indexOf("case 'winlink-state':"), REMOTE.indexOf("case 'rig-presets-refused':"));
  for (const t of ['winlink-state', 'winlink-account', 'winlink-mailbox', 'winlink-session', 'winlink-message', 'winlink-gateways', 'winlink-attachment', 'winlink-result', 'winlink-refused']) {
    assert.ok(sw.includes("case '" + t + "':"), t + ' is routed');
  }
  assert.ok(/mailOnMessage\(msg\);\s*break;/.test(sw));
  const st = REMOTE.slice(REMOTE.indexOf('function switchTab('), REMOTE.indexOf('activeTab = tab;', REMOTE.indexOf('function switchTab(')));
  assert.ok(/if \(activeTab === 'mail' && tab !== 'mail'\) mailOnLeave\(\);/.test(st), 'switchTab calls mailOnLeave before the tab changes');
});

test('lib/winlink-mail-view.js is inlined into the page', () => {
  assert.ok(/<!-- winlink-mail-view-js -->/.test(HTML));
  assert.ok(/\['winlink-mail-view-js', 'winlink-mail-view\.js'\]/.test(SERVER));
  assert.ok(/var MailView = window\.WinlinkMailView;/.test(REMOTE));
});

// ── W1: the radio goes back ──────────────────────────────────────────────────

test('W1: leaving the Mail tab after a gateway pick sends winlink-qsy-restore, once', () => {
  const p = openOnArdop();
  pickGateway(p);
  p.mailOnLeave();
  assert.deepStrictEqual(p.take(), RESTORE);
  p.mailOnLeave();
  p.win.dispatch('pagehide');
  assert.deepStrictEqual(p.take(), [], 'nothing more to put back');
});

test('W1: leaving without a pick sends nothing; a refused pick owes nothing', () => {
  const p = openOnArdop();
  p.mailOnLeave();
  assert.deepStrictEqual(p.take(), []);
  p.mailOnOpen(); p.take();
  gwCard(p, 1).click();
  p.take();
  p.mailOnMessage({ type: 'winlink-result', op: 'qsy', ok: false, error: 'The radio is in use by jtcat' });
  assert.deepStrictEqual(p.toasts, ['The radio is in use by jtcat']);
  p.mailOnLeave();
  assert.deepStrictEqual(p.take(), [], 'the shack never moved the radio');
});

test('W1: closing the page (pagehide, beforeunload) sends the restore', () => {
  for (const ev of ['pagehide', 'beforeunload']) {
    const p = openOnArdop();
    pickGateway(p);
    p.win.dispatch(ev);
    assert.deepStrictEqual(p.take(), RESTORE, ev);
  }
});

test('W1: going back to the internet without connecting sends the restore', () => {
  const p = openOnArdop();
  pickGateway(p);
  seg(p, 'telnet').click();
  const out = p.take();
  assert.ok(out.some((m) => m.type === 'winlink-qsy-restore'), JSON.stringify(out));
  assert.ok(p.$('mail-radio').hidden, 'the gateway picker is closed');
});

test('W1: no restore while a session runs, and none after it: the shack returns the radio itself', () => {
  for (const st of ['starting', 'connecting', 'connected', 'disconnecting']) {
    const p = openOnArdop();
    pickGateway(p);
    p.mailOnMessage({ type: 'winlink-session', session: { state: st, mode: 'ardop', gateway: 'W4EDX-10', dialKhz: 7101.2 } });
    p.mailOnLeave();
    assert.deepStrictEqual(p.take(), [], 'nothing sent while ' + st);
    p.mailOnMessage({ type: 'winlink-session', session: { state: 'error', mode: 'ardop', gateway: 'W4EDX-10', dialKhz: 7101.2, error: 'W4EDX-10 did not answer.' } });
    p.mailOnOpen(); p.take();
    p.mailOnLeave();
    p.win.dispatch('pagehide');
    assert.deepStrictEqual(p.take(), [], 'nothing sent after a session that started ' + st);
  }
});

test('W1: a session seen in winlink-state counts too', () => {
  const p = openOnArdop();
  pickGateway(p);
  p.mailOnMessage(state({ mode: 'ardop', session: { state: 'connected', mode: 'ardop', gateway: 'W4EDX-10' } }));
  p.mailOnLeave();
  assert.deepStrictEqual(p.take(), []);
});

test('W1: with the link down the restore is kept, and sent when the shack is back', () => {
  const p = openOnArdop();
  pickGateway(p);
  p.ws.readyState = 3;
  p.mailOnLeave();
  assert.deepStrictEqual(p.take(), []);
  p.ws.readyState = 1;
  p.mailOnMessage(state({ mode: 'ardop' }));
  assert.deepStrictEqual(p.take(), RESTORE);
});

test('W1: the rule itself (MailView.restoreOnLeave)', () => {
  assert.strictEqual(MailView.restoreOnLeave({ moved: false, session: { state: 'idle' } }), 'none');
  assert.strictEqual(MailView.restoreOnLeave({ moved: true, session: { state: 'idle' } }), 'send');
  assert.strictEqual(MailView.restoreOnLeave({ moved: true, session: { state: 'done' } }), 'send');
  assert.strictEqual(MailView.restoreOnLeave({ moved: true, session: null }), 'send');
  for (const st of MailView.ACTIVE) assert.strictEqual(MailView.restoreOnLeave({ moved: true, session: { state: st } }), 'drop');
});

// ── W2: the two cards ────────────────────────────────────────────────────────

const DROPPED = WinlinkOutcome.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, queued: 3, outbox: 2, received: 0 });
function endedSession(over) {
  return Object.assign({
    state: 'error', mode: 'ardop', gateway: 'KY4RY', dialKhz: 7103.5, url: 'ardop:///KY4RY?freq=7103.5', startedAt: 1700000000000,
    error: DROPPED.text, errorKind: DROPPED.errorKind,
    outcome: { kind: DROPPED.kind, word: DROPPED.word, title: DROPPED.title, detail: DROPPED.detail, next: DROPPED.next, retry: DROPPED.retry },
  }, over || {});
}
function cardTexts(p) {
  const box = p.$('mail-end-card');
  return { hidden: box.hidden, cls: box.className, rows: box.children.filter((c) => !/actions/.test(c.className)).map((c) => c.textContent), buttons: (box.children.find((c) => /actions/.test(c.className)) || { children: [] }).children.map((b) => b.textContent) };
}

test('W2: a link that dropped draws the not-finished card: label, the shack\'s sentences, Try again, OK', () => {
  const p = openOnArdop({ mode: 'ardop' });
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  const c = cardTexts(p);
  assert.strictEqual(c.hidden, false);
  assert.ok(/\bmail-end-ended\b/.test(c.cls));
  assert.deepStrictEqual(c.rows, [
    'Link dropped · KY4RY · ARDOP',
    'The link to KY4RY dropped before the mail exchange finished.',
    'So far: 1 sent, 0 received. 2 messages are still in your Outbox and will go on the next try.',
    'Try again, or try another gateway or another band.',
  ]);
  assert.deepStrictEqual(c.buttons, ['Try again', 'OK']);
  assert.ok(p.$('mail-session').hidden, 'the sentence is on the card, not also in a line');
  assert.ok(p.$('mail-connect-bar').hidden, 'one way to call again: the Try again on the card, no Connect bar under it');
  p.$('mail-end-ok').click();
  assert.strictEqual(p.$('mail-connect').hidden, false, 'OK brings Connect back');
  assert.ok(!/color = ss\.state === 'error' \? '#e94560'/.test(REMOTE), 'the red line is gone from the page');
});

test('W2: Try again re-sends winlink-connect with the session\'s gateway, dial, mode and url', () => {
  const p = openOnArdop({ mode: 'ardop' });
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  p.take();
  p.$('mail-end-retry').click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-connect', mode: 'ardop', gateway: 'KY4RY', url: 'ardop:///KY4RY?freq=7103.5', dialKhz: 7103.5 }]);
  assert.ok(p.$('mail-end-card').hidden, 'the card is put away');
});

test('W2: Try again asks for the notice first when it has not been accepted', () => {
  const p = openOnArdop({ mode: 'ardop', noticeAccepted: false, noticeText: 'The notice.' });
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  p.take();
  p.$('mail-end-retry').click();
  assert.deepStrictEqual(p.take(), [], 'nothing is sent before the notice');
  assert.strictEqual(p.$('mail-notice').hidden, false);
  assert.strictEqual(p.$('mail-notice-text').textContent, 'The notice.');
  p.$('mail-notice-ok').click();
  assert.deepStrictEqual(p.take().map((m) => m.type), ['winlink-accept-notice', 'winlink-connect']);
});

test('W2: OK puts the card away, the line then carries the sentence, and the same session does not bring it back', () => {
  const p = openOnArdop({ mode: 'ardop' });
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  p.$('mail-end-ok').click();
  assert.ok(p.$('mail-end-card').hidden);
  assert.strictEqual(p.$('mail-session').textContent, DROPPED.text);
  assert.ok(!p.$('mail-session').hidden);
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  assert.ok(p.$('mail-end-card').hidden, 'the second push of the same session');
  p.mailOnMessage({ type: 'winlink-session', session: endedSession({ startedAt: 1700000999000 }) });
  assert.strictEqual(p.$('mail-end-card').hidden, false, 'a new session ending shows its own card');
  assert.deepStrictEqual(p.take(), [], 'OK sends nothing');
});

test('W2: the second push of an ending (the Outbox read back) updates the words; a repeat does not rebuild the buttons', () => {
  const p = openOnArdop({ mode: 'ardop' });
  const first = endedSession({ outcome: Object.assign({}, endedSession().outcome, { detail: '' }) });
  p.mailOnMessage({ type: 'winlink-session', session: first });
  assert.strictEqual(cardTexts(p).rows.length, 3);
  const btn = p.$('mail-end-retry');
  p.mailOnMessage({ type: 'winlink-session', session: first });
  assert.strictEqual(p.$('mail-end-retry'), btn, 'the same button after a repeat');
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  assert.strictEqual(cardTexts(p).rows.length, 4);
});

test('W2: an ending with no sensible retry has OK only; an internet ending has no gateway in its label', () => {
  const stopped = WinlinkOutcome.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'operator' } });
  const p = openOnArdop({ mode: 'ardop' });
  p.mailOnMessage({ type: 'winlink-session', session: endedSession({ error: stopped.text, outcome: stopped }) });
  let c = cardTexts(p);
  assert.deepStrictEqual(c.rows, ['Stopped · KY4RY · ARDOP', 'You stopped the session.']);
  assert.deepStrictEqual(c.buttons, ['OK']);
  const net = WinlinkOutcome.describeOutcome({ state: 'error', mode: 'telnet', dialed: true, connected: false });
  p.mailOnMessage({ type: 'winlink-session', session: { state: 'error', mode: 'telnet', startedAt: 5, error: net.text, outcome: net } });
  c = cardTexts(p);
  assert.deepStrictEqual(c.rows, ['Not connected', 'Could not reach Winlink over the internet.', 'Check this computer\'s internet connection, then try again.']);
  assert.deepStrictEqual(c.buttons, ['OK']);
});

test('W2: a good radio session draws "Mail exchanged with ..." and what moved; OK only', () => {
  const p = openOnArdop({ mode: 'ardop' });
  const done = WinlinkOutcome.describeOutcome({ state: 'done', mode: 'ardop', gateway: 'KY4RY', sent: 1, received: 2 });
  p.mailOnMessage({ type: 'winlink-session', session: { state: 'done', mode: 'ardop', gateway: 'KY4RY', dialKhz: 7103.5, startedAt: 9, text: done.text, outcome: done,
    result: { call: 'KY4RY', mode: 'ardop', khz: 7103.5, dialKhz: 7103.5, url: 'u', band: '40m', sent: 1, received: 2, saved: false } } });
  const c = cardTexts(p);
  assert.ok(/\bmail-end-done\b/.test(c.cls));
  assert.deepStrictEqual(c.rows, ['Finished', 'Mail exchanged with KY4RY', '40m · 7.103.50 MHz · ARDOP · 1 sent · 2 received']);
  assert.deepStrictEqual(c.buttons, ['OK']);
});

test('W2: an internet check that finished keeps its one line and draws no card; a running session draws none', () => {
  const p = openOnArdop();
  p.mailOnMessage({ type: 'winlink-session', session: { state: 'done', mode: 'telnet', startedAt: 3, text: 'Checked mail over the internet — nothing to send; no new mail.' } });
  assert.ok(p.$('mail-end-card').hidden);
  assert.strictEqual(p.$('mail-session').textContent, 'Checked mail over the internet — nothing to send; no new mail.');
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  assert.strictEqual(p.$('mail-end-card').hidden, false);
  p.mailOnMessage({ type: 'winlink-session', session: { state: 'connecting', mode: 'ardop', gateway: 'KY4RY', text: 'Calling KY4RY' } });
  assert.ok(p.$('mail-end-card').hidden, 'a new session clears the card');
  assert.ok(p.$('mail-connect').hidden && !p.$('mail-abort').hidden, 'Abort replaces Connect while it runs');
});

test('W2: fields the card does not know are ignored (the automatic retry will add some)', () => {
  const s = endedSession();
  s.outcome = Object.assign({}, s.outcome, { retryInS: 14, retryState: 'waiting', somethingNew: { a: 1 } });
  const plain = MailView.endCard(endedSession(), { fmtDial: FreqDots.khzMhz });
  assert.deepStrictEqual(MailView.endCard(s, { fmtDial: FreqDots.khzMhz }), plain);
  assert.deepStrictEqual(Object.keys(plain).sort(), ['key', 'kind', 'label', 'lines', 'ok', 'retry', 'title']);
  const old = MailView.endCard({ state: 'error', mode: 'ardop', gateway: 'KY4RY', error: 'It did not work.' });
  assert.strictEqual(old.title, 'It did not work.');
  assert.strictEqual(old.retry, null);
  assert.strictEqual(MailView.endCard({ state: 'idle' }), null);
  assert.strictEqual(MailView.endCard(null), null);
  assert.ok(/AUTOMATIC RETRY \(follow-up\)/.test(REMOTE), 'the place for the countdown line is marked in mailRenderEndCard');
  assert.ok(/\.mail-end-retry-box \{/.test(MAIL_CSS), 'the layout keeps a block for it');
});

test('W2: nothing from the shack reaches the Mail tab through innerHTML', () => {
  const a = REMOTE.indexOf('  // ── Winlink mail (the shack\'s Pat; owner only)');
  const b = REMOTE.indexOf('  // Auto-connect on page load (or bootstrap popout view)');
  assert.ok(!/innerHTML/.test(REMOTE.slice(a, b)), 'the Mail section uses textContent and createElement only');
  const p = openOnArdop({ mode: 'ardop' });
  const s = endedSession();
  s.outcome = Object.assign({}, s.outcome, { title: '<img src=x onerror=alert(1)>' });
  p.mailOnMessage({ type: 'winlink-session', session: s });
  assert.strictEqual(cardTexts(p).rows[1], '<img src=x onerror=alert(1)>', 'shown as text');
});

// ── W4: the small first-run fixes ────────────────────────────────────────────

test('W4a: a mode the shack cannot offer is not a segment, and the line under Send via says why', () => {
  const p = loadMail();
  const modes = [MODES[0],
    { id: 'ardop', label: 'ARDOP (radio)', available: false, reason: 'Set up a radio first (Settings > My Rigs)' },
    { id: 'packet', label: 'Packet (VHF/UHF radio)', available: false, reason: 'Set up a radio first (Settings > My Rigs)' },
    { id: 'vara', label: 'VARA HF (radio, your own VARA)', available: false, reason: 'VARA HF is a Windows program' }];
  p.mailOnMessage(state({ modes }));
  p.$('mail-open-connect').click();
  const note = p.$('mail-mode-note');
  assert.strictEqual(note.hidden, false);
  assert.deepStrictEqual(note.children.map((c) => c.textContent), [
    'ARDOP (radio) and Packet (VHF/UHF radio) are not available: Set up a radio first (Settings > My Rigs).',
    'VARA HF (radio, your own VARA) is not available: VARA HF is a Windows program.',
  ]);
  assert.deepStrictEqual(p.$('mail-mode').children.map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['Internet', 'true']]);
  p.mailOnMessage(state());
  assert.ok(p.$('mail-mode-note').hidden, 'no line when every mode is available');
  assert.deepStrictEqual(p.$('mail-mode').children.map((b) => b.textContent), ['Internet', 'ARDOP', 'Packet']);
  assert.deepStrictEqual(MailView.modeReasons([{ label: 'A', available: false, reason: 'x' }, { label: 'B', available: false, reason: 'x' }, { label: 'C', available: false, reason: 'x' }]), ['A, B and C are not available: x.']);
  assert.strictEqual(MailView.modeOptionText({ label: 'ARDOP (radio)', available: false }), 'ARDOP (radio) (unavailable)');
});

test('W4b: the account card offers Try again when Winlink could not be reached', () => {
  const p = loadMail();
  p.mailOnMessage(state({ hasPassword: false }));
  assert.strictEqual(p.$('mail-acct').hidden, false);
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-account-check' }]);
  assert.strictEqual(p.$('mail-acct-text').textContent, 'Checking whether your callsign has an account…');
  p.mailOnMessage({ type: 'winlink-result', op: 'account-check', ok: false, error: 'getaddrinfo ENOTFOUND api.winlink.org' });
  assert.strictEqual(p.$('mail-acct-text').textContent, 'Could not reach Winlink to check: getaddrinfo ENOTFOUND api.winlink.org.');
  assert.ok(!/Close and reopen Mail/.test(REMOTE), 'the old instruction is gone');
  const retry = p.$('mail-acct-retry');
  assert.strictEqual(retry.hidden, false);
  assert.strictEqual(retry.textContent, 'Try again');
  assert.ok(p.$('mail-acct-go').hidden && p.$('mail-acct-pw').hidden, 'no form until the check answers');
  p.mailOnMessage(state({ hasPassword: false }));
  assert.deepStrictEqual(p.take(), [], 'a state push does not ask again by itself');
  retry.click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-account-check' }]);
  assert.ok(retry.hidden);
  assert.strictEqual(p.$('mail-acct-text').textContent, 'Checking whether your callsign has an account…');
  p.mailOnMessage({ type: 'winlink-account', callsign: 'K3SBP', exists: true });
  assert.strictEqual(p.$('mail-acct-text').textContent, 'K3SBP already has a Winlink account. Enter its password.');
  assert.ok(!p.$('mail-acct-go').hidden && !p.$('mail-acct-pw').hidden && p.$('mail-acct-email').hidden);
  assert.strictEqual(p.$('mail-acct-go').textContent, 'Save password');
  assert.strictEqual(MailView.accountCheckFailed('').text, 'Could not reach Winlink to check: no answer.');
});

test('W4c: a gateway list that did not load clears "Loading" and says what happened, with Try again', () => {
  const p = loadMail();
  p.mailOnMessage(state({ mode: 'ardop' }));
  p.mailOnOpen();
  p.$('mail-open-connect').click();
  const ask = p.take().find((m) => m.type === 'winlink-gateways-get');
  assert.ok(ask && ask.reqId && ask.mode === 'ardop', 'opening Send / Receive in a radio mode loads the list, with a reqId');
  assert.strictEqual(p.$('mail-gateway').textContent, 'Loading, predicting propagation…');
  p.mailOnMessage({ type: 'winlink-result', op: 'gateways', ok: false, error: 'Pat is not running', reqId: ask.reqId });
  assert.strictEqual(p.$('mail-gateway').textContent, 'The list did not load');
  assert.strictEqual(p.$('mail-gw-note').textContent, 'The gateway list did not load: Pat is not running.');
  assert.strictEqual(p.$('mail-gw-status').hidden, false);
  const retry = p.$('mail-gw-retry');
  assert.strictEqual(retry.hidden, false);
  assert.strictEqual(retry.textContent, 'Try again');
  assert.deepStrictEqual(p.toasts, [], 'said in place, not in a toast that fades');
  retry.click();
  const again = p.take();
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].type, 'winlink-gateways-get');
  assert.notStrictEqual(again[0].reqId, ask.reqId);
  assert.ok(retry.hidden, 'Try again goes while it loads');
  p.mailOnMessage({ type: 'winlink-result', op: 'gateways', ok: false, error: 'old', reqId: ask.reqId });
  assert.strictEqual(p.$('mail-gateway').textContent, 'Loading, predicting propagation…', 'a late answer to the first request is dropped');
  p.mailOnMessage({ type: 'winlink-gateways', mode: 'ardop', list: GATEWAYS, predicted: true, note: 'Best predicted path first, for right now', reqId: again[0].reqId });
  assert.strictEqual(p.$('mail-gateway').children.length, 2);
  assert.strictEqual(MailView.gatewaysFailed('').text, 'The gateway list did not load.');
});

test('W4d: prediction progress while the list loads, then the order note and the left-out count', () => {
  const p = loadMail();
  p.mailOnMessage(state({ mode: 'ardop', predictMs: { ardop: 35400 } }));
  p.mailOnOpen();
  p.$('mail-open-connect').click();
  const ask = p.take().find((m) => m.type === 'winlink-gateways-get');
  assert.strictEqual(p.$('mail-gw-note').textContent, 'Predicting propagation for every gateway: 0 s so far, about 35 s last time.');
  p.clock.now += 12000;
  p.tick();
  assert.strictEqual(p.$('mail-gw-note').textContent, 'Predicting propagation for every gateway: 12 s so far, about 35 s last time.');
  assert.ok(p.$('mail-gw-retry').hidden);
  p.mailOnMessage({ type: 'winlink-gateways', mode: 'ardop', list: GATEWAYS, predicted: true, note: 'Best predicted path first, for right now', leftOut: 4, reqId: ask.reqId });
  assert.strictEqual(p.$('mail-gw-note').textContent, 'Best predicted path first, for right now. 4 more this radio cannot call (outside the amateur bands, or bands not set up in Settings > My Rigs > Bands).');
  p.clock.now += 5000;
  p.tick();
  assert.ok(/^Best predicted path first/.test(p.$('mail-gw-note').textContent), 'the progress line stops when the list arrives');
});

test('W4d: the texts for every case of the line under the list', () => {
  assert.strictEqual(MailView.predictText({ mode: 'ardop', predictionOn: true, predictMs: {}, elapsedMs: 3000 }), 'Predicting propagation for every gateway: 3 s so far. The first ranking can take a minute or two.');
  assert.strictEqual(MailView.predictText({ mode: 'packet', predictionOn: true, elapsedMs: 3000 }), '', 'an FM list is not ranked');
  assert.strictEqual(MailView.predictText({ mode: 'vara', predictionOn: false, elapsedMs: 3000 }), '', 'ranking turned off');
  assert.strictEqual(MailView.loadingText('ardop', true), 'Loading, predicting propagation…');
  assert.strictEqual(MailView.loadingText('packet', true), 'Loading gateways…');
  assert.strictEqual(MailView.loadingText('ardop', false), 'Loading gateways…');
  assert.strictEqual(MailView.gatewayNote({ list: GATEWAYS, predicted: false, note: 'Nearest first. No propagation prediction came back.' }), 'Nearest first. No propagation prediction came back.');
  assert.strictEqual(MailView.gatewayNote({ list: GATEWAYS, predicted: false, note: 'Nearest first', leftOut: 1 }), 'Nearest first. 1 more this radio cannot call (outside the amateur bands, or bands not set up in Settings > My Rigs > Bands).');
  assert.strictEqual(MailView.gatewayNote({ list: GATEWAYS, predicted: true }), 'Best predicted path first, for right now.', 'no note sent: the predicted flag decides');
  assert.strictEqual(MailView.gatewayNote({ list: [], predicted: false, note: '' }), '');
});

test('W4e: Winlink off on the shack shows the tab with where to turn it on, and asks the shack for nothing', () => {
  const p = loadMail();
  assert.ok(p.$('mail-tab-btn').hidden, 'no tab before the shack says anything');
  p.mailOnMessage({ type: 'winlink-state', enabled: false, patReady: false, modes: [], session: { state: 'idle' } });
  assert.strictEqual(p.$('mail-tab-btn').hidden, false, 'the tab shows');
  assert.strictEqual(p.$('mail-off').hidden, false);
  assert.strictEqual(p.$('mail-off').textContent, 'Turn Winlink on at the shack: Settings > Station > Winlink');
  assert.ok(p.$('mail-view').classList.contains('mail-is-off'));
  assert.ok(/#mail-view\.mail-is-off > :not\(#mail-off\) \{ display: none !important; \}/.test(MAIL_CSS), 'everything else in the tab is hidden');
  p.mailOnOpen();
  assert.deepStrictEqual(p.take(), [], 'opening the tab does not start Pat');
  p.mailOnMessage(state());
  assert.ok(p.$('mail-off').hidden && !p.$('mail-view').classList.contains('mail-is-off'), 'turned on: the tab is the mailbox again');
  p.mailOnOpen();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-list', box: 'in' }]);
});

test('W4e: a Guest Pass still never sees Mail: no winlink-state reaches it, so the tab stays hidden', () => {
  assert.ok(/<button class="tab hidden" data-tab="mail" id="mail-tab-btn">/.test(HTML), 'the tab starts hidden');
  assert.ok(/if \(btn\) btn\.classList\.toggle\('hidden', !mailState\);/.test(REMOTE), 'only a winlink-state shows it');
  const rs = new RemoteServer();
  const mk = (pass) => { const sent = []; return { _authenticated: true, readyState: 1, _passSession: pass ? { id: 'g' } : null, send: (w) => sent.push(JSON.parse(w)), _sent: sent }; };
  const owner = mk(false), guest = mk(true);
  rs._clients = new Set([owner, guest]);
  rs.broadcastWinlinkState({ enabled: false });
  rs.broadcastWinlinkSession({ state: 'idle' });
  rs._sendWinlinkHydration(guest);
  rs._sendWinlinkHydration(owner);
  assert.ok(owner._sent.some((m) => m.type === 'winlink-state' && m.enabled === false), 'the owner is told, on or off');
  assert.deepStrictEqual(guest._sent.filter((m) => /^winlink-/.test(m.type)), [], 'the guest is told nothing');
});

// ── W0: the layout ───────────────────────────────────────────────────────────

const INBOX = { type: 'winlink-mailbox', box: 'in', messages: [
  { mid: 'A1', from: 'KY4RY', to: ['K3SBP'], subject: 'Re: Net check-in Thursday', date: '2026-11-12T14:31:00Z', read: false },
  { mid: 'A2', from: 'SERVICE', to: ['K3SBP'], subject: 'Your Winlink account is ready', date: '2026-11-10T09:05:00Z', read: true, attachments: [{ name: 'a.txt' }] },
] };

test('W0: the inbox: header with the call, folder segments with counts, rows as cards', () => {
  const p = loadMail();
  p.mailOnMessage(state({ unread: 1, counts: { in: 2, out: 2, sent: 7, archive: 0 } }));
  p.mailOnOpen();
  p.mailOnMessage(INBOX);
  assert.strictEqual(p.screen(), 'list');
  assert.strictEqual(p.$('mail-head-sub').textContent, 'K3SBP · Winlink');
  const folders = p.$('mail-folders').children;
  assert.deepStrictEqual(folders.map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['Inbox 1', 'true'], ['Outbox 2', 'false'], ['Sent', 'false'], ['Archive', 'false']]);
  const rows = p.$('mail-list').querySelectorAll('.mail-row');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].tagName, 'BUTTON');
  assert.ok(rows[0].classList.contains('mail-unread') && !rows[1].classList.contains('mail-unread'));
  assert.deepStrictEqual(rows[0].querySelectorAll('.mail-row-who,.mail-row-line,.mail-row-time').map((e) => e.textContent), ['KY4RY', 'Re: Net check-in Thursday', '1431z']);
  assert.deepStrictEqual(rows[1].querySelectorAll('.mail-row-who,.mail-row-line,.mail-row-time').map((e) => e.textContent), ['SERVICE', 'Your Winlink account is ready · 1 attachment', 'Nov 10']);
  const kids = p.$('mail-list').children;
  assert.strictEqual(kids[kids.length - 1].textContent, 'New mail arrives when you press Send / Receive.');
  p.take();
  folders[1].click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-list', box: 'out' }]);
  assert.strictEqual(p.$('mail-folders').children[1].getAttribute('aria-pressed'), 'true');
  assert.strictEqual(p.$('mail-list').textContent, 'Nothing here.', 'an empty Outbox; the Inbox hint is only on the Inbox');
});

test('W0: the last-session card, and the session running now in its place', () => {
  const p = loadMail();
  p.mailOnMessage(state({ lastSession: { at: '2026-11-12T14:32:00Z', ok: true, text: 'Sent 1 message via KY4RY (ARDOP); 2 new messages in your Inbox.' } }));
  assert.strictEqual(p.$('mail-last').hidden, false);
  assert.strictEqual(p.$('mail-last-label').textContent, 'Last session · 1432z');
  assert.strictEqual(p.$('mail-last-text').textContent, 'Sent 1 message via KY4RY (ARDOP); 2 new messages in your Inbox.');
  assert.ok(p.$('mail-last').classList.contains('mail-tone-ok'));
  p.mailOnMessage({ type: 'winlink-session', session: { state: 'connected', mode: 'ardop', gateway: 'KY4RY', text: 'Connected to KY4RY' } });
  assert.strictEqual(p.$('mail-last-label').textContent, 'Session running · KY4RY');
  assert.ok(p.$('mail-last').classList.contains('mail-tone-run'));
  p.$('mail-last').click();
  assert.strictEqual(p.screen(), 'connect', 'a tap opens Send / Receive');
  const q = loadMail();
  q.mailOnMessage(state({ lastSession: null }));
  assert.ok(q.$('mail-last').hidden, 'no card before the first session');
});

test('W0: screens: a row opens the reader; Back, Write and Send / Receive move between screens', () => {
  const p = loadMail();
  p.mailOnMessage(state());
  p.mailOnOpen();
  p.mailOnMessage(INBOX);
  p.take();
  p.$('mail-list').querySelectorAll('.mail-row')[1].click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-read', box: 'in', mid: 'A2' }]);
  p.mailOnMessage({ type: 'winlink-message', box: 'in', mid: 'A2', message: { from: 'SERVICE', to: ['K3SBP'], subject: 'Your Winlink account is ready', date: '2026-11-10T09:05:00Z', body: 'Welcome.\n73', attachments: [{ name: 'a.txt', size: 2048 }] } });
  assert.strictEqual(p.screen(), 'read');
  assert.strictEqual(p.$('mail-read-subject').textContent, 'Your Winlink account is ready');
  assert.strictEqual(p.$('mail-read-meta').textContent, 'From SERVICE · to K3SBP · Nov 10');
  assert.strictEqual(p.$('mail-read-body').textContent, 'Welcome.\n73');
  assert.strictEqual(p.$('mail-list').querySelectorAll('.mail-row')[1].getAttribute('aria-current'), 'true', 'the open message is marked in the list');
  const save = p.$('mail-read-atts').querySelector('button');
  assert.strictEqual(save.textContent, 'Save');
  assert.strictEqual(save.getAttribute('aria-label'), 'Save a.txt');
  assert.strictEqual(p.$('mail-read-atts').querySelector('.mail-att-name').textContent, 'a.txt · 2 kB');
  save.click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-attachment-get', box: 'in', mid: 'A2', name: 'a.txt' }]);
  // Delete asks once more, then deletes and goes back.
  p.$('mail-del').click();
  assert.strictEqual(p.$('mail-del').textContent, 'Delete this message?');
  p.$('mail-del').click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-delete', box: 'in', mid: 'A2' }]);
  assert.strictEqual(p.screen(), 'list');
  // Reply opens compose with the address and Re:.
  p.mailOnMessage({ type: 'winlink-message', box: 'in', mid: 'A1', message: { from: 'KY4RY', to: ['K3SBP'], subject: 'Net', body: '' } });
  p.$('mail-reply').click();
  assert.strictEqual(p.screen(), 'compose');
  assert.strictEqual(p.$('mail-to').value, 'KY4RY');
  assert.strictEqual(p.$('mail-subj').value, 'Re: Net');
  p.$('mail-cancel').click();
  assert.strictEqual(p.screen(), 'list');
  p.$('mail-new').click();
  assert.strictEqual(p.screen(), 'compose');
  p.$('mail-queue').click();
  assert.strictEqual(p.$('mail-err').textContent, 'Add a recipient and a subject');
  p.$('mail-to').value = 'W1AW'; p.$('mail-subj').value = 'Hi'; p.$('mail-body').value = 'Body';
  p.take();
  p.$('mail-queue').click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-compose', to: 'W1AW', subject: 'Hi', body: 'Body' }]);
  p.mailOnMessage({ type: 'winlink-result', op: 'compose', ok: true });
  assert.strictEqual(p.screen(), 'list');
  p.$('mail-open-connect').click();
  assert.strictEqual(p.screen(), 'connect');
  p.$('mail-connect-screen').querySelector('[data-back]').click();
  assert.strictEqual(p.screen(), 'list');
});

test('W0: Send / Receive: band chips for the mode and the rig, gateway cards with a quality tag, the Connect bar', () => {
  const p = openOnArdop({ mode: 'ardop' });
  assert.deepStrictEqual(p.$('mail-band').children.map((c) => c.textContent), ['80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', 'All']);
  assert.strictEqual(chip(p, '').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(p.$('mail-gw-head').textContent, 'Best path now');
  const c0 = gwCard(p, 0);
  assert.deepStrictEqual(c0.querySelectorAll('.mail-row-who,.mail-row-line,.mail-tag').map((e) => e.textContent), ['KY4RY', '7.103.50 MHz · 412 km', 'GOOD']);
  assert.ok(gwCard(p, 1).querySelector('.mail-tag').classList.contains('mail-tag-warn'));
  assert.strictEqual(c0.getAttribute('aria-pressed'), 'true', 'the first is picked');
  assert.strictEqual(p.$('mail-connect').textContent, 'Connect to KY4RY');
  assert.ok(p.$('mail-connect').classList.contains('mail-btn-ok'));
  assert.strictEqual(p.$('mail-radio-line').textContent, 'Tap a gateway to tune the radio to it, or connect now.');
  pickGateway(p);
  assert.strictEqual(p.$('mail-connect').textContent, 'Connect to W4EDX-10');
  assert.strictEqual(p.$('mail-radio-line').textContent, 'The radio is set for W4EDX-10 on 7.101.20 MHz. It goes back when you leave Mail.');
  p.$('mail-connect').click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-connect', mode: 'ardop', gateway: 'W4EDX-10', dialKhz: 7101.2, url: 'ardop:///W4EDX-10?freq=7101.2' }]);
  chip(p, '40m').click();
  const ask = p.take().find((m) => m.type === 'winlink-gateways-get');
  assert.deepStrictEqual([ask.mode, ask.band], ['ardop', '40m']);
  assert.strictEqual(p.$('mail-radio-line').textContent, 'Waiting for the gateway list.');
  assert.ok(p.$('mail-connect').hidden, 'no Connect without a gateway');
  seg(p, 'packet').click();
  assert.deepStrictEqual(p.$('mail-band').children.map((c) => c.textContent), ['2m', '1.25m', '70cm', 'All']);
  seg(p, 'telnet').click();
  assert.ok(p.$('mail-radio').hidden);
  assert.strictEqual(p.$('mail-connect').textContent, 'Send / Receive over the internet');
  p.take();
  p.$('mail-connect').click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-connect', mode: 'telnet' }]);
});

test('W0: band chips follow the shack rig\'s bands (S2C rig-bands)', () => {
  const p = loadMail({ rigBands: ['40m', '20m', '2m'] });
  p.mailOnMessage(state({ mode: 'ardop' }));
  p.mailOnOpen();
  p.$('mail-open-connect').click();
  assert.deepStrictEqual(p.$('mail-band').children.map((c) => c.textContent), ['40m', '20m', 'All']);
  assert.ok(/if \(document\.getElementById\('mail-band'\) && typeof mailRenderBands === 'function'\) mailRenderBands\(\);/.test(REMOTE), 'applyWebRigBands redraws the chips');
});

test('W0: the busy-channel prompt brings Send / Receive up, and keeps its buttons while the wait counts up', () => {
  const p = loadMail();
  p.mailOnMessage(state({ mode: 'ardop' }));
  p.mailOnOpen();
  assert.strictEqual(p.screen(), 'list');
  const prompt = (w) => ({ type: 'winlink-session', session: { state: 'connecting', mode: 'ardop', gateway: 'KY4RY', prompt: { id: 'p1', kind: 'busy-channel', waitedSec: w, limitSec: 120 } } });
  p.mailOnMessage(prompt(5));
  assert.strictEqual(p.screen(), 'connect');
  const go = p.$('mail-p-go');
  assert.deepStrictEqual(p.$('mail-prompt').querySelectorAll('button').map((b) => b.textContent), ['Keep waiting', 'Call anyway', 'Give up']);
  p.mailOnMessage(prompt(6));
  assert.strictEqual(p.$('mail-p-go'), go, 'the same buttons');
  assert.ok(/Waited 0:06 of 2:00/.test(p.$('mail-prompt').textContent));
  p.take();
  go.click();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-prompt', id: 'p1', value: 'continue' }]);
});

test('W0: the Mail markup has no inline style, labels its fields and names its icon buttons', () => {
  assert.ok(!/\sstyle="/.test(MAIL_HTML), 'no style attribute in the Mail markup');
  for (const id of ['mail-acct-pw', 'mail-acct-email', 'mail-to', 'mail-subj', 'mail-body']) assert.ok(new RegExp('<label for="' + id + '"').test(MAIL_HTML), '#' + id + ' has a label');
  const icons = MAIL_HTML.match(/<button[^>]*class="mail-icon-btn[^"]*"[^>]*>/g) || [];
  assert.ok(icons.length >= 3);
  for (const b of icons) assert.ok(/aria-label="[^"]+"/.test(b), 'icon button has an aria-label: ' + b);
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(MAIL_HTML), 'no emoji');
  for (const gone of ['History', 'Templates', 'Favourites', 'Attach', 'Position report', 'POTA spot', 'Retune', 'Add Cc']) assert.ok(!MAIL_HTML.includes('>' + gone + '<'), 'no dead control: ' + gone);
});

test('W0: the Mail rules carry no colour literal; text 16 px except the 12 px small-caps labels; tap targets 44 px', () => {
  assert.ok(MAIL_CSS.length > 1000, 'the Mail block is in remote.css');
  const block = MAIL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'no hex colour');
  assert.ok(!/\b(?:rgb|rgba|hsl|hsla)\(/.test(block), 'no rgb() or hsl()');
  assert.ok(!/:\s*(?:white|black)\b/.test(block), 'no white or black literal');
  for (const r of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = r[1].trim(), body = r[2];
    for (const m of body.matchAll(/font-size:\s*(\d+)px/g)) {
      const n = Number(m[1]);
      if (n < 16) assert.ok(n === 12 && /mail-caps|mail-tag|mail-end-label/.test(sel) && /font-weight: 800/.test(body), sel + ' is ' + n + ' px');
    }
    if (/^\.(mail-btn|mail-seg-btn|mail-chip|mail-row, \.mail-gw|mail-last)$/.test(sel)) assert.ok(/min-height: (4[4-9]|5\d)px/.test(body), sel + ' is at least 44 px tall');
  }
  assert.ok(/\.mail-icon-btn \{[^}]*width: 44px; height: 44px;/.test(block));
  assert.ok(/\.mail-btn-bar \{[^}]*min-height: 50px;/.test(block));
  assert.ok(/\.mail-row-who \{[^}]*font-size: 18px;[^}]*font-weight: 800;/.test(block), 'row titles 18 px / 800');
  assert.ok(/@container mail \(min-width: 700px\)/.test(block), 'two panes once the Mail view is 700 px wide');
  assert.ok(/:root\[data-ds\] #mail-view \{[^}]*--m-on-tint: var\(--ds-on-tint\);[^}]*--m-on-ok: var\(--ds-on-ok\);/.test(block), 'text on a fill uses its on- ink');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
