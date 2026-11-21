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
//
// A3, messages over the radio (Casey 2026-11-21). A message composed with
// over 'radio' never goes to APRS-IS. Its tries are radio jobs: tick() hands
// one job at a time to sendRadio(job) (main runs lib/aprs-rf-beacon.js's
// radio run and the gate) and radioDone(key, result) records how it went.
//  - The first try goes when the operator presses Send. Each later try needs
//    a press (tryAgain), unless radioAutoRetry() is true (a setting that is
//    off by default): then they follow the same schedule as the internet.
//  - A try counts only when the radio run says it went out. A refusal (the
//    gate, a busy channel, the radio's own interlock) ends the message with
//    the refusal's words; nothing keeps trying after a refusal.
//  - A numbered message heard on the radio is acked over the internet, as in
//    A1, and also on the radio when radioAutoAck() is true (a setting that is
//    off by default). One radio try per copy heard; the sender's next copy
//    gets the next ack.
//  - A radio job that cannot start (the radio is busy with another packet)
//    waits up to LINK_WAIT_MS, like a try waiting for APRS-IS.

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
  if (msg.over === 'radio') return radioStatusWords(msg);
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

/** A radio message's words: who has to act next is always clear. */
function radioStatusWords(msg) {
  switch (msg.state) {
    case 'queued': return msg.radioBusy ? 'Sending on the radio' : 'Waiting for the radio';
    case 'sending': {
      if (msg.radioBusy) return `Sending on the radio, try ${msg.tries + 1} of ${MAX_TRIES}`;
      let w = `Sent on the radio, try ${msg.tries} of ${MAX_TRIES}`;
      if (msg.unconfirmed) w += ' (the radio could not confirm it transmitted)';
      if (msg.waitingPress) w += '. No ack yet: press Try again to send it once more';
      return w;
    }
    case 'delivered': return 'Delivered (ack)';
    case 'rejected': return 'Rejected (rej)';
    case 'stopped': return 'Stopped';
    case 'failed': return msg.sentence || `No reply after ${MAX_TRIES} tries on the radio`;
    default: return '';
  }
}

function createMessenger({ now, send, canSend, myCall, myBase, state, sendRadio, radioAutoRetry, radioAutoAck } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const sendLine = typeof send === 'function' ? send : () => false;
  const linkUp = typeof canSend === 'function' ? canSend : () => true;
  const startRadio = typeof sendRadio === 'function' ? sendRadio : () => false;
  const autoRetry = () => typeof radioAutoRetry === 'function' && radioAutoRetry() === true;
  const autoAck = () => typeof radioAutoAck === 'function' && radioAutoAck() === true;
  let radioJob = null; // the one radio job in flight: { key, kind: 'message'|'ack', lid?, to, info }
  let radioAcks = []; // { to, id, until }
  let jobSeq = 0;
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

  /**
   * Queue a message: { ok, msg } or { ok: false, sentence }. It goes out on
   * the next tick(). opts.over: 'internet' (the default) or 'radio' (A3).
   */
  function compose(to, text, opts = {}) {
    if (!from) return { ok: false, sentence: 'Set your callsign in Settings first.' };
    const a = M.checkAddressee(to);
    if (!a.ok) return a;
    if (a.call === from) return { ok: false, sentence: `${a.call} is your own call.` };
    const t = M.checkText(text);
    if (!t.ok) return t;
    nextId = M.nextMessageId(nextId);
    const at = clock();
    const msg = { lid: `o${at}-${++seq}`, dir: 'out', from, to: a.call, text: t.text, id: String(nextId), at, state: 'queued', tries: 0, nextAt: at, lastTryAt: 0, sentence: '' };
    if (opts && opts.over === 'radio') msg.over = 'radio';
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
      if (m && IN_FLIGHT.has(m.state)) { m.state = 'stopped'; m.nextAt = 0; m.waitingPress = false; return true; }
    }
    return false;
  }

  function findMsg(lid) {
    for (const c of convos.values()) { const m = c.msgs.find((x) => x.lid === lid); if (m) return m; }
    return null;
  }

  /**
   * The operator pressed Try again on a radio message: one more try on the
   * next tick(). { ok } or { ok: false, sentence }.
   */
  function tryAgain(lid) {
    const m = findMsg(lid);
    if (!m || m.dir !== 'out' || m.over !== 'radio') return { ok: false, sentence: 'There is no radio message to try again.' };
    if (!IN_FLIGHT.has(m.state)) return { ok: false, sentence: 'This message is no longer going out. Use Send again to write it once more.' };
    if (m.radioBusy) return { ok: false, sentence: 'It is going out on the radio now.' };
    if (m.tries >= MAX_TRIES) return { ok: false, sentence: `It has had ${MAX_TRIES} tries.` };
    m.pressed = true;
    m.waitingPress = false;
    m.nextAt = clock();
    return { ok: true };
  }

  /**
   * How a radio job went. result: lib/aprs-rf-beacon.js send's answer
   * ({ ok, confirmed, sentence } or { ok: false, reason, sentence }).
   * Returns true when a message changed.
   */
  function radioDone(key, result) {
    const job = radioJob;
    if (!job || job.key !== key) return false;
    radioJob = null;
    if (job.kind !== 'message') return false;
    const m = findMsg(job.lid);
    if (!m) return false;
    const t = clock();
    m.radioBusy = false;
    const r = result || { ok: false, sentence: 'The radio gave no answer.' };
    if (r.ok) {
      m.tries++;
      m.lastTryAt = t;
      m.unconfirmed = !r.confirmed;
      if (m.state === 'queued') m.state = 'sending';
      if (m.state === 'sending') m.nextAt = t + (m.tries < MAX_TRIES ? RETRY_DELAYS_MS[m.tries - 1] : FINAL_WAIT_MS);
      return true;
    }
    if (!IN_FLIGHT.has(m.state)) return true; // stopped while it was going out
    const why = String(r.sentence || 'The radio did not send it.').replace(/\.+$/, '');
    m.state = 'failed';
    m.nextAt = 0;
    m.sentence = m.tries ? `Stopped after try ${m.tries}: ${why}` : `Not sent on the radio: ${why}`;
    return true;
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
  function receive(line, { via = 'internet', ownCalls = [] } = {}) {
    const p = M.parseMessageLine(line);
    if (!p || !base || !M.isForMe(p.addressee, base)) return { changed: false, kind: null };
    if (p.from === from) return { changed: false, kind: null }; // our own line coming back
    if (ownCalls.some((c) => String(c || '').toUpperCase() === p.from)) return { changed: false, kind: null }; // our own radio frame, digipeated back
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
    if (p.id && via === 'radio' && autoAck()) radioAcks.push({ to: p.from, id: p.id, until: t + ACK_WAIT_MS });
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
    // A3: radio acks first (they are short and the sender is waiting), one job at a time.
    if (radioAcks.length) {
      radioAcks = radioAcks.filter((a) => {
        if (t > a.until || !autoAck()) return false;
        if (radioJob) { soon(LINK_POLL_MS); return true; }
        const info = M.buildAckInfo({ to: a.to, id: a.id });
        if (!info) return false;
        const job = { key: `a${++jobSeq}`, kind: 'ack', to: a.to, info };
        if (startRadio(job)) { radioJob = job; return false; }
        soon(LINK_POLL_MS);
        return true;
      });
    }
    for (const c of convos.values()) {
      for (const m of c.msgs) {
        if (m.dir !== 'out' || !IN_FLIGHT.has(m.state)) continue;
        if (m.over === 'radio') { if (radioTick(m, t, soon)) changed = true; continue; }
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

  /** One radio message in tick(): its next try, its wait for a press, or its end. Returns changed. */
  function radioTick(m, t, soon) {
    if (m.radioBusy) return false;
    if (m.nextAt > t) { if (m.tries === 0 || m.pressed || autoRetry()) soon(m.nextAt - t); return false; }
    if (m.tries >= MAX_TRIES) { m.state = 'failed'; m.sentence = ''; m.waitingPress = false; return true; }
    if (!(m.tries === 0 || m.pressed || autoRetry())) {
      // Manual retries: the schedule's wait is over and the next try is the operator's press.
      if (m.waitingPress) return false;
      m.waitingPress = true;
      return true;
    }
    if (!radioJob) {
      const info = M.buildMessageInfo({ to: m.to, text: m.text, id: m.id });
      const job = { key: `m${++jobSeq}`, kind: 'message', lid: m.lid, to: m.to, info };
      if (info && startRadio(job)) {
        radioJob = job;
        m.radioBusy = true;
        m.pressed = false;
        m.waitingPress = false;
        return true;
      }
    }
    // The radio is busy with another packet: wait for it, as a try waits for APRS-IS.
    if (t - m.nextAt >= LINK_WAIT_MS) {
      m.state = 'failed';
      m.pressed = false;
      m.sentence = 'The radio stayed busy' + (m.tries ? ` after try ${m.tries}` : ', so it was not sent');
      return true;
    }
    soon(LINK_POLL_MS);
    return false;
  }

  /** True while anything needs the uplink: a message going out or an ack owed. */
  function needsLink() {
    if (acksOwed.length) return true;
    for (const c of convos.values()) if (c.msgs.some((m) => m.dir === 'out' && m.over !== 'radio' && IN_FLIGHT.has(m.state))) return true;
    return false;
  }

  /** True while a radio message or a radio ack waits (main keeps tick() running for it). */
  function needsRadio() {
    if (radioJob || radioAcks.length) return true;
    for (const c of convos.values()) if (c.msgs.some((m) => m.dir === 'out' && m.over === 'radio' && IN_FLIGHT.has(m.state))) return true;
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
    radioAcks = [];
    radioJob = null;
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.convos)) return;
    nextId = Number.isFinite(Number(obj.nextId)) ? Math.floor(Number(obj.nextId)) : 0;
    for (const c of obj.convos.slice(-MAX_CONVOS * 2)) {
      if (!c || typeof c.call !== 'string' || !Array.isArray(c.msgs)) continue;
      const msgs = c.msgs.filter((m) => m && (m.dir === 'in' || m.dir === 'out') && typeof m.text === 'string').slice(-MAX_MSGS).map((m) => {
        const x = Object.assign({}, m, { text: m.text.slice(0, 200) });
        if (x.dir === 'out') {
          if (!STATES.includes(x.state)) x.state = 'failed';
          if (IN_FLIGHT.has(x.state)) { x.state = 'failed'; x.sentence = 'Not sent: POTACAT closed'; x.nextAt = 0; }
          delete x.radioBusy; delete x.pressed; delete x.waitingPress;
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
    compose, stop, tryAgain, radioDone, needsRadio, receive, tick, needsLink, markRead, unread, list, thread, remove, serialize, load, setCall,
    get call() { return from; },
    get radioJob() { return radioJob ? Object.assign({}, radioJob) : null; },
    get lastTickChanged() { return lastTickChanged; },
  };
}

module.exports = {
  createMessenger, statusWords, radioStatusWords, RETRY_DELAYS_MS, MAX_TRIES, FINAL_WAIT_MS, LINK_WAIT_MS, ACK_WAIT_MS,
  DUPE_WINDOW_MS, MAX_CONVOS, MAX_MSGS, STATES, LINK_POLL_MS,
};
