'use strict';
// Who took the rig: the fields of the ECHOCAT `kicked` message sent to the
// device that was displaced (docs/echocat-protocol.md, "kicked").
//
//   byName      the newcomer in words, when the shack knows it: the guest's
//               callsign (Guest Pass), the paired device's name, or
//               "this computer" for a connection from this PC that did not
//               come through the Cloud Tunnel. Absent when none is known
//               (the device then falls back to byPlatform / byHost).
//   byHost      the newcomer's address: the visitor's own IP from
//               cf-connecting-ip when it came through the Cloud Tunnel
//               (the socket itself is cloudflared on 127.0.0.1), else the
//               socket address, as before.
//   byPlatform, byVersion  from the newcomer's hello, as before.
//
// Pure: remote-server records the connection's facts on the socket at
// connect and calls kickedPayload when it displaces someone.

const THIS_COMPUTER = 'this computer';
const REASON = 'Another device took over this rig';

function hasTunnelHeaders(headers) {
  return !!(headers && (headers['cf-ray'] || headers['cf-connecting-ip']));
}

function isLoopback(addr) {
  let ip = String(addr || '').trim();
  if (ip === '::1') return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** A connection from this PC itself: a loopback socket without the Cloud
 *  Tunnel's headers (a tunnel visitor arrives on loopback too, via cloudflared). */
function isThisComputer(headers, remoteAddress) {
  return isLoopback(remoteAddress) && !hasTunnelHeaders(headers);
}

/** The newcomer's address for byHost. */
function peerHost(headers, remoteAddress) {
  const cf = headers && headers['cf-connecting-ip'];
  if (cf) return String(Array.isArray(cf) ? cf[0] : cf).split(',')[0].trim();
  return String(remoteAddress || '');
}

/** byName, or '' when nothing better than the platform is known. */
function byName({ guestCall, pairedName, thisComputer } = {}) {
  const call = String(guestCall || '').trim();
  if (call) return call.toUpperCase();
  const name = String(pairedName || '').trim();
  if (name) return name;
  if (thisComputer) return THIS_COMPUTER;
  return '';
}

/**
 * The whole `kicked` message.
 * @param {object} o
 *   platform, version: from the newcomer's hello
 *   host: peerHost() of the newcomer
 *   guestCall, pairedName, thisComputer: see byName
 */
function kickedPayload(o = {}) {
  const msg = {
    type: 'kicked',
    reason: REASON,
    byPlatform: String(o.platform || ''),
    byVersion: String(o.version || ''),
    byHost: String(o.host || ''),
  };
  const name = byName(o);
  if (name) msg.byName = name;
  return msg;
}

module.exports = { THIS_COMPUTER, REASON, hasTunnelHeaders, isLoopback, isThisComputer, peerHost, byName, kickedPayload };
