/**
 * Where the Landmarks catalog comes from (lib/landmarks.js has the rules).
 *
 * Order of trust: the copy fetched from master on GitHub (so a fix to
 * data/landmarks.json reaches every install within a few hours, no release),
 * then the last good fetched copy cached in userData, then the copy bundled
 * with this build. A fetched copy that fails `sanitizeCatalog` in ANY way is
 * refused whole and the previous one stays.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const Landmarks = require('./landmarks');

const FEED_URL = 'https://raw.githubusercontent.com/Waffleslop/POTACAT/master/data/landmarks.json';
const BUNDLED_PATH = path.join(__dirname, '..', 'data', 'landmarks.json');
const MAX_BYTES = 512 * 1024;

function fetchText(url, { timeoutMs = 15000, depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'POTACAT' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), { timeoutMs, depth: depth + 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error('catalog too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

class LandmarksFeed {
  /**
   * @param {object} o
   * @param {string} o.cachePath  userData file for the last good fetched copy
   * @param {(line: string) => void} [o.log]
   * @param {string} [o.url]  override for tests
   * @param {string} [o.bundledPath]  override for tests
   */
  constructor({ cachePath, log, url, bundledPath } = {}) {
    this.cachePath = cachePath;
    this.log = log || (() => {});
    this.url = url || FEED_URL;
    this.bundledPath = bundledPath || BUNDLED_PATH;
    this._catalog = { categories: [], landmarks: [] };
    this.source = 'none';
  }

  /** Cached copy if it is good, else the bundled one. Synchronous, at launch. */
  load() {
    for (const [file, source] of [[this.cachePath, 'cache'], [this.bundledPath, 'bundled']]) {
      if (!file) continue;
      try {
        const c = Landmarks.sanitizeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!c.errors.length) { this._set(c, source); return this.catalog(); }
        this.log(`[Landmarks] ${source} copy refused: ${c.errors[0]}${c.errors.length > 1 ? ` (+${c.errors.length - 1} more)` : ''}`);
      } catch { /* missing or unreadable: try the next */ }
    }
    return this.catalog();
  }

  /**
   * Fetch master's copy. Resolves true when the catalog changed.
   * `opts.fetchText` replaces the transport (tests).
   */
  async refresh(opts) {
    const get = (opts && opts.fetchText) || fetchText;
    let text;
    try { text = await get(this.url); } catch (err) {
      this.log(`[Landmarks] Could not fetch the list (${err.message}); keeping the ${this.source} copy`);
      return false;
    }
    let json;
    try { json = JSON.parse(text); } catch {
      this.log('[Landmarks] Fetched list is not valid JSON; keeping the ' + this.source + ' copy');
      return false;
    }
    const c = Landmarks.sanitizeCatalog(json);
    if (c.errors.length) {
      this.log(`[Landmarks] Fetched list refused: ${c.errors[0]}${c.errors.length > 1 ? ` (+${c.errors.length - 1} more)` : ''}; keeping the ${this.source} copy`);
      return false;
    }
    const before = JSON.stringify(this._catalog);
    this._set(c, 'feed');
    if (this.cachePath) { try { fs.writeFileSync(this.cachePath, text); } catch { /* read-only profile: fine */ } }
    return JSON.stringify(this._catalog) !== before;
  }

  _set(c, source) {
    this._catalog = { categories: c.categories, landmarks: c.landmarks };
    this.source = source;
  }

  catalog() { return this._catalog; }

  /** URLs the catalog names: the open-external gate allows exactly these. */
  urlAllowed(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url)
      && this._catalog.landmarks.some((l) => l.url === url);
  }
}

module.exports = { LandmarksFeed, FEED_URL, fetchText };
