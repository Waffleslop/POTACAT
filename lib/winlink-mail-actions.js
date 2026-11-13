// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// What a Winlink message can do, decided in one place (#462, #475): which
// buttons the reader shows in each folder, where Archive's "Move back" goes,
// who a Reply All is addressed to, and how the Deleted folder words its days.
// The Winlink window (renderer/winlink-popout.js), ECHOCAT Web
// (renderer/remote.js) and main all read these, so every surface offers the
// same actions with the same words.
//
//   FOLDERS / PAT_BOXES / folderName()   the five folders; Pat holds four of them
//   canMove(from, to)                    the moves POTACAT makes
//   readerActions(box, msg, mycall)      the reader's buttons, in order
//   archiveReturnBox(msg, mycall)        Archive's way back: Sent for our own, else Inbox
//   replyAll(msg, mycall)                {to, cc}: the sender; everyone else but us
//   isOwnAddress(addr, mycall)           K3SBP, k3sbp@winlink.org, K3SBP-10 are all us
//   deletedDays(v) / DELETED_DAYS_CHOICES   the purge setting (0 = never)
//   deletedFolderNote() / deletedNote()  the Deleted folder's sentences
//
// Pure: no DOM, no clock (callers pass nowMs). Dual-mode: require() in main
// and tests, window.WinlinkMailActions in the pages.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinlinkMailActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAT_BOXES = ['in', 'out', 'sent', 'archive'];
  var DELETED = 'deleted';
  var FOLDERS = PAT_BOXES.concat([DELETED]);
  var NAMES = { in: 'Inbox', out: 'Outbox', sent: 'Sent', archive: 'Archive', deleted: 'Deleted' };

  var DELETED_DAYS_CHOICES = [7, 30, 90, 0];   // 0 = never
  var DEFAULT_DELETED_DAYS = 30;
  var DAY_MS = 86400000;

  function str(v) { return v == null ? '' : String(v); }
  function folderName(box) { return NAMES[box] || str(box); }

  /**
   * The moves POTACAT makes. Archive from Inbox or Sent and back; anything
   * Pat holds to Deleted (the Outbox too: that takes it out of the queue);
   * Deleted back to any of Pat's folders.
   */
  function canMove(from, to) {
    if (from === to) return false;
    if (from === DELETED) return PAT_BOXES.indexOf(to) >= 0;
    if (to === 'archive') return from === 'in' || from === 'sent';
    if (from === 'archive') return to === 'in' || to === 'sent' || to === DELETED;
    if (to === DELETED) return PAT_BOXES.indexOf(from) >= 0;
    return false;
  }

  /**
   * One address as a key that compares the way an operator means it: a
   * Winlink address is its base callsign (K3SBP, k3sbp@winlink.org and
   * K3SBP-10 are one station); an internet address is itself, lower case.
   */
  function addressKey(addr) {
    var a = str(addr).trim();
    if (!a) return '';
    var at = a.indexOf('@');
    if (at >= 0) {
      var domain = a.slice(at + 1).toLowerCase();
      if (domain !== 'winlink.org') return a.toLowerCase();
      a = a.slice(0, at);
    }
    return a.toUpperCase().replace(/-\d{1,2}$/, '');
  }

  /** The address is this station's own (bare call, call@winlink.org, any case, any SSID). */
  function isOwnAddress(addr, mycall) {
    var me = addressKey(mycall);
    return !!me && addressKey(addr) === me;
  }

  /**
   * Reply All: To = the sender; Cc = everyone the message went to (To and Cc)
   * except this station and the sender, each once, in the order they were
   * written. A message this station sent itself (in Archive) replies to its
   * own recipients instead: To = its To, Cc = its Cc.
   * @returns {{to: string[], cc: string[]}}
   */
  function replyAll(msg, mycall) {
    msg = msg || {};
    var seen = {};
    var take = function (list) {
      var out = [];
      (Array.isArray(list) ? list : []).forEach(function (a) {
        var k = addressKey(a);
        if (!k || seen[k] || isOwnAddress(a, mycall)) return;
        seen[k] = true;
        out.push(str(a).trim());
      });
      return out;
    };
    var from = str(msg.from).trim();
    if (from && !isOwnAddress(from, mycall)) {
      var to = take([from]);
      return { to: to, cc: take([].concat(msg.to || [], msg.cc || [])) };
    }
    var to2 = take(msg.to);
    return { to: to2, cc: take(msg.cc) };
  }

  /** "Re: <subject>", once. */
  function replySubject(subject) {
    var s = str(subject);
    return /^re:/i.test(s) ? s : 'Re: ' + s;
  }

  /** Archive's way back: our own message goes to Sent, anything else to Inbox. */
  function archiveReturnBox(msg, mycall) {
    return msg && isOwnAddress(msg.from, mycall) ? 'sent' : 'in';
  }

  /**
   * The reader's buttons for one message, in display order. Each is
   * {id, label, danger?, to?}. Reply and Reply all only on mail from someone
   * else; Reply all only when there is someone besides the sender to reach.
   * ids: reply | reply-all | forward | archive | move-back | delete | restore | delete-for-good
   */
  function readerActions(box, msg, mycall) {
    msg = msg || {};
    var acts = [];
    var fromOther = !!str(msg.from).trim() && !isOwnAddress(msg.from, mycall);
    if (box === DELETED) {
      var back = PAT_BOXES.indexOf(msg.fromBox) >= 0 ? msg.fromBox : 'in';
      acts.push({ id: 'restore', label: 'Restore to ' + folderName(back), to: back });
      acts.push({ id: 'delete-for-good', label: 'Delete for good', danger: true });
      return acts;
    }
    if ((box === 'in' || box === 'archive') && fromOther) {
      acts.push({ id: 'reply', label: 'Reply' });
      if (replyAll(msg, mycall).cc.length) acts.push({ id: 'reply-all', label: 'Reply all' });
    }
    acts.push({ id: 'forward', label: 'Forward' });
    if (box === 'in' || box === 'sent') acts.push({ id: 'archive', label: 'Archive', to: 'archive' });
    if (box === 'archive') {
      var ret = archiveReturnBox(msg, mycall);
      acts.push({ id: 'move-back', label: 'Move to ' + folderName(ret), to: ret });
    }
    if (PAT_BOXES.indexOf(box) >= 0) acts.push({ id: 'delete', label: box === 'out' ? 'Delete (do not send)' : 'Delete', danger: true, to: DELETED });
    return acts;
  }

  /** The purge setting: 7, 30 or 90 days, or 0 for never. Anything else is the default. */
  function deletedDays(v) {
    if (v === 'never' || v === 0 || v === '0') return 0;
    var n = parseInt(v, 10);
    return DELETED_DAYS_CHOICES.indexOf(n) >= 0 ? n : DEFAULT_DELETED_DAYS;
  }

  /** The words for one choice: "30 days", "Never". */
  function daysChoiceLabel(n) {
    return n === 0 ? 'Never' : n + ' days';
  }

  /** The line at the top of the Deleted folder. */
  function deletedFolderNote(days) {
    var d = deletedDays(days);
    return d ? 'Deleted messages are removed for good after ' + d + ' days.' : 'Deleted messages stay here until you delete them for good.';
  }

  /** Whole days until a deleted message is removed for good (0 = today), or null with no limit. */
  function daysLeft(deletedAt, days, nowMs) {
    var d = deletedDays(days);
    var t = new Date(deletedAt).getTime();
    if (!d || isNaN(t)) return null;
    return Math.max(0, Math.ceil((t + d * DAY_MS - nowMs) / DAY_MS));
  }

  /** "Deleted from Inbox. Removed for good in 12 days." for the reader of a deleted message. */
  function deletedNote(msg, days, nowMs) {
    msg = msg || {};
    var t = 'Deleted from ' + folderName(PAT_BOXES.indexOf(msg.fromBox) >= 0 ? msg.fromBox : 'in') + '.';
    var left = daysLeft(msg.deletedAt, days, nowMs);
    if (left == null) return t;
    return t + (left === 0 ? ' Removed for good today.' : ' Removed for good in ' + left + (left === 1 ? ' day.' : ' days.'));
  }

  var DELETE_FOR_GOOD_CONFIRM = 'Delete for good? It cannot be brought back.';

  return {
    PAT_BOXES: PAT_BOXES, DELETED: DELETED, FOLDERS: FOLDERS, folderName: folderName,
    canMove: canMove, addressKey: addressKey, isOwnAddress: isOwnAddress,
    replyAll: replyAll, replySubject: replySubject, archiveReturnBox: archiveReturnBox,
    readerActions: readerActions,
    DELETED_DAYS_CHOICES: DELETED_DAYS_CHOICES, DEFAULT_DELETED_DAYS: DEFAULT_DELETED_DAYS,
    deletedDays: deletedDays, daysChoiceLabel: daysChoiceLabel, deletedFolderNote: deletedFolderNote,
    daysLeft: daysLeft, deletedNote: deletedNote, DELETE_FOR_GOOD_CONFIRM: DELETE_FOR_GOOD_CONFIRM,
  };
});
