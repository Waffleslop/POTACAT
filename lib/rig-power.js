// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Radio power on/off asked for by a remote client (GitHub #152, Casey
// 2026-11-07). Two rules, both decided here so they can be tested:
//  1. Power Off from a remote client is refused while the shack is
//     transmitting: a radio switched off mid-over is a stuck key or a dropped
//     contact on someone else's screen. The operator AT the shack keeps the
//     button (source 'desktop').
//  2. Power On is sent, and if the shack's link to the radio is closed (no CAT
//     client, or RigController.setPowerState found the port shut) the client
//     is told the shack can't reach the radio's port. Reopening the link first
//     is not done here.
// Pure: no Electron.
'use strict';

const POWER_OFF_WHILE_TX = 'Power Off not sent — the radio is transmitting. Try again when it stops.';
const POWER_ON_NO_PORT = "Power On not sent — the shack can't reach the radio's port.";
const POWER_ON_UNSUPPORTED = 'Power On not sent — this radio can be switched off over CAT but not on. Switch it on at the radio.';

/**
 * Whether Power On can be offered (#485). caps.power says the radio can be
 * switched over CAT at all; caps.powerOn: false says off only (the FTX-1's PS
 * command has no power-on value). Absent powerOn means on and off both.
 */
function powerOnAvailable(caps) {
  return !!(caps && caps.power) && caps.powerOn !== false;
}

/** The reason to refuse a Power On before sending anything, or null. */
function powerOnRefusal(caps) {
  return caps && caps.power && caps.powerOn === false ? POWER_ON_UNSUPPORTED : null;
}

/** The reason to refuse a Power Off, or null to send it. */
function powerOffRefusal({ source, transmitting } = {}) {
  if (source === 'desktop') return null;
  return transmitting ? POWER_OFF_WHILE_TX : null;
}

/**
 * What to tell the client after a Power On, or null when it went out.
 * `sent` is setPowerState's answer: false = the port was not open; a CAT
 * client that returns nothing is taken as sent.
 */
function powerOnReport({ catPresent, sent } = {}) {
  if (!catPresent || sent === false) return POWER_ON_NO_PORT;
  return null;
}

module.exports = {
  powerOffRefusal, powerOnReport, powerOnAvailable, powerOnRefusal,
  POWER_OFF_WHILE_TX, POWER_ON_NO_PORT, POWER_ON_UNSUPPORTED,
};
