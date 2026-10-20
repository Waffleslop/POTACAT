'use strict';
//
// The active rig and the connection target must name the same radio.
//
// Two settings describe "the radio POTACAT drives": `activeRigId` (which entry
// in My Rigs is selected) and `catTarget` (what connectCat opens). They are
// written together by the CAT pill popover, but the Settings dialog's full
// save wrote only `activeRigId`, and a rig deleted and re-added gets a new id
// while the global target keeps the old port. The result (SP5GB, 1.11.7,
// six rigs): `activeRigId` named nothing, so the rig editor showed "None"
// while POTACAT kept connecting to COM15, every model lookup fell through to
// the generic brand table, and the log alternated between "Connecting to
// Kenwood on COM15" and "6 rigs are configured but none is set ACTIVE" as he
// clicked around the popover.
//
// `healActiveRig` adopts the rig whose target IS the connection target. It
// never clears an id and never changes the target — a contradictory state is
// repaired toward the radio that is actually connected, not away from it.
// Pure; main.js logs and saves.

function sameTarget(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if ((a.type || '') !== (b.type || '')) return false;
  if (a.type === 'serial' || a.path || b.path) {
    const pa = String(a.path || '').toLowerCase(); // COM15 vs com15 on Windows
    const pb = String(b.path || '').toLowerCase();
    return !!pa && pa === pb;
  }
  if (a.type === 'none') return true;
  const ha = String(a.host || '').toLowerCase(), hb = String(b.host || '').toLowerCase();
  const pa = String(a.port || ''), pb = String(b.port || '');
  return !!ha && ha === hb && pa === pb;
}

/** The rig whose catTarget is `target`, or null. */
function findRigByTarget(rigs, target) {
  if (!target) return null;
  return (rigs || []).find((r) => r && r.catTarget && sameTarget(r.catTarget, target)) || null;
}

/**
 * Repair `settings.activeRigId` when it names no rig but `settings.catTarget`
 * matches one. Mutates `settings`; returns what happened so the caller can log.
 * @returns {{changed: boolean, reason: 'ok'|'no-rigs'|'adopted'|'unmatched', rig: object|null, staleId: string|null}}
 */
function healActiveRig(settings) {
  const rigs = (settings && settings.rigs) || [];
  if (!rigs.length) return { changed: false, reason: 'no-rigs', rig: null, staleId: null };
  const current = rigs.find((r) => r && r.id === settings.activeRigId) || null;
  if (current) return { changed: false, reason: 'ok', rig: current, staleId: null };
  const staleId = settings.activeRigId || null;
  const match = findRigByTarget(rigs, settings.catTarget);
  if (!match) return { changed: false, reason: 'unmatched', rig: null, staleId };
  settings.activeRigId = match.id;
  return { changed: true, reason: 'adopted', rig: match, staleId };
}

module.exports = { sameTarget, findRigByTarget, healActiveRig };
