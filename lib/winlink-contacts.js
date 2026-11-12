// Winlink address book (Casey 2026-11-11: "there should be an address book ...
// so it's lovely"). Saved contacts and groups live in the profile's settings
// (winlinkContacts, winlinkContactGroups) and ride winlink-state; suggestions
// also draw on every address seen in the Inbox and Sent, so the book is useful
// before anyone saves a thing.
//
// An address is either a Winlink address (a callsign, a callsign-SSID, or a
// tactical address such as ARES-NC) or an internet email address (has an @).
//
// Dual-mode: require() in main, window.WinlinkContacts in the mail window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinlinkContacts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_CONTACTS = 500;
  var MAX_GROUPS = 50;
  var MAX_MEMBERS = 100;
  var LIMITS = { name: 60, address: 120, note: 200 };

  var EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
  var WINLINK_RE = /^[A-Z0-9][A-Z0-9-]{1,29}$/;

  function str(v, n) { return String(v == null ? '' : v).slice(0, n); }

  /** "w1aw" -> "W1AW"; "Joe@Example.com" -> "joe@example.com"; '' when not an address. */
  function normalizeAddress(a) {
    var s = String(a == null ? '' : a).trim().replace(/^["'<]+|[>"']+$/g, '');
    if (!s) return '';
    if (s.indexOf('@') >= 0) return EMAIL_RE.test(s) ? s.toLowerCase() : '';
    var u = s.toUpperCase();
    return WINLINK_RE.test(u) ? u : '';
  }

  /** 'email' for an internet address, 'winlink' for a callsign or tactical address, '' for neither. */
  function kindOf(a) {
    var n = normalizeAddress(a);
    if (!n) return '';
    return n.indexOf('@') >= 0 ? 'email' : 'winlink';
  }

  /** Split a To/Cc string ("W1AW, joe@x.org; K3SBP") into its addresses, in order, unique. */
  function splitAddresses(s) {
    var out = [];
    String(s == null ? '' : s).split(/[,;\s]+/).forEach(function (p) {
      var n = normalizeAddress(p);
      if (n && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  /** The To/Cc string the send path expects. */
  function joinAddresses(list) {
    return (list || []).map(normalizeAddress).filter(Boolean).filter(function (a, i, arr) { return arr.indexOf(a) === i; }).join(', ');
  }

  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function cleanContact(c) {
    if (!c || typeof c !== 'object') return null;
    var address = normalizeAddress(str(c.address, LIMITS.address));
    if (!address) return null;
    return {
      id: /^c[a-z0-9]{6,30}$/.test(String(c.id || '')) ? String(c.id) : null,
      name: str(c.name, LIMITS.name).trim(),
      address: address,
      kind: kindOf(address),
      note: str(c.note, LIMITS.note).trim(),
      lastUsedAt: Number(c.lastUsedAt) > 0 ? Number(c.lastUsedAt) : 0,
    };
  }

  /** The stored contacts, cleaned; one per address (first wins); every one with an id. */
  function normalizeContacts(list) {
    var seen = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      var k = cleanContact(c);
      if (!k || seen[k.address]) return;
      if (!k.id) k.id = newId('c') + out.length;
      seen[k.address] = true;
      out.push(k);
    });
    return out.slice(0, MAX_CONTACTS);
  }

  /** Save a contact: the same id edits it; the same address as another contact is refused. */
  function saveContact(list, c) {
    var cur = normalizeContacts(list);
    var k = cleanContact(c);
    if (!k) return { ok: false, list: cur, error: 'That is not a Winlink address (a callsign) or an email address' };
    var at = k.id ? cur.findIndex(function (x) { return x.id === k.id; }) : -1;
    var clash = cur.find(function (x, i) { return i !== at && x.address === k.address; });
    if (clash) return { ok: false, list: cur, error: k.address + ' is already in your address book' + (clash.name ? ' as ' + clash.name : '') };
    if (at >= 0) { var next = cur.slice(); k.lastUsedAt = k.lastUsedAt || cur[at].lastUsedAt; next[at] = k; return { ok: true, list: next, id: k.id }; }
    if (cur.length >= MAX_CONTACTS) return { ok: false, list: cur, error: 'The address book is full (' + MAX_CONTACTS + '); delete one first' };
    k.id = newId('c');
    return { ok: true, list: cur.concat([k]), id: k.id };
  }

  function removeContact(list, id) {
    return normalizeContacts(list).filter(function (c) { return c.id !== id; });
  }

  function cleanGroup(g) {
    if (!g || typeof g !== 'object') return null;
    var name = str(g.name, LIMITS.name).trim();
    if (!name) return null;
    var members = splitAddresses((Array.isArray(g.members) ? g.members : []).join(',')).slice(0, MAX_MEMBERS);
    return { id: /^g[a-z0-9]{6,30}$/.test(String(g.id || '')) ? String(g.id) : null, name: name, members: members };
  }

  function normalizeGroups(list) {
    var names = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (g) {
      var k = cleanGroup(g);
      if (!k || names[k.name.toLowerCase()]) return;
      if (!k.id) k.id = newId('g') + out.length;
      names[k.name.toLowerCase()] = true;
      out.push(k);
    });
    return out.slice(0, MAX_GROUPS);
  }

  function saveGroup(list, g) {
    var cur = normalizeGroups(list);
    var k = cleanGroup(g);
    if (!k) return { ok: false, list: cur, error: 'Give the group a name' };
    if (!k.members.length) return { ok: false, list: cur, error: 'A group needs at least one address' };
    var at = k.id ? cur.findIndex(function (x) { return x.id === k.id; }) : -1;
    var clash = cur.find(function (x, i) { return i !== at && x.name.toLowerCase() === k.name.toLowerCase(); });
    if (clash) return { ok: false, list: cur, error: 'There is already a group called "' + clash.name + '"' };
    if (at >= 0) { var next = cur.slice(); next[at] = k; return { ok: true, list: next, id: k.id }; }
    if (cur.length >= MAX_GROUPS) return { ok: false, list: cur, error: 'At most ' + MAX_GROUPS + ' groups; delete one first' };
    k.id = newId('g');
    return { ok: true, list: cur.concat([k]), id: k.id };
  }

  function removeGroup(list, id) {
    return normalizeGroups(list).filter(function (g) { return g.id !== id; });
  }

  /**
   * Addresses seen in mail: [{address, count, lastAt}] from the Inbox (from)
   * and Sent (to, cc). `mycall` is left out: nobody writes to themselves by
   * picking their own call from a list.
   */
  function seenAddresses(lists, mycall) {
    var me = normalizeAddress(mycall);
    var by = {};
    function add(a, at) {
      var n = normalizeAddress(a);
      if (!n || n === me) return;
      var e = by[n] || (by[n] = { address: n, count: 0, lastAt: 0 });
      e.count++;
      var t = Date.parse(at) || 0;
      if (t > e.lastAt) e.lastAt = t;
    }
    ((lists && lists.in) || []).forEach(function (m) { add(m.from, m.date); });
    ((lists && lists.sent) || []).forEach(function (m) {
      (m.to || []).forEach(function (a) { add(a, m.date); });
      (m.cc || []).forEach(function (a) { add(a, m.date); });
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }

  /**
   * What to offer while the operator types in To or Cc: saved contacts and
   * groups first when they match, then addresses seen in mail, each ranked by
   * how often and how lately it was used. `exclude` = addresses already chosen.
   * Each row: {type:'contact'|'seen'|'group', address?, name, kind?, members?}.
   */
  function suggest(query, o) {
    o = o || {};
    var q = String(query == null ? '' : query).trim().toLowerCase();
    var exclude = {};
    (o.exclude || []).forEach(function (a) { exclude[normalizeAddress(a)] = true; });
    var contacts = normalizeContacts(o.contacts);
    var byAddr = {};
    contacts.forEach(function (c) { byAddr[c.address] = c; });
    var seen = seenAddresses(o.lists, o.mycall);
    var seenBy = {};
    seen.forEach(function (s) { seenBy[s.address] = s; });
    var now = Number(o.now) || Date.now();
    function score(addr, lastUsedAt) {
      var s = seenBy[addr];
      var count = s ? s.count : 0;
      var last = Math.max(lastUsedAt || 0, s ? s.lastAt : 0);
      var ageDays = last ? Math.max(0, (now - last) / 86400000) : 3650;
      return count * 2 + 30 / (1 + ageDays);
    }
    function matches(name, addr) {
      if (!q) return true;
      return String(name || '').toLowerCase().indexOf(q) >= 0 || String(addr || '').toLowerCase().indexOf(q) >= 0;
    }
    var rows = [];
    contacts.forEach(function (c) {
      if (exclude[c.address] || !matches(c.name, c.address)) return;
      rows.push({ type: 'contact', address: c.address, name: c.name, kind: c.kind, id: c.id, rank: 1000 + score(c.address, c.lastUsedAt) });
    });
    normalizeGroups(o.groups).forEach(function (g) {
      if (!matches(g.name, '')) return;
      var left = g.members.filter(function (a) { return !exclude[a]; });
      if (!left.length) return;
      rows.push({ type: 'group', name: g.name, members: left, id: g.id, rank: 900 });
    });
    seen.forEach(function (s) {
      if (byAddr[s.address] || exclude[s.address] || !matches('', s.address)) return;
      rows.push({ type: 'seen', address: s.address, name: '', kind: kindOf(s.address), rank: score(s.address, 0) });
    });
    rows.sort(function (a, b) { return b.rank - a.rank; });
    return rows.slice(0, Number(o.limit) || 8);
  }

  /** Mark addresses as just used (a message went in the Outbox to them). */
  function touch(list, addresses, at) {
    var want = {};
    (addresses || []).forEach(function (a) { var n = normalizeAddress(a); if (n) want[n] = true; });
    var changed = false;
    var out = normalizeContacts(list).map(function (c) {
      if (!want[c.address]) return c;
      changed = true;
      return Object.assign({}, c, { lastUsedAt: at || Date.now() });
    });
    return { changed: changed, list: out };
  }

  return {
    MAX_CONTACTS: MAX_CONTACTS, MAX_GROUPS: MAX_GROUPS, LIMITS: LIMITS,
    normalizeAddress: normalizeAddress, kindOf: kindOf, splitAddresses: splitAddresses, joinAddresses: joinAddresses,
    normalizeContacts: normalizeContacts, saveContact: saveContact, removeContact: removeContact,
    normalizeGroups: normalizeGroups, saveGroup: saveGroup, removeGroup: removeGroup,
    seenAddresses: seenAddresses, suggest: suggest, touch: touch,
  };
});
