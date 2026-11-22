// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS message templates (A2): pick one and it fills the compose box's To and
// Text; nothing is sent until the operator presses Send (the send is A1's,
// lib/aprs-messenger.js). Pure: the activation and the radio come in as a
// context object from main.js; the operator's own templates are a list kept
// in the profile's settings (aprsMsgTemplates).
//
// Every built-in format and its source (each read 2026-11-20):
//  - Group CQ, Join APRSThursday: ANSRVR, the announcement server. The
//    #APRSThursday page (aprs.to/events/aprs_thursday/about/): send ANSRVR
//    "CQ [space] HOTG [space] Your message text..."; the group word goes
//    where HOTG is for any other ANSRVR group.
//  - Leave APRSThursday: same page, "send it this follow-up message to
//    unjoin: U [space] HOTG".
//  - Email: EMAIL-2, the javAPRSSrvr email gateway (aprs-is.net/Email.aspx):
//    the email address as the first word, then the text. "Sending is
//    interactive. It requires numbered messages, proper ack handling" (A1
//    numbers every message and retries until the ack).
//  - Weather report: WXBOT (KI6WJP, sites.google.com/site/ki6wjp/wxbot):
//    "City,ST must be the first part of the message", or a 5-digit zip
//    ("Tomorrow 96067").
//
// Held back, not shown (listed in HELD with the reason; each is one entry to
// move into BUILT_IN once its format is confirmed or Casey says so):
//  - POTA spot through APSPOT ("! POTA <PARK> <FREQ> <MODE>"): a third-party
//    gateway; the A-list plan leaves it to Casey and its own site
//    (apspot.radio) could not be read, only a blog post (hamradio.my).
//  - SOTA spot through APRS2SOTA: no published format found to check the
//    field order against (the plan: "check exact order").
//  - WHO-IS: only second-hand descriptions found ("check" in the plan).
//  - SMS through SMSGTE: forum posts only ("check before shipping").
//
// Fields: <PARK> <SUMMIT> <FREQ> <MODE> <CALL> are filled from the context
// (the running activation, else the radio's dial and mode; the Settings
// callsign). Any other <FIELD> is left for the operator, and the window will
// not send while one is left.
//
// Dual-mode: require() in main and tests, window.AprsTemplates in the window.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsTemplates = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TEXT = 67;
  const MAX_MINE = 30;
  const MAX_NAME = 30;
  const FIELD_RE = /<[A-Z][A-Za-z0-9 ,]*>/g;
  const AUTO_FIELDS = ['PARK', 'SUMMIT', 'FREQ', 'MODE', 'CALL'];

  const BUILT_IN = Object.freeze([
    { group: 'Groups and nets', items: [
      { id: 'ansrvr-cq', name: 'Group CQ', to: 'ANSRVR', text: 'CQ <GROUP> <TEXT>',
        hint: 'ANSRVR passes your text to everyone who joined that group. Replace <GROUP> and <TEXT>.' },
      { id: 'hotg-join', name: 'Join APRSThursday', to: 'ANSRVR', text: 'CQ HOTG <TEXT>',
        hint: 'APRSThursday runs every Thursday, 00:00 to 23:59 UTC. Replace <TEXT> with your check-in.' },
      { id: 'hotg-leave', name: 'Leave APRSThursday', to: 'ANSRVR', text: 'U HOTG',
        hint: 'Stops the APRSThursday group messages coming to you.' },
    ] },
    { group: 'Gateways', items: [
      { id: 'email', name: 'Email', to: 'EMAIL-2', text: '<ADDRESS> <TEXT>',
        hint: 'The email address first, then your text. EMAIL-2 acks once the email has gone.' },
      { id: 'wxbot', name: 'Weather report', to: 'WXBOT', text: '<City,ST or ZIP>',
        hint: 'A US city as City,ST (no space before the comma), or a 5-digit zip code.' },
    ] },
  ]);

  const HELD = Object.freeze([
    { id: 'apspot-pota', name: 'POTA spot (APSPOT)', to: 'APSPOT', text: '! POTA <PARK> <FREQ> <MODE>', reason: 'third-party gateway: Casey decides; its own site could not be read' },
    { id: 'aprs2sota', name: 'SOTA spot', to: 'APRS2SOTA', text: '<CALL> <SUMMIT> <FREQ> <MODE> <COMMENT>', reason: 'no published format found to check the field order' },
    { id: 'who-is', name: 'Where is a station', to: 'WHO-IS', text: '<CALL>', reason: 'only second-hand descriptions found' },
    { id: 'sms', name: 'SMS', to: 'SMSGTE', text: '@<NUMBER> <TEXT>', reason: 'forum posts only' },
  ]);

  function findBuiltIn(id) {
    for (const g of BUILT_IN) for (const t of g.items) if (t.id === id) return t;
    return null;
  }

  /** The fields still in a text: ['<GROUP>', '<TEXT>']. */
  function unfilled(text) { return String(text || '').match(FIELD_RE) || []; }

  /**
   * Fill a template from the context.
   * ctx: { park, summit, freq, mode, call } (strings, '' when unknown).
   * Returns { to, text, hint, filled: ['PARK', ...], left: ['<TEXT>', ...], length, fits }.
   */
  function fill(tpl, ctx) {
    const c = ctx || {};
    const filled = [];
    const text = String((tpl && tpl.text) || '').replace(FIELD_RE, (f) => {
      const k = f.slice(1, -1).toUpperCase();
      const v = AUTO_FIELDS.includes(k) ? String(c[k.toLowerCase()] || '').trim() : '';
      if (!v) return f;
      if (!filled.includes(k)) filled.push(k);
      return v;
    });
    const left = unfilled(text);
    return { to: String((tpl && tpl.to) || '').toUpperCase(), text, hint: (tpl && tpl.hint) || '', filled, left, length: text.length, fits: text.length <= MAX_TEXT };
  }

  /** "Filled from your activation: park, frequency and mode; callsign from Settings", or ''. */
  function filledWords(filled, running) {
    const words = { PARK: 'park', SUMMIT: 'summit', FREQ: 'frequency', MODE: 'mode' };
    const f = filled || [];
    const w = f.map((k) => words[k]).filter(Boolean);
    const list = w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
    const parts = [];
    if (w.length) parts.push((running ? 'Filled from your activation: ' : 'Filled from your radio: ') + list);
    if (f.includes('CALL')) parts.push(w.length ? 'callsign from Settings' : 'Filled from Settings: callsign');
    return parts.join('; ');
  }

  function cleanName(n) { return String(n || '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME); }
  function cleanTo(t) { return String(t || '').toUpperCase().trim(); }
  function cleanTpl(t) { return String(t || '').replace(/[^\x20-\x7e]/g, ' ').replace(/[|~{]/g, '').trim(); }

  /** The saved list as it should be: at most 30, each { id, name, to, text } with a To APRS can send to. */
  function normalizeMine(list) {
    const out = [];
    const ids = new Set();
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || typeof t !== 'object') continue;
      const to = cleanTo(t.to);
      const text = cleanTpl(t.text);
      const name = cleanName(t.name);
      const id = String(t.id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
      if (!id || ids.has(id) || !/^[A-Z0-9-]{1,9}$/.test(to) || !text || text.length > MAX_TEXT || !name) continue;
      ids.add(id);
      out.push({ id, name, to, text });
      if (out.length >= MAX_MINE) break;
    }
    return out;
  }

  /**
   * Save the compose box as one of my templates. Returns { ok, list, tpl } or { ok: false, sentence }.
   * The same name replaces the old one.
   */
  function saveMine(list, { name, to, text } = {}, idSeed) {
    const mine = normalizeMine(list);
    const n = cleanName(name);
    const t = cleanTo(to);
    const x = cleanTpl(text);
    if (!n) return { ok: false, sentence: 'Give the template a name.' };
    if (!t) return { ok: false, sentence: 'Type who the message is to first.' };
    if (!/^[A-Z0-9-]{1,9}$/.test(t)) return { ok: false, sentence: `${t} is not a call APRS can send to.` };
    if (!x) return { ok: false, sentence: 'Type the message first.' };
    if (x.length > MAX_TEXT) return { ok: false, sentence: `The message is ${x.length} characters; APRS takes at most ${MAX_TEXT}.` };
    const same = mine.findIndex((m) => m.name.toLowerCase() === n.toLowerCase());
    if (same < 0 && mine.length >= MAX_MINE) return { ok: false, sentence: `You have ${MAX_MINE} templates. Delete one first.` };
    const tpl = { id: same >= 0 ? mine[same].id : 'm' + String(idSeed || Date.now()).replace(/\D/g, '').slice(-12), name: n, to: t, text: x };
    if (same >= 0) mine[same] = tpl; else mine.push(tpl);
    return { ok: true, list: mine, tpl };
  }

  function removeMine(list, id) { return normalizeMine(list).filter((m) => m.id !== String(id || '')); }

  return { MAX_TEXT, MAX_MINE, MAX_NAME, BUILT_IN, HELD, AUTO_FIELDS, findBuiltIn, unfilled, fill, filledWords, normalizeMine, saveMine, removeMine };
});
