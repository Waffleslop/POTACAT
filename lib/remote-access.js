'use strict';

// ECHOCAT access — the door itself (adversarial review of 1.13.9, finding 1;
// Casey 2026-11-03: no default-on password, but a real Off and a Cloud-only
// mode). ONE setting, settings.remoteAccess:
//   'lan'   — today's behaviour and the default: the listener binds every
//             interface (0.0.0.0), mDNS advertises it, LAN/Tailscale/Cloud
//             all reach it.
//   'cloud' — the listener binds 127.0.0.1 only. cloudflared's ingress is
//             https://localhost:7300 (lib/origin-health.js), so the Cloud
//             address, Guest Pass and the launcher keep working; the LAN and
//             the tailnet see a closed port. No mDNS.
//   'off'   — no listener at all. No phone, web or Cloud access.
// `enableRemote` stays as the DERIVED boolean (access !== 'off') because
// eleven readers in main.js and the headless path key off it; it is never
// the source of truth again. Until now main.js forced it true at every
// start (KE6ZC's migrated profile came up with the flag missing), so Off did
// not exist and the always-on listener was reachable from the whole LAN.

const ACCESS = ['off', 'cloud', 'lan'];
const DEFAULT_ACCESS = 'lan';

function isAccess(v) { return typeof v === 'string' && ACCESS.includes(v); }

/** Migration + repair, applied at settings load and before every persist:
 *  a valid remoteAccess wins; otherwise the legacy boolean decides
 *  (enableRemote === false → 'off'; missing or true → 'lan'). */
function normalizeRemoteAccess(s) {
  const src = s || {};
  const access = isAccess(src.remoteAccess) ? src.remoteAccess
    : (src.enableRemote === false ? 'off' : DEFAULT_ACCESS);
  const enableRemote = access !== 'off';
  const changed = src.remoteAccess !== access || src.enableRemote !== enableRemote;
  return { access, enableRemote, changed };
}

/** An incoming settings patch: remoteAccess is authoritative. A client that
 *  only knows the boolean (an older page, a phone) cannot open or close the
 *  door with it — enableRemote is rewritten from the access in force. */
function reconcileRemoteAccessPatch(patch, current) {
  if (!patch || typeof patch !== 'object') return patch;
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has('remoteAccess') && isAccess(patch.remoteAccess)) {
    patch.enableRemote = patch.remoteAccess !== 'off';
  } else if (has('remoteAccess') || has('enableRemote')) {
    const cur = normalizeRemoteAccess(current || {});
    patch.remoteAccess = cur.access;
    patch.enableRemote = cur.enableRemote;
  }
  return patch;
}

/** The address the listener binds, or null for no listener. */
function listenHostFor(access) {
  const a = isAccess(access) ? access : DEFAULT_ACCESS;
  if (a === 'off') return null;
  return a === 'cloud' ? '127.0.0.1' : '0.0.0.0';
}

/** mDNS advertises the listener only where the LAN can reach it. */
function mdnsFor(access) {
  return (isAccess(access) ? access : DEFAULT_ACCESS) === 'lan';
}

function describeRemoteAccess(access) {
  const a = isAccess(access) ? access : DEFAULT_ACCESS;
  if (a === 'off') return 'Off — no phone, web or Cloud access; the Cloud address and Guest Pass are unavailable';
  if (a === 'cloud') return 'Cloud only — reachable through the POTACAT Cloud address; the port is closed to the local network and Tailscale';
  return 'Local network and Cloud — reachable on the LAN, Tailscale and the Cloud address';
}

module.exports = {
  ACCESS,
  DEFAULT_ACCESS,
  isAccess,
  normalizeRemoteAccess,
  reconcileRemoteAccessPatch,
  listenHostFor,
  mdnsFor,
  describeRemoteAccess,
};
