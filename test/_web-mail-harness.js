// SPDX-License-Identifier: Apache-2.0
'use strict';
/**
 * The ECHOCAT Web Mail tab, run in Node: the Mail section of renderer/remote.js
 * against a stand-in document parsed from the Mail markup in remote.html.
 * Shared by test/remote-web-mail-test.js (#425) and
 * test/winlink-mine-web-test.js (#585 phase 4). Not a test file itself.
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const MailView = require('../lib/winlink-mail-view');
const FreqDots = require('../lib/freq-dots');
const RigBands = require('../lib/rig-bands');

const ROOT = path.join(__dirname, '..');
const REMOTE = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
const HTML = readSrc(path.join(ROOT, 'renderer', 'remote.html'));
const MAIL_HTML = HTML.slice(HTML.indexOf('    <div id="mail-view"'), HTML.indexOf('    <div id="bottom-bar">'));

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
  focus() { if (this.doc) this.doc.activeElement = this; }
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
  win.WinlinkMailActions = require('../lib/winlink-mail-actions');
  win.RigBands = RigBands;
  win.WinlinkMine = require('../lib/winlink-my-gateways');
  Object.assign(win, opts.window || {});
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

module.exports = { El, buildDocument, loadMail, MODES, state, REMOTE, HTML, MAIL_HTML };
