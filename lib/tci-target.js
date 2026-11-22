// SPDX-License-Identifier: Apache-2.0
/**
 * A TCI rig target (settings.catTarget with type 'tci'): the radio is driven
 * through the TCI server of the SDR program that owns it (Zeus, Thetis).
 * Based on PR #632 by w5lee.
 *
 * Dual-mode: Node `require()` gets module.exports; the rig editor loads it
 * with a <script> tag and gets `window.TciTarget`. No DOM or Node imports.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TciTarget = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The TCI port each program starts with. Zeus 40001: w5lee's Zeus +
  // Hermes-Lite 2 station (#632). Thetis 50001: the port POTACAT's TCI
  // panadapter spots have always defaulted to.
  var SERVERS = {
    zeus: { label: 'Zeus', port: 40001 },
    thetis: { label: 'Thetis', port: 50001 },
  };

  var HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i;
  var IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

  function isHost(host) {
    if (typeof host !== 'string' || !host) return false;
    var h = host.replace(/^\[([^\]]+)\]$/, '$1');
    if (IPV4.test(h) || HOSTNAME.test(h)) return true;
    return h.indexOf(':') !== -1 && /^[0-9a-f:.]+$/i.test(h); // IPv6
  }

  /** The operator-facing problem with a target, or null when it is usable. */
  function validate(t) {
    if (!t || t.type !== 'tci') return 'Not a TCI radio';
    if (!Object.prototype.hasOwnProperty.call(SERVERS, t.server)) return 'Select Zeus or Thetis';
    if (!isHost(t.host)) return 'Enter the TCI server hostname or IP address';
    if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) return 'Enter a TCI port from 1 to 65535';
    return null;
  }

  /** A clean target from editor fields: trims the host, fills the defaults. */
  function normalize(t) {
    t = t || {};
    var server = Object.prototype.hasOwnProperty.call(SERVERS, t.server) ? t.server : 'zeus';
    var host = String(t.host == null ? '' : t.host).trim().replace(/^\[([^\]]+)\]$/, '$1') || '127.0.0.1';
    var port = Number(t.port);
    return {
      type: 'tci',
      server: server,
      host: host,
      port: Number.isInteger(port) && port > 0 ? port : SERVERS[server].port,
      autoStart: t.autoStart !== false,
    };
  }

  function serverLabel(server) {
    return (SERVERS[server] || SERVERS.zeus).label;
  }

  function describe(t) {
    return serverLabel(t && t.server) + ' TCI at ' + (t && t.host) + ':' + (t && t.port);
  }

  /** ws:// address for a host (an IPv6 literal goes in brackets). */
  function address(host, port) {
    var h = String(host || '127.0.0.1');
    if (h.indexOf(':') !== -1 && h.charAt(0) !== '[') h = '[' + h + ']';
    return 'ws://' + h + ':' + port;
  }

  return { SERVERS: SERVERS, validate: validate, normalize: normalize, serverLabel: serverLabel, describe: describe, address: address };
});
