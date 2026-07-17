'use strict';

// SDR receiver list sync — desktop half of the two-layer contract with
// ECHOCAT mobile (potacat-app docs/desktop-asks/sdr-list-full-sync.md).
//
// The phone owns an ordered, dense, unlimited list of SDR receivers
// (settings.kiwiSdrList: [{label, host}]). The legacy 3-slot keys
// (kiwiSdrLabel1..3 / kiwiSdrHost1..3) are a VIEW onto the list's first
// three entries — kept in lockstep so older phones, the web client, and
// the desktop Settings form (all of which speak only slots) stay in sync.
//
// Semantics mirror the phone's pure model (potacat-app src/utils/sdrList.ts)
// exactly, so the two ends can't drift:
//   - the list is dense: entries with a blank host are dropped;
//   - a slot edit overlays entries 0-2 as a window, then re-compacts —
//     clearing a slot's host REMOVES the row and shifts later entries up;
//   - entries 4+ ride along untouched through slot-only edits.
//
// Sanitization follows the sanitizeVfoProfiles lesson (2026-07-15): never
// persist a client blob verbatim. Coerce label/host to strings, clamp
// lengths, cap the list, drop garbage. Hosts are NOT normalized here — the
// phone canonicalizes (":8073" default, protocol stripped) before sending,
// and the desktop rewriting them would fight that canonical form.
//
// Pure + dependency-free for unit testing (test/sdr-list-sync-test.js).

const LABEL_MAX = 64;   // matches sanitizeVfoProfiles' name clamp
const HOST_MAX = 128;
const LIST_MAX = 100;   // far above any real use

const SLOT_KEYS = [
  'kiwiSdrLabel1', 'kiwiSdrLabel2', 'kiwiSdrLabel3',
  'kiwiSdrHost1', 'kiwiSdrHost2', 'kiwiSdrHost3',
];

/**
 * Coerce an arbitrary value into a clean, dense [{label, host}] list.
 * Mirrors the phone's normalizeSdrList, plus length/count clamps.
 * @param {unknown} raw
 * @returns {{label: string, host: string}[]}
 */
function sanitizeKiwiSdrList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const label = String(e.label == null ? '' : e.label).slice(0, LABEL_MAX);
    const host = String(e.host == null ? '' : e.host).slice(0, HOST_MAX);
    if (host.trim() === '') continue; // dense invariant
    out.push({ label, host });
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

/**
 * Reconcile the SDR keys of an incoming settings partial against the
 * currently persisted list, returning the cleaned canonical pair — the full
 * list AND the six slot keys derived from its first three entries — or null
 * when the partial contains nothing SDR-related (caller skips entirely; a
 * push without SDR keys must behave exactly as before).
 *
 * Handles every editor uniformly:
 *   - phone edit: partial has kiwiSdrList + mirrored slots → adopt the
 *     sanitized list (slot overlay is then a no-op);
 *   - web client / desktop Settings form: slots only → overlay onto the
 *     current list's 0-2 window, compact, keep entries 3+;
 *   - both layers present but inconsistent: the slot keys win for rows 0-2
 *     (same precedence the phone applies on receive).
 *
 * @param {object} partial - incoming settings partial (not mutated)
 * @param {unknown} currentList - settings.kiwiSdrList as persisted
 * @returns {{ list: {label:string, host:string}[], slotKeys: object } | null}
 */
function reconcileSdrSettings(partial, currentList) {
  if (!partial || typeof partial !== 'object') return null;
  const hasList = Array.isArray(partial.kiwiSdrList);
  const hasSlots = SLOT_KEYS.some((k) => typeof partial[k] === 'string');
  if (!hasList && !hasSlots) return null;

  const base = hasList ? sanitizeKiwiSdrList(partial.kiwiSdrList)
                       : sanitizeKiwiSdrList(currentList);

  let list = base;
  if (hasSlots) {
    // Window overlay — mirrors the phone's applyDesktopSlots: present slot
    // keys overwrite rows 0-2, absent keys keep current values, then the
    // window re-compacts (blank host = row deleted, later entries shift up).
    const window = [0, 1, 2].map((i) =>
      base[i] ? { ...base[i] } : { label: '', host: '' });
    for (let i = 0; i < 3; i++) {
      const label = partial[`kiwiSdrLabel${i + 1}`];
      const host = partial[`kiwiSdrHost${i + 1}`];
      if (typeof label === 'string') window[i].label = label.slice(0, LABEL_MAX);
      if (typeof host === 'string') window[i].host = host.slice(0, HOST_MAX);
    }
    list = [
      ...window.filter((e) => e.host.trim() !== ''),
      ...base.slice(3),
    ].slice(0, LIST_MAX);
  }

  // Slots are a view onto list[0..2] — always derived, never free-floating.
  const slotKeys = {};
  for (let i = 0; i < 3; i++) {
    slotKeys[`kiwiSdrLabel${i + 1}`] = list[i] ? list[i].label : '';
    slotKeys[`kiwiSdrHost${i + 1}`] = list[i] ? list[i].host : '';
  }
  return { list, slotKeys };
}

module.exports = { sanitizeKiwiSdrList, reconcileSdrSettings };
