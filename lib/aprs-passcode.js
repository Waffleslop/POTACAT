// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The APRS-IS passcode for a callsign (APRS phase 4).
//
// APRS-IS accepts packets only from a client that logs in with the passcode
// computed from its callsign (aprs-is.net/Connecting.aspx: "Only verified
// (valid passcode) clients may send data to APRS-IS"). APRS software computes
// it for its user. POTACAT computes it only for the callsign in Settings,
// sends it only inside the login line, and never shows or logs it.
//
// Written from the published description of the algorithm in words (gkbrk.com
// journal, 2023-05-08, "Passcodes for the APRS Internet System"), not from any
// program's source:
//   - take the callsign without its SSID, in capitals;
//   - start from the value 0x73E2;
//   - walk the characters two at a time: XOR the first one's code, moved up
//     8 bits, into the value, then XOR the second one's code;
//   - keep the low 15 bits.
// The published pairs it is tested against are listed in
// test/aprs-passcode-test.js.

'use strict';

/** The callsign the passcode is computed from: no SSID, capitals. */
function passcodeBase(callsign) {
  return String(callsign || '').trim().toUpperCase().split('-')[0].trim();
}

/** The passcode, 0..32767, or -1 (the read-only login) with no callsign. */
function aprsPasscode(callsign) {
  const base = passcodeBase(callsign);
  if (!base) return -1;
  let v = 0x73e2;
  for (let i = 0; i < base.length; i += 2) {
    v ^= base.charCodeAt(i) << 8;
    if (i + 1 < base.length) v ^= base.charCodeAt(i + 1);
  }
  return v & 0x7fff;
}

module.exports = { aprsPasscode, passcodeBase };
