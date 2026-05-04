'use strict';
//
// Tiles on the Air — spot fetcher.
//
// API: https://icneuzxitdqtofutxbla.supabase.co/functions/v1/spots
//   - Default window: last 30 minutes (matches tilesontheair.com/Spots).
//   - Polite incremental polling: pass ?since=<ISO timestamp> to fetch only
//     new spots. Rate limit on the key is 120 req/min; polling every
//     30–60s is plenty.
//   - Spots auto-expire 30 minutes after creation.
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

let _lastFetchedAt = null; // ISO string, set after each successful fetch

/**
 * Fetch Tiles spots. Uses ?since= for incremental polling so we only pay
 * for new spots after the first call. Falls back to the default 30-minute
 * window on the first call (and after errors).
 *
 * Returns the parsed `{spots, count, generated_at, window}` envelope.
 * The caller is expected to map `spots[]` into POTACAT's internal spot shape.
 */
function fetchSpots(opts = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams();
    // Limit cap is 200 server-side; pick something a bit under so we stay
    // polite and never run into "your fetch missed N rows" edge cases.
    params.set('limit', String(opts.limit || 150));
    if (_lastFetchedAt) {
      params.set('since', _lastFetchedAt);
    } else if (opts.activeHours) {
      params.set('active_hours', String(opts.activeHours));
    }
    if (opts.callSign) params.set('call_sign', String(opts.callSign).toUpperCase());

    const req = https.request({
      host: HOST,
      path: `${PATH}?${params.toString()}`,
      method: 'GET',
      headers: {
        'x-api-key': API_KEY,
        'User-Agent': 'POTACAT/1.5',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Tiles API ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(data);
          // generated_at is the server's clock; using that as `since` for the
          // next fetch avoids skew between client and server clocks.
          if (parsed.generated_at) _lastFetchedAt = parsed.generated_at;
          // Match the shape of the other fetchSpots helpers (raw array).
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
 * Reset the incremental-polling cursor. Call this when the user toggles
 * Tiles off and back on, or when settings change in a way that should
 * re-seed the buffer with a fresh 30-minute window.
 */
function resetCursor() {
  _lastFetchedAt = null;
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

module.exports = { fetchSpots, resetCursor, parseFreqKhz };
