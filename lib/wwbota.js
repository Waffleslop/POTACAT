// WWBOTA (Worldwide Bunkers on the Air) API client — fetches activator
// spots and re-spots. https://wwbota.net — covers national branches
// UKBOTA, HBBOTA, USBOTA, ITABOTA, FBOTA, ONBOTA, etc.
//
// Per the live OpenAPI at https://api.wwbota.net/openapi.json, both
// GET and POST /spots/ are unauthenticated — no token required.
const https = require('https');

const HOST = 'api.wwbota.net';
// 1-hour window matches the table's typical "what's active right now"
// view. WWBOTA's GET /spots/?age=N clamps N to [0, 24].
const SPOT_AGE_HOURS = 1;

function fetchSpots() {
  return new Promise((resolve, reject) => {
    https.get({
      host: HOST,
      path: `/spots/?age=${SPOT_AGE_HOURS}`,
      headers: { 'User-Agent': 'POTACAT/1.0', 'Accept': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          reject(new Error('Failed to parse WWBOTA response'));
        }
      });
    }).on('error', reject);
  });
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
