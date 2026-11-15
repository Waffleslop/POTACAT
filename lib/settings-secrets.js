'use strict';

// Central registry of every secret that can live in the settings object,
// and the strip/restore pair used by Settings → Export/Import.
//
// Why: export-settings redacted via a hard-coded 3-key blocklist
// (qrzPassword, remoteToken, smartSdrClientId) that silently rotted as
// secrets accumulated — by v1.9.5 an exported settings.json carried
// sotaPassword, every rig's catTarget.password (K4 / RS-BA1), cluster node
// passwords (HamAlert), ECHOCAT paired-device bearer tokens, and cloud
// tokens in plaintext. Users share exports with friends and attach them to
// help requests. ONE list, used everywhere; add new secrets HERE.
//
// Not settings, so not covered here: userData/clublog-outbox.json (#142,
// lib/clublog-outbox.js) holds queued realtime Club Log uploads WITH each
// operator's Application Password in plaintext, as profiles/<CALL>/settings.json
// does. Export writes only the settings object, so it never leaves this
// machine; keep it out of any future export or diagnostics bundle.

// Top-level scalar secrets — stripped on export, re-grafted from the
// current settings on import when the imported file lacks them.
const SECRET_KEYS = [
  'qrzPassword',
  'qrzApiKey',
  'sotaPassword',
  'wavelogApiKey',
  'lotwCertPassword',  // TQSL certificate private-key password (optional)
  'lotwPassword',      // LoTW WEBSITE password (confirmation download; not the cert)
  'clublogPassword',   // Club Log Application Password (never their main password)
  'clublogApiKey',     // dev/self-host override of POTACAT's Club Log app key
  'remoteToken',       // ECHOCAT legacy shared token
  'echocatToken',      // ECHOCAT machine token
  'cloudAccessToken',  // POTACAT Cloud JWTs
  'cloudRefreshToken',
  'winlinkPassword',   // Winlink secure-login password (per operator profile)
  'smartSdrClientId',  // not a secret, but machine identity — never portable
];

// Whole arrays that are machine/deployment-bound credentials: ECHOCAT
// paired phones (each entry carries a raw bearer token = full rig control)
// and desktop-to-desktop connection targets (deviceToken). Exporting them
// is both a credential leak and useless on another machine — re-pairing is
// the correct flow. Stripped entirely; import keeps the current machine's.
const MACHINE_CREDENTIAL_ARRAYS = ['pairedDevices', 'connectionTargets'];

// SDR receiver strings that may carry a station password inline:
// "password@host:port" or "user:password@host:port" (main.js kiwi-connect
// takes everything before the last '@' as the password). Stripped to the
// receiver alone (scheme, host, port); the label and id stay. Export drops
// the password and import grafts it back from the entry with the same
// host:port; a Guest Pass never receives it (stripForGuest).
const SDR_HOST_KEYS = ['kiwiSdrHost', 'kiwiSdrHost1', 'kiwiSdrHost2', 'kiwiSdrHost3'];
const SDR_LIST_KEY = 'kiwiSdrList';

// Settings a Guest Pass guest never receives, on top of every secret above:
// a watchlist group's subscription URL (a private list's link is its key;
// the callsigns it fetched ride along in remoteEntries, which is all a
// guest's device needs to mark spots).
const GUEST_HIDDEN_GROUP_FIELDS = ['url'];

const SCHEME_RE = /^\s*[a-z][a-z0-9+.-]*:\/\//i;

function _cloneSansPassword(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  delete out.password;
  return out;
}

/**
 * "pw@Host:8073" -> "Host:8073", "https://u:pw@kiwi.example:8074/" ->
 * "https://kiwi.example:8074/". A string without an '@' comes back as is.
 * The cut is at the LAST '@', the rule main.js uses to find the password.
 */
function stripSdrUserinfo(raw) {
  if (typeof raw !== 'string') return raw;
  const m = SCHEME_RE.exec(raw);
  const scheme = m ? m[0] : '';
  const rest = raw.slice(scheme.length);
  const at = rest.lastIndexOf('@');
  return at >= 0 ? scheme + rest.slice(at + 1) : raw;
}

/** The userinfo ("pw" or "user:pw") of an SDR string, or ''. */
function sdrUserinfo(raw) {
  if (typeof raw !== 'string') return '';
  const rest = raw.replace(SCHEME_RE, '');
  const at = rest.lastIndexOf('@');
  return at > 0 ? rest.slice(0, at) : '';
}

/** Compare key for an SDR string: no scheme, userinfo, trailing slash or case. */
function _sdrKey(raw) {
  return stripSdrUserinfo(String(raw == null ? '' : raw)).replace(SCHEME_RE, '')
    .trim().replace(/\/+$/, '').toLowerCase();
}

/** Remove every inline SDR password from `out` (a clone; mutated). */
function _stripSdrPasswords(out) {
  for (const k of SDR_HOST_KEYS) {
    if (typeof out[k] === 'string') out[k] = stripSdrUserinfo(out[k]);
  }
  if (Array.isArray(out[SDR_LIST_KEY])) {
    out[SDR_LIST_KEY] = out[SDR_LIST_KEY].map((e) =>
      (e && typeof e === 'object' ? { ...e, host: stripSdrUserinfo(e.host) } : e));
  }
}

/**
 * Deep-enough clone of `settings` with every registered secret removed.
 * Never mutates the input. Safe to serialize and hand to a user.
 */
function stripSecrets(settings) {
  const out = { ...(settings || {}) };
  for (const k of SECRET_KEYS) delete out[k];
  for (const k of MACHINE_CREDENTIAL_ARRAYS) delete out[k];
  // Active CAT target (K4 network / Icom Network passwords)
  if (out.catTarget) out.catTarget = _cloneSansPassword(out.catTarget);
  // Per-rig CAT targets
  if (Array.isArray(out.rigs)) {
    out.rigs = out.rigs.map(r =>
      r && r.catTarget ? { ...r, catTarget: _cloneSansPassword(r.catTarget) } : (r ? { ...r } : r));
  }
  // Cluster node passwords (HamAlert etc.)
  if (Array.isArray(out.clusterNodes)) {
    out.clusterNodes = out.clusterNodes.map(n => (n ? _cloneSansPassword(n) : n));
  }
  // SDR station passwords typed inline in the receiver string
  _stripSdrPasswords(out);
  return out;
}

/**
 * What a Guest Pass guest's device may see of the settings the station shares
 * with its remote clients (lib/remote-server.js _settingsFor): everything
 * stripSecrets removes (so the SDR receivers arrive as scheme, host, port,
 * label and id), and the fields in GUEST_HIDDEN_GROUP_FIELDS. The station
 * keeps the full settings: a guest's connect to one of its SDRs is matched by
 * id or host:port (lib/guest-sdr.js) and made with the owner's own entry.
 * Never mutates the input.
 */
function stripForGuest(settings) {
  const out = stripSecrets(settings);
  if (Array.isArray(out.watchlistGroups)) {
    out.watchlistGroups = out.watchlistGroups.map((g) => {
      if (!g || typeof g !== 'object') return g;
      const c = { ...g };
      for (const f of GUEST_HIDDEN_GROUP_FIELDS) delete c[f];
      return c;
    });
  }
  return out;
}

/**
 * Graft the current machine's secrets back onto an imported settings
 * object wherever the import doesn't carry its own value. Handles the
 * nested cases a shallow `{...current, ...imported}` merge gets wrong:
 * imported.rigs/clusterNodes REPLACE the current arrays wholesale, so a
 * stripped export imported back would silently wipe every stored rig and
 * cluster password. Matches rigs and cluster nodes by id. Mutates and
 * returns `imported`.
 */
function restoreSecrets(imported, current) {
  if (!imported || typeof imported !== 'object') return imported;
  const cur = current || {};
  for (const k of SECRET_KEYS) {
    if (imported[k] == null && cur[k] != null) imported[k] = cur[k];
  }
  for (const k of MACHINE_CREDENTIAL_ARRAYS) {
    if (imported[k] == null && cur[k] != null) imported[k] = cur[k];
  }
  // Active CAT target — same transport shape means the current password
  // still belongs to it.
  if (imported.catTarget && !imported.catTarget.password &&
      cur.catTarget && cur.catTarget.password &&
      imported.catTarget.type === cur.catTarget.type) {
    imported.catTarget.password = cur.catTarget.password;
  }
  if (Array.isArray(imported.rigs) && Array.isArray(cur.rigs)) {
    for (const rig of imported.rigs) {
      if (!rig || !rig.catTarget || rig.catTarget.password) continue;
      const match = cur.rigs.find(r => r && r.id === rig.id);
      if (match && match.catTarget && match.catTarget.password) {
        rig.catTarget.password = match.catTarget.password;
      }
    }
  }
  if (Array.isArray(imported.clusterNodes) && Array.isArray(cur.clusterNodes)) {
    for (const node of imported.clusterNodes) {
      if (!node || node.password) continue;
      const match = cur.clusterNodes.find(n => n && n.id === node.id);
      if (match && match.password) node.password = match.password;
    }
  }
  // SDR station passwords: an imported receiver string with no userinfo gets
  // the current one back when the current settings hold the same host:port
  // with a password.
  const curSdr = new Map();
  const note = (h) => {
    const u = sdrUserinfo(h);
    if (u && !curSdr.has(_sdrKey(h))) curSdr.set(_sdrKey(h), u);
  };
  for (const k of SDR_HOST_KEYS) note(cur[k]);
  if (Array.isArray(cur[SDR_LIST_KEY])) {
    for (const e of cur[SDR_LIST_KEY]) if (e && typeof e === 'object') note(e.host);
  }
  if (curSdr.size) {
    const graft = (h) => {
      if (typeof h !== 'string' || !h.trim() || sdrUserinfo(h)) return h;
      const u = curSdr.get(_sdrKey(h));
      if (!u) return h;
      const m = SCHEME_RE.exec(h);
      const scheme = m ? m[0] : '';
      return scheme + u + '@' + h.slice(scheme.length);
    };
    for (const k of SDR_HOST_KEYS) if (typeof imported[k] === 'string') imported[k] = graft(imported[k]);
    if (Array.isArray(imported[SDR_LIST_KEY])) {
      for (const e of imported[SDR_LIST_KEY]) if (e && typeof e === 'object') e.host = graft(e.host);
    }
  }
  return imported;
}

module.exports = {
  SECRET_KEYS, MACHINE_CREDENTIAL_ARRAYS, SDR_HOST_KEYS, SDR_LIST_KEY, GUEST_HIDDEN_GROUP_FIELDS,
  stripSecrets, restoreSecrets, stripForGuest, stripSdrUserinfo, sdrUserinfo,
};
