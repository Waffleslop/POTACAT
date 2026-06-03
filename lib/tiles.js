'use strict';
//
// Tiles on the Air — spot fetcher.
//
// API: https://icneuzxitdqtofutxbla.supabase.co/functions/v1/spots
//   - With no `since` parameter the endpoint returns a full snapshot of the
//     currently-active spots (last 30 minutes, matches tilesontheair.com).
//   - With `since=<ISO>` the endpoint returns only spots posted after that
//     timestamp. Caller merges these into its cache.
//   - Server-side rate limit: 4 req/min/API-key. Overage returns HTTP 429
//     with a Retry-After header (seconds). Callers MUST honor it — the
//     operator is on Supabase Free tier and POTACAT's aggregate polling
//     drove a quota incident on 2026-06-02. Per the operator: "10 to 30
//     seconds between polls is plenty fast to catch a new spot within
//     its 30-minute lifetime." main.js polls every 30 s, mostly with a
//     `since` cutoff so each response is small, and refreshes the full
//     snapshot occasionally to handle clock skew / dropped spots.
//   - Server-side QRT filter: spots whose notes contain the word "qrt"
//     (whole word, case-insensitive) are dropped before they reach us.
//   - Other filters: active_hours (decimals OK, max 168), call_sign, limit
//     (max 200).
//
// Activation reference is the spot's maidenhead grid square — there's no
// separate "tile id." A spot can also carry pota_ref / sota_ref for
// activations that overlap multiple programs.
//

const https = require('https');

const HOST = 'icneuzxitdqtofutxbla.supabase.co';
const PATH = '/functions/v1/spots';
const API_KEY = 'f8c97c8c-88b9-48da-a68c-e8d52c23a042';

/**
 * Thrown on HTTP 429. Carries the Retry-After value (seconds) so the
 * caller can pause its poll cadence rather than blindly retry.
 */
class TilesRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(`Tiles rate-limited; retry after ${retryAfterSeconds}s`);
    this.name = 'TilesRateLimitError';
    this.retryAfter = retryAfterSeconds;
  }
}

/**
 * Fetch Tiles spots. Resolves to the raw `spots[]` array.
 *
 * @param {object} opts
 * @param {number} [opts.limit=150]     Cap on returned spots (server max 200).
 * @param {string} [opts.since]         ISO timestamp; only spots after this are
 *                                      returned. Omit for a full snapshot.
 * @param {number} [opts.activeHours]   Override the 0.5-hour default window.
 * @param {string} [opts.callSign]      Filter to a single station.
 *
 * Rejects with TilesRateLimitError on 429 (with `.retryAfter` seconds), or a
 * plain Error on other non-2xx.
 */
function fetchSpots(opts = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit || 150));
    if (opts.since) params.set('since', String(opts.since));
    if (opts.activeHours) params.set('active_hours', String(opts.activeHours));
    if (opts.callSign) params.set('call_sign', String(opts.callSign).toUpperCase());

    const req = https.request({
      host: HOST,
      path: `${PATH}?${params.toString()}`,
      method: 'GET',
      headers: {
        'x-api-key': API_KEY,
        'User-Agent': 'POTACAT/1.6',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          // Honor Retry-After. Spec allows seconds (integer) or HTTP-date —
          // Supabase Edge uses seconds. Default to 60 s if absent / unparseable.
          const ra = res.headers['retry-after'];
          let seconds = parseInt(ra, 10);
          if (!isFinite(seconds) || seconds <= 0) {
            const asDate = Date.parse(ra || '');
            if (isFinite(asDate)) seconds = Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
            else seconds = 60;
          }
          return reject(new TilesRateLimitError(seconds));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Tiles API ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed.spots) ? parsed.spots : []);
        } catch (err) {
          reject(new Error(`Tiles API parse failed: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Tiles API timeout')); });
    req.end();
  });
}

/**
 * Parse a Tiles frequency string into kHz.
 *
 * The API delivers `frequency` as a string in MHz, but real-world values
 * include malformed entries like "14.310.5" (the spotter inserted a stray
 * dot; the intended value was 14310.5 kHz / 14.3105 MHz). Strip extra dots
 * defensively, parse as MHz, return kHz as a number. Returns 0 for
 * unparseable inputs.
 */
function parseFreqKhz(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  // Keep only digits and the first dot.
  let seenDot = false;
  let cleaned = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') cleaned += ch;
    else if (ch === '.' && !seenDot) { cleaned += ch; seenDot = true; }
    // otherwise: skip (treats further dots / commas / letters as noise)
  }
  const mhz = parseFloat(cleaned);
  if (!isFinite(mhz) || mhz <= 0) return 0;
  return Math.round(mhz * 1000 * 10) / 10; // kHz with 100 Hz precision
}

module.exports = { fetchSpots, parseFreqKhz, TilesRateLimitError };
