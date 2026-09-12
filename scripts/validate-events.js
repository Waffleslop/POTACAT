#!/usr/bin/env node
// Validate an event catalog — the website feed (events/active.json) or the
// BUILTIN_EVENTS fallback in main.js — before it ships.
//
// The recipe for a checklist event (13 Colonies, WRTC, Route 66) is "one
// definition, two identical copies, exact-match patterns"; every rule below
// is a way that recipe can rot silently: a pattern with no checklist item
// badges a spot the board can never tick, `total` drifting from the item
// count shows "worked N of M" for the wrong M, a `W6*` pattern would tag
// every California call, an out-of-range (or half-present) lat/lon plots a
// station nowhere, a duplicated `route` number folds the map polyline back
// on itself, and a fallback copy that differs from the feed gives a
// first-launch install a different event from everyone else.
//
//   node scripts/validate-events.js                  # BUILTIN_EVENTS in main.js
//   node scripts/validate-events.js path/active.json # a feed file as well
//   node scripts/validate-events.js path/active.json --compare --require 13colonies-2026,wrtc-2026,route66-2026
//        # ...and assert those BUILTIN entries deep-equal the feed's
//
// Pure: `validateEventsCatalog(data, opts)` returns the problem list, so the
// test suite runs the same rules against BUILTIN_EVENTS on every push.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BOARDS = new Set(['checklist', 'regions', 'counter']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
// Exact-match callsign or a `PREFIX/*` wildcard — the only two shapes
// matchesEventPattern (renderer/app.js) understands.
const PATTERN_RE = /^[A-Z0-9]+(?:\/[A-Z0-9]+)*(?:\/\*)?$/;

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * @param {object} data  `{schemaVersion?, events:[...]}`
 * @param {object} [opts] `{feed:true}` = the website file (schemaVersion and
 *   `updated` are required there; the BUILTIN fallback has neither)
 * @returns {string[]} problems, empty when the catalog is sound
 */
function validateEventsCatalog(data, opts = {}) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!data || typeof data !== 'object') return ['catalog is not an object'];
  if (opts.feed) {
    if (data.schemaVersion !== 1) bad(`schemaVersion must be 1 (got ${JSON.stringify(data.schemaVersion)})`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.updated))) bad(`updated must be YYYY-MM-DD (got ${JSON.stringify(data.updated)})`);
  }
  if (!Array.isArray(data.events) || !data.events.length) return problems.concat(['events must be a non-empty array']);

  const ids = new Set();
  data.events.forEach((ev, i) => {
    const tag = `events[${i}]${ev && ev.id ? ` (${ev.id})` : ''}`;
    if (!ev || typeof ev !== 'object') { bad(`${tag}: not an object`); return; }
    if (!isStr(ev.id) || !/^[a-z0-9-]+$/.test(ev.id)) bad(`${tag}: id must be a kebab-case string`);
    else if (ids.has(ev.id)) bad(`${tag}: duplicate id`);
    ids.add(ev.id);
    if (!isStr(ev.name)) bad(`${tag}: name missing`);
    if (!isStr(ev.type)) bad(`${tag}: type missing`);
    if (!BOARDS.has(ev.board)) bad(`${tag}: board must be one of ${[...BOARDS].join('|')}`);
    if (!isStr(ev.url) || !/^https:\/\//.test(ev.url)) bad(`${tag}: url must be https`);
    if (!isStr(ev.badge)) bad(`${tag}: badge missing`);
    if (ev.badgeColor !== undefined && !HEX_RE.test(String(ev.badgeColor))) bad(`${tag}: badgeColor must be #rrggbb`);
    if (ev.contestId !== undefined && !/^[a-z0-9-]+$/.test(String(ev.contestId))) bad(`${tag}: contestId must be a kebab-case id`);
    if (ev.links !== undefined) {
      if (!ev.links || typeof ev.links !== 'object' || Array.isArray(ev.links)) bad(`${tag}: links must be an object`);
      else for (const [k, v] of Object.entries(ev.links)) {
        if (!isStr(v) || !/^https:\/\//.test(v)) bad(`${tag}: links.${k} must be an https URL`);
      }
    }

    // Callsign patterns (a counter board counts every QSO in the window and
    // may legitimately name no station at all)
    const patterns = Array.isArray(ev.callsignPatterns) ? ev.callsignPatterns : null;
    if (!patterns) bad(`${tag}: callsignPatterns must be an array`);
    else if (!patterns.length && ev.board !== 'counter') bad(`${tag}: callsignPatterns must be non-empty for a ${ev.board} board`);
    else {
      const seen = new Set();
      patterns.forEach((p) => {
        if (!isStr(p) || !PATTERN_RE.test(p)) bad(`${tag}: pattern ${JSON.stringify(p)} is not an exact call or PREFIX/* wildcard`);
        if (seen.has(p)) bad(`${tag}: duplicate pattern ${p}`);
        seen.add(p);
      });
    }

    // Schedule
    if (!Array.isArray(ev.schedule) || !ev.schedule.length) bad(`${tag}: schedule must be a non-empty array`);
    else ev.schedule.forEach((s, j) => {
      const st = `${tag}.schedule[${j}]`;
      if (!s || typeof s !== 'object') { bad(`${st}: not an object`); return; }
      if (!isStr(s.region)) bad(`${st}: region missing`);
      if (!isStr(s.regionName)) bad(`${st}: regionName missing`);
      for (const k of ['start', 'end']) {
        if (!ISO_RE.test(String(s[k])) || Number.isNaN(Date.parse(s[k]))) bad(`${st}: ${k} must be an ISO-8601 UTC instant (...Z)`);
      }
      if (ISO_RE.test(String(s.start)) && ISO_RE.test(String(s.end)) && Date.parse(s.start) >= Date.parse(s.end)) bad(`${st}: start must precede end`);
      if (s.patterns !== undefined) {
        if (!Array.isArray(s.patterns) || !s.patterns.length) bad(`${st}: patterns must be a non-empty array when present`);
        else s.patterns.forEach((p) => { if (!isStr(p) || !PATTERN_RE.test(p)) bad(`${st}: pattern ${JSON.stringify(p)} is malformed`); });
      }
    });

    // Tracking
    const tr = ev.tracking;
    if (!tr || typeof tr !== 'object') { bad(`${tag}: tracking missing`); return; }
    if (tr.type !== ev.board) bad(`${tag}: tracking.type (${tr.type}) must equal board (${ev.board})`);
    if (!Number.isInteger(tr.total) || tr.total < 0 || (tr.total === 0 && ev.board !== 'counter')) bad(`${tag}: tracking.total must be a positive integer`);
    if (!isStr(tr.label)) bad(`${tag}: tracking.label missing`);

    if (ev.board === 'checklist') {
      const items = Array.isArray(tr.items) ? tr.items : null;
      if (!items || !items.length) { bad(`${tag}: checklist needs tracking.items`); return; }
      if (tr.total !== items.length) bad(`${tag}: tracking.total (${tr.total}) != items.length (${items.length})`);
      const itemIds = new Set();
      const routes = new Map();
      items.forEach((it, j) => {
        const st = `${tag}.items[${j}]${it && it.id ? ` (${it.id})` : ''}`;
        if (!it || typeof it !== 'object') { bad(`${st}: not an object`); return; }
        if (!isStr(it.id)) bad(`${st}: id missing`);
        else if (itemIds.has(it.id)) bad(`${st}: duplicate item id`);
        itemIds.add(it.id);
        if (typeof it.name !== 'string') bad(`${st}: name must be a string (may be empty)`);
        const hasLat = it.lat !== undefined, hasLon = it.lon !== undefined;
        if (hasLat !== hasLon) bad(`${st}: lat and lon must both be present or both absent`);
        if (hasLat && (!isNum(it.lat) || it.lat < -90 || it.lat > 90)) bad(`${st}: lat out of range`);
        if (hasLon && (!isNum(it.lon) || it.lon < -180 || it.lon > 180)) bad(`${st}: lon out of range`);
        if (it.route !== undefined) {
          if (!Number.isInteger(it.route) || it.route <= 0) bad(`${st}: route must be a positive integer`);
          else if (routes.has(it.route)) bad(`${st}: route ${it.route} already used by ${routes.get(it.route)}`);
          routes.set(it.route, it.id);
          if (!hasLat) bad(`${st}: route order needs lat/lon`);
          if (it.offRoute) bad(`${st}: route and offRoute are mutually exclusive`);
        }
        if (it.offRoute !== undefined && typeof it.offRoute !== 'boolean') bad(`${st}: offRoute must be boolean`);
        if (it.group !== undefined && !isStr(it.group)) bad(`${st}: group must be a non-empty string`);
      });
      // Exact patterns <=> checklist items: every station you can badge is a
      // box you can tick, and vice-versa. Only enforced when no pattern is a
      // wildcard (a wildcard event cannot enumerate its stations).
      if (patterns && patterns.every((p) => isStr(p) && !p.endsWith('/*'))) {
        for (const p of patterns) if (!itemIds.has(p)) bad(`${tag}: pattern ${p} has no checklist item`);
        for (const id of itemIds) if (!patterns.includes(id)) bad(`${tag}: item ${id} is not in callsignPatterns`);
      }
    }
  });
  return problems;
}

/** BUILTIN_EVENTS out of main.js without booting Electron. */
function loadBuiltinEvents(mainPath) {
  const src = fs.readFileSync(mainPath || path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf('const BUILTIN_EVENTS = ');
  const end = src.indexOf('\nfunction loadEventsCache()', start);
  if (start < 0 || end < 0) throw new Error('BUILTIN_EVENTS block not found in main.js');
  const body = src.slice(start + 'const BUILTIN_EVENTS = '.length, end).trim().replace(/;\s*$/, '');
  return new Function(`return (${body});`)(); // eslint-disable-line no-new-func
}

/**
 * Per-id comparison of the fallback against the feed. Returns
 * `{id, status:'identical'|'differs'|'builtin-only', keys?}` rows.
 */
function compareCatalogs(builtin, feed) {
  return (builtin.events || []).map((be) => {
    const fe = (feed.events || []).find((e) => e && e.id === be.id);
    if (!fe) return { id: be.id, status: 'builtin-only' };
    try { assert.deepStrictEqual(be, fe); return { id: be.id, status: 'identical' }; }
    catch {
      const keys = [...new Set([...Object.keys(be), ...Object.keys(fe)])].filter((k) => {
        try { assert.deepStrictEqual(be[k], fe[k]); return false; } catch { return true; }
      });
      return { id: be.id, status: 'differs', keys };
    }
  });
}

module.exports = { validateEventsCatalog, loadBuiltinEvents, compareCatalogs };

if (require.main === module) {
  const args = process.argv.slice(2);
  const compare = args.includes('--compare');
  const reqIdx = args.indexOf('--require');
  const required = reqIdx >= 0 ? String(args[reqIdx + 1] || '').split(',').filter(Boolean) : [];
  const file = args.find((a, i) => !a.startsWith('--') && i !== reqIdx + 1);
  let failed = false;

  const report = (label, problems) => {
    if (problems.length) { failed = true; console.error(`${label}: ${problems.length} problem(s)`); problems.forEach((p) => console.error(`  - ${p}`)); }
    else console.log(`${label}: OK`);
  };

  const builtin = loadBuiltinEvents();
  report(`BUILTIN_EVENTS (${builtin.events.length} events)`, validateEventsCatalog(builtin));

  if (file) {
    const feed = JSON.parse(fs.readFileSync(file, 'utf8'));
    report(`${file} (${(feed.events || []).length} events, updated ${feed.updated})`, validateEventsCatalog(feed, { feed: true }));
    if (compare) {
      for (const row of compareCatalogs(builtin, feed)) {
        const must = required.includes(row.id);
        const line = `  ${row.id}: ${row.status}${row.keys ? ` (${row.keys.join(', ')})` : ''}`;
        if (row.status === 'differs' && must) { failed = true; console.error(line + '  <-- must be identical'); }
        else console.log(line);
      }
      for (const id of required) {
        if (!builtin.events.some((e) => e.id === id)) { failed = true; console.error(`  ${id}: missing from BUILTIN_EVENTS`); }
        if (!(feed.events || []).some((e) => e.id === id)) { failed = true; console.error(`  ${id}: missing from ${file}`); }
      }
    }
  }
  process.exit(failed ? 1 : 0);
}
