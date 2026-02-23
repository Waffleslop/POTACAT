// QRZ.com XML API client — callsign lookup with session management and caching
const https = require('https');

const BASE_URL = 'https://xmldata.qrz.com/xml/current/';
const AGENT = 'POTACAT/0.9';

class QrzClient {
  constructor() {
    this._sessionKey = null;
    this._username = null;
    this._password = null;
    this._cache = new Map(); // callsign → { fname, name, state, country, addr2 }
    this._pending = new Map(); // callsign → Promise (dedup in-flight lookups)
    this._loggedIn = false;
  }

  /**
   * Configure credentials. Call this when settings change.
   * Clears the session so next lookup triggers a fresh login.
   */
  configure(username, password) {
    if (username === this._username && password === this._password) return;
    this._username = username;
    this._password = password;
    this._sessionKey = null;
    this._loggedIn = false;
  }

  get configured() {
    return !!(this._username && this._password);
  }

  /**
   * Login to QRZ and obtain a session key.
   */
  async login() {
    if (!this._username || !this._password) {
      throw new Error('QRZ credentials not configured');
    }
    const params = `username=${enc(this._username)}&password=${enc(this._password)}&agent=${enc(AGENT)}`;
    const xml = await httpGet(`${BASE_URL}?${params}`);
    const key = extractTag(xml, 'Key');
    const error = extractTag(xml, 'Error');
    if (!key) {
      throw new Error(error || 'QRZ login failed — no session key returned');
    }
    this._sessionKey = key;
    this._loggedIn = true;
    return key;
  }

  /**
   * Look up a single callsign. Returns cached result if available.
   * Returns null if lookup fails (not found, network error, etc).
   */
  async lookup(callsign) {
    if (!callsign) return null;
    const upper = callsign.toUpperCase().split('/')[0]; // strip portable suffixes

    // Return cached
    if (this._cache.has(upper)) return this._cache.get(upper);

    // Dedup concurrent lookups for same callsign
    if (this._pending.has(upper)) return this._pending.get(upper);

    const promise = this._doLookup(upper);
    this._pending.set(upper, promise);
    try {
      return await promise;
    } finally {
      this._pending.delete(upper);
    }
  }

  async _doLookup(callsign) {
    // Ensure logged in
    if (!this._sessionKey) {
      try { await this.login(); } catch { return null; }
    }

    let xml;
    try {
      xml = await httpGet(`${BASE_URL}?s=${enc(this._sessionKey)}&callsign=${enc(callsign)}`);
    } catch {
      return null;
    }

    // Check for session expiry
    const error = extractTag(xml, 'Error');
    if (error && /session/i.test(error)) {
      // Re-login and retry once
      try {
        await this.login();
        xml = await httpGet(`${BASE_URL}?s=${enc(this._sessionKey)}&callsign=${enc(callsign)}`);
      } catch {
        return null;
      }
    }

    // Check for not-found
    if (error && /not found/i.test(error)) {
      this._cache.set(callsign, null);
      return null;
    }

    const call = extractTag(xml, 'call');
    if (!call) {
      this._cache.set(callsign, null);
      return null;
    }

    const result = {
      call,
      fname: extractTag(xml, 'fname') || '',
      name: extractTag(xml, 'name') || '',
      nickname: extractTag(xml, 'nickname') || '',
      addr2: extractTag(xml, 'addr2') || '',
      state: extractTag(xml, 'state') || '',
      county: extractTag(xml, 'county') || '',
      country: extractTag(xml, 'country') || '',
      grid: extractTag(xml, 'grid') || '',
    };

    this._cache.set(callsign, result);
    return result;
  }

  /**
   * Batch lookup multiple callsigns. Skips already-cached ones.
   * Lookups are sequential with a small delay to be polite to QRZ.
   * Returns Map of callsign → result.
   */
  async batchLookup(callsigns) {
    if (!this.configured) return new Map();
    const results = new Map();
    const todo = [];
    for (const cs of callsigns) {
      const upper = cs.toUpperCase().split('/')[0];
      if (this._cache.has(upper)) {
        results.set(upper, this._cache.get(upper));
      } else {
        todo.push(upper);
      }
    }
    // Dedupe
    const unique = [...new Set(todo)];
    for (const cs of unique) {
      const result = await this.lookup(cs);
      results.set(cs, result);
      // Small delay between lookups to avoid hammering QRZ
      if (unique.length > 1) await sleep(100);
    }
    return results;
  }

  /** Number of cached entries */
  get cacheSize() { return this._cache.size; }

  /** Clear the cache (e.g. on credential change) */
  clearCache() { this._cache.clear(); }
}

// --- Helpers ---

function enc(s) { return encodeURIComponent(s); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

module.exports = { QrzClient };
