// POTA self-spot by email (W7RTA 2026-10-24: spotted himself over Winlink).
// The service at potaspot.tdod.org reads ONE line of a plain-text body sent to
// spot@pota.tdod.org — `!CALL POTA REF FREQ_MHZ MODE [comment]` — and posts it
// to POTA as the activator's own spot. One park per message, so an n-fer is
// one message per park. Dual-mode: require() in main, window.PotaEmailSpot in
// the Winlink mail window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PotaEmailSpot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SPOT_ADDRESS = 'spot@pota.tdod.org';
  var PARK_PLACEHOLDER = 'PARK';

  // The modes the service names; anything else is passed as given.
  function spotMode(mode) {
    var m = String(mode || '').toUpperCase().trim();
    if (m === 'USB' || m === 'LSB' || m === 'SSB' || m === 'PHONE') return 'SSB';
    if (m === 'CW-R' || m === 'CWR') return 'CW';
    if (m === 'FM-N' || m === 'NFM') return 'FM';
    return m;
  }

  // kHz → MHz with no trailing zeros past the kHz digit: 14067.5 → 14.0675, 14074 → 14.074
  function formatFreqMhz(khz) {
    var k = Number(khz);
    if (!isFinite(k) || k <= 0) return '';
    var s = (Math.round(k * 10) / 10000).toFixed(4);
    s = s.replace(/0+$/, '');
    if (/\.\d{0,2}$/.test(s)) s = (Math.round(k * 10) / 10000).toFixed(3);
    return s;
  }

  function spotLine(o) {
    var call = String(o.call || '').toUpperCase().trim();
    var ref = String(o.ref || PARK_PLACEHOLDER).toUpperCase().trim();
    var parts = ['!' + call, 'POTA', ref, formatFreqMhz(o.freqKhz) || 'FREQ', spotMode(o.mode) || 'MODE'];
    var comment = String(o.comment || '').replace(/[\r\n]+/g, ' ').trim();
    if (comment) parts.push(comment);
    return parts.join(' ');
  }

  /**
   * The message to put in the compose form: one line per POTA park.
   * @param {{call:string, refs:string[], freqKhz:number, mode:string, comment?:string}} o
   * @returns {{to:string, subject:string, body:string, missing:string[]}}
   */
  function buildSpotMessage(o) {
    o = o || {};
    var refs = (o.refs || []).filter(Boolean);
    var missing = [];
    if (!String(o.call || '').trim()) missing.push('your callsign');
    if (!refs.length) missing.push('the park');
    if (!formatFreqMhz(o.freqKhz)) missing.push('the frequency');
    if (!spotMode(o.mode)) missing.push('the mode');
    var lines = (refs.length ? refs : [null]).map(function (ref) {
      return spotLine({ call: o.call, ref: ref, freqKhz: o.freqKhz, mode: o.mode, comment: o.comment });
    });
    return { to: SPOT_ADDRESS, subject: 'POTA spot', body: lines.join('\n'), missing: missing };
  }

  /** Is this outgoing message addressed to the spot service? */
  function isSpotAddress(to) {
    return String(to || '').split(/[,;\s]+/).some(function (a) { return a.toLowerCase() === SPOT_ADDRESS; });
  }

  /**
   * A body for the spot service → one body per spot line, or the reason it
   * cannot go. Lines that do not start with `!` are ignored by the service,
   * so they are dropped; a line still naming the PARK placeholder is refused.
   * @returns {{ok:boolean, bodies?:string[], error?:string}}
   */
  function splitSpotBody(body) {
    var lines = String(body || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return /^!/.test(l); });
    if (!lines.length) return { ok: false, error: 'A POTA spot is one line starting with ! — for example !K3SBP POTA US-0001 14.074 FT8' };
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i].split(/\s+/);
      if (f.length < 5 || f[1].toUpperCase() !== 'POTA') return { ok: false, error: 'Spot line ' + (i + 1) + ' should read !CALL POTA PARK FREQ MODE' };
      if (f[2].toUpperCase() === PARK_PLACEHOLDER) return { ok: false, error: 'Put your park reference in place of PARK' };
      if (!(Number(f[3]) > 0)) return { ok: false, error: 'Spot line ' + (i + 1) + ': the frequency is in MHz, like 14.074' };
    }
    return { ok: true, bodies: lines };
  }

  return { SPOT_ADDRESS: SPOT_ADDRESS, PARK_PLACEHOLDER: PARK_PLACEHOLDER, spotMode: spotMode, formatFreqMhz: formatFreqMhz, spotLine: spotLine, buildSpotMessage: buildSpotMessage, isSpotAddress: isSpotAddress, splitSpotBody: splitSpotBody };
});
