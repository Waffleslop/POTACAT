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
//  3. Power Off is offered only where POTACAT knows it can switch the radio
//     back on, unless the operator allows it for this rig (GitHub #293). Most
//     radios carry their CAT port on their own USB: switched off, the port is
//     gone and Power On can never reach them (IC-7100 over USB, the FT-710 and
//     FTDX10). Unknown counts as "cannot".
// Pure: no Electron.
'use strict';

const POWER_OFF_WHILE_TX = 'Power Off not sent — the radio is transmitting. Try again when it stops.';
const POWER_ON_NO_PORT = "Power On not sent — the shack can't reach the radio's port.";
const POWER_ON_UNSUPPORTED = 'Power On not sent — this radio can be switched off over CAT but not on. Switch it on at the radio.';
const POWER_OFF_NO_WAKE = 'Power Off not sent — POTACAT may not be able to switch this radio back on. '
  + "To allow it, tick 'Allow Power Off for a radio POTACAT cannot turn back on' in this rig's settings at the shack.";

// The links that stay up while the radio is off, so a Power On still reaches
// it. Only the SCU-LAN10: its Power button "automatically powers ON" the
// FTDX101, FTDX10 and FT-710 (SCU-LAN10 Operation Manual rev 2311-D, p. 17).
// Not the Icom network link: the radio wakes over the LAN only with "Power OFF
// Setting (for Remote Control)" at Standby, and the factory setting is
// Shutdown only (IC-7610 Basic Manual rev 10, p. 60). Not a serial or USB
// port: an Icom documents CI-V power-on (18 01 after a run of FE, IC-7100 Full
// Manual rev 5 p. 363, IC-7300 Full Manual rev 12b p. 163), but over the
// radio's own USB the port is gone once it is off (IC-7100 field report), and
// POTACAT cannot tell that port from a CI-V jack cable.
const WAKE_LINKS = new Set(['yaesu-lan']);

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

/**
 * Whether POTACAT knows it can switch this radio back on after a Power Off
 * (#293): the model has a CAT power-on, and the link to it stays up while the
 * radio is off. `linkType` is the rig's catTarget.type.
 */
function canWakeAfterOff(caps, linkType) {
  if (!caps || !caps.power || caps.powerOn === false) return false;
  return WAKE_LINKS.has(String(linkType || ''));
}

/**
 * Whether Power Off can be offered (#293): the radio switches off over CAT,
 * and either POTACAT can switch it back on or the operator allowed it for
 * this rig (`allowOffNoWake`, the rig's allowPowerOffNoWake).
 */
function powerOffAvailable(caps, { linkType, allowOffNoWake } = {}) {
  if (!caps || !caps.power) return false;
  return allowOffNoWake === true || canWakeAfterOff(caps, linkType);
}

/**
 * The reason to refuse a Power Off, or null to send it. `offAllowed` is
 * caps.powerOff: false refuses every source, the shack's own window too
 * (#293); absent (an older caller) leaves only the transmit rule.
 */
function powerOffRefusal({ source, transmitting, offAllowed } = {}) {
  if (offAllowed === false) return POWER_OFF_NO_WAKE;
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
  canWakeAfterOff, powerOffAvailable,
  POWER_OFF_WHILE_TX, POWER_ON_NO_PORT, POWER_ON_UNSUPPORTED, POWER_OFF_NO_WAKE,
};
