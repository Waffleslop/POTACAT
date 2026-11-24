// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink catalog requests: the rules (pure, unit-tested). Design, facts and
// sources: docs/winlink-catalog.md.
//
// Winlink mails you things on request: propagation forecasts, weather text,
// gateway lists, help files. A request is an ordinary message To INQUIRY,
// Subject REQUEST, with one item ID per line in the body. Each item comes
// back as its own message on a later connect. The body LIST returns the whole
// catalog as one text table.
//
// What this module holds:
//   - a short starter list in POTACAT's own words (IDs are facts about the
//     service; no list file or description text of Winlink's or of any other
//     program is in this repository);
//   - parseCatalogList: Winlink's LIST reply as items. The reply is
//     recognised by its table, never by its sender or subject;
//   - the view (starter names over the full list), groups, search;
//   - buildRequests: the messages for a set of IDs, at most 10 IDs each;
//   - sizeAdvice: one plain line when a selection is large for a radio link.
//     It is advice and never blocks;
//   - the operator's picks (starred and recently requested), the pending
//     LIST request, and every sentence the panel shows (TEXT), so the mail
//     window and a phone say the same words.
//
// Catalog text arrives in mail, so it is untrusted: categories and IDs are
// held to letters, digits, dot, underscore and hyphen; a subject is plain
// text that a surface must show as text (textContent), never as HTML.
//
// Dual-mode: require() in main and tests, window.WinlinkCatalog in the mail
// window. Plain ES5, no dependencies.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinlinkCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── the request ────────────────────────────────────────────────────────────

  var REQUEST_TO = 'INQUIRY';
  var REQUEST_SUBJECT = 'REQUEST';
  var LIST_COMMAND = 'LIST';
  /**
   * IDs per request message. Winlink states no limit; a third-party note says
   * 10. Ten per message is safe whichever is true: a longer request goes out
   * as several messages.
   */
  var MAX_IDS_PER_MESSAGE = 10;
  /** The most one press of Put in Outbox queues (20 messages). */
  var MAX_IDS_PER_REQUEST = 200;

  /** A category or an item ID: one word of letters, digits, dot, underscore, hyphen. */
  var WORD_RE = /^[A-Za-z0-9._-]{1,40}$/;
  function isId(v) { return typeof v === 'string' && WORD_RE.test(v); }

  function uniqueIds(ids, max) {
    var out = [];
    var seen = {};
    var list = Array.isArray(ids) ? ids : [];
    for (var i = 0; i < list.length && out.length < max; i++) {
      var id = list[i];
      if (!isId(id) || seen['$' + id]) continue;
      seen['$' + id] = true;
      out.push(id);
    }
    return out;
  }

  /**
   * The messages that ask for these items: each {to, subject, body, ids},
   * at most 10 IDs in one, one ID per line, in the order given. IDs go out
   * exactly as the catalog spells them (whether Winlink minds the case is
   * not known). Anything that is not an ID is dropped, never repaired.
   */
  function buildRequests(ids) {
    var clean = uniqueIds(ids, MAX_IDS_PER_REQUEST);
    var out = [];
    for (var i = 0; i < clean.length; i += MAX_IDS_PER_MESSAGE) {
      var part = clean.slice(i, i + MAX_IDS_PER_MESSAGE);
      out.push({ to: REQUEST_TO, subject: REQUEST_SUBJECT, body: part.join('\n'), ids: part });
    }
    return out;
  }

  /** The message that asks Winlink for the whole catalog. */
  function listRequest() {
    return { to: REQUEST_TO, subject: REQUEST_SUBJECT, body: LIST_COMMAND };
  }

  /** Is one of these To addresses Winlink's catalog address (INQUIRY, or INQUIRY@winlink.org)? */
  function isCatalogAddress(to) {
    var parts = String(to == null ? '' : to).split(/[,;\s]+/);
    for (var i = 0; i < parts.length; i++) {
      if (/^inquiry(@winlink\.org)?$/i.test(parts[i])) return true;
    }
    return false;
  }

  // ── the starter list ───────────────────────────────────────────────────────
  // Shown before the operator has the full catalog. Only IDs seen in two
  // independent public sources or in an official Winlink source
  // (docs/winlink-catalog.md has the table). The names are POTACAT's own. No
  // sizes: they come with the full catalog.

  var STARTER = [
    { category: 'PROPAGATION', id: 'PROP_3DAY', name: 'Three-day propagation forecast' },
    { category: 'PROPAGATION', id: 'PROP_WWV', name: 'WWV solar and geomagnetic report' },
    { category: 'WL2K_RMS', id: 'PUB_ARDOP', name: 'ARDOP gateways and frequencies' },
    { category: 'WL2K_RMS', id: 'PUB_PACKET', name: 'Packet gateways and frequencies (large)' },
    { category: 'WL2K_RMS', id: 'PUB_PACTOR', name: 'Pactor gateways and frequencies' },
    { category: 'WL2K_USERS', id: 'WL2K_NEARBY', name: 'The 30 stations nearest your last position report', note: 'Needs a position report first (Templates > Position report).' },
    { category: 'WL2K_USERS', id: 'WL2K_MOBILES', name: 'Stations that posted a position in the last 30 days' },
    { category: 'WL2K_HELP', id: 'DIDUNO', name: 'Winlink hints and tips' },
    { category: 'WL2K_HELP', id: 'USER.OPTIONS', name: 'Account options you can set by message' },
  ];

  /** Friendly names for the categories POTACAT names; the order they are shown in. */
  var CATEGORY_NAMES = { PROPAGATION: 'Propagation', WL2K_RMS: 'Gateway lists', WL2K_USERS: 'Stations', WL2K_HELP: 'Help' };
  var CATEGORY_ORDER = ['PROPAGATION', 'WL2K_RMS', 'WL2K_USERS', 'WL2K_HELP'];

  /**
   * A category as the operator reads it: the four above by name; WX_... as
   * "Weather: " and the rest of the code with spaces; any other code as it is.
   */
  function categoryName(code) {
    var c = String(code == null ? '' : code);
    var up = c.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(CATEGORY_NAMES, up)) return CATEGORY_NAMES[up];
    if (/^WX_./.test(up)) return 'Weather: ' + c.slice(3).replace(/_/g, ' ');
    return c;
  }

  // ── reading Winlink's LIST reply ───────────────────────────────────────────

  var MAX_ITEMS = 5000;
  var MAX_SUBJECT = 200;
  var MAX_LINE = 1000;
  /** A reply is read up to this many characters (the real one is about 70,000). */
  var MAX_TEXT = 2000000;
  var MIN_ROWS = 20;
  var MIN_ROW_SHARE = 0.8;
  /** looksLikeCatalog: a message smaller than this is not the catalog. */
  var LIST_MIN_BYTES = 5000;

  var HEADER_RE = /CATEGORY.*INQUIRY_ID.*SUBJECT/i;
  var MODIFIED_RE = /Global_Modified:\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/i;
  var RIGHT_RE = /^\s*(\d{1,9})?\s*(\d{4}\/\d{2}\/\d{2}(?:\s+\d{2}:\d{2})?)?\s*(\[[A-Za-z]\])?\s*$/;

  /** One table line as an item, or null when it is not a row. */
  function parseRow(line) {
    var a = line.indexOf('"');
    var b = line.lastIndexOf('"');
    if (a < 0 || b <= a) return null;
    var left = line.slice(0, a).trim().split(/\s+/);
    if (left.length !== 2 || !WORD_RE.test(left[0]) || !WORD_RE.test(left[1])) return null;
    var subject = line.slice(a + 1, b).trim().slice(0, MAX_SUBJECT);
    var right = line.slice(b + 1);
    var size = null;
    var m = RIGHT_RE.exec(right);
    if (m) { if (m[1]) size = Number(m[1]); }
    else {
      // Columns POTACAT does not know after the subject: a leading whole number is still the size.
      var n = /^\s*(\d{1,9})(?=\s|$)/.exec(right);
      if (n) size = Number(n[1]);
    }
    return { category: left[0], id: left[1], subject: subject, size: size };
  }

  /**
   * Winlink's LIST reply as items.
   *   { ok, items: [{category, id, subject, size}], modified, reason, skipped, firstLine }
   * - The header is the first line holding CATEGORY, INQUIRY_ID and SUBJECT in
   *   that order (any case). None: reason 'no-header'.
   * - "Global_Modified: YYYY/MM/DD HH:MM" above the table is `modified`.
   * - A row is CATEGORY ID "Subject" SIZE DATE [flag]; size, date and flag may
   *   be missing (size null). Tabs, runs of spaces, CRLF and trailing spaces
   *   are fine. A line that is not a row is skipped and counted.
   * - It is a catalog only with at least 20 rows that are at least 80% of the
   *   non-blank lines after the header. Otherwise reason 'not-a-table', and
   *   `firstLine` is the first non-blank line after the header (120 characters).
   * - IDs are kept as written. A second row with the same ID is dropped.
   *   At most 5,000 items; a subject is cut at 200 characters.
   * Never throws.
   */
  function parseCatalogList(text) {
    var out = { ok: false, items: [], modified: '', reason: 'no-header', skipped: 0, firstLine: '' };
    if (typeof text !== 'string' || !text) return out;
    var lines = text.slice(0, MAX_TEXT).split(/\r\n|\r|\n/);
    var h = -1;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.length > MAX_LINE) continue;
      if (!out.modified) { var mm = MODIFIED_RE.exec(l); if (mm) out.modified = mm[1].replace(/\s+/, ' '); }
      if (HEADER_RE.test(l)) { h = i; break; }
    }
    if (h < 0) { out.modified = ''; return out; }
    var items = [];
    var seen = {};
    var rows = 0;
    var nonBlank = 0;
    for (var j = h + 1; j < lines.length; j++) {
      var line = lines[j];
      if (!line || !line.trim()) continue;
      nonBlank++;
      if (!out.firstLine) out.firstLine = line.trim().slice(0, 120);
      var row = line.length > MAX_LINE ? null : parseRow(line);
      if (!row) { out.skipped++; continue; }
      rows++;
      if (seen['$' + row.id] || items.length >= MAX_ITEMS) continue;
      seen['$' + row.id] = true;
      items.push(row);
    }
    if (rows < MIN_ROWS || rows < nonBlank * MIN_ROW_SHARE) { out.reason = 'not-a-table'; return out; }
    out.ok = true;
    out.items = items;
    out.reason = '';
    return out;
  }

  /**
   * The cheap check before a message is parsed: over 5,000 characters and
   * holding INQUIRY_ID (the table's header word) in any case.
   */
  function looksLikeCatalog(message) {
    var body = message && typeof message.body === 'string' ? message.body : '';
    if (body.length <= LIST_MIN_BYTES) return false;
    return /INQUIRY_ID/i.test(body);
  }

  // ── one view from two sources ──────────────────────────────────────────────

  function starterById() {
    var m = {};
    for (var i = 0; i < STARTER.length; i++) m['$' + STARTER[i].id] = STARTER[i];
    return m;
  }

  /**
   * What the panel lists: {full, items: [{category, id, name, subject, size, note}]}.
   * With a full catalog (its items), that list, with POTACAT's name and note
   * on the items the starter list covers. Without one, the starter list.
   */
  function mergeCatalog(fullItems) {
    var full = Array.isArray(fullItems) ? fullItems : [];
    var items = [];
    var i;
    if (!full.length) {
      for (i = 0; i < STARTER.length; i++) {
        items.push({ category: STARTER[i].category, id: STARTER[i].id, name: STARTER[i].name, subject: '', size: null, note: STARTER[i].note || '' });
      }
      return { full: false, items: items };
    }
    var ours = starterById();
    for (i = 0; i < full.length && items.length < MAX_ITEMS; i++) {
      var f = full[i];
      if (!f || !isId(f.id) || !isId(f.category)) continue;
      var s = ours['$' + f.id];
      items.push({
        category: f.category, id: f.id, name: s ? s.name : '',
        subject: String(f.subject == null ? '' : f.subject).slice(0, MAX_SUBJECT),
        size: typeof f.size === 'number' && isFinite(f.size) && f.size >= 0 ? f.size : null,
        note: s && s.note ? s.note : '',
      });
    }
    return { full: true, items: items };
  }

  /** What a row is called: POTACAT's name, else Winlink's subject, else the ID. */
  function itemLabel(item) {
    return (item && (item.name || item.subject || item.id)) || '';
  }

  /**
   * Items by category: [{code, name, items}]. POTACAT's four categories
   * first, in a fixed order; the rest by their shown name. Items keep the
   * catalog's order.
   */
  function groupItems(items) {
    var by = {};
    var order = [];
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var key = '$' + list[i].category;
      if (!by[key]) { by[key] = { code: list[i].category, name: categoryName(list[i].category), items: [] }; order.push(by[key]); }
      by[key].items.push(list[i]);
    }
    var rank = function (g) { var r = CATEGORY_ORDER.indexOf(String(g.code).toUpperCase()); return r < 0 ? CATEGORY_ORDER.length : r; };
    order.sort(function (a, b) {
      var d = rank(a) - rank(b);
      if (d) return d;
      var x = a.name.toLowerCase(), y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return order;
  }

  /**
   * Does a group start open? All of them with the short list. With the full
   * catalog only a group holding one of the operator's picks, and every group
   * shown while finding (those are the groups with a match).
   */
  function groupStartsOpen(group, o) {
    o = o || {};
    if (!o.full || o.finding) return true;
    var picks = Array.isArray(o.pickIds) ? o.pickIds : [];
    var items = (group && group.items) || [];
    for (var i = 0; i < items.length; i++) if (picks.indexOf(items[i].id) >= 0) return true;
    return false;
  }

  /**
   * Items whose name, subject, ID or category (code or shown name) hold every
   * word of the query, any case. A label that starts with the query comes
   * first. An empty query matches none.
   */
  function searchItems(items, query, limit) {
    var words = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var q = words.join(' ');
    var list = Array.isArray(items) ? items : [];
    var first = [];
    var rest = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var hay = (it.name + ' ' + it.subject + ' ' + it.id + ' ' + it.category + ' ' + categoryName(it.category)).toLowerCase();
      var all = true;
      for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) < 0) { all = false; break; }
      if (!all) continue;
      (itemLabel(it).toLowerCase().indexOf(q) === 0 ? first : rest).push(it);
    }
    return first.concat(rest).slice(0, limit > 0 ? limit : SEARCH_LIMIT);
  }
  /** The most rows a find shows; the panel says so when there are more. */
  var SEARCH_LIMIT = 300;

  // ── sizes ──────────────────────────────────────────────────────────────────
  // Winlink's size figures are estimates of the uncompressed text. One KB here
  // is 1,000 bytes, as Winlink's own 120,000-byte limit is written.
  //
  // The two advice thresholds are POTACAT's own judgement, not Winlink's:
  // under 15 KB is an ordinary message on any link; 60 KB and up is long
  // enough over HF that the internet is the better tool.
  var ADVICE_NOTE_BYTES = 15000;
  var ADVICE_SLOW_BYTES = 60000;
  /** A row this large carries the "large" tag (the same line as the slow advice). */
  var LARGE_ITEM_BYTES = 60000;
  /**
   * Winlink's default (and largest) message size limit, measured on the
   * compressed message. An item estimated above it may still fit once
   * compressed; POTACAT cannot know, so it says so.
   */
  var SIZE_LIMIT_BYTES = 120000;

  function knownSize(item) {
    return item && typeof item.size === 'number' && isFinite(item.size) && item.size >= 0 ? item.size : null;
  }

  /** "600 bytes", "27 KB", "2.5 MB"; '' when the size is not known. */
  function formatSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1000) return Math.round(bytes) + (Math.round(bytes) === 1 ? ' byte' : ' bytes');
    if (bytes < 999500) return Math.round(bytes / 1000) + ' KB';
    return (Math.round(bytes / 100000) / 10) + ' MB';
  }

  function isLarge(item) {
    var s = knownSize(item);
    return s !== null && s >= LARGE_ITEM_BYTES;
  }

  /** Does the row carry the "large" tag? Not when its own name already says so. */
  function showLargeTag(item) {
    return isLarge(item) && !/\(large\)\s*$/i.test(itemLabel(item));
  }

  /** Every mode but Telnet goes over the radio. */
  function isRadioMode(mode) {
    return !!mode && mode !== 'telnet';
  }

  /**
   * The action bar's words for the ticked items and the connection mode:
   *   { count, bytes, total, advice }
   * total: "Nothing ticked yet", "3 items, about 12 KB", or "3 items" when a
   * size is not known. advice: '' or one plain line (see the thresholds
   * above). Over Telnet there is no advice about time. One item estimated
   * over Winlink's 120,000-byte limit adds a line in any mode. With a size
   * unknown there is no figure and no advice about time. Never blocks.
   */
  function sizeAdvice(items, mode) {
    var list = Array.isArray(items) ? items : [];
    var count = list.length;
    if (!count) return { count: 0, bytes: null, total: TEXT.nothingTicked, advice: '' };
    var bytes = 0;
    var overLimit = false;
    for (var i = 0; i < count; i++) {
      var s = knownSize(list[i]);
      if (s === null) { bytes = null; }
      else {
        if (bytes !== null) bytes += s;
        if (s > SIZE_LIMIT_BYTES) overLimit = true;
      }
    }
    var total = count + (count === 1 ? ' item' : ' items') + (bytes !== null ? ', about ' + formatSize(bytes) : '');
    var parts = [];
    if (bytes !== null && isRadioMode(mode) && bytes >= ADVICE_NOTE_BYTES) {
      parts.push('About ' + formatSize(bytes) + '. ' + (bytes >= ADVICE_SLOW_BYTES ? TEXT.adviceSlow : TEXT.adviceNote));
    }
    if (overLimit) parts.push(TEXT.adviceLimit);
    return { count: count, bytes: bytes, total: total, advice: parts.join(' ') };
  }

  // ── the operator's picks ───────────────────────────────────────────────────
  // { starred: [ids], recent: [ids] }, kept per operator profile. recent is
  // what was requested, newest first, at most 8. A starred item stays.

  var RECENT_MAX = 8;
  var STARRED_MAX = 50;

  function normalizePicks(p) {
    p = p && typeof p === 'object' ? p : {};
    return { starred: uniqueIds(p.starred, STARRED_MAX), recent: uniqueIds(p.recent, RECENT_MAX) };
  }

  /** These IDs were just requested: they go first, in the order given. */
  function addRecent(picks, ids) {
    var p = normalizePicks(picks);
    return { starred: p.starred, recent: uniqueIds(uniqueIds(ids, MAX_IDS_PER_REQUEST).concat(p.recent), RECENT_MAX) };
  }

  function isStarred(picks, id) {
    return normalizePicks(picks).starred.indexOf(id) >= 0;
  }

  /** Star or unstar one item. Past 50 stars a new one is not added. */
  function setStar(picks, id, on) {
    var p = normalizePicks(picks);
    if (!isId(id)) return p;
    var at = p.starred.indexOf(id);
    if (on && at < 0 && p.starred.length < STARRED_MAX) p.starred.push(id);
    if (!on && at >= 0) p.starred.splice(at, 1);
    return p;
  }

  /** Your picks, in order: the last requests (newest first), then the other starred items. */
  function pickIds(picks) {
    var p = normalizePicks(picks);
    return uniqueIds(p.recent.concat(p.starred), RECENT_MAX + STARRED_MAX);
  }

  /** Your picks as items of the list now shown (an ID the list does not hold is left out). */
  function pickItems(items, picks) {
    var by = {};
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) by['$' + list[i].id] = list[i];
    var out = [];
    var ids = pickIds(picks);
    for (var j = 0; j < ids.length; j++) if (by['$' + ids[j]]) out.push(by['$' + ids[j]]);
    return out;
  }

  // ── the stored catalog and the pending LIST request ────────────────────────

  var PENDING_MS = 7 * 86400000;
  /** Inbox messages looked at in one pass. */
  var EXAMINE_MAX = 200;

  /** Is a LIST request still waited for? For 7 days from when it was queued. */
  function pendingActive(requestedAt, now) {
    var at = Number(requestedAt);
    var t = Number(now);
    if (!(at > 0) || !isFinite(t)) return false;
    return t - at < PENDING_MS && at - t < 60000;
  }

  function cleanItems(items) {
    var out = [];
    var seen = {};
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length && out.length < MAX_ITEMS; i++) {
      var it = list[i];
      if (!it || !isId(it.id) || !isId(it.category) || seen['$' + it.id]) continue;
      seen['$' + it.id] = true;
      out.push({
        category: it.category, id: it.id,
        subject: String(it.subject == null ? '' : it.subject).slice(0, MAX_SUBJECT),
        size: typeof it.size === 'number' && isFinite(it.size) && it.size >= 0 ? it.size : null,
      });
    }
    return out;
  }

  /** What is kept on disk for a catalog that was read: {modified, readAt, sourceMid, sourceDate, items}. */
  function storedFrom(parsed, message, now) {
    return cleanStored({
      modified: parsed && parsed.modified, readAt: now,
      sourceMid: message && message.mid, sourceDate: message && message.date,
      items: parsed && parsed.items,
    });
  }

  /** The stored catalog, checked field by field; null when it holds no items. */
  function cleanStored(o) {
    if (!o || typeof o !== 'object') return null;
    var items = cleanItems(o.items);
    if (!items.length) return null;
    return {
      modified: typeof o.modified === 'string' ? o.modified.slice(0, 40) : '',
      readAt: Number(o.readAt) > 0 ? Number(o.readAt) : 0,
      sourceMid: typeof o.sourceMid === 'string' ? o.sourceMid.slice(0, 64) : '',
      sourceDate: typeof o.sourceDate === 'string' ? o.sourceDate.slice(0, 40) : '',
      items: items,
    };
  }

  /**
   * The Inbox messages worth reading for a catalog, newest first: not looked
   * at before (`seen`, a Set of message IDs), not the one the stored catalog
   * came from, and not older than it. At most `cap` in one pass.
   */
  function toExamine(list, o) {
    o = o || {};
    var seen = o.seen;
    var stored = o.stored || null;
    var since = stored && stored.sourceDate ? Date.parse(stored.sourceDate) : NaN;
    var rows = [];
    var msgs = Array.isArray(list) ? list : [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || typeof m.mid !== 'string' || !m.mid) continue;
      if (seen && typeof seen.has === 'function' && seen.has(m.mid)) continue;
      if (stored && stored.sourceMid === m.mid) continue;
      var t = Date.parse(m.date);
      if (isFinite(since) && isFinite(t) && t < since) continue;
      rows.push({ mid: m.mid, t: isFinite(t) ? t : 0, i: i });
    }
    rows.sort(function (a, b) { return b.t - a.t || a.i - b.i; });
    var cap = o.cap > 0 ? o.cap : EXAMINE_MAX;
    var out = [];
    for (var j = 0; j < rows.length && j < cap; j++) out.push(rows[j].mid);
    return out;
  }

  /**
   * What a surface is given to draw the panel: the full catalog's items (none
   * while there is only the starter list, which every surface has itself),
   * the operator's picks, and whether a LIST request is pending.
   */
  function payload(stored, o) {
    o = o || {};
    var s = cleanStored(stored);
    var pending = pendingActive(o.requestedAt, o.now);
    return {
      ok: true,
      items: s ? s.items : [], count: s ? s.items.length : 0,
      modified: s ? s.modified : '', sourceDate: s ? s.sourceDate : '', readAt: s ? s.readAt : 0,
      pending: pending, requestedAt: pending ? Number(o.requestedAt) : 0,
      unreadable: !!o.unreadable,
      picks: normalizePicks(o.picks),
    };
  }

  /**
   * The few numbers that ride every winlink-state: a surface asks for the
   * catalog again when any of them changes.
   */
  function stamp(stored, o) {
    o = o || {};
    var pending = pendingActive(o.requestedAt, o.now);
    var n = stored && Array.isArray(stored.items) ? stored.items.length : 0;
    return { count: n, readAt: stored && Number(stored.readAt) > 0 ? Number(stored.readAt) : 0, requestedAt: pending ? Number(o.requestedAt) : 0, unreadable: !!o.unreadable };
  }

  // ── every sentence ─────────────────────────────────────────────────────────

  var TEXT = {
    button: 'Catalog',
    buttonTitle: 'Ask Winlink to mail you weather, propagation, gateway lists and help files',
    title: 'Winlink catalog',
    lead: 'Winlink can mail you weather, propagation forecasts, gateway lists and help files. Tick what you want and put the request in the Outbox. Each answer arrives as its own message: send the request with Send / Receive, wait a few minutes, then connect again to collect it.',
    sourceStarter: 'Showing the short list. Winlink has several hundred more items.',
    sourcePending: 'The full catalog is requested. It arrives as a message of about 70 KB after your next Send / Receive, and this list fills in by itself.',
    sourceUnreadable: 'A catalog message arrived but POTACAT could not read it. The short list still works.',
    getFull: 'Get the full catalog',
    update: 'Update the catalog',
    radioConfirm: 'The catalog is about 70 KB. Over the radio that can take a long time; it is quick over Telnet.',
    radioConfirmYes: 'Request it anyway',
    radioConfirmNo: 'Cancel',
    findPlaceholder: 'Find: propagation, Texas forecast, packet gateways',
    findLabel: 'Find in the catalog',
    findNone: 'Nothing in the catalog has those words.',
    findNoneStarter: 'The full catalog has several hundred more items.',
    findMore: 'Showing the first 300. Add a word to narrow it down.',
    picksHead: 'Your picks',
    large: 'large',
    nothingTicked: 'Nothing ticked yet',
    adviceNote: 'That is several minutes over the radio.',
    adviceSlow: 'That is slow over the radio; consider Telnet for this one.',
    adviceLimit: 'Winlink compresses messages; one this large may still be refused by your size limit.',
    noCallsign: 'Set your callsign in Settings > Station first',
    close: 'Close',
    send: 'Put in Outbox',
    loading: 'Opening the catalog...',
    noAnswer: 'The catalog did not open. Close this and try again.',
    sendFailed: 'Could not put the request in the Outbox.',
    shackOlder: 'The POTACAT on the shack PC is older and has no catalog yet. Update POTACAT on the shack PC, then open Catalog again.',
    composeHint: 'This is a Winlink catalog request. The Catalog button builds it for you.',
  };

  function plural(n, one, many) { return n === 1 ? one : many; }

  /** A whole number with commas: 1400 is "1,400". */
  function formatCount(n) {
    return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  /** "9 March 2026" from Winlink's "2026/03/09 17:08" or from an ISO date; '' when neither. */
  function formatDay(s) {
    var m = /^(\d{4})[\/-](\d{2})[\/-](\d{2})/.exec(String(s == null ? '' : s));
    if (!m) return '';
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return d + ' ' + MONTHS[mo - 1] + ' ' + m[1];
  }

  /**
   * The line above the list and its button, from payload():
   *   { kind: 'starter' | 'pending' | 'full' | 'unreadable', text, button }
   * A pending request has no button, so it cannot be queued twice.
   */
  function sourceRow(p) {
    p = p || {};
    var n = Number(p.count) > 0 ? Number(p.count) : (Array.isArray(p.items) ? p.items.length : 0);
    if (p.pending) return { kind: 'pending', text: TEXT.sourcePending, button: '' };
    if (n > 0) {
      var day = formatDay(p.modified) || formatDay(p.sourceDate);
      return { kind: 'full', text: 'Full catalog: ' + formatCount(n) + plural(n, ' item', ' items') + (day ? ', as of ' + day : '') + '.', button: TEXT.update };
    }
    if (p.unreadable) return { kind: 'unreadable', text: TEXT.sourceUnreadable, button: TEXT.getFull };
    return { kind: 'starter', text: TEXT.sourceStarter, button: TEXT.getFull };
  }

  /** What the reading pane says after Put in Outbox. */
  function queuedText(n) {
    return 'The request for ' + formatCount(n) + plural(n, ' item', ' items') + ' is in the Outbox. It goes out with your next Send / Receive. '
      + plural(n, 'The answer arrives a few minutes later, so connect once more to collect it.', 'The answers arrive a few minutes later, so connect once more to collect them.');
  }

  /** A long request that stopped part way: how many are queued, how many are still ticked, and why. */
  function partialText(queued, left, error) {
    return formatCount(queued) + ' of the ' + formatCount(queued + left) + ' items are in the Outbox. The other ' + formatCount(left) + plural(left, ' is', ' are') + ' still ticked: ' + String(error || TEXT.sendFailed);
  }

  return {
    REQUEST_TO: REQUEST_TO, REQUEST_SUBJECT: REQUEST_SUBJECT, LIST_COMMAND: LIST_COMMAND,
    MAX_IDS_PER_MESSAGE: MAX_IDS_PER_MESSAGE, MAX_IDS_PER_REQUEST: MAX_IDS_PER_REQUEST,
    isId: isId, buildRequests: buildRequests, listRequest: listRequest, isCatalogAddress: isCatalogAddress,
    STARTER: STARTER, CATEGORY_NAMES: CATEGORY_NAMES, categoryName: categoryName,
    MAX_ITEMS: MAX_ITEMS, MAX_SUBJECT: MAX_SUBJECT, LIST_MIN_BYTES: LIST_MIN_BYTES,
    parseCatalogList: parseCatalogList, looksLikeCatalog: looksLikeCatalog,
    mergeCatalog: mergeCatalog, itemLabel: itemLabel, groupItems: groupItems, groupStartsOpen: groupStartsOpen,
    searchItems: searchItems, SEARCH_LIMIT: SEARCH_LIMIT,
    ADVICE_NOTE_BYTES: ADVICE_NOTE_BYTES, ADVICE_SLOW_BYTES: ADVICE_SLOW_BYTES, LARGE_ITEM_BYTES: LARGE_ITEM_BYTES, SIZE_LIMIT_BYTES: SIZE_LIMIT_BYTES,
    formatSize: formatSize, isLarge: isLarge, showLargeTag: showLargeTag, isRadioMode: isRadioMode, sizeAdvice: sizeAdvice,
    RECENT_MAX: RECENT_MAX, STARRED_MAX: STARRED_MAX,
    normalizePicks: normalizePicks, addRecent: addRecent, isStarred: isStarred, setStar: setStar, pickIds: pickIds, pickItems: pickItems,
    PENDING_MS: PENDING_MS, EXAMINE_MAX: EXAMINE_MAX, pendingActive: pendingActive,
    storedFrom: storedFrom, cleanStored: cleanStored, toExamine: toExamine, payload: payload, stamp: stamp,
    TEXT: TEXT, formatCount: formatCount, formatDay: formatDay, sourceRow: sourceRow, queuedText: queuedText, partialText: partialText,
  };
});
