// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS messages over the internet (A1): the conversations, the outbox and its
// retries, the acks we owe, duplicates and unread counts. Pure: the clock and
// the send function are handed in; main.js owns the timer (it calls tick()
// again after the milliseconds tick() returns), the uplink and the file.
// Nothing here keys a radio. The formats are lib/aprs-message.js.
//
//  - Retries (APRS-A-list plan, 2026-11-19, A1): the first try at once, then
//    30 s, 60 s and 120 s, then 5 minutes, five tries in all; after the fifth
//    a last 5 minutes for the ack, then "No reply after 5 tries". APRS 1.0.1
//    chapter 14 has a message sent repeatedly until it is acknowledged or
//    rejected, or a retry count runs out; this is that count. An ack or a rej
//    stops it, and so does Stop. A late ack still marks the message delivered.
//  - Each try waits for a verified APRS-IS link. A try that cannot go for two
//    minutes ends the message: "APRS-IS could not be reached".
//  - Acks we owe (chapter 14: a message with a number is acknowledged): one
//    ack line per copy we receive, over the internet only. One that cannot go
//    at once waits up to 60 s for the link.
//  - Duplicates: the same message (sender, number, text) within 30 s is one
//    copy (aprs-is.net/ServerDesign.aspx checks duplicates "over a 30 second
//    sliding window"): dropped, no second ack. A later copy is the sender
//    retrying because our ack was lost: acked again, not shown twice.
//  - Bounded: 100 conversations, 200 messages each; the oldest go first, and
//    a conversation with a message still going out is never dropped.
//  - Saved per profile by main.js (serialize/load). A message still going out
//    when POTACAT closes comes back as "Not sent: POTACAT closed".

'use strict';

const M = require('./aprs-message');

const RETRY_DELAYS_MS = Object.freeze([30000, 60000, 120000, 300000]);
const MAX_TRIES = 5;
const FINAL_WAIT_MS = 300000;
const LINK_WAIT_MS = 120000;
const LINK_POLL_MS = 5000;
const ACK_WAIT_MS = 60000;
const DUPE_WINDOW_MS = 30000;
const RETRY_COPY_MS = 3600000; // a copy with the same number and text within an hour is the sender retrying
const MAX_CONVOS = 100;
const MAX_MSGS = 200;
const STATES = Object.freeze(['queued', 'sending', 'delivered', 'rejected', 'failed', 'stopped']);
const IN_FLIGHT = new Set(['queued', 'sending']);

/** The words each outgoing state shows in the thread. */
function statusWords(msg) {
  switch (msg.state) {
    case 'queued': return 'Waiting for APRS-IS';
    case 'sending': return `Sending, try ${msg.tries} of ${MAX_TRIES}`;
    case 'delivered': return 'Delivered (ack)';
    case 'rejected': return 'Rejected (rej)';
    case 'stopped': return 'Stopped';
    case 'failed': return msg.sentence || `No reply after ${MAX_TRIES} tries`;
    default: return '';
  }
}

function createMessenger({ now, send, canSend, myCall, myBase, state } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const sendLine = typeof send === 'function' ? send : () => false;
  const linkUp = typeof canSend === 'function' ? canSend : () => true;
  let from = String(myCall || '').toUpperCase();
  let base = M.baseCall(myBase || myCall);
  let nextId = 0;
  let seq = 0;
  let convos = new Map(); // CALL -> { call, unread, updatedAt, msgs: [] }
  const recent = new Map(); // dupe key -> at
  let acksOwed = []; // { line, until }

  function convo(call) {
    const k = String(call || '').toUpperCase();
    let c = convos.get(k);
    if (!c) { c = { call: k, unread: 0, updatedAt: clock(), msgs: [] }; convos.set(k, c); }
    return c;
  }

  function trim() {
    for (const c of convos.values()) {
      while (c.msgs.length > MAX_MSGS) {
        const i = c.msgs.findIndex((m) => !IN_FLIGHT.has(m.state));
        if (i < 0) break;
        c.msgs.splice(i, 1);
      }
    }
    if (convos.size <= MAX_CONVOS) return;
    const old = [...convos.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const c of old) {
      if (convos.size <= MAX_CONVOS) break;
      if (c.msgs.some((m) => IN_FLIGHT.has(m.state))) continue;
      convos.delete(c.call);
    }
  }

  /** Queue a message: { ok, msg } or { ok: false, sentence }. It goes out on the next tick(). */
  function compose(to, text) {
    if (!from) return { ok: false, sentence: 'Set your callsign in Settings first.' };
    const a = M.checkAddressee(to);
    if (!a.ok) return a;
    if (a.call === from) return { ok: false, sentence: `${a.call} is your own call.` };
    const t = M.checkText(text);
    if (!t.ok) return t;
    nextId = M.nextMessageId(nextId);
    const at = clock();
    const msg = { lid: `o${at}-${++seq}`, dir: 'out', from, to: a.call, text: t.text, id: String(nextId), at, state: 'queued', tries: 0, nextAt: at, lastTryAt: 0, sentence: '' };
    const c = convo(a.call);
    c.msgs.push(msg);
    c.updatedAt = at;
    trim();
    return { ok: true, msg };
  }

  /** Stop the retries of one outgoing message. */
  function stop(lid) {
    for (const c of convos.values()) {
      const m = c.msgs.find((x) => x.lid === lid);
      if (m && IN_FLIGHT.has(m.state)) { m.state = 'stopped'; m.nextAt = 0; return true; }
    }
    return false;
  }

  function settle(call, ackId, kind) {
    const c = convos.get(String(call || '').toUpperCase());
    if (!c) return false;
    for (let i = c.msgs.length - 1; i >= 0; i--) {
      const m = c.msgs[i];
      if (m.dir !== 'out' || m.id !== ackId) continue;
      if (m.state === 'delivered' || m.state === 'rejected') return false;
      m.state = kind === 'rej' ? 'rejected' : 'delivered';
      m.nextAt = 0;
      m.answeredAt = clock();
      c.updatedAt = m.answeredAt;
      return true;
    }
    return false;
  }

  function owe(line) {
    if (!line) return;
    if (linkUp() && sendLine(line)) return;
    acksOwed.push({ line, until: clock() + ACK_WAIT_MS });
  }

  /**
   * One line from APRS-IS. Returns { changed, kind, call } (kind: 'message',
   * 'ack', 'rej', 'duplicate', 'retry-copy', or null when it is not for us).
   */
  function receive(line, { via = 'internet' } = {}) {
    const p = M.parseMessageLine(line);
    if (!p || !base || !M.isForMe(p.addressee, base)) return { changed: false, kind: null };
    if (p.from === from) return { changed: false, kind: null }; // our own line coming back
    const t = clock();
    for (const [k, at] of recent) if (t - at >= DUPE_WINDOW_MS) recent.delete(k);
    if (p.kind === 'ack' || p.kind === 'rej') {
      return { changed: settle(p.from, p.ackId, p.kind), kind: p.kind, call: p.from };
    }
    const key = `${p.from}|${p.addressee}|${p.id || ''}|${p.text}`;
    if (recent.has(key)) return { changed: false, kind: 'duplicate', call: p.from };
    recent.set(key, t);
    let changed = false;
    if (p.replyAck) changed = settle(p.from, p.replyAck, 'ack') || changed;
    if (p.id) owe(M.buildAckLine({ from, to: p.from, id: p.id }));
    const c = convo(p.from);
    if (p.id && c.msgs.some((m) => m.dir === 'in' && m.id === p.id && m.text === p.text && t - m.at < RETRY_COPY_MS)) {
      return { changed, kind: 'retry-copy', call: p.from };
    }
    c.msgs.push({ lid: `i${t}-${++seq}`, dir: 'in', from: p.from, to: p.addressee, text: p.text, id: p.id, at: t, via });
    c.unread++;
    c.updatedAt = t;
    trim();
    return { changed: true, kind: 'message', call: p.from };
  }

  /**
   * Send what is due. Returns the milliseconds until something is due again,
   * or null when nothing is waiting.
   */
  function tick() {
    const t = clock();
    let wake = null;
    const soon = (ms) => { wake = wake === null ? ms : Math.min(wake, ms); };
    let changed = false;
    const up = !!linkUp();
    if (acksOwed.length) {
      acksOwed = acksOwed.filter((a) => {
        if (t > a.until) return false;
        if (up && sendLine(a.line)) return false;
        soon(LINK_POLL_MS);
        return true;
      });
    }
    for (const c of convos.values()) {
      for (const m of c.msgs) {
        if (m.dir !== 'out' || !IN_FLIGHT.has(m.state)) continue;
        if (m.nextAt > t) { soon(m.nextAt - t); continue; }
        if (m.tries >= MAX_TRIES) { m.state = 'failed'; m.sentence = ''; changed = true; continue; }
        const line = up ? M.buildMessage({ from, to: m.to, text: m.text, id: m.id }) : null;
        if (line && sendLine(line)) {
          m.tries++;
          m.state = 'sending';
          m.lastTryAt = t;
          m.nextAt = t + (m.tries < MAX_TRIES ? RETRY_DELAYS_MS[m.tries - 1] : FINAL_WAIT_MS);
          soon(m.nextAt - t);
          changed = true;
          continue;
        }
        if (t - m.nextAt >= LINK_WAIT_MS) {
          m.state = 'failed';
          m.sentence = 'APRS-IS could not be reached' + (m.tries ? ` after try ${m.tries}` : ', so it was not sent');
          changed = true;
          continue;
        }
        soon(LINK_POLL_MS);
      }
    }
    lastTickChanged = changed;
    return wake;
  }
  let lastTickChanged = false;

  /** True while anything needs the uplink: a message going out or an ack owed. */
  function needsLink() {
    if (acksOwed.length) return true;
    for (const c of convos.values()) if (c.msgs.some((m) => m.dir === 'out' && IN_FLIGHT.has(m.state))) return true;
    return false;
  }

  function markRead(call) {
    const c = convos.get(String(call || '').toUpperCase());
    if (!c || !c.unread) return false;
    c.unread = 0;
    return true;
  }

  function unread() { let n = 0; for (const c of convos.values()) n += c.unread; return n; }

  /** The conversations, newest first: { call, unread, updatedAt, last, lastDir, lastState }. */
  function list() {
    return [...convos.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => {
      const m = c.msgs[c.msgs.length - 1];
      return { call: c.call, unread: c.unread, updatedAt: c.updatedAt, last: m ? m.text : '', lastDir: m ? m.dir : '', lastState: m && m.dir === 'out' ? m.state : '' };
    });
  }

  /** One conversation's messages, each with its status words. */
  function thread(call) {
    const c = convos.get(String(call || '').toUpperCase());
    if (!c) return [];
    return c.msgs.map((m) => Object.assign({}, m, m.dir === 'out' ? { status: statusWords(m) } : {}));
  }

  function remove(call) { return convos.delete(String(call || '').toUpperCase()); }

  function serialize() {
    return { v: 1, nextId, convos: [...convos.values()].map((c) => ({ call: c.call, unread: c.unread, updatedAt: c.updatedAt, msgs: c.msgs })) };
  }

  /** Load a saved file (anything malformed is skipped). In-flight messages end as "Not sent: POTACAT closed". */
  function load(obj) {
    convos = new Map();
    acksOwed = [];
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.convos)) return;
    nextId = Number.isFinite(Number(obj.nextId)) ? Math.floor(Number(obj.nextId)) : 0;
    for (const c of obj.convos.slice(-MAX_CONVOS * 2)) {
      if (!c || typeof c.call !== 'string' || !Array.isArray(c.msgs)) continue;
      const msgs = c.msgs.filter((m) => m && (m.dir === 'in' || m.dir === 'out') && typeof m.text === 'string').slice(-MAX_MSGS).map((m) => {
        const x = Object.assign({}, m, { text: m.text.slice(0, 200) });
        if (x.dir === 'out') {
          if (!STATES.includes(x.state)) x.state = 'failed';
          if (IN_FLIGHT.has(x.state)) { x.state = 'failed'; x.sentence = 'Not sent: POTACAT closed'; x.nextAt = 0; }
        }
        return x;
      });
      convos.set(c.call.toUpperCase(), { call: c.call.toUpperCase(), unread: Math.max(0, Number(c.unread) | 0), updatedAt: Number(c.updatedAt) || 0, msgs });
    }
    trim();
  }

  /** The Settings callsign changed: the source and the "ours" test follow. */
  function setCall(call, b) { from = String(call || '').toUpperCase(); base = M.baseCall(b || call); }

  if (state) load(state);

  return {
    compose, stop, receive, tick, needsLink, markRead, unread, list, thread, remove, serialize, load, setCall,
    get call() { return from; },
    get lastTickChanged() { return lastTickChanged; },
  };
}

module.exports = {
  createMessenger, statusWords, RETRY_DELAYS_MS, MAX_TRIES, FINAL_WAIT_MS, LINK_WAIT_MS, ACK_WAIT_MS,
  DUPE_WINDOW_MS, MAX_CONVOS, MAX_MSGS, STATES,
};
