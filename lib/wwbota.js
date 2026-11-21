// WWBOTA (Worldwide Bunkers on the Air) API client — fetches activator
// spots and re-spots. https://wwbota.net — covers national branches
// UKBOTA, HBBOTA, USBOTA, ITABOTA, FBOTA, ONBOTA, etc.
//
// Per the live OpenAPI at https://api.wwbota.net/openapi.json, both
// GET and POST /spots/ are unauthenticated — no token required.
//
// The /spots/ endpoint also speaks Server-Sent Events (Accept:
// text/event-stream): the server pushes each spot as it arrives, so we
// hold ONE long-lived connection and read fetchSpots() from an in-memory
// store instead of re-polling the REST endpoint every refresh cycle.
// Bandwidth/load drop accordingly. (kwirk, PR #44 — reworked: no extra
// dependency, multi-band-safe keys, real age pruning, and reconnect/backoff.)
const https = require('https');
const USER_AGENT = 'POTACAT/' + require('../package.json').version;

const HOST = 'api.wwbota.net';
// 3-hour window — WWBOTA traffic is low-volume (mostly UK/EU bunker
// activations), so a 1-hour window often returned empty when checked
// from US time zones (Casey 2026-06-07). API clamps N to [0, 24].
const SPOT_AGE_HOURS = 3;
const SPOT_AGE_MS = SPOT_AGE_HOURS * 60 * 60 * 1000;
const SSE_BACKOFF_MIN_MS = 1000;
const SSE_BACKOFF_MAX_MS = 60000;

// Optional logger (main wires this to sendCatLog so SSE reconnects/errors
// show in the CAT log). No-op by default so the module stays standalone.
let _log = () => {};
function setLogger(fn) { if (typeof fn === 'function') _log = fn; }

// ── Pure helpers (unit-tested in test/wwbota-test.js) ───────────────────────

// Stable key for a spot. Prefer the server's unique id; otherwise
// call+freq+mode so a station spotted on two bands keeps BOTH entries
// (collapsing on call alone dropped multi-band activations). A re-spot or
// QRT that reuses the same key overwrites in place, which is what we want.
function spotKey(spot) {
  if (spot && spot.id != null && spot.id !== '') return 'id:' + spot.id;
  const call = String((spot && spot.call) || '').toUpperCase();
  const freq = String((spot && spot.freq) || '');
  const mode = String((spot && spot.mode) || '').toUpperCase();
  return call + '|' + freq + '|' + mode;
}

// Parse SSE wire text into complete events. Returns the JSON data strings of
// each fully-received frame plus any trailing partial bytes to carry over to
// the next chunk. Handles CRLF, comment (':') keepalive lines, and multi-line
// `data:` fields per the SSE spec.
function parseSseFrames(buffer) {
  buffer = buffer.replace(/\r\n/g, '\n');
  const events = [];
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue; // blank / comment keepalive
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      // event:/id:/retry: are ignored — we only consume data payloads
    }
    if (dataLines.length) events.push(dataLines.join('\n'));
  }
  return { events, rest: buffer };
}

// In-memory spot store with age pruning. Prunes by the spot's own `time`
// (the field POTACAT's renderer reads); if that's missing/unparseable, falls
// back to when we received it so the store can never grow unbounded.
function makeSpotStore() {
  const map = new Map();
  return {
    upsert(spot, now) {
      if (!spot || !spot.call) return;
      map.set(spotKey(spot), { spot, receivedAt: now });
    },
    prune(now, maxAgeMs) {
      for (const [k, e] of map) {
        const t = e.spot && e.spot.time ? Date.parse(e.spot.time) : NaN;
        const age = now - (Number.isFinite(t) ? t : e.receivedAt);
        if (age > maxAgeMs) map.delete(k);
      }
    },
    values() { return Array.from(map.values(), (e) => e.spot); },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

// ── SSE connection state ────────────────────────────────────────────────────
const store = makeSpotStore();
let streamStarted = false;
const sse = { req: null, res: null, buffer: '', stopped: false, backoff: SSE_BACKOFF_MIN_MS, reconnectTimer: null };

function scheduleReconnect() {
  if (sse.stopped || sse.reconnectTimer) return;
  const delay = sse.backoff;
  sse.backoff = Math.min(sse.backoff * 2, SSE_BACKOFF_MAX_MS);
  sse.reconnectTimer = setTimeout(() => { sse.reconnectTimer = null; openSse(); }, delay);
}

function openSse() {
  if (sse.stopped) return;
  sse.buffer = '';
  const req = https.get({
    host: HOST,
    path: `/spots/?age=${SPOT_AGE_HOURS}`,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
    // No timeout: this is a long-lived stream, not a request/response.
  }, (res) => {
    const ctype = String(res.headers['content-type'] || '');
    if (res.statusCode !== 200 || !/text\/event-stream/i.test(ctype)) {
      res.resume();
      _log(`[WWBOTA] SSE unavailable (HTTP ${res.statusCode}, ${ctype || 'no content-type'}) — retrying`);
      scheduleReconnect();
      return;
    }
    sse.res = res;
    sse.backoff = SSE_BACKOFF_MIN_MS; // healthy connection — reset backoff
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      sse.buffer += chunk;
      const { events, rest } = parseSseFrames(sse.buffer);
      sse.buffer = rest;
      const now = Date.now();
      for (const ev of events) {
        try { store.upsert(JSON.parse(ev), now); }
        catch { /* keepalive / non-JSON line — ignore */ }
      }
    });
    res.on('end', () => { sse.res = null; _log('[WWBOTA] SSE stream ended — reconnecting'); scheduleReconnect(); });
    res.on('error', (e) => { sse.res = null; _log('[WWBOTA] SSE stream error: ' + e.message); scheduleReconnect(); });
  });
  req.on('error', (e) => { _log('[WWBOTA] SSE connect error: ' + e.message); scheduleReconnect(); });
  sse.req = req;
}

// Close the stream and forget accumulated spots. Call when WWBOTA is disabled
// or the app is quitting so we don't hold an idle connection to a third party.
function disconnect() {
  sse.stopped = true;
  if (sse.reconnectTimer) { clearTimeout(sse.reconnectTimer); sse.reconnectTimer = null; }
  try { if (sse.req) sse.req.destroy(); } catch {}
  try { if (sse.res) sse.res.destroy(); } catch {}
  sse.req = null; sse.res = null; sse.buffer = '';
  store.clear();
  streamStarted = false;
}

// Returns the current set of WWBOTA spots from the SSE-backed store. The first
// call opens the stream; later calls return the age-pruned store.
async function fetchSpots() {
  sse.stopped = false; // re-enable after a prior disconnect()
  if (!streamStarted) {
    streamStarted = true;
    openSse();
  }
  store.prune(Date.now(), SPOT_AGE_MS);
  return store.values();
}

// POST /spots/ takes { spotter, call, freq (MHz), mode, comment } where
// `comment` MUST embed at least one bunker reference matching B/<scheme>-####.
// Returns the created Spot (with UUID) on success.
function postSpot({ spotter, call, freq, mode, comment, type }) {
  return new Promise((resolve, reject) => {
    const freqMHz = typeof freq === 'number' && freq > 1000 ? freq / 1000 : freq;
    const body = JSON.stringify({
      spotter: String(spotter || '').toUpperCase(),
      call: String(call || '').toUpperCase(),
      freq: Number(freqMHz),
      mode: String(mode || ''),
      comment: String(comment || ''),
      type: type || 'Live',
    });
    const req = https.request({
      host: HOST,
      path: '/spots/',
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: true }); }
        } else {
          // Friendly error: WWBOTA's DRF backend returns JSON like
          //   {"comment":["..."], "freq":["..."]}
          // or {"detail":"..."} on 4xx. Surface the message(s) inline
          // instead of dumping raw JSON into a toast that gets truncated
          // at 200 chars and looks like garbage to the operator.
          let detail = '';
          try {
            const obj = JSON.parse(data);
            if (obj && typeof obj === 'object') {
              if (typeof obj.detail === 'string') {
                detail = obj.detail;
              } else {
                const parts = [];
                for (const [field, val] of Object.entries(obj)) {
                  const list = Array.isArray(val) ? val.join(', ') : String(val);
                  parts.push(`${field}: ${list}`);
                }
                detail = parts.join(' · ');
              }
            }
          } catch {}
          const tail = detail || data.slice(0, 200);
          reject(new Error(`WWBOTA ${res.statusCode}: ${tail}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  fetchSpots,
  postSpot,
  disconnect,
  setLogger,
  // exported for unit tests
  _parseSseFrames: parseSseFrames,
  _spotKey: spotKey,
  _makeSpotStore: makeSpotStore,
};
