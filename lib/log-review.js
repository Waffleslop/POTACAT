'use strict';

// Review a JTCAT contact in the Log QSO window before it is written (AE5JE
// 2026-11-02, WSJT-X's "Prompt me to log QSO"). Main holds the whole record,
// because the form has no box for a heard grid, a Field Day exchange or a
// second program's park; Save lays the operator's edits over that record, so
// whatever the form cannot show is kept.
//
// Contacts queue: one form, and the next QSO can finish while it is open.
//
// Pure: main owns the queue, the window and the write.

const CHIPS = ['pota', 'sota', 'wwff', 'llota']; // the form's reference chips
const EDITED_REFS = ['sig', 'sigInfo', 'potaRef', 'sotaRef', 'wwffRef'];
const RESPOT_KEYS = ['respot', 'wwffRespot', 'wwffReference', 'llotaRespot', 'llotaReference', 'dxcRespot', 'respotComment'];

class LogReviewQueue {
  constructor() { this._items = []; this._next = 1; }

  get size() { return this._items.length; }
  get current() { return this._items[0] || null; }
  get waiting() { return Math.max(0, this._items.length - 1); }

  add(record, meta) {
    const item = { id: this._next++, record, meta: meta || {}, shown: false };
    this._items.push(item);
    return item;
  }

  find(id) { return this._items.find((i) => i.id === id) || null; }

  take(id) {
    const i = this._items.findIndex((x) => x.id === id);
    return i < 0 ? null : this._items.splice(i, 1)[0];
  }

  /** A save that failed goes back to the front, still on screen. */
  putBack(item) { this._items.unshift(item); }

  drain() { return this._items.splice(0); }

  /** Waiting to be saved: the automatic paths must treat it as worked. */
  holds(call, band, mode) {
    const c = String(call || '').toUpperCase();
    const b = String(band || '').toUpperCase();
    const m = String(mode || '').toUpperCase();
    return this._items.some((i) => String(i.record.callsign || '').toUpperCase() === c
      && String(i.record.band || '').toUpperCase() === b
      && String(i.record.mode || '').toUpperCase() === m);
  }
}

/** The reference the form can show: the first hunted program that has a chip. */
function shownRef(record) {
  const hunted = Array.isArray(record.hunted) ? record.hunted : [];
  const first = hunted.find((h) => h && CHIPS.includes(String(h.sig || '').toLowerCase()));
  if (!first) return { type: 'dx', ref: '' };
  const sig = String(first.sig).toUpperCase();
  return {
    type: sig.toLowerCase(),
    ref: hunted.filter((h) => String(h.sig || '').toUpperCase() === sig).map((h) => h.ref).join(','),
  };
}

/** The Log QSO window's prefill for a held contact. */
function prefillFor(item, waiting) {
  const r = item.record;
  const { type, ref } = shownRef(r);
  return {
    review: item.id, waiting: waiting || 0, force: true, type, reference: ref,
    callsign: r.callsign, freqKhz: Number(r.frequency) || undefined, mode: r.mode,
    rstSent: r.rstSent, rstRcvd: r.rstRcvd, qsoDate: r.qsoDate, timeOn: r.timeOn, notes: r.comment,
  };
}

/**
 * The record to write: the held one with what the operator changed. A field
 * left as shown keeps its held value (seconds, a frequency's full precision,
 * every park of an n-fer).
 */
function mergeEdits(record, edits) {
  const e = edits || {};
  const out = { ...record };
  const same = (a, b) => String(a == null ? '' : a).trim().toUpperCase() === String(b == null ? '' : b).trim().toUpperCase();

  if (e.callsign && !same(e.callsign, record.callsign)) {
    // What was heard and spotted belonged to the call that was shown.
    out.callsign = e.callsign;
    out.gridsquare = '';
    out.gridHeard = false;
    delete out.hunted;
  }
  const shown = shownRef(record);
  const form = String(e.sigInfo || '').replace(/\s+/g, '');
  const unchanged = same(form, shown.ref.replace(/\s+/g, '')) && (!form || same(e.sig, shown.type));
  if (!unchanged || !out.hunted) {
    delete out.hunted;
    for (const k of EDITED_REFS) { if (e[k]) out[k] = e[k]; else delete out[k]; }
  }
  if (Number.isFinite(Number(e.frequency)) && Number(e.frequency) !== Number(record.frequency)) {
    out.frequency = String(e.frequency);
    out.band = e.band || '';
  }
  if (e.mode && !same(e.mode, record.mode)) out.mode = e.mode;
  const held = String(record.timeOn || '');
  if ((e.qsoDate && e.qsoDate !== record.qsoDate) || (e.timeOn && String(e.timeOn).slice(0, 4) !== held.slice(0, 4))) {
    // A corrected start: the measured end no longer goes with it.
    out.qsoDate = e.qsoDate || record.qsoDate;
    out.timeOn = e.timeOn || held;
    delete out.timeOff;
    delete out.qsoDateOff;
  }
  out.rstSent = e.rstSent != null ? e.rstSent : record.rstSent;
  out.rstRcvd = e.rstRcvd != null ? e.rstRcvd : record.rstRcvd;
  if (e.comment != null) out.comment = e.comment;
  if (e.txPower) out.txPower = e.txPower;
  if (e.logAs) out.logAs = e.logAs;
  for (const k of RESPOT_KEYS) if (e[k] != null) out[k] = e[k];
  return out;
}

module.exports = { LogReviewQueue, prefillFor, mergeEdits, shownRef };
