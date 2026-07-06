'use strict';

// Event ↔ FT8-decode matching — the desktop half of the event-stroke GO
// decision (potacat-app docs/desktop-asks/ft8-watchlist-stroke-parity-
// RESPONSE.md). Given the active events catalog + the operator's event
// states, classify a decoded callsign as needed / new-slot / worked for
// tracked CHECKLIST events (13 Colonies et al.) that are inside their
// schedule window right now.
//
// Semantics are a deliberate port of ECHOCAT mobile's eventSpotStatusOf +
// eventSlots.ts (checklistItemFor / entrySlots / slotCovers / spotIsNewSlot)
// so both clients classify identically — the phone treats a published
// `eventMatch` as authoritative, so this IS the contract.

/** Canonical band token: "20M" / " 20m " → "20m". Unknown → "". */
function normEventBand(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

/** Canonical mode token, folding aliases that mean the same emission for
 *  "have I worked this mode?" purposes: USB/LSB → SSB, CW-R → CW. */
function normEventMode(v) {
  if (v == null) return '';
  const m = String(v).trim().toUpperCase();
  if (m === 'USB' || m === 'LSB') return 'SSB';
  if (m === 'CW-R') return 'CW';
  return m;
}

/** All band/mode combos a progress entry is known to cover. Prefers the
 *  multi-QSO `slots` array (13colonies-progress-slots contract; reads it
 *  when present exactly like mobile does); falls back to the entry's own
 *  single band/mode. A manual tick has neither — one empty slot, which
 *  slotCovers treats as covering everything (no info → don't re-alert). */
function entrySlots(entry) {
  const raw = entry && entry.slots;
  if (Array.isArray(raw)) {
    const out = [];
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      out.push({ band: normEventBand(s.band), mode: normEventMode(s.mode) });
    }
    if (out.length > 0) return out;
  }
  return [{ band: normEventBand(entry && entry.band), mode: normEventMode(entry && entry.mode) }];
}

/** Missing data on EITHER side counts as covered — when we can't tell the
 *  worked slot apart from the decode, stay quiet rather than re-alert. */
function slotCovers(slot, band, mode) {
  const bandMatch = slot.band === '' || band === '' || slot.band === band;
  const modeMatch = slot.mode === '' || mode === '' || slot.mode === mode;
  return bandMatch && modeMatch;
}

function spotIsNewSlot(entry, spotBand, spotMode) {
  const band = normEventBand(spotBand);
  const mode = normEventMode(spotMode);
  return !entrySlots(entry).some((slot) => slotCovers(slot, band, mode));
}

/**
 * Classify a decoded call against the tracked events.
 * @param events active events catalog (main.js activeEvents)
 * @param eventStates settings.events ({ [id]: { optedIn, progress } })
 * @param call uppercase decoded callsign
 * @param band current rig band ('20m') — may be null
 * @param mode decode mode ('FT8'/'FT4'/'FT2') — may be null
 * @param now Date (injectable for tests)
 * @returns { id, badge, badgeColor, status: 'needed'|'new-slot'|'worked' } | null
 */
function eventDecodeMatch(events, eventStates, call, band, mode, now = new Date()) {
  if (!call || !Array.isArray(events) || events.length === 0 || !eventStates) return null;
  for (const ev of events) {
    if (!ev || !ev.id) continue;
    const state = eventStates[ev.id];
    if (!state || !state.optedIn) continue;
    // Checklist boards only — same gate as mobile's eventSpotStatusOf.
    // Per-year history of a counter/regions event per decode is noise.
    const board = ev.board || (ev.tracking && ev.tracking.type) || 'regions';
    if (board !== 'checklist') continue;
    // In-window right now (schedule entries carry ISO start/end).
    const inWindow = (ev.schedule || []).some((s) => {
      const start = new Date(s.start);
      const end = new Date(s.end);
      return now >= start && now < end;
    });
    if (!inWindow) continue;
    // Same item matcher as checkEventQso: exact id or id + portable suffix.
    const items = (ev.tracking && ev.tracking.items) || [];
    const item = items.find((it) => it && it.id &&
      (call === it.id.toUpperCase() || call.startsWith(it.id.toUpperCase() + '/')));
    if (!item) continue;
    const entry = state.progress && state.progress[item.id];
    const status = !entry ? 'needed'
      : (spotIsNewSlot(entry, band, mode) ? 'new-slot' : 'worked');
    return { id: ev.id, badge: ev.badge || '', badgeColor: ev.badgeColor || '', status };
  }
  return null;
}

module.exports = {
  eventDecodeMatch, spotIsNewSlot, entrySlots, normEventBand, normEventMode,
};
