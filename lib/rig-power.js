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
//  3. Power Off is offered where POTACAT can switch the radio back on, unless
//     the operator chose otherwise for this rig (GitHub #293, #768). POTACAT
//     sends a Power On over a direct serial port (PS1; from the Kenwood-style
//     codec, CI-V 18 01 from the Icom codec) and through a Yaesu SCU-LAN10,
//     so those start with Power Off shown. Hamlib / rigctld starts with it
//     hidden (Casey, 2026-11-19). Every other link is not classified: hidden
//     until the operator ticks the box, as in 1.14.6.
// Pure: no Electron.
'use strict';

const POWER_OFF_WHILE_TX = 'Power Off not sent — the radio is transmitting. Try again when it stops.';
const POWER_ON_NO_PORT = "Power On not sent — the shack can't reach the radio's port.";
const POWER_ON_UNSUPPORTED = 'Power On not sent — this radio can be switched off over CAT but not on. Switch it on at the radio.';
const POWER_OFF_BOX_LABEL = 'Show Power Off for this radio';
const POWER_OFF_NO_WAKE = 'Power Off not sent — Power Off is switched off for this radio. '
  + "To allow it, tick '" + POWER_OFF_BOX_LABEL + "' in this rig's settings at the shack.";

// Links (catTarget.type) where POTACAT sends a Power On that can reach a radio
// that is off, so Power Off is shown by default:
//  - 'serial': the built-in serial codecs. The Kenwood-style codec (Yaesu,
//    Kenwood, Elecraft) sends PS1; twice, 500 ms apart (kenwood-codec.js
//    setPowerState). A model with no power-on says so in its caps (power
//    false, or powerOn false for the FTX-1) and is never counted here.
//  - 'icom': CI-V on a serial port. The codec sends a run of FE and then
//    18 01 (civ-codec.js setPowerState; IC-7100 Full Manual rev 5 p. 363,
//    IC-7300 Full Manual rev 12b p. 163).
//  - 'yaesu-lan': the SCU-LAN10, whose Power button "automatically powers ON"
//    the FTDX101, FTDX10 and FT-710 (Operation Manual rev 2311-D, p. 17).
// A radio whose own USB port goes away when it is off cannot hear that
// command (IC-7100 field report, #293); its operator unticks the box.
const WAKE_LINKS = new Set(['serial', 'icom', 'yaesu-lan']);
// Links where POTACAT cannot switch the radio back on: Hamlib, both the
// rigctld POTACAT starts ("Other Rig (Hamlib)") and one on the network.
const NO_WAKE_LINKS = new Set(['rigctld', 'rigctldnet']);
// Everything else (tcp, k4-network, civ-tcp, icom-network, tci, flrig,
// dxlab-commander, none) is 'unknown': not classified, hidden by default. The
// Icom network link wakes only with "Power OFF Setting (for Remote Control)"
// at Standby, and the factory setting is Shutdown only (IC-7610 Basic Manual
// rev 10, p. 60).

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
 * Whether POTACAT can switch this radio back on after a Power Off, by the
 * link to it (`linkType` is the rig's catTarget.type):
 *   'yes'     the model has a CAT power-on and POTACAT sends it over this link
 *   'no'      it cannot: Hamlib, or a model with no CAT power-on
 *   'unknown' a link that is not classified
 */
function wakeAfterOff(caps, linkType) {
  if (!caps || !caps.power || caps.powerOn === false) return 'no';
  const link = String(linkType || '');
  if (WAKE_LINKS.has(link)) return 'yes';
  if (NO_WAKE_LINKS.has(link)) return 'no';
  return 'unknown';
}

/** True only for 'yes': unknown counts as cannot. */
function canWakeAfterOff(caps, linkType) {
  return wakeAfterOff(caps, linkType) === 'yes';
}

/**
 * Whether Power Off can be offered (#293, #768): the radio switches off over
 * CAT, and the operator's choice for this rig says so. `allowOffNoWake` is
 * the rig's stored allowPowerOffNoWake: true = show, false = hide, anything
 * else = no choice stored, so the default applies: shown where POTACAT can
 * switch the radio back on.
 */
function powerOffAvailable(caps, { linkType, allowOffNoWake } = {}) {
  if (!caps || !caps.power) return false;
  if (allowOffNoWake === true) return true;
  if (allowOffNoWake === false) return false;
  return canWakeAfterOff(caps, linkType);
}

const NOTE_NEEDS_BUTTON = " You will need the radio's own power button.";
const WAKE_NOTES = {
  serial: 'POTACAT can turn this radio back on over its serial connection.',
  icom: 'POTACAT can turn this radio back on over its CI-V serial connection.',
  'yaesu-lan': 'POTACAT can turn this radio back on through the SCU-LAN10.',
};
const NOTE_HAMLIB = 'POTACAT cannot turn this radio back on through Hamlib.' + NOTE_NEEDS_BUTTON;
const NOTE_OFF_ONLY = 'This radio can be turned off from POTACAT but not back on.' + NOTE_NEEDS_BUTTON;
const NOTE_NO_POWER = 'POTACAT has no power command for this radio on this connection, so there is no Power Off button to show.';
const NOTE_UNKNOWN = 'POTACAT does not know if it can turn this radio back on over this connection. '
  + "Tick the box only if someone can reach the radio's power button.";

/**
 * The rig editor's box (#768): whether it starts ticked for a rig with no
 * stored choice, whether it applies at all, and the line under it that says
 * when POTACAT can turn the radio back on. `caps` absent (no model picked)
 * is taken as a radio with CAT power on and off, as the generic rigs are.
 */
function powerOffEditorInfo({ caps, linkType } = {}) {
  const c = caps || { power: true };
  const link = String(linkType || '');
  if (!c.power) return { applies: false, wake: 'no', defaultOn: false, note: NOTE_NO_POWER };
  const wake = wakeAfterOff(c, link);
  let note = NOTE_UNKNOWN;
  if (wake === 'yes') note = WAKE_NOTES[link];
  else if (c.powerOn === false) note = NOTE_OFF_ONLY;
  else if (wake === 'no') note = NOTE_HAMLIB;
  return { applies: true, wake, defaultOn: wake === 'yes', note };
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
  canWakeAfterOff, wakeAfterOff, powerOffAvailable, powerOffEditorInfo,
  WAKE_LINKS, NO_WAKE_LINKS, POWER_OFF_BOX_LABEL,
  POWER_OFF_WHILE_TX, POWER_ON_NO_PORT, POWER_ON_UNSUPPORTED, POWER_OFF_NO_WAKE,
};
