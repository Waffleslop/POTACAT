'use strict';
// A Winlink session must end with an error on screen, never with POTACAT's
// crash dialog (artificialjump, 2026-10-31: packet Send/Receive "crashes
// POTACAT", two photos of the dialog). The connect chain catches what it
// awaits, but the session also runs on sockets and child processes (Dire
// Wolf, ardopcf, Pat, the modem audio server, the radio-control shim) whose
// event callbacks throw outside any try. Those land in main's
// uncaughtException handler, which was fatal for everything but plain
// network errnos. This decides when such an exception belongs to the
// session: a session is running and the throw came from Winlink code.
// Pure, so the rule is tested (test/winlink-fault-test.js).

const WINLINK_FRAMES = /[\\/]lib[\\/](winlink-[a-z]+|direwolf-process|ardop-process|modem-audio-server|modem-rx-level|rigctld-server)\.js|\bwinlink[A-Z]\w*|\b(spawnDirewolf|spawnArdop|direwolf|ardop)\w*\b/;

/**
 * @param {Error|any} err
 * @param {{sessionActive:boolean}} ctx
 * @returns {boolean} true = end the session with this error instead of crashing
 */
function isWinlinkSessionFault(err, ctx) {
  if (!ctx || !ctx.sessionActive || !err) return false;
  const stack = String((err && err.stack) || '');
  if (!stack) return false;
  return WINLINK_FRAMES.test(stack);
}

module.exports = { isWinlinkSessionFault };
