'use strict';
/**
 * The station gear a device sends with a contact (#975): ECHOCAT's log-qso
 * carries the activation's radio (`myRig`) and antenna (`myAntenna`), which
 * the log writes as ADIF MY_RIG and MY_ANTENNA.
 *
 * gearText: a non-empty string, trimmed, control characters folded to one
 * space, at most GEAR_MAX_CHARS characters. Anything else is '' (not sent),
 * so the contact gets what it got before: the desktop's own station rig for
 * MY_RIG (logContact), no MY_ANTENNA.
 */
const GEAR_MAX_CHARS = 64;

function gearText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GEAR_MAX_CHARS).trim();
}

module.exports = { gearText, GEAR_MAX_CHARS };
