/**
 * lib/cloud-held.js — deletes POTACAT Cloud is holding for the member to
 * review (Cloud handoff 2026-11-26, "held deletes").
 *
 * Since #245 the Cloud does not apply a burst of deletes of live QSOs (more
 * than 25 in an hour from one device): it holds them and the QSOs stay in
 * the Cloud. The push reply lists the held uuids in `held`, and
 * GET /v1/sync/held lists every pending hold for the account. The member
 * settles them with POST /v1/sync/held/resolve:
 *
 *   - `delete`: the Cloud tombstones each QSO and every device pulls that;
 *   - `keep`:   the QSO stays in the Cloud as it is. Devices that already
 *               dropped it locally do not get it back.
 *
 * `restore` (keep and raise the version so devices pull it back) is NOT
 * offered: this desktop's own duplicate guard could delete it again, and
 * the server side of it was not deployed when this was written.
 *
 * This module never touches the local log: the desktop already removed
 * these QSOs from it, and the push path retires its batch whatever the
 * `held` list says. It only reads the Cloud's lists and builds the
 * resolve requests.
 *
 * Pure, dual-mode: `require()` in main, `window.CloudHeld` in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CloudHeld = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The actions this desktop offers. `restore` is deliberately absent. */
  const ACTIONS = ['delete', 'keep'];
  /** The server's cap on uuids per resolve call. */
  const RESOLVE_CHUNK = 5000;
  /** How many holds the review screen asks for. */
  const LIST_LIMIT = 1000;

  const str = (v) => (v === undefined || v === null ? '' : String(v));

  /** The held uuids in a push reply (`held` may be absent on older servers). */
  function heldFromPush(result) {
    const list = result && Array.isArray(result.held) ? result.held : [];
    const out = [];
    for (const u of list) {
      const s = str(u && typeof u === 'object' ? u.uuid : u).trim();
      if (s) out.push(s);
    }
    return out;
  }

  /** YYYYMMDD -> YYYY-MM-DD; anything else as it came. */
  function fmtDate(d) {
    const s = str(d).trim();
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
  }

  /** HHMM or HHMMSS -> HH:MM; anything else as it came. */
  function fmtTime(t) {
    const s = str(t).trim();
    const m = /^(\d{2}):?(\d{2})(?::?\d{2})?$/.exec(s);
    return m ? `${m[1]}:${m[2]}` : s;
  }

  /**
   * GET /v1/sync/held's answer, normalised for the review screen.
   * Rows without a uuid are dropped (nothing could resolve them).
   * @returns {{ rows: object[], total: number }}
   */
  function parseHeldList(resp) {
    const list = resp && Array.isArray(resp.held) ? resp.held : [];
    const rows = [];
    for (const h of list) {
      if (!h || typeof h !== 'object') continue;
      const uuid = str(h.uuid).trim();
      if (!uuid) continue;
      rows.push({
        uuid,
        call: str(h.call).toUpperCase(),
        date: fmtDate(h.qsoDate),
        time: fmtTime(h.timeOn),
        band: str(h.band),
        mode: str(h.mode).toUpperCase(),
        stationCall: str(h.stationCallsign).toUpperCase(),
        deviceId: str(h.deviceId),
        heldAt: str(h.heldAt),
      });
    }
    const t = Number(resp && resp.total);
    const total = Number.isFinite(t) && t >= rows.length ? Math.floor(t) : rows.length;
    return { rows, total };
  }

  /**
   * The resolve request bodies for one action: chunks of at most 5000
   * uuids, or a single `{ action, all: true }`. Duplicates and blanks are
   * dropped. Throws on an action this desktop does not offer.
   * @param {'delete'|'keep'} action
   * @param {{ uuids?: string[], all?: boolean }} sel
   * @returns {object[]}
   */
  function resolveBodies(action, sel = {}) {
    if (!ACTIONS.includes(action)) throw new Error('unsupported action: ' + action);
    if (sel.all === true) return [{ action, all: true }];
    const seen = new Set();
    const uuids = [];
    for (const u of Array.isArray(sel.uuids) ? sel.uuids : []) {
      const s = str(u).trim();
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      uuids.push(s);
    }
    const bodies = [];
    for (let i = 0; i < uuids.length; i += RESOLVE_CHUNK) {
      bodies.push({ action, uuids: uuids.slice(i, i + RESOLVE_CHUNK) });
    }
    return bodies;
  }

  const contacts = (n) => (n === 1 ? '1 contact' : `${n} contacts`);

  /** The one line Settings > Cloud shows; '' when nothing is held. */
  function noticeText(count) {
    const n = Math.floor(Number(count) || 0);
    if (n <= 0) return '';
    return `POTACAT Cloud kept ${contacts(n)} that this computer tried to delete.`;
  }

  /** The line under the review screen's heading. */
  function reviewIntro(shown, total) {
    const lead = 'This computer deleted these contacts. POTACAT Cloud has not deleted them yet.';
    if (total > shown) return `${lead} Showing the newest ${shown} of ${total}.`;
    return lead;
  }

  /** The inline confirmation before a resolve. */
  function confirmText(action, n) {
    if (action === 'delete') return `Delete ${contacts(n)} from POTACAT Cloud? Every device signed in to this account will delete them too.`;
    return `Keep ${contacts(n)} in POTACAT Cloud? They stay in the Cloud. This computer's log does not change.`;
  }

  /** The line after a resolve. */
  function doneText(action, n) {
    if (action === 'delete') return `Deleted ${contacts(n)} from POTACAT Cloud.`;
    return `Kept ${contacts(n)} in POTACAT Cloud.`;
  }

  return {
    ACTIONS, RESOLVE_CHUNK, LIST_LIMIT,
    heldFromPush, parseHeldList, resolveBodies, fmtDate, fmtTime,
    noticeText, reviewIntro, confirmText, doneText,
  };
}));
