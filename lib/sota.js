// SOTA API client — fetches activator spots and summit info
const https = require('https');

const SPOT_URL = 'https://api-db2.sota.org.uk/api/spots/50/all/all';
const EPOCH_URL = 'https://api-db2.sota.org.uk/api/spots/epoch';
const UA = 'POTACAT/1.0';

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
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

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Epoch-based caching — only fetch full spot list when data has changed
let _lastEpoch = '';
let _cachedSpots = null;

async function fetchSpots() {
  const ep = await httpsGetText(EPOCH_URL);
  if (_lastEpoch !== ep || !_cachedSpots) {
    _cachedSpots = await httpsGetJson(SPOT_URL);
    // Use epoch from the spot data if available, otherwise from the epoch endpoint
    _lastEpoch = (_cachedSpots.length > 0 && _cachedSpots[0].epoch) || ep;
  }
  return _cachedSpots;
}

// In-memory cache: "W4C/CM-094" -> { lat, lon } or null
const summitCache = new Map();

// Association code -> friendly name (e.g. "W0C" -> "Colorado", "G" -> "England")
const assocNames = new Map();

async function loadAssociations() {
  if (assocNames.size > 0) return; // already loaded
  try {
    const data = await httpsGetJson('https://api-db2.sota.org.uk/api/associations');
    for (const a of data) {
      // Strip "USA - " / "Canada - " prefix for cleaner display
      let name = a.associationName || a.associationCode;
      name = name.replace(/^USA\s*-\s*/, '').replace(/^Canada\s*-\s*/, '');
      assocNames.set(a.associationCode, name);
    }
  } catch {
    // Non-fatal — will just show association codes as before
  }
}

function getAssociationName(code) {
  return assocNames.get(code) || code;
}

async function fetchSummitCoords(associationCode, summitCode) {
  const key = associationCode + '/' + summitCode;
  if (summitCache.has(key)) return summitCache.get(key);

  try {
    const url = `https://api-db2.sota.org.uk/api/summits/${encodeURIComponent(associationCode)}/${encodeURIComponent(summitCode)}`;
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
// Returns Map of "assoc/code" -> {lat, lon} or null
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

// --- SOTA SSO + Upload Client ---
// Auth: Keycloak OIDC at sso.sota.org.uk
// Upload: POST to api-db2.sota.org.uk/uploads

const { EventEmitter } = require('events');

const SSO_HOST = 'sso.sota.org.uk';
const SSO_TOKEN_PATH = '/auth/realms/SOTA/protocol/openid-connect/token';
const API_DB_HOST = 'api-db2.sota.org.uk';
const SOTA_CLIENT_ID = 'sotawatch';

function httpsPost(host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: host,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'POTACAT',
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('SOTA API timeout')); });
    req.write(data);
    req.end();
  });
}

// Map POTACAT modes to SOTA-accepted values: CW, SSB, FM, AM, Data
function sotaMode(mode) {
  if (!mode) return 'SSB';
  const m = mode.toUpperCase();
  if (m === 'CW' || m === 'CW-L' || m === 'CW-R' || m === 'CW-U') return 'CW';
  if (m === 'SSB' || m === 'USB' || m === 'LSB') return 'SSB';
  if (m === 'FM' || m === 'NFM' || m === 'WFM') return 'FM';
  if (m === 'AM') return 'AM';
  return 'Data';
}

// Convert kHz frequency to SOTA band format: "14.074MHz"
function sotaBand(freqKhz) {
  const mhz = parseFloat(freqKhz) / 1000;
  if (isNaN(mhz) || mhz <= 0) return '14MHz';
  if (mhz % 1 === 0) return `${mhz}MHz`;
  return `${mhz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}MHz`;
}

// YYYYMMDD -> DD/MM/YYYY
function sotaDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) {
    const now = new Date();
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${now.getUTCFullYear()}`;
  }
  return `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(0, 4)}`;
}

// HHMM -> HH:MM
function sotaTime(hhmm) {
  if (!hhmm || hhmm.length < 4) {
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
}

class SotaUploader extends EventEmitter {
  constructor() {
    super();
    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.tokenExpiry = 0;
    this._username = '';
    this._password = '';
  }

  configure(username, password) {
    const changed = username !== this._username || password !== this._password;
    this._username = username || '';
    this._password = password || '';
    if (changed) {
      this.accessToken = null;
      this.refreshToken = null;
      this.idToken = null;
      this.tokenExpiry = 0;
    }
  }

  get configured() {
    return !!(this._username && this._password);
  }

  async _login() {
    if (!this._username || !this._password) {
      throw new Error('SOTA credentials not configured');
    }
    const body = `client_id=${SOTA_CLIENT_ID}&grant_type=password&scope=openid&username=${encodeURIComponent(this._username)}&password=${encodeURIComponent(this._password)}`;
    const res = await httpsPost(SSO_HOST, SSO_TOKEN_PATH, body);
    if (res.status !== 200 || !res.json || !res.json.access_token) {
      const msg = (res.json && res.json.error_description) || (res.json && res.json.error) || `HTTP ${res.status}`;
      throw new Error(`SOTA login failed: ${msg}`);
    }
    this.accessToken = res.json.access_token;
    this.refreshToken = res.json.refresh_token;
    this.idToken = res.json.id_token;
    this.tokenExpiry = Date.now() + ((res.json.expires_in || 300) - 30) * 1000;
  }

  async _refresh() {
    if (!this.refreshToken) return this._login();
    const body = `client_id=${SOTA_CLIENT_ID}&grant_type=refresh_token&scope=openid&refresh_token=${encodeURIComponent(this.refreshToken)}`;
    const res = await httpsPost(SSO_HOST, SSO_TOKEN_PATH, body);
    if (res.status !== 200 || !res.json || !res.json.access_token) {
      this.refreshToken = null;
      return this._login();
    }
    this.accessToken = res.json.access_token;
    this.refreshToken = res.json.refresh_token;
    this.idToken = res.json.id_token;
    this.tokenExpiry = Date.now() + ((res.json.expires_in || 300) - 30) * 1000;
  }

  async _ensureAuth() {
    if (!this.accessToken) await this._login();
    else if (Date.now() >= this.tokenExpiry) await this._refresh();
  }

  /**
   * Upload a chaser QSO to SOTAdata.
   * @param {object} qso - QSO data from saveQsoRecord (must have sig=SOTA, sigInfo=summit ref)
   * @returns {{ success: boolean, error?: string }}
   */
  async uploadChase(qso) {
    await this._ensureAuth();

    const chase = {
      date: sotaDate(qso.qsoDate),
      timeStr: sotaTime(qso.timeOn),
      otherCallsign: (qso.callsign || '').toUpperCase(),
      ownCallsign: (qso.stationCallsign || qso.operator || '').toUpperCase(),
      s2sSummitCode: (qso.sigInfo || '').toUpperCase(),
      summitCode: '',
      mode: sotaMode(qso.mode),
      band: sotaBand(qso.frequency),
      notes: [
        (qso.rstSent || qso.rstRcvd) ? `S${qso.rstSent || '59'} R${qso.rstRcvd || '59'}` : '',
        qso.comment || '',
      ].filter(Boolean).join(' '),
    };

    const payload = { activations: [], s2s: [], chases: [chase] };
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
    };
    if (this.idToken) headers['id_token'] = this.idToken;

    let res = await httpsPost(API_DB_HOST, '/uploads', payload, headers);

    // Retry once on auth error
    if (res.status === 401 || res.status === 403) {
      await this._login();
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      if (this.idToken) headers['id_token'] = this.idToken;
      else delete headers['id_token'];
      res = await httpsPost(API_DB_HOST, '/uploads', payload, headers);
    }

    if (res.status >= 200 && res.status < 300) {
      return { success: true };
    }
    return { success: false, error: `HTTP ${res.status}: ${(res.text || '').slice(0, 200)}` };
  }
}

module.exports = { fetchSpots, fetchSummitCoords, fetchSummitCoordsBatch, summitCache, loadAssociations, getAssociationName, SotaUploader };
