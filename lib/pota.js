// POTA API client — fetches activator spots
const https = require('https');

const SPOT_URL = 'https://api.pota.app/spot/activator';

// A failure must REJECT: refreshSpots then shows the last good POTA list
// (lib/spot-source-cache.js). An error page or a JSON error object used to
// resolve as if it were the spot list, and a stalled request held the whole
// refresh (wayne 2026-10-31: the table blanked, then came back source by source).
function fetchSpots() {
  return new Promise((resolve, reject) => {
    const req = https.get(SPOT_URL, { headers: { 'User-Agent': 'flex-lookup/1.0' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('POTA HTTP ' + res.statusCode));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (e) { reject(new Error('Failed to parse POTA response')); return; }
        if (!Array.isArray(json)) { reject(new Error('POTA answered without a spot list')); return; }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('POTA did not answer in 15 s')));
  });
}

/**
 * Fetch spot history (a.k.a. "comments") for a given activator at a given
 * reference from POTA.app. Returns an array of past spot entries:
 * [{ spotter, frequency, mode, source, comments, spotTime }, ...]
 * Up to ~25 most recent entries depending on the API.
 *
 * Always settles: the whole request (connect, headers and body) gets
 * `timeoutMs` (10 s), then it is aborted and the promise rejects. A stalled
 * socket used to leave the caller waiting for good.
 */
const SPOT_HISTORY_TIMEOUT_MS = 10000;
const SPOT_HISTORY_MAX_BYTES = 512 * 1024; // about 25 spots answer in a few kB
function fetchSpotHistory(call, reference, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!call || !reference) { resolve([]); return; }
    const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : SPOT_HISTORY_TIMEOUT_MS;
    // Call first, then the park: /spot/comments/{ref}/{call} answers an empty
    // list for every activator, which made this endpoint look broken.
    const url = `https://api.pota.app/spot/comments/${encodeURIComponent(call.toUpperCase())}/${encodeURIComponent(reference)}`;
    let settled = false;
    let timer = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };
    const req = https.get(url, { headers: { 'User-Agent': 'POTACAT/1.0' } }, (res) => {
      if (res.statusCode === 404) { res.resume(); done(resolve, []); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        done(reject, new Error('POTA history HTTP ' + res.statusCode));
        return;
      }
      let data = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > SPOT_HISTORY_MAX_BYTES) {
          // Not a spot history: stop reading it, never parse it.
          const err = new Error('POTA history answer is over ' + (SPOT_HISTORY_MAX_BYTES / 1024) + ' kB');
          done(reject, err);
          try { req.destroy(err); } catch { /* already gone */ }
          return;
        }
        data += chunk;
      });
      res.on('error', (err) => done(reject, err));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          done(resolve, Array.isArray(json) ? json : []);
        } catch {
          done(resolve, []); // empty / malformed = treat as no history
        }
      });
    });
    req.on('error', (err) => done(reject, err));
    timer = setTimeout(() => {
      const err = new Error(`POTA history did not answer in ${Math.round(timeoutMs / 1000)} s`);
      done(reject, err);
      try { req.destroy(err); } catch { /* already gone */ }
    }, timeoutMs);
  });
}

/**
 * Parse the state codes out of a POTA park locationDesc. Parks that span
 * states list several comma-separated designators — "US-WI,US-MI" (some
 * trail parks list a dozen) — and the old `split('-')` parse produced
 * garbage like "WI,US-MI" in the log's STATE field (WG9I, 2026-06-12).
 * Returns deduped state codes: "US-WI,US-MI" → ['WI','MI']; "US-ME" →
 * ['ME']; '' → []. Callers decide what to do with >1 (the desktop log
 * paths prompt the operator; the phone path leaves STATE blank — the
 * activator is only ever standing in one of them).
 *
 * Mirrored as parkStatesFromLocationLocal in renderer/app.js (no
 * require() in the renderer) — keep the two in sync.
 */
function parkStatesFromLocation(locationDesc) {
  const out = [];
  for (const part of String(locationDesc || '').split(',')) {
    const seg = part.trim();
    const dash = seg.indexOf('-');
    const st = dash >= 0 ? seg.slice(dash + 1).trim() : '';
    if (st && out.indexOf(st) < 0) out.push(st);
  }
  return out;
}

module.exports = { fetchSpots, fetchSpotHistory, parkStatesFromLocation };
