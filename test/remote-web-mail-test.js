#!/usr/bin/env node
'use strict';
/**
 * ECHOCAT Web's Mail tab, first batch (#425, web items W1, W2, W4).
 *
 *   W1  the radio goes back after a look at a gateway: leaving the tab, closing
 *       the page, or going back to the internet sends winlink-qsy-restore;
 *       never while a session runs, and not after one has run (the shack puts
 *       the radio back itself when a session ends)
 *   W2  a finished session leaves a card: "Mail exchanged with ..." or the
 *       not-finished card, whose Try again re-sends winlink-connect with the
 *       session's gateway, dial, mode and url
 *   W4  a greyed mode says why; the account card has Try again; a gateway list
 *       that did not load says so with Try again; prediction progress and the
 *       list's order note; Winlink off on the shack says where to turn it on
 *
 * The Mail section of renderer/remote.js is run here as it is in the page,
 * against a small stand-in document built from the ids in remote.html, with
 * stand-in winlink-* messages. lib/winlink-mail-view.js is the real module.
 *
 * Run: node test/remote-web-mail-test.js
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const MailView = require('../lib/winlink-mail-view');
const FreqDots = require('../lib/freq-dots');
const { RemoteServer } = require('../lib/remote-server');
const WinlinkOutcome = require('../lib/winlink-outcome');

const ROOT = path.join(__dirname, '..');
const REMOTE = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
const HTML = readSrc(path.join(ROOT, 'renderer', 'remote.html'));
const CSS = readSrc(path.join(ROOT, 'renderer', 'remote.css'));
const SERVER = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// ── a stand-in document: just enough DOM for the Mail section ────────────────
class El {
  constructor(tag, id, cls) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this._cls = new Set(String(cls || '').split(/\s+/).filter(Boolean));
    this.children = [];
    this._text = '';
    this._value = undefined;
    this.style = {};
    this._on = {};
    this.disabled = false;
    const self = this;
    this.classList = {
      add(...c) { c.forEach((x) => self._cls.add(x)); },
      remove(...c) { c.forEach((x) => self._cls.delete(x)); },
      contains(c) { return self._cls.has(c); },
      toggle(c, on) { const want = on === undefined ? !self._cls.has(c) : !!on; if (want) self._cls.add(c); else self._cls.delete(c); return want; },
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v == null ? '' : v); this._html = ''; if (this.tagName === 'SELECT') this._value = undefined; }
  get innerHTML() { return this._html || ''; }
  set innerHTML(v) { this.children = []; this._text = ''; this._html = String(v); }
  get value() {
    if (this.tagName !== 'SELECT') return this._value === undefined ? '' : this._value;
    if (this._value !== undefined) return this.children.some((o) => o.value === this._value) ? this._value : '';
    return this.children.length ? this.children[0].value : '';
  }
  set value(v) { this._value = String(v); }
  get hidden() { return this._cls.has('hidden'); }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); }
  dispatch(type, ev) {
    const e = Object.assign({ target: this, type }, ev || {});
    if (typeof this['on' + type] === 'function') this['on' + type](e);
    (this._on[type] || []).forEach((fn) => fn(e));
    return e;
  }
  click() { const e = this.dispatch('click'); if (this.doc) this.doc.dispatch('click', { target: this }); return e; }
  closest() { return null; }
  querySelectorAll() { return []; }
  getAttribute() { return null; }
  setAttribute() {}
  /** Every element under this one, depth first. */
  all() { return this.children.reduce((a, c) => a.concat([c], c.all()), []); }
}

/** The page's Mail markup, as ids: every element with an id inside #mail-view, plus the tab button. */
function buildDocument() {
  const start = HTML.indexOf('<div id="mail-view"');
  const end = HTML.indexOf('<div id="bottom-bar">');
  assert.ok(start > 0 && end > start, 'the Mail markup is in remote.html');
  const block = HTML.slice(start, end) + HTML.slice(HTML.indexOf('id="mail-tab-btn"') - 60, HTML.indexOf('id="mail-tab-btn"') + 160);
  const byId = {};
  const doc = new El('document');
  for (const m of block.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const id = (/\bid="([^"]+)"/.exec(m[2]) || [])[1];
    if (!id) continue;
    const el = new El(m[1], id, (/\bclass="([^"]+)"/.exec(m[2]) || [])[1] || '');
    el.doc = doc;
    byId[id] = el;
  }
  doc.byId = byId;
  doc.getElementById = (id) => {
    if (byId[id]) return byId[id];
    // An element the section made itself (a card's buttons).
    for (const el of Object.values(byId)) { const hit = el.all().find((c) => c.id === id); if (hit) return hit; }
    return null;
  };
  doc.createElement = (tag) => { const el = new El(tag); el.doc = doc; return el; };
  doc.body = new El('body');
  return doc;
}

/** The Mail section of remote.js, run as it is in the page. */
function loadMail() {
  const a = REMOTE.indexOf('  // ── Winlink mail (the shack\'s Pat; owner only)');
  const b = REMOTE.indexOf('  // Auto-connect on page load (or bootstrap popout view)');
  assert.ok(a > 0 && b > a, 'the Mail section is found in remote.js');
  const section = REMOTE.slice(a, b);
  const doc = buildDocument();
  const sent = [];
  const toasts = [];
  const win = new El('window');
  win.WinlinkMailView = MailView;
  const ws = { readyState: 1, send: (w) => sent.push(JSON.parse(w)) };
  const clock = { now: 1000000 };
  const timers = [];
  class FakeDate extends Date { static now() { return clock.now; } }
  const fn = new Function('window', 'document', 'ws', 'WebSocket', 'showToast', 'esc', 'FreqDots', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
    section + '\n  return { mailOnMessage: mailOnMessage, mailOnLeave: mailOnLeave, mailOnOpen: mailOnOpen };');
  const api = fn(win, doc, ws, { OPEN: 1 }, (text) => toasts.push(text), (s) => String(s), FreqDots,
    (f) => { f(); return 0; }, () => {},
    (f) => { timers.push(f); return timers.length; }, (id) => { if (id) timers[id - 1] = null; }, FakeDate);
  const $ = (id) => { const el = doc.getElementById(id); assert.ok(el, 'element #' + id + ' exists'); return el; };
  return Object.assign(api, { doc, $, sent, toasts, win, ws, clock, tick: () => timers.forEach((f) => f && f()), take: () => sent.splice(0) });
}

const MODES = [
  { id: 'telnet', label: 'Internet (telnet)', available: true, reason: '' },
  { id: 'ardop', label: 'ARDOP (radio)', available: true, reason: '' },
  { id: 'packet', label: 'Packet (VHF/UHF radio)', available: true, reason: '' },
];
function state(over) {
  return Object.assign({ type: 'winlink-state', enabled: true, patReady: true, patStarted: true, hasPassword: true, noticeAccepted: true, mode: 'telnet', modes: MODES, session: { state: 'idle' }, predictionOn: true, predictMs: {} }, over || {});
}
const GATEWAYS = [
  { call: 'KY4RY', dialKhz: 7103.5, url: 'ardop:///KY4RY?freq=7103.5', qualityWord: 'Good', quality: 80, distKm: 412 },
  { call: 'W4EDX-10', dialKhz: 7101.2, url: 'ardop:///W4EDX-10?freq=7101.2', distKm: 588 },
];
/** Open the tab in ARDOP with the list loaded; returns the page. */
function openOnArdop(over) {
  const p = loadMail();
  p.mailOnMessage(state(over));
  p.mailOnOpen();
  p.$('mail-mode').value = 'ardop';
  p.$('mail-mode').dispatch('change');
  const ask = p.sent.find((m) => m.type === 'winlink-gateways-get');
  p.mailOnMessage({ type: 'winlink-gateways', mode: 'ardop', band: '', list: GATEWAYS, predicted: true, note: 'Best predicted path first, for right now', leftOut: 0, reqId: ask.reqId });
  p.take();
  return p;
}
/** Pick the second gateway; the shack answers that it tuned there. */
function pickGateway(p) {
  p.$('mail-gateway').value = '1';
  p.$('mail-gateway').dispatch('change');
  const q = p.take();
  assert.deepStrictEqual(q, [{ type: 'winlink-qsy', dialKhz: 7101.2, mode: 'ardop' }]);
  p.mailOnMessage({ type: 'winlink-result', op: 'qsy', ok: true });
}
const RESTORE = [{ type: 'winlink-qsy-restore' }];

console.log('ECHOCAT Web Mail tab: frequency restore, end cards, first-run texts (W1, W2, W4)');

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
  p.$('mail-gateway').value = '1';
  p.$('mail-gateway').dispatch('change');
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
  p.$('mail-mode').value = 'telnet';
  p.$('mail-mode').dispatch('change');
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
    // The session ends on that frequency; the operator comes back and leaves again.
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
  assert.strictEqual(p.$('mail-session').textContent, '', 'the sentence is on the card, not also in a red line');
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
  p.$('mail-notice-ok').click();
  assert.deepStrictEqual(p.take().map((m) => m.type), ['winlink-accept-notice', 'winlink-connect']);
});

test('W2: OK puts the card away, the line then carries the sentence, and the same session does not bring it back', () => {
  const p = openOnArdop({ mode: 'ardop' });
  p.mailOnMessage({ type: 'winlink-session', session: endedSession() });
  p.$('mail-end-ok').click();
  assert.ok(p.$('mail-end-card').hidden);
  assert.strictEqual(p.$('mail-session').textContent, DROPPED.text);
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
});

test('W2: fields the card does not know are ignored (the automatic retry will add some)', () => {
  const s = endedSession();
  s.outcome = Object.assign({}, s.outcome, { retryInS: 14, retryState: 'waiting', somethingNew: { a: 1 } });
  const plain = MailView.endCard(endedSession(), { fmtDial: FreqDots.khzMhz });
  assert.deepStrictEqual(MailView.endCard(s, { fmtDial: FreqDots.khzMhz }), plain);
  assert.deepStrictEqual(Object.keys(plain).sort(), ['key', 'kind', 'label', 'lines', 'ok', 'retry', 'title']);
  // An older shack (no outcome): the sentence still shows, with OK.
  const old = MailView.endCard({ state: 'error', mode: 'ardop', gateway: 'KY4RY', error: 'It did not work.' });
  assert.strictEqual(old.title, 'It did not work.');
  assert.strictEqual(old.retry, null);
  assert.strictEqual(MailView.endCard({ state: 'idle' }), null);
  assert.strictEqual(MailView.endCard(null), null);
  assert.ok(/AUTOMATIC RETRY \(follow-up\)/.test(REMOTE), 'the place for the countdown line is marked in mailRenderEndCard');
});

test('W2: nothing from the shack reaches the card through innerHTML', () => {
  const fnBody = REMOTE.slice(REMOTE.indexOf('function mailRenderEndCard()'), REMOTE.indexOf('function mailShowList()'));
  assert.ok(!/innerHTML/.test(fnBody), 'mailRenderEndCard uses textContent only');
  const p = openOnArdop({ mode: 'ardop' });
  const s = endedSession();
  s.outcome = Object.assign({}, s.outcome, { title: '<img src=x onerror=alert(1)>' });
  p.mailOnMessage({ type: 'winlink-session', session: s });
  assert.strictEqual(cardTexts(p).rows[1], '<img src=x onerror=alert(1)>', 'shown as text');
  assert.ok(p.$('mail-end-card').all().every((el) => !el.innerHTML));
});

// ── W4: the small first-run fixes ────────────────────────────────────────────

test('W4a: a greyed mode says why, in the shack\'s words', () => {
  const p = loadMail();
  const modes = [MODES[0],
    { id: 'ardop', label: 'ARDOP (radio)', available: false, reason: 'Set up a radio first (Settings > My Rigs)' },
    { id: 'packet', label: 'Packet (VHF/UHF radio)', available: false, reason: 'Set up a radio first (Settings > My Rigs)' },
    { id: 'vara', label: 'VARA HF (radio, your own VARA)', available: false, reason: 'VARA HF is a Windows program' }];
  p.mailOnMessage(state({ modes }));
  const note = p.$('mail-mode-note');
  assert.strictEqual(note.hidden, false);
  assert.deepStrictEqual(note.children.map((c) => c.textContent), [
    'ARDOP (radio) and Packet (VHF/UHF radio) are not available: Set up a radio first (Settings > My Rigs).',
    'VARA HF (radio, your own VARA) is not available: VARA HF is a Windows program.',
  ]);
  const opts = p.$('mail-mode').children;
  assert.deepStrictEqual(opts.map((o) => [o.textContent, o.disabled]), [['Internet (telnet)', false], ['ARDOP (radio) (unavailable)', true], ['Packet (VHF/UHF radio) (unavailable)', true], ['VARA HF (radio, your own VARA) (unavailable)', true]]);
  p.mailOnMessage(state());
  assert.ok(p.$('mail-mode-note').hidden, 'no line when every mode is available');
  assert.deepStrictEqual(MailView.modeReasons([{ label: 'A', available: false, reason: 'x' }, { label: 'B', available: false, reason: 'x' }, { label: 'C', available: false, reason: 'x' }]), ['A, B and C are not available: x.']);
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
  // A state push in between does not ask again by itself.
  p.mailOnMessage(state({ hasPassword: false }));
  assert.deepStrictEqual(p.take(), []);
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
  p.$('mail-mode').value = 'ardop';
  p.$('mail-mode').dispatch('change');
  const ask = p.take().find((m) => m.type === 'winlink-gateways-get');
  assert.ok(ask && ask.reqId, 'the request carries a reqId');
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
  assert.strictEqual(again[0].mode, 'ardop');
  assert.notStrictEqual(again[0].reqId, ask.reqId);
  assert.ok(retry.hidden, 'Try again goes while it loads');
  assert.strictEqual(p.$('mail-gateway').textContent, 'Loading, predicting propagation…');
  // The late answer to the first request is not shown over the second.
  p.mailOnMessage({ type: 'winlink-result', op: 'gateways', ok: false, error: 'old', reqId: ask.reqId });
  assert.strictEqual(p.$('mail-gateway').textContent, 'Loading, predicting propagation…');
  p.mailOnMessage({ type: 'winlink-gateways', mode: 'ardop', list: GATEWAYS, predicted: true, note: 'Best predicted path first, for right now', reqId: again[0].reqId });
  assert.strictEqual(p.$('mail-gateway').children.length, 2);
  assert.strictEqual(p.$('mail-gateway').children[0].textContent, 'KY4RY  7.103.50 MHz  Good 80%  412 km');
  assert.strictEqual(MailView.gatewaysFailed('').text, 'The gateway list did not load.');
});

test('W4d: prediction progress while the list loads, then the order note and the left-out count', () => {
  const p = loadMail();
  p.mailOnMessage(state({ mode: 'ardop', predictMs: { ardop: 35400 } }));
  p.mailOnOpen();
  p.$('mail-mode').value = 'ardop';
  p.$('mail-mode').dispatch('change');
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
  assert.ok(/#mail-view\.mail-is-off > :not\(#mail-off\) \{ display: none !important; \}/.test(CSS), 'everything else in the tab is hidden');
  assert.ok(p.$('mail-acct').hidden);
  p.mailOnOpen();
  assert.deepStrictEqual(p.take(), [], 'opening the tab does not start Pat');
  p.mailOnMessage(state());
  assert.ok(p.$('mail-off').hidden && !p.$('mail-view').classList.contains('mail-is-off'), 'turned on: the tab is the mailbox again');
  p.mailOnOpen();
  assert.deepStrictEqual(p.take(), [{ type: 'winlink-list', box: 'in' }]);
});

test('W4e: a Guest Pass still never sees Mail: no winlink-state reaches it, so the tab stays hidden', () => {
  assert.ok(/id="mail-tab-btn"/.test(HTML) && /<button class="tab hidden" data-tab="mail" id="mail-tab-btn">/.test(HTML), 'the tab starts hidden');
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

// ── style: what this batch added is on the theme, at a readable size ─────────

test('the Mail rules in remote.css carry no colour literal, 16 px text and 44 px buttons', () => {
  const i = CSS.indexOf('/* ── Mail tab (Winlink)');
  assert.ok(i > 0, 'the Mail block is in remote.css');
  const block = CSS.slice(i).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'no hex colour');
  assert.ok(!/\b(?:rgb|rgba|hsl|hsla)\(/.test(block), 'no rgb() or hsl()');
  assert.ok(!/:\s*(?:white|black)\b/.test(block), 'no white or black literal');
  const rule = (sel) => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(block); assert.ok(m, 'rule ' + sel); return m[1]; };
  assert.ok(/min-height: 44px/.test(rule('.mail-btn')) && /width: 100%/.test(rule('.mail-btn')) && /font-size: 16px/.test(rule('.mail-btn')));
  for (const sel of ['.mail-off', '.mail-acct', '.mail-note', '.mail-note-text', '.mail-end-card', '.mail-input']) assert.ok(/font-size: 16px/.test(rule(sel)), sel + ' is 16 px');
  for (const m of block.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 16, 'no text under 16 px in the Mail block (' + m[1] + ')');
});

test('the markup this batch added has no inline style', () => {
  for (const id of ['mail-off', 'mail-acct', 'mail-acct-text', 'mail-acct-retry', 'mail-acct-pw', 'mail-acct-email', 'mail-acct-go', 'mail-mode-note', 'mail-gw-status', 'mail-gw-note', 'mail-gw-retry', 'mail-end-card']) {
    const m = new RegExp('<\\w+[^>]*\\bid="' + id + '"[^>]*>').exec(HTML);
    assert.ok(m, '#' + id + ' is in remote.html');
    assert.ok(!/\bstyle=/.test(m[0]), '#' + id + ' has no inline style');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
