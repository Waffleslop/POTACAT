'use strict';

// Which SDR a Guest Pass guest may use (GitHub #543).
//
// A guest operates the station; the SDRs the owner has already set up at the
// station (rtl_tcp, KiwiSDR, WebSDR) are part of it. So a pass session may
// connect to, disconnect from, switch between and tune those receivers. It may
// not point the station at a receiver of its own: a connect that names a host
// or port the owner has not configured is refused, and nothing a guest sends
// adds, edits or saves an SDR entry (save-settings is refused for a guest
// inside its case; this module says so in words when the partial is SDR keys).
//
// The owner's list is what the station already shares with every client in
// its settings payload: kiwiSdrList (the full list) and the legacy slot keys
// kiwiSdrHost1..3 / kiwiSdrHost (lib/sdr-list-sync.js). A guest's request is
// matched by the entry's `id` when the entry has one, or by exact host:port
// (scheme, trailing slash, an inline "password@" and the host's case are
// ignored; no port means 8073, as everywhere else). The connect that goes on
// to main carries the OWNER's entry string, never the guest's, and never a
// guest-supplied password.
//
// Pure; the demux in lib/remote-server.js calls it. Tests: test/guest-sdr-test.js.

const PassWording = require('./pass-wording');

/** The SDR message types a pass session may send (all three pass the wall). */
const GUEST_SDR_TYPES = Object.freeze(['kiwi-connect', 'kiwi-disconnect', 'kiwi-tune']);

/** Settings keys that configure the SDR list. A guest's write of any is refused. */
const SDR_SETTINGS_KEYS = Object.freeze([
  'kiwiSdrList', 'kiwiSdrHost',
  'kiwiSdrHost1', 'kiwiSdrHost2', 'kiwiSdrHost3',
  'kiwiSdrLabel1', 'kiwiSdrLabel2', 'kiwiSdrLabel3',
]);

const DEFAULT_PORT = 8073;

/**
 * "https://pw@Host.example:8074/" -> { key: 'host.example:8074', host, port }.
 * null for an empty or unusable string.
 */
function normalizeSdrHost(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  if (!s) return null;
  let host = s, port = DEFAULT_PORT;
  const colon = s.lastIndexOf(':');
  if (colon > 0 && s.indexOf(':') === colon) {
    host = s.slice(0, colon);
    const p = s.slice(colon + 1);
    if (p !== '') {
      if (!/^\d{1,5}$/.test(p)) return null;
      port = parseInt(p, 10);
      if (port < 1 || port > 65535) return null;
    }
  }
  host = host.trim().toLowerCase();
  if (!host || /[\s/]/.test(host)) return null;
  return { key: host + ':' + port, host, port };
}

/**
 * The SDRs the owner has configured, in the station's order, without
 * duplicates: [{ id, label, host, key }]. `host` is the owner's own string
 * (it may carry an inline station password); `id` is the entry's own id or ''.
 */
function ownerSdrEntries(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const out = [];
  const seen = new Set();
  const add = (host, label, id) => {
    const n = normalizeSdrHost(host);
    if (!n || seen.has(n.key)) return;
    seen.add(n.key);
    out.push({ id: typeof id === 'string' ? id : '', label: String(label || ''), host: String(host).trim(), key: n.key });
  };
  if (Array.isArray(s.kiwiSdrList)) {
    for (const e of s.kiwiSdrList) if (e && typeof e === 'object') add(e.host, e.label, e.id);
  }
  add(s.kiwiSdrHost1 || s.kiwiSdrHost, s.kiwiSdrLabel1);
  add(s.kiwiSdrHost2, s.kiwiSdrLabel2);
  add(s.kiwiSdrHost3, s.kiwiSdrLabel3);
  return out;
}

/**
 * What a kiwi-connect turns into.
 *   - Not a pass session: the message as sent (unchanged behaviour).
 *   - A pass session asking for one of the owner's entries (by id, by exact
 *     host:port, or with no host at all = the station's first SDR):
 *     { ok: true, msg: { type, host: <owner's string> } }.
 *   - Anything else: { ok: false, text } with the words to show.
 * @param {object} msg the client's kiwi-connect
 * @param {object} settings the settings the station shares (kiwiSdrList, slot keys)
 * @param {{pass?: boolean}} [opts]
 */
function resolveSdrConnect(msg, settings, opts) {
  const m = msg && typeof msg === 'object' ? msg : {};
  if (!(opts && opts.pass)) return { ok: true, msg: m };
  const entries = ownerSdrEntries(settings);
  const refuse = { ok: false, text: PassWording.SDR_NOT_OWNERS };
  let entry = null;
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  const hostAsked = String(m.host == null ? '' : m.host).trim();
  if (id) {
    entry = entries.find((e) => e.id && e.id === id) || null;
    if (!entry) return refuse;
    if (hostAsked) {
      const n = normalizeSdrHost(hostAsked);
      if (!n || n.key !== entry.key) return refuse;
    }
  } else if (hostAsked) {
    const n = normalizeSdrHost(hostAsked);
    entry = n ? entries.find((e) => e.key === n.key) || null : null;
  } else {
    entry = entries[0] || null;
  }
  if (!entry) return refuse;
  return { ok: true, msg: { type: 'kiwi-connect', host: entry.host } };
}

/** Does this settings partial touch the SDR list? */
function isSdrSettingsWrite(partial) {
  if (!partial || typeof partial !== 'object') return false;
  return SDR_SETTINGS_KEYS.some((k) => Object.prototype.hasOwnProperty.call(partial, k));
}

module.exports = {
  GUEST_SDR_TYPES,
  SDR_SETTINGS_KEYS,
  normalizeSdrHost,
  ownerSdrEntries,
  resolveSdrConnect,
  isSdrSettingsWrite,
};
