// SOTA API client — fetches activator spots and summit info
const https = require('https');

const SPOT_URL = 'https://api2.sota.org.uk/api/spots/60/all';

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'flex-lookup/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse SOTA response'));
        }
      });
    }).on('error', reject);
  });
}

function fetchSpots() {
  return httpsGetJson(SPOT_URL);
}

// In-memory cache: "W4C/CM-094" → { lat, lon } or null
const summitCache = new Map();

async function fetchSummitCoords(associationCode, summitCode) {
  const key = associationCode + '/' + summitCode;
  if (summitCache.has(key)) return summitCache.get(key);

  try {
    const url = `https://api2.sota.org.uk/api/summits/${encodeURIComponent(associationCode)}/${encodeURIComponent(summitCode)}`;
    const info = await httpsGetJson(url);
    const lat = parseFloat(info.latitude);
    const lon = parseFloat(info.longitude);
    const coords = (!isNaN(lat) && !isNaN(lon)) ? { lat, lon } : null;
    summitCache.set(key, coords);
    return coords;
  } catch {
    summitCache.set(key, null);
    return null;
  }
}

// Batch-fetch coordinates for a list of {associationCode, summitCode} pairs
// Returns Map of "assoc/code" → {lat, lon} or null
async function fetchSummitCoordsBatch(summits) {
  const unique = [];
  const seen = new Set();
  for (const { associationCode, summitCode } of summits) {
    if (!associationCode || !summitCode) continue;
    const key = associationCode + '/' + summitCode;
    if (seen.has(key) || summitCache.has(key)) continue;
    seen.add(key);
    unique.push({ associationCode, summitCode });
  }

  // Fetch up to 20 at a time to avoid hammering the API
  const BATCH = 20;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map((s) => fetchSummitCoords(s.associationCode, s.summitCode))
    );
  }

  return summitCache;
}

module.exports = { fetchSpots, fetchSummitCoords, fetchSummitCoordsBatch, summitCache };
