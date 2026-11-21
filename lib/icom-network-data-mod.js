// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Icom over the network (RS-BA1 audio): the radio's DATA MOD (the transmit
// audio source in data modes) is set to LAN for the session and put back at
// the end (main.js prepareIcomNetworkDataMod / restoreIcomNetworkDataMod).
// This is the table of radios and items, moved out of main.js for #853.
//
// #853: the IC-7610 has a source per data mode, DATA1/2/3 MOD (Icom IC-7610
// CI-V Reference Guide rev 4, 1A 05 table: 00 92 / 00 93 / 00 94, values 00 MIC,
// 01 ACC, 02 MIC+ACC, 03 USB, 04 MIC+USB, 05 LAN; the data byte of 1A 06 is
// 01/02/03 = DATA1/2/3). POTACAT re-selects whichever DATA number the radio
// last reported (lib/codecs/civ-codec.js _dataByte; WF4I runs FT8 on USB-D2),
// but always set DATA1 MOD, so on D2 or D3 the radio keyed with no audio.
// A spec with `perData` now names the item for each DATA number.
'use strict';

const SPECS = [
  {
    models: ['IC-7610'],
    civAddrs: [0x98],
    settingId: 0x0092,
    label: 'DATA1 MOD',
    networkLabel: 'LAN',
    networkValue: 0x05,
    values: { 0x00: 'MIC', 0x01: 'ACC', 0x02: 'MIC+ACC', 0x03: 'USB', 0x04: 'MIC+USB', 0x05: 'LAN' },
  },
  {
    models: ['IC-9700'],
    civAddrs: [0xA2],
    settingId: 0x0116,
    label: 'DATA MOD',
    networkLabel: 'LAN',
    networkValue: 0x05,
    values: { 0x00: 'MIC', 0x01: 'ACC', 0x02: 'MIC+ACC', 0x03: 'USB', 0x04: 'MIC+USB', 0x05: 'LAN' },
  },
  {
    models: ['IC-705'],
    civAddrs: [0xA4],
    settingId: 0x0119,
    label: 'DATA MOD',
    networkLabel: 'WLAN',
    networkValue: 0x03,
    values: { 0x00: 'MIC', 0x01: 'USB', 0x02: 'MIC+USB', 0x03: 'WLAN' },
  },
  {
    // IC-7760 CI-V Reference Guide: set-mode item 0130 "DATA1 MOD" (0131 =
    // DATA2, 0132 = DATA3 — each data mode has its own source; POTACAT uses
    // DATA1, which is what `1A 06 01` selects). Value 09 = LAN.
    models: ['IC-7760'],
    civAddrs: [0xB2],
    settingId: 0x0130,
    label: 'DATA1 MOD',
    networkLabel: 'LAN',
    networkValue: 0x09,
    values: { 0x00: 'MIC', 0x01: 'USB', 0x02: 'LINE-IN', 0x03: 'ACC', 0x04: 'MIC+USB', 0x05: 'MIC+LINE-IN', 0x06: 'MIC+ACC', 0x07: 'MIC+USB+ACC', 0x08: 'MIC+LINE-IN+ACC', 0x09: 'LAN' },
  },
];

// #853: the IC-7610's three data sources (CI-V Reference Guide rev 4, 1A 05).
SPECS[0].perData = Object.freeze({
  1: Object.freeze({ settingId: 0x0092, label: 'DATA1 MOD' }),
  2: Object.freeze({ settingId: 0x0093, label: 'DATA2 MOD' }),
  3: Object.freeze({ settingId: 0x0094, label: 'DATA3 MOD' }),
});

/**
 * The spec for the DATA number in use: the item and label for DATA1/2/3 when
 * the radio has one per data mode, else the spec as it is. An unknown or
 * out-of-range number is DATA1, what POTACAT selects first.
 */
function specForDataNumber(spec, dataNumber) {
  if (!spec || !spec.perData) return spec || null;
  const n = Number(dataNumber);
  const pick = spec.perData[n] || spec.perData[1];
  return Object.assign({}, spec, { settingId: pick.settingId, label: pick.label, dataNumber: spec.perData[n] ? n : 1 });
}

module.exports = { SPECS, specForDataNumber };
