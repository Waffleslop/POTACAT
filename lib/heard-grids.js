'use strict';
// The grid each station last SAID on the air (Casey, via the echocat session,
// 2026-11-02): a QSO started by clicking a station's RR73 or report carried no
// grid, because the grid came only from the clicked message's own text, even
// when that station's CQ with a grid was decoded minutes earlier. Main notes
// every decoded grid here and fills a QSO's missing grid from it (reply
// handlers and jtcatAutoLog). A grid heard is a grid said by them, so it
// counts as `gridHeard` like one in the clicked message.

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000; // a station rarely moves within an activation
const GRID_RE = /^[A-R]{2}[0-9]{2}([A-Xa-x]{2})?$/;

class HeardGrids {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = 2000, now = () => Date.now() } = {}) {
    this._ttl = ttlMs; this._max = max; this._now = now;
    this._map = new Map(); // CALL -> { grid, at }
  }
  note(call, grid) {
    const c = String(call || '').trim().toUpperCase();
    const g = String(grid || '').trim().toUpperCase();
    if (!c || !GRID_RE.test(g) || /^RR\d{2}$/.test(g)) return false;
    this._map.delete(c);
    this._map.set(c, { grid: g, at: this._now() });
    if (this._map.size > this._max) this._map.delete(this._map.keys().next().value);
    return true;
  }
  /** The grid heard from `call` within the TTL, or ''. */
  get(call) {
    const c = String(call || '').trim().toUpperCase();
    const e = this._map.get(c);
    if (!e) return '';
    if (this._now() - e.at > this._ttl) { this._map.delete(c); return ''; }
    return e.grid;
  }
  get size() { return this._map.size; }
}

module.exports = { HeardGrids, DEFAULT_TTL_MS };
