'use strict';
// SSTV templates follow the operator to every machine they sign in on
// (Casey 2026-09-29: "A user will want to take their templates to other
// machines if they Share a Rig"). Contract: potacat-cloudlog
// CLOUD_TO_DESKTOP_HANDOFF_2026-09-29_SSTV_TEMPLATES.md.
//
// The server stores one whole set per account and never merges; it only
// compare-and-swaps on a version it owns. Merging is ours, so it lives here,
// pure, and every client must behave exactly like this file:
//   - union of templates by id; where both sides have one, newer updatedAt
//     wins (a tie keeps ours);
//   - a template whose tombstone `at` is at or after its updatedAt is gone,
//     and the union of tombstones is kept (so a delete on one machine is not
//     resurrected by the next merge);
//   - order: ours as it is, then theirs that we did not have;
//   - scalars (lookShuffle, lookLocked, activePack, defaultReply): ours wins;
//     claimedPacks is the union; a defaultReply naming a dropped template
//     becomes null.
//
// Identity is stamped at ONE place, main's save-settings (stampTemplates):
// the SSTV window and the ECHOCAT web client both write the whole list, so
// only a diff against what was stored can tell an edit from a delete.

const LIMITS = {
  setBytes: 2 * 1024 * 1024,
  templates: 24,
  bgBytes: 150 * 1024,
  thumbBytes: 32 * 1024,
  texts: 64,
  deleted: 500,
  idChars: 64,
};
const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;
const SCHEMA = 1;
const IMAGE_URL = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/;

function isId(x) { return typeof x === 'string' && x.length >= 1 && x.length <= LIMITS.idChars; }

// What counts as an edit: everything but the stamp itself.
function contentKey(t) {
  const { updatedAt, ...rest } = t || {};
  return JSON.stringify(rest);
}

function pruneTombstones(deleted, now) {
  const byId = new Map();
  for (const d of Array.isArray(deleted) ? deleted : []) {
    if (!d || !isId(d.id) || !Number.isFinite(d.at)) continue;
    if (now - d.at > TOMBSTONE_TTL_MS) continue;
    const had = byId.get(d.id);
    if (!had || d.at > had.at) byId.set(d.id, { id: d.id, at: d.at });
  }
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, LIMITS.deleted);
}

/**
 * Give every template a stable id and an updatedAt, and turn removals into
 * tombstones, by diffing the list being saved against the one stored.
 * @param {Array} prev   the stored list
 * @param {Array} next   the list being saved (the whole list, from any surface)
 * @param {{now:number, newId:()=>string, deleted?:Array}} o
 * @returns {{templates: Array, deleted: Array, changed: boolean}}
 */
function stampTemplates(prev, next, o) {
  const now = o.now;
  const tombAt = new Map((Array.isArray(o.deleted) ? o.deleted : []).filter((d) => d && isId(d.id)).map((d) => [d.id, d.at]));
  const prevById = new Map();
  for (const t of Array.isArray(prev) ? prev : []) if (t && isId(t.id)) prevById.set(t.id, t);
  const seen = new Set();
  let changed = false;
  const templates = [];
  for (const raw of Array.isArray(next) ? next : []) {
    if (!raw || typeof raw !== 'object') continue;
    const t = Object.assign({}, raw);
    if (!isId(t.id) || seen.has(t.id)) {
      t.id = o.newId();
      t.updatedAt = now;
      changed = true;
    } else {
      const old = prevById.get(t.id);
      if (old) {
        if (contentKey(old) !== contentKey(t)) { t.updatedAt = now; changed = true; }
        else t.updatedAt = Number.isFinite(old.updatedAt) ? old.updatedAt : now;
      } else if (!Number.isFinite(t.updatedAt)) {
        t.updatedAt = now; changed = true;
      } else if (tombAt.has(t.id) && tombAt.get(t.id) >= t.updatedAt) {
        // A stale copy of a template deleted since (a surface that had not
        // heard about the delete saved its whole list): stays deleted.
        changed = true;
        continue;
      } else {
        changed = true; // arrived with its own stamp (import, cloud merge)
      }
    }
    seen.add(t.id);
    templates.push(t);
  }
  let deleted = Array.isArray(o.deleted) ? o.deleted.slice() : [];
  for (const id of prevById.keys()) {
    if (!seen.has(id)) { deleted.push({ id, at: now }); changed = true; }
  }
  // A template present again (restored by an import) outlives its tombstone.
  deleted = deleted.filter((d) => !(d && seen.has(d.id) && templates.find((t) => t.id === d.id).updatedAt > d.at));
  return { templates, deleted: pruneTombstones(deleted, now), changed };
}

/** The set as the server stores it, from settings. */
function buildSet(s) {
  return {
    potacatSstvTemplates: SCHEMA,
    templates: Array.isArray(s.sstvTemplates) ? s.sstvTemplates : [],
    deleted: Array.isArray(s.sstvTemplatesDeleted) ? s.sstvTemplatesDeleted : [],
    lookShuffle: Number.isFinite(s.sstvLookShuffle) ? s.sstvLookShuffle : 0,
    lookLocked: !!s.sstvLookLocked,
    claimedPacks: Array.isArray(s.sstvPacksClaimed) ? s.sstvPacksClaimed.filter(isId) : [],
    activePack: isId(s.sstvActivePack) ? s.sstvActivePack : null,
    defaultReply: isId(s.sstvDefaultReply) ? s.sstvDefaultReply : null,
  };
}

/** The settings patch that makes this machine hold `set`. */
function settingsFromSet(set) {
  return {
    sstvTemplates: set.templates,
    sstvTemplatesDeleted: set.deleted,
    sstvLookShuffle: set.lookShuffle,
    sstvLookLocked: !!set.lookLocked,
    sstvPacksClaimed: set.claimedPacks,
    sstvActivePack: set.activePack,
    sstvDefaultReply: set.defaultReply,
  };
}

/**
 * Merge the server's set into ours (see the rule at the top of the file).
 * @returns {object} the merged set, in the server's shape
 */
function mergeSets(local, remote, now) {
  const L = local || {}, Rm = remote || {};
  const lt = Array.isArray(L.templates) ? L.templates : [];
  const rt = Array.isArray(Rm.templates) ? Rm.templates : [];
  const deleted = pruneTombstones([...(L.deleted || []), ...(Rm.deleted || [])], now);
  const tomb = new Map(deleted.map((d) => [d.id, d.at]));
  const remoteById = new Map(rt.filter((t) => t && isId(t.id)).map((t) => [t.id, t]));
  const out = [], seen = new Set(), dropped = new Set();
  const stamp = (t) => (Number.isFinite(t.updatedAt) ? t.updatedAt : 0);
  const keep = (t) => {
    if (tomb.has(t.id) && tomb.get(t.id) >= stamp(t)) { dropped.add(t.id); return; }
    out.push(t);
  };
  for (const t of lt) {
    if (!t || !isId(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    const r = remoteById.get(t.id);
    keep(r && stamp(r) > stamp(t) ? r : t);
  }
  for (const t of rt) {
    if (!t || !isId(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    keep(t);
  }
  const claimed = [];
  for (const id of [...(L.claimedPacks || []), ...(Rm.claimedPacks || [])]) if (isId(id) && !claimed.includes(id)) claimed.push(id);
  const merged = Object.assign({}, Rm, L, {
    potacatSstvTemplates: SCHEMA,
    templates: out,
    deleted,
    claimedPacks: claimed,
    defaultReply: L.defaultReply && dropped.has(L.defaultReply) ? null : (L.defaultReply === undefined ? (Rm.defaultReply || null) : L.defaultReply),
  });
  delete merged.exportedAt;
  return merged;
}

/**
 * Would the server take this set? Checked before every PUT, so the operator
 * reads a sentence instead of a 400.
 * @returns {{ok: true, bytes: number}|{ok: false, error: string}}
 */
function checkSet(set) {
  const tpls = set.templates || [];
  if (tpls.length > LIMITS.templates) return { ok: false, error: `You have ${tpls.length} templates; ${LIMITS.templates} can sync. Remove a few.` };
  for (const t of tpls) {
    const name = t.name || 'A template';
    if (!isId(t.id) || !Number.isFinite(t.updatedAt)) return { ok: false, error: `${name} has no identity yet. Save it again.` };
    if (t.bgDataUrl != null && (typeof t.bgDataUrl !== 'string' || t.bgDataUrl.length > LIMITS.bgBytes || !IMAGE_URL.test(t.bgDataUrl))) {
      return { ok: false, error: `${name} has a photo too large to sync. Open it and save it again, or remove it.` };
    }
    if (t.thumbnail != null && (typeof t.thumbnail !== 'string' || t.thumbnail.length > LIMITS.thumbBytes || !IMAGE_URL.test(t.thumbnail))) {
      return { ok: false, error: `${name} has a preview that cannot sync. Save it again.` };
    }
    if (!Array.isArray(t.texts) || t.texts.length > LIMITS.texts) return { ok: false, error: `${name} has too many text layers to sync.` };
  }
  const bytes = Buffer.byteLength(JSON.stringify(set));
  if (bytes > LIMITS.setBytes) return { ok: false, error: 'Your templates are too large to sync. Remove a photo template.' };
  return { ok: true, bytes };
}

const isNotDeployed = (e) => !!e && (e.status === 404 || /^HTTP 404\b/.test(e.message || ''));

/**
 * The GET/PUT half. `request(method, path, body)` resolves the parsed JSON
 * body or rejects with an Error carrying `status` and `body` (CloudSyncClient
 * ._authedRequest does exactly that).
 */
class SstvTemplateSync {
  constructor(o) {
    this.request = o.request;          // () => request fn, or null when signed out
    this.owner = o.owner;              // () => account id, or null
    this.getSettings = o.getSettings;
    this.saveSettings = o.saveSettings; // (patch) => void; persists + pushes to windows
    this.log = o.log || (() => {});
    this.now = o.now || (() => Date.now());
    this.debounceMs = o.debounceMs == null ? 4000 : o.debounceMs;
    this._timer = null;
    this._busy = null;
    this.state = { status: 'idle', error: null, at: null };
  }

  _meta() {
    const m = this.getSettings().sstvTemplatesSync;
    const owner = this.owner();
    // A different account starts from nothing, not from the last one's version.
    return m && m.owner === owner ? m : { owner, version: 0 };
  }
  _setMeta(version) { this.saveSettings({ sstvTemplatesSync: { owner: this.owner(), version, at: this.now() } }, { fromCloud: true }); }
  _state(status, error) { this.state = { status, error: error || null, at: this.now() }; }

  /** Push soon after the last edit. */
  schedulePush() {
    if (!this.owner()) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.sync('edit').catch(() => {}); }, this.debounceMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** GET, merge, and PUT when ours has anything theirs lacks. One at a time. */
  sync(reason) {
    if (this._busy) return this._busy.then(() => this.sync(reason));
    this._busy = this._sync(reason).finally(() => { this._busy = null; });
    return this._busy;
  }

  async _sync(reason) {
    const req = this.request();
    if (!req || !this.owner()) { this._state('signed-out'); return this.state; }
    let meta = this._meta();
    let remote;
    try {
      remote = await req('GET', '/v1/sstv/templates');
    } catch (e) {
      if (isNotDeployed(e)) { this._state('not-ready'); return this.state; }
      this._state('error', e.message); this.log(`[SSTV templates] sync (${reason}) failed: ${e.message}`); return this.state;
    }
    let base = remote && Number.isInteger(remote.version) ? remote.version : 0;
    let theirs = remote && remote.data;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ours = buildSet(this.getSettings());
      const merged = theirs ? mergeSets(ours, theirs, this.now()) : ours;
      if (theirs) this._adopt(merged);
      const mergedKey = JSON.stringify(stripVolatile(merged));
      if (theirs && mergedKey === JSON.stringify(stripVolatile(theirs))) {
        this._setMeta(base); this._state('ok'); return this.state; // nothing new to send
      }
      if (!theirs && !merged.templates.length && !merged.deleted.length && base === 0) {
        this._setMeta(base); this._state('ok'); return this.state; // nothing on either side
      }
      const check = checkSet(merged);
      if (!check.ok) { this._state('too-large', check.error); this.log(`[SSTV templates] not synced: ${check.error}`); return this.state; }
      try {
        const r = await req('PUT', '/v1/sstv/templates', { baseVersion: base, data: merged });
        this._setMeta(r.version);
        this._state('ok');
        this.log(`[SSTV templates] synced ${merged.templates.length} template(s), version ${r.version} (${reason})`);
        return this.state;
      } catch (e) {
        if (e.status === 409 && e.body) { base = e.body.version; theirs = e.body.data; continue; }
        if (isNotDeployed(e)) { this._state('not-ready'); return this.state; }
        const msg = (e.body && e.body.detail) ? `${e.message}: ${e.body.detail}` : e.message;
        this._state('error', msg); this.log(`[SSTV templates] push failed: ${msg}`); return this.state;
      }
    }
    this._state('error', 'kept conflicting with another machine; will try again');
    return this.state;
  }

  _adopt(merged) {
    const s = this.getSettings();
    const patch = settingsFromSet(merged);
    const cur = settingsFromSet(buildSet(s));
    if (JSON.stringify(patch) !== JSON.stringify(cur)) this.saveSettings(patch, { fromCloud: true });
  }
}

function stripVolatile(set) {
  const { exportedAt, ...rest } = set || {};
  return rest;
}

module.exports = {
  LIMITS, TOMBSTONE_TTL_MS,
  stampTemplates, pruneTombstones, buildSet, settingsFromSet, mergeSets, checkSet,
  SstvTemplateSync, isNotDeployed,
};
