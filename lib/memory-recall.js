// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Memory recall: a Channels entry that names one of the radio's own memory
// channels puts the radio there with one command, offset and tone included,
// because the memory already holds them (GitHub #308: "select repeaters from
// the memory bank ... I'm not sure POTACAT knows to account for those
// offsets"). Pure: the command bytes and text, and the read-back verdict.
//
// Command sources (Hamlib 4.6.2; Icom's CI-V reference guides and Yaesu's
// CAT manual sit behind click-through download pages and were not read):
//   Icom CI-V   rigs/icom/icom.c  icom_set_vfo(RIG_VFO_MEM): 08, no data
//                                 icom_set_mem: 08 + the channel in big-endian
//                                   BCD, one byte below 100, two from 100
//               icom_set_vfo(RIG_VFO_VFO): 07, no data
//   rigctld     `V MEM`, `E <ch>` (set_mem), `V VFOA`: Hamlib does each radio's
//               own commands, so every radio rigctld drives is covered.
// Memory groups/banks (IC-705: 100 groups; IC-9700: memory per band) are NOT
// selected here: the channel is recalled in the radio's current group, and
// the read-back below is what catches the wrong one.

'use strict';

const MEM_MAX = 9999;

/** A channel's memory number, or null: a whole number 0..9999. */
function memNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MEM_MAX ? n : null;
}

/** Icom CI-V data bytes for `08 <channel>`: big-endian BCD, 1 byte below 100, 2 bytes from 100. */
function icomMemoryBcd(ch) {
  const n = memNumber(ch);
  if (n === null) throw new Error(`not a memory channel: ${ch}`);
  const bcd = (v) => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
  return n < 100 ? [bcd(n)] : [bcd(Math.floor(n / 100)), bcd(n % 100)];
}

/** The rigctld lines for a recall: memory mode, then the channel. One command per line. */
function rigctldRecallLines(ch) {
  const n = memNumber(ch);
  if (n === null) throw new Error(`not a memory channel: ${ch}`);
  return ['V MEM\n', `E ${n}\n`];
}
const RIGCTLD_VFO_LINE = 'V VFOA\n';

/**
 * Did the recall land where the channel says? The radio's receive frequency
 * after the recall against the channel's, within 1 kHz. `gotHz` 0/absent =
 * no read-back yet.
 * @returns {{ok:boolean|null, text:string}}
 */
const FreqDots = require('./freq-dots');

function recallVerdict({ channel, gotHz } = {}) {
  const want = Number(channel && channel.khz) * 1000;
  const name = String((channel && channel.name) || 'the channel');
  const mem = channel && channel.mem;
  if (!(want > 0)) return { ok: null, text: '' };
  if (!(Number(gotHz) > 0)) return { ok: null, text: `memory ${mem} recalled for ${name}; the radio has not reported its frequency yet` };
  const mhz = (hz) => FreqDots.hzMhz(hz); // the VFO way, 146.940.00 MHz
  if (Math.abs(Number(gotHz) - want) <= 1000) return { ok: true, text: `memory ${mem} recalled: ${name} on ${mhz(want)}` };
  return {
    ok: false,
    text: `memory ${mem} put the radio on ${mhz(Number(gotHz))}, not ${name}'s ${mhz(want)}. That memory holds something else on this radio (or it is in another memory group): fix the channel's memory number in Directory > Channels`,
  };
}

module.exports = { MEM_MAX, memNumber, icomMemoryBcd, rigctldRecallLines, RIGCTLD_VFO_LINE, recallVerdict };
