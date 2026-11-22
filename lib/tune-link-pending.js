// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
'use strict';
/**
 * A potacat://tune link that LAUNCHES POTACAT used to tune after a fixed 2 s.
 * The radio is rarely connected by then (a serial port, a Flex discovery, a
 * TCI socket all take longer), so the tune went nowhere. Now the link waits:
 *
 *   - While POTACAT is starting (the radio has not yet been seen ready), a tune
 *     link is HELD. Only the latest one counts: a second link replaces the
 *     first and restarts the wait.
 *   - Ready = the radio link is up (sendCatStatus connected: CAT, Flex or TCI)
 *     AND a frequency has been read back from the radio (not POTACAT's own
 *     tune echo). Then the held link tunes, once.
 *   - After timeoutMs (60 s) without ready, the held link is dropped with a
 *     CAT log line and the notice "Could not tune: the radio did not connect".
 *   - Once the radio has been ready, links go straight through, as before,
 *     even if the link drops later.
 *   - No radio configured (no CAT, or this PC drives a remote shack): links
 *     go straight through, as before.
 *
 * Pure: main.js owns the timer and the effects (tuneLinkPending* in main.js).
 * Run its test: node test/tune-link-pending-test.js
 */

const TUNE_LINK_WAIT_MS = 60 * 1000;
const GIVE_UP_NOTICE = 'Could not tune: the radio did not connect';

/**
 * The kHz of a potacat://tune/<kHz>/<MODE> link, parsed the way
 * handleProtocolUrl parses it; NaN for anything else.
 */
function tuneLinkFreqKhz(url) {
  try {
    const parsed = new URL(url);
    const action = parsed.hostname || (parsed.pathname.match(/^\/?([^/]+)/) || [])[1] || '';
    if (action !== 'tune') return NaN;
    const segments = parsed.pathname.replace(/^\/+/, '').split('/').filter((p) => p && p.toLowerCase() !== 'tune');
    return segments[0] ? parseFloat(segments[0]) : NaN;
  } catch { return NaN; }
}

function createPendingTuneLink(opts) {
  const timeoutMs = (opts && opts.timeoutMs) || TUNE_LINK_WAIT_MS;
  let pending = null;   // { link, since }
  let linkUp = false;
  let freqSeen = false;
  let ready = false;    // the radio has been ready once this session

  function flushIfReady() {
    if (!pending || !(linkUp && freqSeen)) return null;
    ready = true;
    const link = pending.link;
    pending = null;
    return { action: 'tune', link };
  }

  return {
    /**
     * A tune link arrived.
     * @param {*} link        whatever the caller needs to tune it later
     * @param {number} now    ms
     * @param {boolean} rigConfigured  a radio is set up on this PC
     * @returns {{action:'tune', link}|{action:'hold', replaced:boolean, waitMs:number}}
     */
    offer(link, now, rigConfigured) {
      if (!rigConfigured || ready) return { action: 'tune', link };
      if (linkUp && freqSeen) { ready = true; return { action: 'tune', link }; }
      const replaced = !!pending;
      pending = { link, since: now };
      return { action: 'hold', replaced, waitMs: timeoutMs };
    },
    /** The radio link went up or down (effective status, Flex/TCI included). */
    noteLinkUp(up) {
      linkUp = !!up;
      if (!linkUp) freqSeen = false; // a fresh link must read back again
      return flushIfReady();
    },
    /** A frequency was read back from the radio (not our own tune echo). */
    noteFrequency(hz) {
      if (!(hz > 0) || !linkUp) return null;
      freqSeen = true;
      return flushIfReady();
    },
    /** The timer fired: give up on a link held for timeoutMs or more. */
    check(now) {
      if (!pending || now - pending.since < timeoutMs) return null;
      const link = pending.link;
      pending = null;
      return { action: 'give-up', link };
    },
    get pending() { return pending ? pending.link : null; },
    get ready() { return ready; },
  };
}

module.exports = { tuneLinkFreqKhz, createPendingTuneLink, TUNE_LINK_WAIT_MS, GIVE_UP_NOTICE };
