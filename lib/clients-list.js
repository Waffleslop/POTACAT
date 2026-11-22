'use strict';

// clients-list: who is connected, one copy per device (lib/remote-server.js
// _broadcastClientsList). ECHOCAT handoff 2026-11-22: on a guest row the
// owner's devices also learn which pass the guest is on and the guest's
// on-air call, so Settings > Guest pass > My passes can say "Connected now"
// on the right pass.
//
//   passCode  the guest's pass code (ws._passSession.code)
//   call      the guest's on-air call, '' for an anonymous guest
//
// Owner devices only. A guest never sees another guest's pass code, and its
// own row is no richer than before. Pure.

/** The fields only owner devices see on a guest row. */
function guestRowExtras(passSession, onAirCall) {
  if (!passSession) return null;
  return { passCode: String(passSession.code || ''), call: String(onAirCall || '') };
}

/**
 * One device's copy of the list. rows: [{...row, ownerOnly?}]; viewer:
 * {id, guest}. ownerOnly is merged into the row for an owner device and
 * dropped for a guest; `you` marks the viewer's own row.
 */
function rowsFor(rows, viewer) {
  const v = viewer || {};
  return (rows || []).map((row) => {
    const { ownerOnly, ...r } = row;
    const out = { ...r, you: r.id === v.id };
    if (!v.guest && ownerOnly) Object.assign(out, ownerOnly);
    return out;
  });
}

module.exports = { guestRowExtras, rowsFor };
