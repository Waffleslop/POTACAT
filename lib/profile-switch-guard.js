// lib/profile-switch-guard.js — no settings save once an operator switch has
// begun (GitHub #344).
//
// Switching operator profile saves the current operator, moves the
// activeProfile pointer to the new one, and then restarts POTACAT after the
// radio is released (a second or more). The in-memory settings still hold the
// OLD operator's callsign, log path and Cloud sign-in, but now point at the
// NEW profile. Any save in that window (the Settings save, a debounced save,
// a window-bounds save, a Cloud sign-in refresh, a paired-device change, a
// quit handler) wrote the old operator into the new profile's file, and the
// restarted app opened as the new callsign with the old operator's settings.
//
// The rule: once the pointer has moved, every settings-file write is refused
// until the process exits. The one gate sits on the single function that
// writes settings files in main.js (_writeJsonAtomic), so a new save path
// cannot slip past it. The relaunched process starts with a fresh gate.
'use strict';

function createSettingsWriteGate(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  let closed = null; // { from, to }
  let refused = 0;
  return {
    /** Close the gate: from now on no settings file is written. */
    close(from, to) {
      if (closed) return;
      closed = { from: String(from || ''), to: String(to || '') };
      log(`[multi-op] switching operator ${closed.from || '?'} -> ${closed.to || '?'}: settings saves are held until POTACAT restarts`);
    },
    isClosed() { return !!closed; },
    /** True when a write may go ahead; false (and said once in the log) when refused. */
    allowWrite(file) {
      if (!closed) return true;
      refused++;
      if (refused === 1) {
        log(`[multi-op] settings save refused during the operator switch (${file || 'settings'}): the new operator's settings stay as they were`);
      }
      return false;
    },
    refusedCount() { return refused; },
  };
}

/**
 * The switch itself, in the order that keeps both profiles right:
 *   1. save the current operator (its own file, pointer unchanged),
 *   2. move the pointer to the new operator,
 *   3. close the gate, in the same tick, before anything else can run,
 *   4. mark the new operator active in memory.
 * A failure in 1 or 2 leaves the gate open and the switch not made.
 *
 * deps: { settings, saveSettings(s), setActiveProfilePointer(call), gate }
 */
function commitProfileSwitch(toCall, deps) {
  const { settings, saveSettings, setActiveProfilePointer, gate } = deps;
  const call = String(toCall || '').toUpperCase().trim();
  const previous = String((settings && settings.activeProfile) || '');
  saveSettings(settings);
  setActiveProfilePointer(call);
  gate.close(previous, call);
  settings.activeProfile = call;
  return { previous, call };
}

module.exports = { createSettingsWriteGate, commitProfileSwitch };
