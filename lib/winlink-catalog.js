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

  /** Words Winlink reads as commands, not items. They are never listed and never sent as an item. */
  var COMMAND_WORDS = ['LIST', 'UPDATE_CAT'];
  function isCommandWord(id) { return COMMAND_WORDS.indexOf(String(id).toUpperCase()) >= 0; }

  /**
   * What a surface asked for, checked against the catalog in force (the full
   * catalog's items, or the starter list when there is none):
   *   { ok, ids, over, error }
   * Every ID must be an item of that catalog; one that is not (a command
   * word, a made-up ID, an item the catalog no longer holds) refuses the whole
   * request. `ids` is the first 200, `over` how many were left out.
   */
  function checkRequest(ids, storedItems) {
    var view = mergeCatalog(storedItems).items;
    var have = {};
    var i;
    for (i = 0; i < view.length; i++) have['$' + view[i].id] = true;
    var list = Array.isArray(ids) ? ids : [];
    var out = [];
    var seen = {};
    var beyond = Math.max(0, list.length - MAX_ITEMS);
    for (i = 0; i < list.length && i < MAX_ITEMS; i++) {
      var id = list[i];
      if (typeof id !== 'string' || have['$' + id] !== true) return { ok: false, ids: [], over: 0, error: TEXT.notInCatalog };
      if (seen['$' + id]) continue;
      seen['$' + id] = true;
      out.push(id);
    }
    if (!out.length) return { ok: false, ids: [], over: 0, error: TEXT.tickOne };
    return { ok: true, ids: out.slice(0, MAX_IDS_PER_REQUEST), over: Math.max(0, out.length - MAX_IDS_PER_REQUEST) + beyond, error: '' };
  }

  /** May this item be starred? Only an item of the catalog in force; a star can always be taken off. */
  function mayStar(id, on, storedItems) {
    if (!isId(id)) return false;
    if (!on) return true;
    return checkRequest([id], storedItems).ok;
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

  /** US postal codes (a category WX_US_TX is Texas), so "texas" finds the Texas items. */
  var US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };

  /**
   * A category as the operator reads it: the four above by name; WX_... as
   * "Weather: " and the rest of the code with spaces; any other code as it is.
   */
  function categoryName(code) {
    var c = String(code == null ? '' : code);
    var up = c.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(CATEGORY_NAMES, up)) return CATEGORY_NAMES[up];
    var st = /^WX_US_([A-Z]{2})$/.exec(up);
    if (st && Object.prototype.hasOwnProperty.call(US_STATES, st[1])) return 'Weather: ' + US_STATES[st[1]];
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

  var MODIFIED_RE = /Global_Modified:\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/i;

  // The text is mail, so nothing here can be slow on a line built to be slow:
  // the header and the row are found with indexOf and split, never with a
  // pattern that can backtrack.
  /** Does the line hold CATEGORY, INQUIRY_ID and SUBJECT, in that order (any case)? */
  function isHeader(line) {
    var u = line.toUpperCase();
    var a = u.indexOf('CATEGORY');
    if (a < 0) return false;
    var b = u.indexOf('INQUIRY_ID', a + 8);
    return b >= 0 && u.indexOf('SUBJECT', b + 10) >= 0;
  }

  var SIZE_RE = /^(\d{1,9}|\d{1,3}(,\d{3}){1,2})$/;
  var DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;
  var FLAG_RE = /^\[[A-Za-z]\]$/;
  function isBlank(code) { return code === 32 || code === 9; }
  /** The word of `line` at or after `from` (spaces and tabs skipped), at most 21 characters; '' at the end of the line. */
  function wordAt(line, from) {
    var i = from;
    while (i < line.length && isBlank(line.charCodeAt(i))) i++;
    var j = i;
    while (j < line.length && j - i < 21 && !isBlank(line.charCodeAt(j))) j++;
    return line.slice(i, j);
  }

  /**
   * One table line as an item, or null when it is not a row. The subject
   * starts at the first double quote and ends at the first later quote that
   * is followed by the end of the row, or by blank space and then a size, a
   * date or a flag. So a subject may hold quotes of its own, and a quote in a
   * column after the subject does not stretch it. A size may be written with
   * thousands separators (1,234).
   */
  function parseRow(line) {
    var end = line.length;
    while (end > 0 && line.charCodeAt(end - 1) <= 32) end--;
    line = line.slice(0, end);
    var a = line.indexOf('"');
    if (a < 0) return null;
    var left = line.slice(0, a).trim().split(/\s+/);
    if (left.length !== 2 || !WORD_RE.test(left[0]) || !WORD_RE.test(left[1])) return null;
    var b = -1;
    var word = '';
    for (var q = line.indexOf('"', a + 1); q >= 0; q = line.indexOf('"', q + 1)) {
      if (q + 1 < line.length && !isBlank(line.charCodeAt(q + 1))) continue;
      word = wordAt(line, q + 1);
      if (word === '' || SIZE_RE.test(word) || DATE_RE.test(word) || FLAG_RE.test(word)) { b = q; break; }
    }
    if (b < 0) return null;
    var subject = line.slice(a + 1, b).trim().slice(0, MAX_SUBJECT);
    var size = SIZE_RE.test(word) ? Number(word.replace(/,/g, '')) : null;
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
    var out = { ok: false, items: [], modified: '', reason: 'no-header', skipped: 0, rows: 0, firstLine: '' };
    if (typeof text !== 'string' || !text) return out;
    var lines = text.slice(0, MAX_TEXT).split(/\r\n|\r|\n/);
    var h = -1;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.length > MAX_LINE) continue;
      if (!out.modified) { var mm = MODIFIED_RE.exec(l); if (mm) out.modified = mm[1].replace(/\s+/, ' '); }
      if (isHeader(l)) { h = i; break; }
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
    out.rows = rows;
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
      if (!f || !isId(f.id) || !isId(f.category) || isCommandWord(f.id)) continue;
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

  /** The size as it is shown (whole KB from 1,000 bytes up), so a threshold never disagrees with the figure beside it. */
  function shownBytes(bytes) { return bytes < 1000 ? bytes : Math.round(bytes / 1000) * 1000; }

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
    return s !== null && shownBytes(s) >= LARGE_ITEM_BYTES;
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
    if (bytes !== null && isRadioMode(mode) && shownBytes(bytes) >= ADVICE_NOTE_BYTES) {
      parts.push('About ' + formatSize(bytes) + '. ' + (shownBytes(bytes) >= ADVICE_SLOW_BYTES ? TEXT.adviceSlow : TEXT.adviceNote));
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
  /** A request stamped up to an hour ahead of the clock (the clock was stepped back) counts as just made. */
  var CLOCK_SKEW_MS = 3600000;
  /** A reply is the answer to a request when it is dated no earlier than 10 minutes before the request. */
  var REPLY_EARLY_MS = 600000;
  var EXAMINED_MAX = 1000;
  /** Inbox messages looked at in one pass. */
  var EXAMINE_MAX = 200;

  /** Is a LIST request still waited for? For 7 days from when it was queued. */
  function pendingActive(requestedAt, now) {
    var at = Number(requestedAt);
    var t = Number(now);
    if (!(at > 0) || !isFinite(t)) return false;
    return t - at < PENDING_MS && at - t <= CLOCK_SKEW_MS;
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

  /** A sender for a sentence or a log line: printable characters, single spaces, at most 60. Shown as text, never as markup. */
  function cleanSender(from) {
    var t = String(from == null ? '' : from).replace(/[^\x20-\x7E]/g, ' ').split(' ').filter(Boolean).join(' ').slice(0, 60);
    return t || 'an unknown sender';
  }

  /** What is kept on disk for a catalog that was read: {modified, readAt, sourceMid, sourceDate, sourceFrom, items}. */
  function storedFrom(parsed, message, now) {
    return cleanStored({
      modified: parsed && parsed.modified, readAt: now,
      sourceMid: message && message.mid, sourceDate: message && message.date, sourceFrom: message && message.from,
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
      sourceFrom: typeof o.sourceFrom === 'string' && o.sourceFrom ? cleanSender(o.sourceFrom) : '',
      items: items,
    };
  }

  // The pending LIST request is tied to the message itself: {at, mid}.

  /** Is this Outbox or Sent entry a catalog request (To INQUIRY, Subject REQUEST)? */
  function isRequestEntry(m) {
    if (!m) return false;
    var to = Array.isArray(m.to) ? m.to.join(' ') : String(m.to == null ? '' : m.to);
    return isCatalogAddress(to) && String(m.subject == null ? '' : m.subject).trim().toUpperCase() === REQUEST_SUBJECT;
  }
  /** The catalog requests in an Outbox list, at most 20: the ones whose body is worth reading to see whether it is LIST. */
  function requestEntries(list) {
    var out = [];
    var l = Array.isArray(list) ? list : [];
    for (var i = 0; i < l.length && out.length < 20; i++) if (l[i] && typeof l[i].mid === 'string' && isRequestEntry(l[i])) out.push(l[i].mid);
    return out;
  }
  /** Is this message body the request for the whole catalog? */
  function isListBody(body) {
    return String(body == null ? '' : body).trim().toUpperCase() === LIST_COMMAND;
  }

  function hasMid(list, mid) {
    var l = Array.isArray(list) ? list : [];
    for (var i = 0; i < l.length; i++) if (l[i] && l[i].mid === mid) return true;
    return false;
  }

  function cleanRequest(r) {
    if (!r || typeof r !== 'object' || !(Number(r.at) > 0)) return null;
    return { at: Number(r.at), mid: typeof r.mid === 'string' ? r.mid.slice(0, 64) : '' };
  }

  /**
   * The request just queued: {at, mid}. `before` and `after` are the IDs of
   * the LIST requests in the Outbox, each from a fresh listing taken just
   * before and just after the send (never from a cached list). The one that
   * is new is ours; when that cannot be told, mid is '' and the request is
   * kept as "unknown".
   */
  function newRequest(now, before, after) {
    var b = Array.isArray(before) ? before : [];
    var a = Array.isArray(after) ? after : [];
    var mid = '';
    for (var i = 0; i < a.length; i++) if (typeof a[i] === 'string' && a[i] && b.indexOf(a[i]) < 0) { mid = a[i]; break; }
    return { at: Number(now), mid: mid.slice(0, 64) };
  }

  /**
   * May a LIST request be queued now? 'queue' or 'already'.
   * Never while a LIST request sits in the Outbox (`inOutbox`: the IDs of the
   * LIST requests in a fresh Outbox listing), whatever the state says. While
   * one is waited for, only "Request again" queues another.
   */
  function listRule(o) {
    o = o || {};
    if (Array.isArray(o.inOutbox) && o.inOutbox.length) return 'already';
    if (o.kind && o.kind !== 'none' && o.again !== true) return 'already';
    return 'queue';
  }

  /**
   * Which folders are known for a mailbox, after a refresh that listed
   * `listed` (the folders that were listed without an error, in order).
   * - out: the Outbox was listed.
   * - sentFresh: Sent was listed in this refresh or a later one than the last
   *   Outbox listing. An Outbox listing without Sent makes it stale again; a
   *   Sent listing that failed never counts.
   */
  function noteListed(prev, listed, box) {
    var p = prev && prev.box === box ? prev : { box: box, out: false, sentFresh: false };
    var l = Array.isArray(listed) ? listed : [];
    var out = l.indexOf('out') >= 0;
    var sent = l.indexOf('sent') >= 0;
    return { box: box, out: p.out || out, sentFresh: sent ? true : (out ? false : p.sentFresh) };
  }

  /**
   * Where the request for the full catalog stands, and whether to forget it:
   *   { kind, pendingKind, pending, inOutbox, request, drop }
   * kind:
   *   'queued'   its message is in the Outbox (or, when the message could not be
   *              identified, some catalog request is). No button.
   *   'sent'     its message is in Sent, or it could not be identified and no
   *              catalog request is in the Outbox. "Request again" is offered.
   *   'unknown'  its message is in neither folder as far as is known (the
   *              folders are not listed yet, or the Sent list is older than the
   *              Outbox's). The request is kept and shown as queued.
   *   'none'     nothing is waited for.
   * A request is forgotten (`drop`) only when: a catalog was read after it;
   * its message is gone from the Outbox and a fresh Sent list does not hold it
   * (the operator deleted it before it went); or 7 days have passed and its
   * message is not in the Outbox.
   * o = { request, outbox, sent, lists: {out, sentFresh} | null, stored, now }.
   */
  function settleRequest(o) {
    o = o || {};
    var r = cleanRequest(o.request);
    var lists = o.lists || {};
    var kind = 'none';
    if (r) {
      var inOut = !!lists.out && (r.mid ? hasMid(o.outbox, r.mid) : requestEntries(o.outbox).length > 0);
      if (inOut) kind = 'queued';
      else if (o.stored && Number(o.stored.readAt) > r.at) kind = 'none';
      else if (!pendingActive(r.at, o.now)) kind = 'none';
      else if (!r.mid) kind = lists.out ? 'sent' : 'unknown';
      else if (hasMid(o.sent, r.mid)) kind = 'sent';
      else if (lists.out && lists.sentFresh) kind = 'none';
      else kind = 'unknown';
    }
    var pendingKind = kind === 'sent' ? 'sent' : (kind === 'none' ? '' : 'queued');
    return { kind: kind, pendingKind: pendingKind, pending: kind !== 'none', inOutbox: kind === 'queued', request: kind === 'none' ? null : r, requestedAt: kind === 'none' || !r ? 0 : r.at, drop: kind === 'none' && !!r };
  }

  // Which Inbox messages were examined is remembered by message ID (the last
  // 1,000, per operator profile), never by date: a message's date is the
  // sender's and may be wrong or out of order.

  function cleanExamined(list) {
    var out = [];
    var seen = {};
    var l = Array.isArray(list) ? list : [];
    for (var i = 0; i < l.length; i++) {
      if (typeof l[i] !== 'string' || !l[i] || l[i].length > 64 || seen['$' + l[i]]) continue;
      seen['$' + l[i]] = true;
      out.push(l[i]);
    }
    return out.slice(-EXAMINED_MAX);
  }

  /**
   * The Inbox messages to read in a pass: every one not examined before
   * (`seen`, a Set of message IDs), whatever its date; the newest-dated first;
   * at most `cap`. { mids, left }: `left` is how many more wait for the next pass.
   */
  function toExamine(list, o) {
    o = o || {};
    var seen = o.seen;
    var rows = [];
    var msgs = Array.isArray(list) ? list : [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || typeof m.mid !== 'string' || !m.mid) continue;
      if (seen && typeof seen.has === 'function' && seen.has(m.mid)) continue;
      var t = Date.parse(m.date);
      rows.push({ mid: m.mid, t: isFinite(t) ? t : 0, i: i });
    }
    rows.sort(function (a, b) { return b.t - a.t || a.i - b.i; });
    var cap = o.cap > 0 ? o.cap : EXAMINE_MAX;
    var out = [];
    for (var j = 0; j < rows.length && j < cap; j++) out.push(rows[j].mid);
    return { mids: out, left: Math.max(0, rows.length - out.length) };
  }

  /** Look at the Inbox now? While a request is pending, or once after the panel was opened or the catalog asked for. */
  function shouldScan(o) {
    return !!(o && (o.pending || o.want));
  }

  /** A message with the header and this many rows that still is not a catalog is "a catalog POTACAT could not read". */
  var UNREADABLE_MIN_ROWS = 5;
  var DECLINED_MAX = 50;

  function cleanDeclined(list) {
    var out = [];
    var l = Array.isArray(list) ? list : [];
    for (var i = 0; i < l.length; i++) if (typeof l[i] === 'string' && l[i] && l[i].length <= 64 && out.indexOf(l[i]) < 0) out.push(l[i]);
    return out.slice(-DECLINED_MAX);
  }
  /** The operator said no to this message's catalog, or used another: it is not offered again. */
  function addDeclined(list, mid) {
    return cleanDeclined(cleanDeclined(list).concat(typeof mid === 'string' ? [mid] : []));
  }

  /** A catalog waiting for the operator's "Use it": {mid, from, date, count, have}; null for anything else. */
  function cleanOffer(o) {
    if (!o || typeof o !== 'object' || typeof o.mid !== 'string' || !o.mid || !(Number(o.count) > 0)) return null;
    return { mid: o.mid.slice(0, 64), from: cleanSender(o.from), date: typeof o.date === 'string' ? o.date.slice(0, 40) : '', count: Math.round(Number(o.count)), have: Number(o.have) > 0 ? Math.round(Number(o.have)) : 0 };
  }

  /** The message whose catalog could not be read: {mid}, kept so a restart still explains it; null for anything else. */
  function cleanUnreadable(u) {
    return u && typeof u === 'object' && typeof u.mid === 'string' && u.mid ? { mid: u.mid.slice(0, 64) } : null;
  }

  /**
   * What to do with one Inbox message:
   *   { action: 'skip' }                       not a catalog (or one already declined). A message with
   *                                            the header line but fewer than 5 rows is this too: a help
   *                                            text never ends a wait.
   *   { action: 'unreadable', log, answers }   the header and at least 5 rows, but the table does not parse
   *   { action: 'accept', stored, log }        a catalog, a request is pending, the message is dated no
   *                                            earlier than 10 minutes before the request, and it has at
   *                                            least half the items of the catalog in use
   *   { action: 'offer', offer, log, answers } any other catalog: the operator decides
   * `answers`: the message is the reply to the pending request (pending, and
   * dated after it), so the wait is over even though nothing was taken.
   * ctx = { mid, from, date, stored, pending, requestAt, declined, now }.
   * No line of any message is put in a log line: only the sender and counts.
   */
  function decideMessage(msg, ctx) {
    ctx = ctx || {};
    if (!looksLikeCatalog(msg)) return { action: 'skip' };
    var p = parseCatalogList(msg.body);
    var t = Date.parse(ctx.date);
    var fresh = !(Number(ctx.requestAt) > 0) || (isFinite(t) && t >= Number(ctx.requestAt) - REPLY_EARLY_MS);
    var answers = !!ctx.pending && fresh;
    if (!p.ok) {
      if (p.reason === 'not-a-table' && p.rows >= UNREADABLE_MIN_ROWS) {
        return { action: 'unreadable', answers: answers, log: 'catalog: a message from ' + cleanSender(ctx.from) + ' looks like the Winlink catalog but its table could not be read (' + p.rows + ' rows read, ' + p.skipped + ' lines skipped)' };
      }
      return { action: 'skip' };
    }
    if (cleanDeclined(ctx.declined).indexOf(ctx.mid) >= 0) return { action: 'skip' };
    var stored = storedFrom(p, { mid: ctx.mid, date: ctx.date, from: ctx.from }, ctx.now);
    if (!stored) return { action: 'skip' };
    var n = stored.items.length;
    var have = ctx.stored && Array.isArray(ctx.stored.items) ? ctx.stored.items.length : 0;
    var from = cleanSender(ctx.from);
    if (answers && !(have > 0 && n * 2 < have)) {
      return { action: 'accept', stored: stored, log: 'catalog: read the Winlink catalog you asked for, from ' + from + ' (' + n + ' items)' };
    }
    return {
      action: 'offer', answers: answers, offer: cleanOffer({ mid: ctx.mid, from: ctx.from, date: ctx.date, count: n, have: have }),
      log: 'catalog: a catalog message from ' + from + ' is in the Inbox (' + n + ' items' + (have ? ', the one in use has ' + have : '') + '); it is used only if the operator says so',
    };
  }

  /**
   * One pass over the Inbox. Reads are one at a time, newest-dated first, capped.
   * o = { list, seen, stored, pending, requestAt, declined, now, cap,
   *       read(mid) -> Promise of the message, store(stored) -> true when written }
   * Resolves { accepted, offer, unreadableMid, clearPending, failed, examined, left, logs }.
   * - The first catalog found is accepted or offered and the pass ends.
   * - A message is added to `seen` only on a clean answer (not a catalog,
   *   unreadable, offered) or after its catalog was written. A read that fails
   *   or a write that is refused leaves it out, so the next pass asks again.
   * - clearPending: the reply the operator waited for has arrived.
   */
  function scanInbox(o) {
    o = o || {};
    var res = { accepted: null, offer: null, unreadableMid: '', clearPending: false, failed: false, examined: 0, left: 0, logs: [] };
    var list = Array.isArray(o.list) ? o.list : [];
    var plan = toExamine(list, { seen: o.seen, cap: o.cap });
    var mids = plan.mids;
    res.left = plan.left;
    var by = {};
    for (var k = 0; k < list.length; k++) if (list[k] && typeof list[k].mid === 'string') by['$' + list[k].mid] = list[k];
    var i = 0;
    function done() {
      res.left += mids.length - i;
      return res;
    }
    function next() {
      if (i >= mids.length) return done();
      var mid = mids[i++];
      var entry = by['$' + mid] || {};
      return Promise.resolve().then(function () { return o.read(mid); }).then(function (msg) {
        res.examined++;
        var d = decideMessage(msg, { mid: mid, from: entry.from || (msg && msg.from), date: entry.date || (msg && msg.date), stored: o.stored, pending: !!o.pending && !res.clearPending, requestAt: o.requestAt, declined: o.declined, now: o.now });
        if (d.action === 'accept') {
          var ok = false;
          try { ok = o.store(d.stored) === true; } catch (e) { ok = false; }
          if (!ok) { res.failed = true; i--; return done(); }
          o.seen.add(mid);
          res.accepted = d.stored;
          res.clearPending = true;
          res.logs.push(d.log);
          return done();
        }
        o.seen.add(mid);
        if (d.action === 'offer') {
          res.offer = d.offer;
          if (d.answers) res.clearPending = true;
          res.logs.push(d.log);
          return done();
        }
        if (d.action === 'unreadable') {
          if (!res.unreadableMid) res.unreadableMid = mid;
          if (d.answers) res.clearPending = true;
          res.logs.push(d.log);
        }
        return next();
      }, function () {
        res.failed = true;
        res.left++;
        return next();
      });
    }
    return Promise.resolve().then(next);
  }

  /**
   * What a finished pass changes in what is kept for the operator.
   *   state = { request, offer, declined, unreadable, requestInOutbox }
   *   -> { state, changed, lookDone, again }
   * - accepted: the wait is over, the "could not read" note is cleared, an
   *   outstanding offer is superseded (remembered as declined).
   * - offer: it replaces an outstanding one, which is remembered as declined.
   *   The same offer again changes nothing.
   * - unreadable (and nothing better found): noted with its message.
   * - The request is cleared when the pass says the reply arrived, but never
   *   while its message is still in the Outbox.
   * `examined`: every message ID examined so far (the last 1,000 are kept).
   * `changed`: a surface should ask for the catalog again. `lookDone`: the
   * one-time look after opening the panel is finished (nothing failed, there
   * was mail to look at, nothing is left). `again`: more mail waits for
   * another pass.
   */
  function applyScan(state, res, examined, listLength) {
    state = state || {};
    res = res || {};
    var next = {
      request: cleanRequest(state.request), offer: cleanOffer(state.offer), declined: cleanDeclined(state.declined),
      unreadable: cleanUnreadable(state.unreadable), examined: cleanExamined(examined),
    };
    var changed = false;
    var offer = cleanOffer(res.offer);
    if (res.accepted) {
      if (next.offer) next.declined = addDeclined(next.declined, next.offer.mid);
      next.offer = null;
      next.unreadable = null;
      changed = true;
    } else if (offer) {
      if (!next.offer || next.offer.mid !== offer.mid) {
        if (next.offer) next.declined = addDeclined(next.declined, next.offer.mid);
        next.offer = offer;
        changed = true;
      }
    } else if (res.unreadableMid && !(next.unreadable && next.unreadable.mid === res.unreadableMid)) {
      next.unreadable = cleanUnreadable({ mid: res.unreadableMid });
      changed = true;
    }
    if (res.clearPending && next.request && !state.requestInOutbox) { next.request = null; changed = true; }
    var found = !!(res.accepted || offer);
    return {
      state: next, changed: changed, save: changed || res.examined > 0,
      lookDone: !res.failed && Number(listLength) > 0 && (found || !(res.left > 0)),
      again: !res.failed && !found && res.left > 0,
    };
  }

  /**
   * The settings a state is kept in (undefined = remove the key). The old
   * date mark (winlinkCatalogScannedTo) is no longer used and is removed.
   */
  function toSettings(state) {
    state = state || {};
    var d = cleanDeclined(state.declined);
    var e = cleanExamined(state.examined);
    return {
      winlinkCatalogRequest: cleanRequest(state.request) || undefined,
      winlinkCatalogOffer: cleanOffer(state.offer) || undefined,
      winlinkCatalogDeclined: d.length ? d : undefined,
      winlinkCatalogExamined: e.length ? e : undefined,
      winlinkCatalogUnreadable: cleanUnreadable(state.unreadable) || undefined,
      winlinkCatalogScannedTo: undefined,
    };
  }

  /** "Use it": the offered message, read again, as the catalog to store; null when it is no longer one. */
  function useOffer(msg, offer, now) {
    var o = cleanOffer(offer);
    if (!o || !looksLikeCatalog(msg)) return null;
    var p = parseCatalogList(msg.body);
    return p.ok ? storedFrom(p, { mid: o.mid, date: o.date, from: o.from }, now) : null;
  }

  /**
   * After "Use it" or "No thanks" was carried out for the offer `answered`:
   * what is kept. The offer is removed only if it is still the one that was
   * answered (a newer one may have arrived meanwhile), and the answered
   * message is not offered again. `used`: its catalog is now in use, so the
   * "could not read" note is cleared.
   */
  function afterOffer(state, answered, used) {
    state = state || {};
    var cur = cleanOffer(state.offer);
    var a = cleanOffer(answered);
    return {
      offer: cur && a && cur.mid === a.mid ? null : cur,
      declined: a ? addDeclined(state.declined, a.mid) : cleanDeclined(state.declined),
      unreadable: used ? null : cleanUnreadable(state.unreadable),
    };
  }

  /**
   * What a surface is given to draw the panel: the full catalog's items (none
   * while there is only the starter list, which every surface has itself),
   * the operator's picks, where the request for the full catalog stands
   * (pendingKind 'queued' | 'sent' | ''), and a catalog waiting for "Use it".
   */
  function payload(stored, o) {
    o = o || {};
    var s = cleanStored(stored);
    var kind = o.pendingKind === 'queued' || o.pendingKind === 'sent' ? o.pendingKind : '';
    return {
      ok: true,
      items: s ? s.items : [], count: s ? s.items.length : 0,
      modified: s ? s.modified : '', sourceDate: s ? s.sourceDate : '', readAt: s ? s.readAt : 0,
      pending: !!kind, pendingKind: kind, requestedAt: kind ? Number(o.requestedAt) || 0 : 0,
      unreadable: !!o.unreadable,
      offer: cleanOffer(o.offer),
      picks: normalizePicks(o.picks),
    };
  }

  /**
   * The few values that ride every winlink-state: a surface asks for the
   * catalog again when any of them changes (a catalog read, a request queued,
   * sent or answered, an offer, a star or a new pick on another surface).
   */
  function stamp(stored, o) {
    o = o || {};
    var kind = o.pendingKind === 'queued' || o.pendingKind === 'sent' ? o.pendingKind : '';
    var n = stored && Array.isArray(stored.items) ? stored.items.length : 0;
    var offer = cleanOffer(o.offer);
    return {
      count: n, readAt: stored && Number(stored.readAt) > 0 ? Number(stored.readAt) : 0,
      requestedAt: kind ? Number(o.requestedAt) || 0 : 0, pendingKind: kind, unreadable: !!o.unreadable,
      offerMid: offer ? offer.mid : '', picksAt: Number(o.picksAt) > 0 ? Number(o.picksAt) : 0,
    };
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
    sourceUnreadableFull: 'A newer catalog message arrived but POTACAT could not read it. Your catalog is unchanged.',
    requestAgain: 'Request again',
    useIt: 'Use it',
    noThanks: 'No thanks',
    offerGone: 'That message is no longer in your Inbox.',
    saveFailed: 'Could not save the catalog. Try again.',
    notInCatalog: 'One of the ticked items is not in the catalog any more. Close the catalog and open it again.',
    tickOne: 'Tick at least one item.',
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
   * The line above the list and its buttons, from payload():
   *   { kind: 'offer' | 'unreadable' | 'pending' | 'full' | 'starter', text, button, button2 }
   * In this order:
   * - a catalog message waiting for the operator: "Use it" / "No thanks";
   * - a catalog message that could not be read (it wins over a pending
   *   request, so the operator is never left waiting with no button);
   * - a pending request: no button while the request is in the Outbox (it
   *   cannot be queued twice); once it has gone out, a quiet "Request again";
   * - the full catalog; the short list.
   */
  function sourceRow(p) {
    p = p || {};
    var n = Number(p.count) > 0 ? Number(p.count) : (Array.isArray(p.items) ? p.items.length : 0);
    var offer = cleanOffer(p.offer);
    if (offer) {
      var small = offer.have > 0 && offer.count * 2 < offer.have;
      return {
        kind: 'offer', button: TEXT.useIt, button2: TEXT.noThanks,
        text: 'A catalog message from ' + offer.from + ' is in your Inbox: ' + formatCount(offer.count) + plural(offer.count, ' item', ' items') + '.' + (small ? ' Yours has ' + formatCount(offer.have) + '.' : ''),
      };
    }
    if (p.unreadable) {
      return n > 0 ? { kind: 'unreadable', text: TEXT.sourceUnreadableFull, button: TEXT.update, button2: '' }
        : { kind: 'unreadable', text: TEXT.sourceUnreadable, button: TEXT.getFull, button2: '' };
    }
    if (p.pending) return { kind: 'pending', text: TEXT.sourcePending, button: '', button2: p.pendingKind === 'sent' ? TEXT.requestAgain : '' };
    if (n > 0) {
      var day = formatDay(p.modified) || formatDay(p.sourceDate);
      return { kind: 'full', text: 'Full catalog: ' + formatCount(n) + plural(n, ' item', ' items') + (day ? ', as of ' + day : '') + '.', button: TEXT.update, button2: '' };
    }
    return { kind: 'starter', text: TEXT.sourceStarter, button: TEXT.getFull, button2: '' };
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

  /** More than 200 were ticked: the first 200 are queued and the rest stay ticked. */
  function overText(queued, left) {
    return formatCount(queued) + ' of the ' + formatCount(queued + left) + ' items are in the Outbox. The other ' + formatCount(left) + plural(left, ' is', ' are') + ' still ticked.';
  }

  return {
    COMMAND_WORDS: COMMAND_WORDS, isCommandWord: isCommandWord, checkRequest: checkRequest, US_STATES: US_STATES,
    cleanSender: cleanSender, isRequestEntry: isRequestEntry, requestEntries: requestEntries, isListBody: isListBody, cleanRequest: cleanRequest,
    newRequest: newRequest, listRule: listRule, noteListed: noteListed, settleRequest: settleRequest, mayStar: mayStar,
    cleanExamined: cleanExamined, shouldScan: shouldScan, cleanUnreadable: cleanUnreadable, toSettings: toSettings, afterOffer: afterOffer,
    CLOCK_SKEW_MS: CLOCK_SKEW_MS, REPLY_EARLY_MS: REPLY_EARLY_MS, EXAMINED_MAX: EXAMINED_MAX,
    UNREADABLE_MIN_ROWS: UNREADABLE_MIN_ROWS, cleanDeclined: cleanDeclined, addDeclined: addDeclined, cleanOffer: cleanOffer,
    decideMessage: decideMessage, scanInbox: scanInbox, applyScan: applyScan, useOffer: useOffer, overText: overText,
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
