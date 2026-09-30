'use strict';
// SSTV style packs: where they come from and which ones an operator has.
//
// Three sources, merged by id (newest version wins):
//   bundled   data/sstv-packs/<id>/  shipped inside the app (Halloween is the first)
//   installed userData/sstv-packs/<id>/  downloaded from the feed
//   feed      https://packs.potacat.com/feeds/sstv-packs.json  the signed index
//
// The feed is served like the DXpedition list (worker/sstv-packs). Its wire
// form is { index: "<JSON string>", sig: "<base64 ed25519>", keyId }. The
// signature is over the exact UTF-8 bytes of `index`, checked against the
// public key below before a single field of it is trusted; each pack and each
// file it lists is then checked against the sha256 in the index, and every
// pack goes through lib/sstv-pack-validate.js before it is kept or drawn. A
// hijacked DNS entry or cache can therefore serve nothing we would use.
//
// Claims (which packs this operator has taken) live in settings and travel
// between the desktop and a paired ECHOCAT app (S2C/C2S 'sstv-pack-claims').
// A claim is a union: nothing one device does removes another's claim except
// an explicit unclaim on that device.
//
// fetch and fs are injectable so tests need neither network nor disk.

const EventEmitter = require('events');
const crypto = require('crypto');
const path = require('path');
const { validatePack, inSeason, FONT_FILE_LIMITS } = require('./sstv-pack-validate');

const FEED_URL = 'https://packs.potacat.com/feeds/sstv-packs.json';
// ed25519 public key (raw 32 bytes, base64). The private half is kept off the
// repo (scripts/sign-sstv-packs.js reads it from ~/.potacat).
const PACK_PUBLIC_KEY = 'QoF8It3Zo+8JT2L72ZZZvMq6pJuChUVbVzIzgKhX1kg=';
const KEY_ID = 'potacat-packs-1';
const FIRST_FETCH_MS = 30 * 1000;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const MAX_FILE_BYTES = FONT_FILE_LIMITS;

function publicKeyObject(rawB64) {
  // SPKI DER prefix for an ed25519 key, then the 32 raw bytes.
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(rawB64, 'base64')]), format: 'der', type: 'spki' });
}

/** Verify a feed wrapper. Returns the parsed index, or throws with the reason. */
function verifyIndex(wire, rawPubB64) {
  if (!wire || typeof wire.index !== 'string' || typeof wire.sig !== 'string') throw new Error('feed is not a signed index');
  const ok = crypto.verify(null, Buffer.from(wire.index, 'utf8'), publicKeyObject(rawPubB64 || PACK_PUBLIC_KEY), Buffer.from(wire.sig, 'base64'));
  if (!ok) throw new Error('feed signature does not verify');
  const index = JSON.parse(wire.index);
  if (!index || index.schema !== 1 || !Array.isArray(index.packs)) throw new Error('feed index has the wrong shape');
  for (const e of index.packs) {
    if (!e || typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) throw new Error('feed entry without a valid id');
    if (!Number.isInteger(e.version) || !/^[0-9a-f]{64}$/.test(e.sha256 || '')) throw new Error(`feed entry ${e.id}: bad version or hash`);
    for (const f of e.files || []) {
      if (!f || !/^[A-Za-z0-9._-]+\.(woff2|ttf|otf|txt)$/.test(f.name || '') || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) throw new Error(`feed entry ${e.id}: bad file entry`);
    }
  }
  return index;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

async function defaultFetch(url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  const body = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  return { status: res.status, etag: res.headers.get('etag'), body };
}

class SstvPackStore extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.bundledDir       data/sstv-packs
   * @param {string} o.userDir          userData/sstv-packs
   * @param {function} o.getSettings    returns the live settings object (claims are kept on it);
   *                                    a getter because main replaces the object on reload
   * @param {function} o.saveSettings   persists settings
   * @param {string} o.appVersion
   * @param {function} [o.fetch]        (url, headers) => Promise<{status, etag, body: Buffer}>
   * @param {object} [o.fs]             node fs (sync API)
   * @param {function} [o.log]
   * @param {function} [o.now]
   * @param {string} [o.feedUrl]
   * @param {string} [o.publicKey]      raw base64 ed25519 key (tests)
   */
  constructor(o) {
    super();
    this.bundledDir = o.bundledDir;
    this.userDir = o.userDir;
    this._getSettings = o.getSettings || (() => o.settings);
    this.saveSettings = o.saveSettings || (() => {});
    this.appVersion = o.appVersion || '0.0.0';
    this.fetch = o.fetch || defaultFetch;
    this.fs = o.fs || require('fs');
    this.log = o.log || (() => {});
    this.now = o.now || (() => Date.now());
    this.feedUrl = o.feedUrl || process.env.POTACAT_PACKS_URL || FEED_URL;
    this.publicKey = o.publicKey || PACK_PUBLIC_KEY;
    this.feed = null;       // verified index
    this.feedEtag = null;
    this.bundled = new Map(); // id -> { pack, dir }
    this.installed = new Map();
    this._timers = [];
    this._loadLocal();
  }

  get settings() { return this._getSettings() || {}; }

  // ---------- local packs ----------

  _readPackDir(dir) {
    const raw = this.fs.readFileSync(path.join(dir, 'pack.json'));
    const pack = JSON.parse(raw.toString('utf8'));
    const v = validatePack(pack, { bytes: raw.length });
    if (!v.ok) throw new Error(v.errors.slice(0, 3).join('; '));
    return pack;
  }

  _loadLocal() {
    for (const [map, dir, label] of [[this.bundled, this.bundledDir, 'bundled'], [this.installed, this.userDir, 'installed']]) {
      map.clear();
      let ids = [];
      try { ids = this.fs.readdirSync(dir); } catch { continue; }
      for (const id of ids) {
        const d = path.join(dir, id);
        try {
          if (!this.fs.existsSync(path.join(d, 'pack.json'))) continue;
          const pack = this._readPackDir(d);
          if (pack.id !== id) throw new Error(`folder ${id} holds pack ${pack.id}`);
          map.set(id, { pack, dir: d });
        } catch (e) {
          this.log(`[SSTV packs] ignoring ${label} pack ${id}: ${e.message}`);
        }
      }
    }
    // The last verified feed, so the shelf shows something offline.
    try {
      const cache = JSON.parse(this.fs.readFileSync(path.join(this.userDir, 'feed-cache.json'), 'utf8'));
      this.feed = verifyIndex(cache.wire, this.publicKey);
      this.feedEtag = cache.etag || null;
    } catch { /* no cache yet */ }
  }

  /** The newest local copy of a pack: installed beats bundled only when newer. */
  _local(id) {
    const b = this.bundled.get(id), i = this.installed.get(id);
    if (b && i) return i.pack.version > b.pack.version ? { ...i, from: 'installed' } : { ...b, from: 'bundled' };
    if (i) return { ...i, from: 'installed' };
    if (b) return { ...b, from: 'bundled' };
    return null;
  }

  _claimed() { return Array.isArray(this.settings.sstvPacksClaimed) ? this.settings.sstvPacksClaimed.slice() : []; }

  _setClaimed(ids) {
    this.settings.sstvPacksClaimed = Array.from(new Set(ids));
    this.saveSettings(this.settings);
  }

  // ---------- public API ----------

  /** Every pack we know of, for the shelf. */
  list() {
    const now = new Date(this.now());
    const claimed = new Set(this._claimed());
    const ids = new Set([...this.bundled.keys(), ...this.installed.keys(), ...((this.feed && this.feed.packs) || []).map((e) => e.id)]);
    const out = [];
    for (const id of ids) {
      const local = this._local(id);
      const entry = this.feed && this.feed.packs.find((e) => e.id === id);
      const meta = local ? local.pack : entry;
      const minApp = (entry && (!local || entry.version > local.pack.version) ? entry.minApp : meta.minApp) || '0.0.0';
      out.push({
        id,
        name: meta.name,
        version: local ? local.pack.version : entry.version,
        season: meta.season || null,
        by: meta.by || '',
        minApp,
        inSeason: inSeason(meta.season || null, now),
        bundled: this.bundled.has(id),
        installed: !!local,
        available: !!entry,
        updateAvailable: !!(local && entry && entry.version > local.pack.version),
        compatible: cmpVersion(this.appVersion, minApp) >= 0,
        size: entry ? entry.size : null,
        claimed: claimed.has(id),
        active: this.settings.sstvActivePack === id,
      });
    }
    return out.sort((a, b) => (b.inSeason - a.inSeason) || a.name.localeCompare(b.name));
  }

  /**
   * A pack ready to draw: the validated pack plus its font bytes.
   * @returns {{pack: object, fonts: Array<{family, file, bytes: Uint8Array}>}|null}
   */
  get(id) {
    const local = this._local(id);
    if (!local) return null;
    const fonts = [];
    for (const f of local.pack.fonts || []) {
      try { fonts.push({ family: f.family, file: f.file, bytes: new Uint8Array(this.fs.readFileSync(path.join(local.dir, f.file))) }); }
      catch (e) { this.log(`[SSTV packs] ${id}: font ${f.file} missing (${e.message}); headlines use the station font`); }
    }
    return { pack: local.pack, fonts };
  }

  /** Take a pack: download it when only the feed has it, then mark it claimed. */
  async claim(id) {
    try {
      let local = this._local(id);
      const entry = this.feed && this.feed.packs.find((e) => e.id === id);
      if ((!local || (entry && entry.version > local.pack.version)) && entry) {
        await this._download(entry);
        local = this._local(id);
      }
      if (!local) return { ok: false, error: `no pack "${id}"` };
      if (!this._claimed().includes(id)) this._setClaimed(this._claimed().concat(id));
      this.log(`[SSTV packs] claimed ${id} v${local.pack.version} (${local.from})`);
      this.emit('changed');
      return { ok: true };
    } catch (e) {
      this.log(`[SSTV packs] could not claim ${id}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  unclaim(id) {
    const before = this._claimed();
    if (!before.includes(id)) return { ok: true };
    this._setClaimed(before.filter((x) => x !== id));
    if (this.settings.sstvActivePack === id) { this.settings.sstvActivePack = null; this.saveSettings(this.settings); }
    this.emit('changed');
    return { ok: true };
  }

  /** The pack the SSTV templates are dressed in, or null for none. */
  setActive(id) {
    if (id && !this._local(id)) return { ok: false, error: `pack "${id}" is not installed` };
    if (id && !this._claimed().includes(id)) this._setClaimed(this._claimed().concat(id));
    this.settings.sstvActivePack = id || null;
    this.saveSettings(this.settings);
    this.emit('changed');
    return { ok: true };
  }

  /** Pairing sync: another device's claims, unioned with ours. */
  async mergeClaims(ids) {
    const incoming = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(x)).slice(0, 50);
    const mine = this._claimed();
    const added = incoming.filter((x) => !mine.includes(x));
    if (!added.length) return false;
    for (const id of added) {
      if (this._local(id)) continue;
      const entry = this.feed && this.feed.packs.find((e) => e.id === id);
      if (entry) {
        try { await this._download(entry); }
        catch (e) { this.log(`[SSTV packs] could not fetch ${id} claimed on the other device: ${e.message}`); }
      }
    }
    // Claims we can't draw yet are kept anyway: the feed may carry them later.
    this._setClaimed(mine.concat(added));
    this.log(`[SSTV packs] claims from the paired device added: ${added.join(', ')}`);
    this.emit('changed');
    return true;
  }

  claimsPayload() {
    return {
      claimed: this._claimed(),
      active: this.settings.sstvActivePack || '',
      lookShuffle: Number.isFinite(this.settings.sstvLookShuffle) ? this.settings.sstvLookShuffle : 0,
    };
  }

  // ---------- feed ----------

  _packsBase() { return new URL('../packs/', this.feedUrl).toString(); }

  async refresh() {
    try {
      const headers = { 'User-Agent': `POTACAT-Desktop/${this.appVersion}` };
      if (this.feedEtag) headers['If-None-Match'] = this.feedEtag;
      const res = await this.fetch(this.feedUrl, headers);
      if (res.status === 304) { this.log('[SSTV packs] feed unchanged'); await this._autoUpdate(); return false; }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const wire = JSON.parse(res.body.toString('utf8'));
      const index = verifyIndex(wire, this.publicKey);
      this.feed = index;
      this.feedEtag = res.etag || null;
      try {
        this.fs.mkdirSync(this.userDir, { recursive: true });
        this.fs.writeFileSync(path.join(this.userDir, 'feed-cache.json'), JSON.stringify({ wire, etag: this.feedEtag }));
      } catch (e) { this.log(`[SSTV packs] could not cache the feed: ${e.message}`); }
      this.log(`[SSTV packs] feed: ${index.packs.length} pack(s), generated ${index.generated || '?'}`);
      await this._autoUpdate();
      this.emit('changed');
      return true;
    } catch (e) {
      this.log(`[SSTV packs] feed not updated (${e.message}); using ${this.feed ? 'the last good copy' : 'bundled packs only'}`);
      return false;
    }
  }

  /** Claimed packs follow their newest version on the feed. */
  async _autoUpdate() {
    if (!this.feed) return;
    for (const id of this._claimed()) {
      const local = this._local(id);
      const entry = this.feed.packs.find((e) => e.id === id);
      if (!entry || (local && local.pack.version >= entry.version)) continue;
      if (cmpVersion(this.appVersion, entry.minApp || '0.0.0') < 0) continue;
      try { await this._download(entry); this.log(`[SSTV packs] updated ${id} to v${entry.version}`); }
      catch (e) { this.log(`[SSTV packs] update of ${id} failed: ${e.message}`); }
    }
  }

  async _download(entry) {
    if (cmpVersion(this.appVersion, entry.minApp || '0.0.0') < 0) throw new Error(`needs POTACAT ${entry.minApp} or newer`);
    const base = this._packsBase();
    const res = await this.fetch(`${base}${entry.id}@${entry.version}.json`, {});
    if (res.status !== 200) throw new Error(`pack download: HTTP ${res.status}`);
    if (sha256(res.body) !== entry.sha256) throw new Error('pack does not match the signed index');
    const pack = JSON.parse(res.body.toString('utf8'));
    const v = validatePack(pack, { bytes: res.body.length });
    if (!v.ok) throw new Error(`pack is not valid: ${v.errors.slice(0, 2).join('; ')}`);
    if (pack.id !== entry.id || pack.version !== entry.version) throw new Error('pack id or version differs from the index');
    const files = [];
    for (const f of entry.files || []) {
      const ext = f.name.split('.').pop();
      const r = await this.fetch(`${base}${entry.id}@${entry.version}/${f.name}`, {});
      if (r.status !== 200) throw new Error(`${f.name}: HTTP ${r.status}`);
      if (r.body.length > (MAX_FILE_BYTES[ext] || 0)) throw new Error(`${f.name} is too large`);
      if (sha256(r.body) !== f.sha256) throw new Error(`${f.name} does not match the signed index`);
      files.push([f.name, r.body]);
    }
    // Write beside, then swap in, so a failed download never leaves half a pack.
    const dir = path.join(this.userDir, entry.id);
    const tmp = `${dir}.tmp-${this.now()}`;
    this.fs.mkdirSync(tmp, { recursive: true });
    this.fs.writeFileSync(path.join(tmp, 'pack.json'), res.body);
    for (const [name, body] of files) this.fs.writeFileSync(path.join(tmp, name), body);
    try { this.fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    this.fs.renameSync(tmp, dir);
    this.installed.set(entry.id, { pack, dir });
    this.log(`[SSTV packs] installed ${entry.id} v${entry.version}`);
  }

  // ---------- timers ----------

  start() {
    this.stop();
    this._timers.push(setTimeout(() => { this.refresh(); }, FIRST_FETCH_MS));
    this._timers.push(setInterval(() => { this.refresh(); }, REFRESH_MS));
    for (const t of this._timers) if (t && t.unref) t.unref();
  }

  stop() {
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers = [];
  }
}

module.exports = { SstvPackStore, verifyIndex, sha256, cmpVersion, PACK_PUBLIC_KEY, KEY_ID, FEED_URL };
