// Contests feed client (docs/contests-feed.md).
//
// The server (api.potacat.com, a daily job) resolves every catalog rule into
// concrete occurrences and publishes them at GET /v1/contests. This module
// fetches that feed with If-None-Match, caches it in userData, and answers
// two questions for the rest of the app:
//
//   catalog()      — the contest list to use (the feed's, else the bundled one)
//   resolvedAt(t)  — each contest with its next { start, end } at time t
//
// Dates come from the feed's `occurrences`: the first whose end is after t.
// When an entry has none left (feed older than its horizon, a `custom:` rule)
// the bundled resolver is asked instead, which may know the rule. So a feed
// that is weeks stale still works, and a catalog edit pushed to the POTACAT
// repo reaches every desktop within a day with no release.
//
// The fetch and the filesystem are injected so tests need neither.
'use strict';

const EventEmitter = require('events');

const FEED_URL = 'https://api.potacat.com/v1/contests';
const SCHEMA_VERSION = 2;

/** A feed we are willing to use: right schema, a non-trivial list, parseable dates. */
function validateFeed(data) {
  if (!data || typeof data !== 'object') return 'not an object';
  if (data.schemaVersion !== SCHEMA_VERSION) return `schemaVersion ${data.schemaVersion}`;
  if (!Array.isArray(data.contests) || data.contests.length < 10) return 'too few contests';
  const ids = new Set();
  for (const c of data.contests) {
    if (!c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string') return 'entry without id/name';
    if (ids.has(c.id)) return `duplicate id ${c.id}`;
    ids.add(c.id);
    if (!Array.isArray(c.occurrences)) return `${c.id}: no occurrences array`;
    for (const o of c.occurrences) {
      if (!o || !Number.isFinite(Date.parse(o.start)) || !Number.isFinite(Date.parse(o.end))) return `${c.id}: bad occurrence`;
    }
  }
  return null;
}

/** First occurrence whose end is after `now`, as Dates; null if none. */
function nextOccurrence(occurrences, now) {
  const t = now.getTime();
  for (const o of occurrences || []) {
    const end = new Date(o.end);
    if (end.getTime() > t) return { start: new Date(o.start), end };
  }
  return null;
}

/** Catalog entry as the rest of the app expects it: feed-only fields removed,
 *  and a rules link the server found dead replaced by the sponsor site. */
function toCatalogEntry(c) {
  const { occurrences, links, ...entry } = c;
  if (links && links.rulesUrl === 'dead' && entry.website) entry.rulesUrl = entry.website;
  return entry;
}

class ContestsFeed extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.cachePath       where the last good feed is kept
   * @param {() => object[]} o.bundled  the catalog shipped with the app
   * @param {(c: object, now: Date) => {start, end}} o.resolveLocal  bundled resolver
   * @param {(url, headers) => Promise<{status, etag, body}>} o.fetch
   * @param {{read: (p) => string, write: (p, s) => void}} o.fs
   */
  constructor({ cachePath, bundled, resolveLocal, fetch, fs, url = FEED_URL, log = () => {} }) {
    super();
    this._cachePath = cachePath;
    this._bundled = bundled;
    this._resolveLocal = resolveLocal;
    this._fetch = fetch;
    this._fs = fs;
    this._url = url;
    this._log = log;
    this._feed = null;     // validated feed object
    this._etag = null;
    this._fetchedAt = 0;
  }

  /** Read the cached feed (startup). A bad cache is ignored, never fatal. */
  load() {
    try {
      const cached = JSON.parse(this._fs.read(this._cachePath));
      const err = validateFeed(cached && cached.feed);
      if (err) { this._log(`[Contests] cached feed ignored: ${err}`); return false; }
      this._feed = cached.feed;
      this._etag = cached.etag || null;
      this._fetchedAt = cached.fetchedAt || 0;
      return true;
    } catch { return false; }
  }

  /** Conditional GET. Resolves to 'updated' | 'unchanged' | 'rejected' | 'failed'. */
  async refresh() {
    let res;
    try {
      res = await this._fetch(this._url, this._etag ? { 'If-None-Match': this._etag } : {});
    } catch (err) {
      this._log(`[Contests] feed fetch failed: ${err && err.message ? err.message : err}`);
      return 'failed';
    }
    if (res.status === 304) {
      this._fetchedAt = Date.now();
      this._save();
      return 'unchanged';
    }
    if (res.status !== 200) {
      this._log(`[Contests] feed fetch: HTTP ${res.status}`);
      return 'failed';
    }
    let data;
    try { data = JSON.parse(res.body); } catch { this._log('[Contests] feed rejected: not JSON'); return 'rejected'; }
    const err = validateFeed(data);
    if (err) { this._log(`[Contests] feed rejected: ${err}`); return 'rejected'; }
    const changed = !this._feed || this._feed.generated !== data.generated || this._feed.catalogSha !== data.catalogSha;
    this._feed = data;
    this._etag = res.etag || null;
    this._fetchedAt = Date.now();
    this._save();
    if (changed) {
      this._log(`[Contests] feed updated: ${data.contests.length} contests (generated ${data.generated})`);
      this.emit('updated');
      return 'updated';
    }
    return 'unchanged';
  }

  _save() {
    try {
      this._fs.write(this._cachePath, JSON.stringify({ feed: this._feed, etag: this._etag, fetchedAt: this._fetchedAt }));
    } catch (err) {
      this._log(`[Contests] could not cache feed: ${err && err.message ? err.message : err}`);
    }
  }

  hasFeed() { return !!this._feed; }

  status() {
    return this._feed
      ? { source: 'feed', generated: this._feed.generated, fetchedAt: this._fetchedAt, contests: this._feed.contests.length }
      : { source: 'bundled', contests: (this._bundled() || []).length };
  }

  /** The contest list: the feed's when we have one, else the bundled catalog. */
  catalog() {
    return this._feed ? this._feed.contests.map(toCatalogEntry) : (this._bundled() || []);
  }

  /** Every contest with its next { start, end } at `now`, sorted by start
   *  (unresolvable last) — the shape contests-db getResolved() returns. */
  resolvedAt(now = new Date()) {
    const out = [];
    if (this._feed) {
      for (const c of this._feed.contests) {
        const entry = toCatalogEntry(c);
        let occ = nextOccurrence(c.occurrences, now);
        if (!occ) {
          try { occ = this._resolveLocal(entry, now); } catch { occ = null; }
        }
        out.push({ ...entry, start: occ && occ.start ? occ.start : null, end: occ && occ.end ? occ.end : null });
      }
    } else {
      for (const c of this._bundled() || []) {
        let occ = null;
        try { occ = this._resolveLocal(c, now); } catch {}
        out.push({ ...c, start: occ && occ.start ? occ.start : null, end: occ && occ.end ? occ.end : null });
      }
    }
    out.sort((a, b) => (a.start ? a.start.getTime() : Infinity) - (b.start ? b.start.getTime() : Infinity));
    return out;
  }
}

module.exports = { ContestsFeed, validateFeed, nextOccurrence, toCatalogEntry, FEED_URL, SCHEMA_VERSION };
