// PARC (Protected Area Radio Community) spot client — https://parc-community.com
//
// A POTA-style parks program (217k+ parks, 255 countries, refs like
// US-NC-2540) with an unauthenticated JSON API. Requested by N3FMC
// (2026-08-17). Read-only in v1: the site documents no public spot-POST API,
// so there is no re-spot path (unlike GMA's DXSpider cluster).
//
// RX: GET /api/spots returns { spots: [...], count: N }. The program is
// young and the feed was EMPTY at integration time, so the per-spot field
// names are UNVERIFIED — normalizeRecord accepts the aliases every sibling
// program uses (and the naming convention of PARC's own /api/parks, which
// we could inspect: reference/name/latitude/longitude/snake_case). A record
// that looks like a spot (call + freq) but matches no known ref/time alias
// logs ONE schema-drift warning so we find out the day the guess is wrong.
const https = require('https');

const API_HOST = 'parc-community.com';
const SPOT_PATH = '/api/spots';

// Optional logger (main wires this to sendCatLog). No-op by default.
let _log = () => {};
function setLogger(fn) { if (typeof fn === 'function') _log = fn; }
let _schemaWarned = false;

// ── Pure helpers (unit-tested in test/parc-test.js) ─────────────────────────

/** First non-empty value among aliases on a record. */
function pick(rec, names) {
  for (const n of names) {
    const v = rec[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/** Spot time → unix SECONDS. Accepts ISO strings, unix seconds, unix ms. */
function parcTimeToUnix(v) {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Heuristic: ms timestamps are 13 digits, seconds are 10.
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  const s = String(v).trim();
  if (/^\d{13}$/.test(s)) return Math.floor(+s / 1000);
  if (/^\d{10}$/.test(s)) return +s;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z'); // bare ISO = UTC
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** Frequency in any of kHz / MHz / Hz → kHz. HF+VHF plausibility keyed on
 *  magnitude: <1000 = MHz (14.074), <100000 = kHz (14074), else Hz. */
function parcFreqToKhz(v) {
  const f = parseFloat(v);
  if (!Number.isFinite(f) || f <= 0) return 0;
  if (f < 1000) return f * 1000;      // MHz
  if (f < 100000) return f;           // kHz (covers 1.8–70 MHz and 144 MHz=144174? no — 144174 kHz > 100000)
  if (f < 1000000) return f;          // still kHz (VHF/UHF: 144174, 432065)
  return f / 1000;                    // Hz
}

/** Normalize one spot record into the WWFF-style shape processParcSpots
 *  consumes. Returns null for records to skip (no ref / no call / bad freq). */
function normalizeRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const activator = String(pick(rec, ['activator', 'activator_callsign', 'callsign', 'call']) || '').toUpperCase().trim();
  const freqKhz = parcFreqToKhz(pick(rec, ['frequency_khz', 'frequency', 'freq_khz', 'freq']));
  const ref = String(pick(rec, ['reference', 'park_reference', 'parkReference', 'ref']) || '').toUpperCase().trim();
  if (!activator || !freqKhz) return null;
  if (!ref) {
    if (!_schemaWarned) {
      _schemaWarned = true;
      _log('[PARC] Spot record has a call+frequency but no recognizable reference field — the API schema may have drifted from what POTACAT expects. Keys seen: ' + Object.keys(rec).join(','));
    }
    return null;
  }
  const lat = parseFloat(pick(rec, ['latitude', 'lat']));
  const lon = parseFloat(pick(rec, ['longitude', 'lon', 'lng']));
  return {
    activator,
    frequency_khz: freqKhz,
    reference: ref,
    reference_name: String(pick(rec, ['park_name', 'parkName', 'name', 'reference_name']) || ''),
    mode: String(pick(rec, ['mode']) || '').toUpperCase().trim(),
    spotter: String(pick(rec, ['spotter', 'spotter_callsign']) || '').toUpperCase().trim(),
    comments: String(pick(rec, ['comments', 'comment', 'text', 'remarks']) || '').trim(),
    spot_time: parcTimeToUnix(pick(rec, ['spot_time', 'spotted_at', 'created_at', 'time', 'timestamp'])),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
  };
}

/** Unwrap the API envelope: { spots: [...] } or a bare array. */
function unwrapSpots(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.spots)) return parsed.spots;
  return [];
}

// ── Network ─────────────────────────────────────────────────────────────────

function fetchSpots() {
  return new Promise((resolve, reject) => {
    https.get({
      host: API_HOST,
      path: SPOT_PATH,
      headers: { 'User-Agent': 'POTACAT/1.0', 'Accept': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`PARC HTTP ${res.statusCode}`));
          return;
        }
        try {
          const out = [];
          for (const rec of unwrapSpots(JSON.parse(data))) {
            const n = normalizeRecord(rec);
            if (n) out.push(n);
          }
          resolve(out);
        } catch (e) {
          reject(new Error('Failed to parse PARC response'));
        }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('PARC fetch timed out')); });
  });
}

module.exports = {
  fetchSpots,
  setLogger,
  // exported for unit tests
  _normalizeRecord: normalizeRecord,
  _parcTimeToUnix: parcTimeToUnix,
  _parcFreqToKhz: parcFreqToKhz,
  _unwrapSpots: unwrapSpots,
};
