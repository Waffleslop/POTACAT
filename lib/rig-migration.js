// lib/rig-migration.js — when a saved CAT target becomes a rig, and when it
// must not (GitHub #314).
//
// Before My Rigs (0.9.6, 2026-02) the radio was one settings key, catTarget.
// migrateRigSettings in main.js turned that key into the first entry of the
// rig list. Today catTarget is still saved, as a copy of the active rig's
// target, in the operator's profile file, while the rig list (rigs,
// activeRigId) lives in the machine's global settings.json. So a file that
// has a catTarget and no rig list is no longer an old file: it is a global
// file that lost its rig list. The old rule ("catTarget set, rig list empty:
// make a rig") answered that loss with a made-up "Serial CAT on COM4" entry
// with none of the rig's own settings, and said nothing (#314).
//
// The rules now:
//   - a rig list with rigs in it is never touched;
//   - an EMPTY rig list is the operator's own (they removed every rig):
//     nothing is made from a leftover catTarget;
//   - no rig list at all in a single-file settings.json (no activeProfile,
//     the layout before operator profiles) is a genuinely old file: the
//     catTarget becomes the first rig, as it always did, and the log says so;
//   - no rig list at all in the profile layout means the rig list was lost:
//     the catTarget still becomes a rig so the radio keeps connecting, and the
//     log says plainly that the rig list was missing and what was made.
'use strict';

/**
 * Decide what the rig migration does with a loaded settings object. Pure: the
 * caller applies the result and saves.
 *
 * @param {object} s  the merged settings as loaded
 * @param {object} [opts] { now: ms, describe: (target) => rig name (main's describeTargetForMigration) }
 * @returns {{ action: 'none'|'legacy'|'lost', rig?: object, log?: string }}
 */
function planRigMigration(s, opts = {}) {
  if (!s || typeof s !== 'object') return { action: 'none' };
  const hasList = Array.isArray(s.rigs);
  if (hasList && s.rigs.length) return { action: 'none' };
  if (!s.catTarget || typeof s.catTarget !== 'object') return { action: 'none' };
  if (hasList) return { action: 'none' }; // an empty list is the operator's own
  const describe = typeof opts.describe === 'function' ? opts.describe : () => 'Radio';
  const rig = {
    id: 'rig_' + (opts.now || Date.now()),
    name: describe(s.catTarget),
    catTarget: JSON.parse(JSON.stringify(s.catTarget)),
  };
  if (!s.activeProfile) {
    return {
      action: 'legacy',
      rig,
      log: `[Rig] settings from before My Rigs: the saved CAT target is now the rig "${rig.name}"`,
    };
  }
  return {
    action: 'lost',
    rig,
    log: `[Rig] WARNING: settings.json has no rig list, but operator ${s.activeProfile} has a saved CAT target. `
      + `The rig list was lost (GitHub #314). Made "${rig.name}" from the CAT target so the radio still connects; `
      + 'its model, audio and other rig settings were not saved with it. Open Settings > Radio and pick your radio again.',
  };
}

/**
 * Apply a plan to the settings object. Returns true when it changed anything
 * that must be saved. Never removes or replaces an existing rig.
 */
function applyRigMigration(s, plan) {
  if (!plan || plan.action === 'none' || !plan.rig) return false;
  if (!Array.isArray(s.rigs)) s.rigs = [];
  if (s.rigs.length) return false; // belt and braces: a list with rigs is never touched
  s.rigs.push(plan.rig);
  s.activeRigId = plan.rig.id;
  delete s.catTarget;
  return true;
}

module.exports = { planRigMigration, applyRigMigration };
