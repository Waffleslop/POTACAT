// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink mail + session state, held in MAIN (pure, unit-tested).
//
// The popout, ECHOCAT Web and the phone all render ONE payload built here
// (the JS8 threads precedent, lib/js8call-threads.js): unread counts survive
// the window closing, a phone that connects mid-session sees the session, and
// no surface keeps its own copy of the mailbox.
//
// Pat's mailbox on disk is the source of truth; this is a cache of the lists
// POTACAT last fetched, plus the session POTACAT is running.

'use strict';

const BOXES = Object.freeze(['in', 'out', 'sent', 'archive']);
const SESSION_STATES = Object.freeze(['idle', 'starting', 'connecting', 'connected', 'disconnecting', 'done', 'error']);
const MAX_LIST = 500;

function _idleSession() {
  return {
    state: 'idle', mode: '', gateway: '', dialKhz: null,
    text: '', direction: '', pct: 0, bytes: 0, total: 0, subject: '',
    sent: 0, received: 0, ptt: false,
    startedAt: 0, capSec: 0, lastProgressAt: 0,
    error: '', prompt: null, returnTo: null, tuned: false,
  };
}

class WinlinkState {
  constructor() {
    this.clear();
  }

  clear() {
    this._boxes = { in: [], out: [], sent: [], archive: [] };
    this._totals = { in: 0, out: 0, sent: 0, archive: 0 };
    this._session = _idleSession();
    this._gateways = { mode: '', band: '', list: [], at: 0 };
    this._modes = [];
    this._pat = { ready: false, error: '', version: '' };
    this._autoCheck = { enabled: false, min: 30, lastAt: 0, lastResult: '' };
  }

  /** Replace one folder's list (Pat's own newest-first order is kept). */
  applyMailbox(box, list) {
    if (!BOXES.includes(box)) return false;
    const all = (Array.isArray(list) ? list : []).filter((m) => m && m.mid);
    this._totals[box] = all.length;
    this._boxes[box] = all.slice(0, MAX_LIST); // Pat lists newest first
    return true;
  }

  /** How many messages the folder really holds (the list is capped at MAX_LIST). */
  total(box) {
    return BOXES.includes(box) ? Math.max(this._totals[box] || 0, this._boxes[box].length) : 0;
  }

  list(box) {
    return BOXES.includes(box) ? this._boxes[box].slice() : [];
  }

  find(box, mid) {
    return BOXES.includes(box) ? this._boxes[box].find((m) => m.mid === mid) || null : null;
  }

  markRead(mid) {
    const m = this._boxes.in.find((x) => x.mid === mid);
    if (!m || m.read) return false;
    m.read = true;
    return true;
  }

  remove(box, mid) {
    if (!BOXES.includes(box)) return false;
    const before = this._boxes[box].length;
    this._boxes[box] = this._boxes[box].filter((m) => m.mid !== mid);
    const removed = this._boxes[box].length !== before;
    if (removed && this._totals[box]) this._totals[box] -= 1;
    return removed;
  }

  get totalUnread() {
    return this._boxes.in.reduce((n, m) => n + (m.read ? 0 : 1), 0);
  }

  counts() {
    const out = {};
    for (const b of BOXES) out[b] = this.total(b);
    return out;
  }

  setPat(p) {
    this._pat = { ...this._pat, ...(p || {}) };
  }

  setModes(list) {
    this._modes = Array.isArray(list) ? list.map((m) => ({ id: m.id, available: !!m.available, reason: m.reason || '', label: m.label || m.id })) : [];
  }

  setAutoCheck(a) {
    this._autoCheck = { ...this._autoCheck, ...(a || {}) };
  }

  setGateways(mode, band, list) {
    this._gateways = { mode: mode || '', band: band || '', list: Array.isArray(list) ? list.slice(0, 200) : [], at: Date.now() };
  }

  gateways() {
    return { ...this._gateways, list: this._gateways.list.slice() };
  }

  get session() {
    return { ...this._session };
  }

  /**
   * Merge a session change. Moving to 'starting' resets the session; a state
   * outside SESSION_STATES is ignored (a typo can never wedge the UI).
   */
  setSession(patch = {}) {
    if (patch.state && !SESSION_STATES.includes(patch.state)) return false;
    if (patch.state === 'starting') this._session = { ..._idleSession(), startedAt: Date.now() };
    this._session = { ...this._session, ...patch };
    return true;
  }

  /** A Pat progress frame (classifyPatEvent kind 'progress'). */
  applyProgress(ev) {
    if (!ev) return;
    const s = this._session;
    s.direction = ev.direction || s.direction;
    s.subject = ev.subject || s.subject;
    s.bytes = ev.bytes || 0;
    s.total = ev.total || 0;
    s.pct = ev.pct || 0;
    s.lastProgressAt = Date.now();
    if (ev.done) {
      if (ev.direction === 'sending') s.sent += 1;
      else if (ev.direction === 'receiving') s.received += 1;
    }
  }

  /** Seconds left before the session cap, or null with no cap / no session. */
  remainingSec(now = Date.now()) {
    const s = this._session;
    if (!s.capSec || !s.startedAt || !['connecting', 'connected'].includes(s.state)) return null;
    return Math.max(0, Math.round(s.capSec - (now - s.startedAt) / 1000));
  }

  /**
   * The ONE payload every surface renders. Message bodies are never in it
   * (they go to the asker only); the folder lists are, so a phone shows the
   * inbox at connect.
   */
  snapshot(extra = {}) {
    return {
      ...extra,
      patReady: !!this._pat.ready,
      patError: this._pat.error || '',
      modes: this._modes.slice(),
      unread: this.totalUnread,
      counts: this.counts(),
      session: { ...this._session, remainingSec: this.remainingSec() },
      autoCheck: { ...this._autoCheck },
    };
  }
}

module.exports = { WinlinkState, BOXES, SESSION_STATES, MAX_LIST };
