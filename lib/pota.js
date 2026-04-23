// POTA API client — fetches activator spots
const https = require('https');

const SPOT_URL = 'https://api.pota.app/spot/activator';

function fetchSpots() {
  return new Promise((resolve, reject) => {
    https.get(SPOT_URL, { headers: { 'User-Agent': 'flex-lookup/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse POTA response'));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch spot history (a.k.a. "comments") for a given activator at a given
 * reference from POTA.app. Returns an array of past spot entries:
 * [{ spotter, frequency, mode, source, comments, spotTime }, ...]
 * Up to ~25 most recent entries depending on the API.
 */
function fetchSpotHistory(call, reference) {
  return new Promise((resolve, reject) => {
    if (!call || !reference) { resolve([]); return; }
    const url = `https://api.pota.app/spot/comments/${encodeURIComponent(reference)}/${encodeURIComponent(call.toUpperCase())}`;
    https.get(url, { headers: { 'User-Agent': 'POTACAT/1.0' } }, (res) => {
      if (res.statusCode === 404) { resolve([]); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error('POTA history HTTP ' + res.statusCode));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(Array.isArray(json) ? json : []);
        } catch {
          resolve([]); // empty / malformed = treat as no history
        }
      });
    }).on('error', reject);
  });
}

module.exports = { fetchSpots, fetchSpotHistory };
