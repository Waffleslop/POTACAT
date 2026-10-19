'use strict';
// Choosing which saved DX cluster nodes feed spots, from the Spots Source menu
// on the desktop and ECHOCAT Web (LZ3AW item 1, 2026-10-19: "option to choose
// between cluster nodes set in POTACAT settings, in both POTACAT and WEB").
//
// The nodes themselves are added, edited and removed only in Settings; this
// only turns a saved node on or off. Never adds a node and never falls back to
// a default server — an install that chose none stays with none
// (KD4D 2026-08-04: someone else's node is not ours to point users at).
//
// Pure. main.js owns settings.clusterNodes and reconnects (connectCluster).

/** connectCluster() connects at most this many enabled nodes. */
const MAX_ENABLED = 3;

/**
 * What a menu may show: id, name, host, enabled. Never the login, password
 * or anything else a node carries — this list goes to ECHOCAT clients.
 */
function nodesForMenu(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .filter((n) => n && n.id)
    .map((n) => ({ id: String(n.id), name: String(n.name || n.host || n.id), host: String(n.host || ''), enabled: !!n.enabled }));
}

/**
 * Turn one saved node on or off.
 * @returns {{ nodes?: object[], changed?: boolean, error?: string }}
 *   nodes = a NEW array (the input is not mutated); error = a sentence to show.
 */
function setNodeEnabled(nodes, id, enabled) {
  const list = Array.isArray(nodes) ? nodes : [];
  const want = !!enabled;
  const i = list.findIndex((n) => n && String(n.id) === String(id));
  if (i < 0) return { error: 'That cluster node is not in Settings any more.' };
  if (!!list[i].enabled === want) return { nodes: list.slice(), changed: false };
  if (want && list.filter((n) => n && n.enabled).length >= MAX_ENABLED) {
    return { error: `At most ${MAX_ENABLED} cluster nodes can be on at once — turn one off first.` };
  }
  const out = list.slice();
  out[i] = { ...list[i], enabled: want };
  return { nodes: out, changed: true };
}

module.exports = { nodesForMenu, setNodeEnabled, MAX_ENABLED };
