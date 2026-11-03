'use strict';
// One POTACAT Cloud address per account, one shack on it at a time.
//
// The account has ONE Cloud tunnel (cloudlog routes/cloud-tunnel.js keeps one
// cloud_tunnel_id + cloud_host per user), and every desktop signed in to it is
// handed the same tunnel token. Two desktops online at once run as replicas of
// that tunnel: Cloudflare splits incoming connections between them, so the
// phone reaches either radio, and nothing said so (KQ5O, three shacks on
// kq5o.potacat.com, 2026-11-03). Each desktop now CLAIMS the address before it
// starts its connector, and the server says when another desktop holds it.
//
// Server contract (cloudlog):
//   POST /v1/cloud-tunnel/claim   { deviceId, name, rigModel, takeover }
//     200 { ok, connectors }                 the address is ours
//     409 { error:'tunnel_in_use', connectors, unclaimedConnectors? }
//   GET  /v1/cloud-tunnel/claim?deviceId=    (database only; polled every 60 s)
//     200 { superseded: null|{byDeviceId, byName, at}, connectors, unclaimedConnectors? }
//   POST /v1/cloud-tunnel/release { deviceId }   no revoke, no DNS change
// connectors = [{ deviceId, name, rigModel, since, lastSeen }], OTHER desktops.
//
// A server without the routes (404) or no network is never a reason to keep
// the tunnel down: the desktop starts as it did before, and says so once.
// Pure; lib/cloud-tunnel.js does the requests, main.js the dialog and notices.

/** Whether an error means "this server has no claim route" (not deployed yet). */
function isUnsupported(err) {
  if (!err) return false;
  if (err.status === 404 || err.status === 405 || err.status === 501) return true;
  return /^HTTP (404|405|501)\b/.test(String(err.message || ''));
}

function cleanConnectors(list, selfId) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && c.deviceId && c.deviceId !== selfId)
    .map((c) => ({
      deviceId: String(c.deviceId),
      name: String(c.name || '').trim() || 'another computer',
      rigModel: String(c.rigModel || '').trim(),
      since: c.since || null,
      lastSeen: c.lastSeen || null,
    }));
}

function unclaimedOf(body) {
  const n = Number(body && body.unclaimedConnectors);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The answer to a POST /claim.
 * @returns {{state:'ok'|'in-use'|'unsupported'|'error', connectors:Array, unclaimed:number, error?:string}}
 */
function interpretClaim(res, err, selfId) {
  if (err) {
    if (err.status === 409 || err.code === 'tunnel_in_use') {
      const body = err.body || {};
      const connectors = cleanConnectors(body.connectors, selfId);
      const unclaimed = unclaimedOf(body);
      // A 409 that names nobody else is the server's own confusion: start.
      if (!connectors.length && !unclaimed) return { state: 'ok', connectors: [], unclaimed: 0 };
      return { state: 'in-use', connectors, unclaimed };
    }
    if (isUnsupported(err)) return { state: 'unsupported', connectors: [], unclaimed: 0 };
    return { state: 'error', connectors: [], unclaimed: 0, error: String(err.message || err) };
  }
  return { state: 'ok', connectors: cleanConnectors(res && res.connectors, selfId), unclaimed: unclaimedOf(res) };
}

/**
 * The answer to the 60 s GET /claim poll.
 * @returns {{state:'superseded'|'shared'|'alone'|'unsupported'|'error', by?:{deviceId,name}, connectors:Array, unclaimed:number}}
 */
function interpretPoll(res, err, selfId) {
  if (err) {
    if (isUnsupported(err)) return { state: 'unsupported', connectors: [], unclaimed: 0 };
    return { state: 'error', connectors: [], unclaimed: 0 };
  }
  const s = res && res.superseded;
  if (s && (s.byDeviceId || s.byName) && s.byDeviceId !== selfId) {
    return { state: 'superseded', by: { deviceId: String(s.byDeviceId || ''), name: String(s.byName || '').trim() || 'another computer' }, connectors: [], unclaimed: 0 };
  }
  const connectors = cleanConnectors(res && res.connectors, selfId);
  const unclaimed = unclaimedOf(res);
  return { state: connectors.length || unclaimed ? 'shared' : 'alone', connectors, unclaimed };
}

/** "KQ5O-MAC (FT-710)", "KQ5O-MAC (FT-710) and DELL (FTDX101D)", or the older-version wording. */
function describeOthers(connectors, unclaimed) {
  const names = (connectors || []).map((c) => c.rigModel ? `${c.name} (${c.rigModel})` : c.name);
  if (unclaimed) names.push(unclaimed === 1 ? 'a POTACAT on an older version' : `${unclaimed} POTACATs on an older version`);
  if (!names.length) return 'another computer';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/** The running notice: another shack is on the address too. */
function sharedNotice(connectors, unclaimed) {
  const who = describeOthers(connectors, unclaimed);
  const many = (connectors || []).length + (unclaimed ? 1 : 0) > 1;
  return `Another shack (${who}) ${many ? 'are' : 'is'} also on your Cloud address; your phone may reach either.`;
}

/** The notice on the desktop that was asked to stop. */
function supersededNotice(by) {
  return `${(by && by.name) || 'Another computer'} took over your Cloud address. This shack's Cloud Tunnel is off; turn it on in Settings > Cloud to take it back.`;
}

/**
 * The question before starting while another shack holds the address.
 * Buttons map to choices by index: 0 takeover, 1 keep, 2 cancel.
 */
function conflictDialog(connectors, unclaimed, cloudHost) {
  const who = describeOthers(connectors, unclaimed);
  const addr = cloudHost || 'your Cloud address';
  return {
    title: 'POTACAT Cloud',
    message: `${who} is already on ${addr}.`,
    detail: `Your account has one Cloud address, and it can lead to one shack at a time. With two on it, your phone may reach either radio.\n\n`
      + `Use this shack instead: ${who} is told to stop, and your phone reaches this one.\n`
      + `Keep the other shack: this computer's Cloud Tunnel stays off.`,
    buttons: ['Use this shack instead', 'Keep the other shack', 'Cancel'],
    choices: ['takeover', 'keep', 'cancel'],
    defaultId: 1,
    cancelId: 2,
  };
}

/** A stable key for "the same set of other shacks", so a notice is said once. */
function othersKey(connectors, unclaimed) {
  return (connectors || []).map((c) => c.deviceId).sort().join(',') + '|' + (unclaimed || 0);
}

module.exports = {
  isUnsupported, interpretClaim, interpretPoll, describeOthers, sharedNotice, supersededNotice, conflictDialog, othersKey,
};
