// WWBOTA (Worldwide Bunkers on the Air) API client — fetches activator
// spots and re-spots. https://wwbota.net — covers national branches
// UKBOTA, HBBOTA, USBOTA, ITABOTA, FBOTA, ONBOTA, etc.
//
// Per the live OpenAPI at https://api.wwbota.net/openapi.json, both
// GET and POST /spots/ are unauthenticated — no token required.
// Spots endpoint also supports Server-Sent Events, which allows spots
// to be sent to clients as soon as they arrive therefore avoid polling
const eventsource = require('eventsource')

const HOST = 'api.wwbota.net';
// 3-hour window — WWBOTA traffic is low-volume (mostly UK/EU bunker
// activations), so a 1-hour window often returned empty when checked
// from US time zones (Casey 2026-06-07). API clamps N to [0, 24].
const SPOT_AGE_HOURS = 3;
const SPOT_AGE_MS = SPOT_AGE_HOURS * 60 * 60 * 1000;

let wwbotaEventSource;
const wwbotaSpotsMap = new Map();

async function fetchSpots() {
  if (!wwbotaEventSource || wwbotaEventSource.readyState === eventsource.EventSource.CLOSED) {
    // No current / active SSE connection
    wwbotaEventSource = new eventsource.EventSource(`https://${HOST}/spots/?age=${SPOT_AGE_HOURS}`);
    wwbotaEventSource.addEventListener('message', (ev) => {
      try {
        const spot = JSON.parse(ev.data);
        if (spot && spot.call) {
          wwbotaSpotsMap.set(spot.call, spot);
        }
      } catch (e) {
        console.error('Failed to parse WWBOTA response');
      }
    })
    // Wait briefly to allow messages to arrive from initial connection
    await new Promise((r) => {setTimeout(r, 1000)})
  }

  const now = Date.now();
  for (const [call, spot] of wwbotaSpotsMap.entries()) {
    if (spot.isoTime) {
      const sDate = new Date(spot.isoTime);
      if (now - sDate.getTime() > SPOT_AGE_MS) {
        wwbotaSpotsMap.delete(call);
      }
    }
  }

  return Array.from(wwbotaSpotsMap.values())
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
        'User-Agent': 'POTACAT/1.0',
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

module.exports = { fetchSpots, postSpot };
