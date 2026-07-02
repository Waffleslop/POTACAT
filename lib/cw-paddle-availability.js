'use strict';

// Decide whether a remote CW paddle / straight-key press will actually key CW
// on the current rig, or would only dead-key the PTT line (transmitter on, but
// ZERO CW output and no rig sidetone). Pure so it can be evaluated proactively
// at rig-connect — so the ECHOCAT phone learns the truth from auth-ok BEFORE its
// first key-down — and reused as the per-press keying guard.
//
// Returns { available, reason }. The reason strings are the contract with the
// phone's toast mapping:
//   'txrx-ptt-only'            Yaesu/Kenwood serial: paddle route is bare PTT
//                              (TX1;/TX0; or TX;/RX;) — no RF CW, no sidetone.
//   'rigctld-no-per-element-cw' hamlib has no per-element CW key; T 1/T 0 is PTT.
//
// A dedicated CW Key Port (external USB-serial DTR, or a QMX second port) keys
// CW for real regardless of the rig's own protocol, so it always wins. Icom
// 'txrx' is a REAL CI-V key line (0x1C 0x01), so only Kenwood-protocol rigs
// (every Yaesu + Kenwood serial model, protocol: 'kenwood') dead-key on 'txrx'.
// DTR routes stay optimistic here — a Linux cdc_acm 'pin-unsupported' failure is
// caught lazily on first key and drops availability then.

/**
 * @param {object} o
 * @param {string} [o.transportType] - settings.catTarget.type (e.g. 'rigctld')
 * @param {string} [o.paddleKey]     - rig model cw.paddleKey ('txrx'|'dtr'|'ta'|false)
 * @param {string} [o.protocol]      - rig model protocol ('kenwood'|'civ'|'smartsdr'|…)
 * @param {boolean} [o.hasKeyPort]   - a dedicated CW Key Port is configured
 * @returns {{ available: boolean, reason: string|null }}
 */
function cwPaddleAvailability({ transportType, paddleKey, protocol, hasKeyPort } = {}) {
  if (hasKeyPort) return { available: true, reason: null };
  if (transportType === 'rigctld') {
    return { available: false, reason: 'rigctld-no-per-element-cw' };
  }
  const method = paddleKey || 'txrx';
  if (method === 'txrx' && protocol === 'kenwood') {
    return { available: false, reason: 'txrx-ptt-only' };
  }
  return { available: true, reason: null };
}

module.exports = { cwPaddleAvailability };
