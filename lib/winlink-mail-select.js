// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Picking several Winlink messages at once and deleting them together (#346).
// The Winlink window's list (renderer/winlink-popout.js) keeps a selection;
// this module decides what a click does to it and words the bar and its one
// confirm. Deleting still goes one message at a time through the existing
// delete path, so nothing new crosses the ECHOCAT wire.
//
//   pick(sel, mid, how, order)       the selection after a click: plain toggles one,
//                                    shift takes the range from the last pick
//   prune(sel, order)                drop picks that are no longer in the list
//   allOf(order) / none()            select every message / nothing
//   barText(n)                       "3 selected"
//   deleteLabel(box, n)              "Delete selected (3)" / "Delete 3 for good"
//   confirmText(box, n)              the one question asked before deleting
//   progressText(box, i, n)          "Deleting 2 of 3..."
//   resultText(box, ok, failed)      what happened, in one sentence
//
// A selection is { mids: string[], anchor: string|null }, always a new object.
// Pure: no DOM. Dual-mode: require() in tests, window.WinlinkMailSelect in the page.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinlinkMailSelect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DELETED = 'deleted';

  function none() { return { mids: [], anchor: null }; }
  function list(order) { return Array.isArray(order) ? order.map(String) : []; }

  /** Every message in the list, in list order. */
  function allOf(order) {
    var o = list(order);
    return { mids: o, anchor: o.length ? o[o.length - 1] : null };
  }

  /**
   * The selection after a click on one message's box.
   * @param {{mids:string[], anchor:?string}} sel  the selection now
   * @param {string} mid    the message clicked
   * @param {{shift?:boolean}} how  shift = select the range from the last pick to this one
   * @param {string[]} order  the list's message ids, top to bottom
   */
  function pick(sel, mid, how, order) {
    sel = sel || none();
    mid = String(mid);
    var o = list(order);
    var have = (sel.mids || []).filter(function (m) { return o.indexOf(m) >= 0; });
    var at = o.indexOf(mid);
    if (at < 0) return { mids: have, anchor: sel.anchor || null };
    var from = how && how.shift && sel.anchor != null ? o.indexOf(String(sel.anchor)) : -1;
    if (from >= 0) {
      var lo = Math.min(from, at), hi = Math.max(from, at);
      var add = o.slice(lo, hi + 1);
      var set = have.slice();
      add.forEach(function (m) { if (set.indexOf(m) < 0) set.push(m); });
      return { mids: o.filter(function (m) { return set.indexOf(m) >= 0; }), anchor: sel.anchor };
    }
    var on = have.indexOf(mid) >= 0;
    var next = on ? have.filter(function (m) { return m !== mid; }) : have.concat([mid]);
    return { mids: o.filter(function (m) { return next.indexOf(m) >= 0; }), anchor: mid };
  }

  /** The selection with only what is still in the list (after a refresh or a delete). */
  function prune(sel, order) {
    sel = sel || none();
    var o = list(order);
    var mids = (sel.mids || []).filter(function (m) { return o.indexOf(m) >= 0; });
    var anchor = sel.anchor != null && o.indexOf(String(sel.anchor)) >= 0 ? String(sel.anchor) : null;
    return { mids: mids, anchor: mids.length ? anchor : null };
  }

  function messages(n) { return n + (n === 1 ? ' message' : ' messages'); }

  function barText(n) { return (n | 0) + ' selected'; }

  /** The bar's delete button. In Deleted, delete is for good, and says so. */
  function deleteLabel(box, n) {
    return box === DELETED ? 'Delete ' + n + ' for good' : 'Delete selected (' + n + ')';
  }

  /** The one question before deleting; the Deleted folder's is stronger. */
  function confirmText(box, n) {
    if (box === DELETED) return 'Delete ' + messages(n) + ' for good? ' + (n === 1 ? 'It' : 'They') + ' cannot be brought back.';
    return 'Move ' + messages(n) + ' to Deleted? You can restore ' + (n === 1 ? 'it' : 'them') + ' from there.';
  }

  function progressText(box, i, n) { return 'Deleting ' + i + ' of ' + n + '...'; }

  /** One sentence for the end of a run: how many went, how many did not, and the first reason. */
  function resultText(box, ok, failed, firstError) {
    ok = ok | 0; failed = failed | 0;
    var done = ok ? (box === DELETED ? 'Deleted ' + messages(ok) + ' for good.' : 'Moved ' + messages(ok) + ' to Deleted.') : '';
    if (!failed) return done;
    var bad = (failed === 1 ? 'One message was' : failed + ' messages were') + ' not deleted'
      + (firstError ? ': ' + String(firstError).replace(/\.$/, '') + '.' : '.');
    return (done ? done + ' ' : '') + bad;
  }

  return {
    none: none, allOf: allOf, pick: pick, prune: prune,
    barText: barText, deleteLabel: deleteLabel, confirmText: confirmText,
    progressText: progressText, resultText: resultText,
  };
});
