// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
'use strict';
/**
 * A potacat://tune link moves the radio. A web page (potacat.com, a Cloud
 * on-air page) can carry one, so the operator may click it while JTCAT is
 * transmitting on its own: Run, Hunt, the WSPR beacon, a Spot Target waiting
 * to call, a QSO in progress, TX left enabled, or the tune carrier. Without a
 * stop, all of that carries on, unattended, on the new frequency.
 *
 * This module decides what a link stops and what the operator is told. main.js
 * (tuneLinkStopAutoTx, called by handleProtocolUrl before tuneRadio) runs the
 * stop through the existing paths: jtcatHaltTxNow (the Halt TX button) and
 * clearSpotTarget. Receive is not touched: a data-mode link keeps decoding, a
 * voice or CW link already stops the engine inside tuneRadio.
 *
 * Only protocol links come here. Spot clicks and every other tune keep their
 * behaviour (a spot click ARMS a Spot Target; it must not clear it).
 *
 * A link also never starts the automatic band-change ATU tune, which keys a
 * carrier (tuneLinkAutoAtu; main.js bandChangeAtuTune asks it).
 *
 * Pure. Run its test: node test/tune-link-guard-test.js
 */

/**
 * @param {object} [s] what is running now:
 *   { run, hunt, wsprBeacon, spotTarget, qso, tx, tune } (booleans)
 *   run        Run / full auto CQ (ULTRACAT), Hunt's Run fallback included
 *   hunt       a Hunt mode (POTA / SOTA / all CQ)
 *   wsprBeacon the WSPR beacon armed or its timer pending
 *   spotTarget a Spot Target armed (it auto-calls the activator)
 *   qso        a JTCAT QSO in progress (JTCAT window or ECHOCAT)
 *   tx         an engine transmitting, or TX enabled with a message queued
 *   tune       the JTCAT tune carrier
 * @returns {{ halt: boolean, clearSpotTarget: boolean, stopped: string[] }}
 *   halt: run jtcatHaltTxNow; stopped: names for the notice, in a fixed order.
 */
function tuneLinkPlan(s) {
  const x = s || {};
  const stopped = [];
  if (x.run) stopped.push('Run');
  if (x.hunt) stopped.push('Hunt');
  if (x.wsprBeacon) stopped.push('the WSPR beacon');
  if (x.spotTarget) stopped.push('the Spot Target call');
  if (x.qso) stopped.push('the QSO in progress');
  // Plain TX (a CQ or reply left enabled) only needs naming when nothing above
  // explains it.
  if (x.tx && !x.run && !x.hunt && !x.wsprBeacon && !x.qso) stopped.push('TX');
  if (x.tune) stopped.push('the tune carrier');
  const halt = !!(x.run || x.hunt || x.wsprBeacon || x.qso || x.tx || x.tune);
  return { halt, clearSpotTarget: !!x.spotTarget, stopped };
}

/** kHz to an MHz string with at least three decimals: 14074 -> "14.074". */
function formatLinkMhz(freqKhz) {
  const mhz = Number(freqKhz) / 1000;
  let t = mhz.toFixed(6).replace(/0+$/, '');
  const dot = t.indexOf('.');
  while (t.length - dot - 1 < 3) t += '0';
  return t;
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * The notice for the main window and the JTCAT window; '' when nothing stopped.
 * opts.atuSkipped: the link skipped the band-change ATU tune (tuneLinkAutoAtu);
 * one clause is added to a notice that is shown anyway. It never raises a
 * notice of its own: the CAT log line (tuneLinkAtuLogLine) covers that case.
 */
function tuneLinkNotice(freqKhz, plan, opts) {
  const names = (plan && plan.stopped) || [];
  if (!names.length) return '';
  const list = joinNames(names);
  const subject = list.charAt(0).toUpperCase() + list.slice(1);
  return `A tune link moved your radio to ${formatLinkMhz(freqKhz)} MHz. `
    + `${subject} ${names.length === 1 ? 'was' : 'were'} stopped so nothing transmits on the new frequency.`
    + (opts && opts.atuSkipped ? ' The automatic ATU tune was skipped; press Tune if you need it.' : '');
}

/**
 * "Auto-tune ATU on band change" (settings.enableAtu) keys a carrier for the
 * tuner. A tune link comes from a web page, so it never starts that tune: a
 * click on a page must never key the transmitter. Spot clicks and every other
 * origin keep the tune exactly as before.
 *
 * @param {{origin?: string, action?: 'tune'|'skip'|'none'}} [o]
 *   origin: tuneRadio's origin ('link' for a potacat://tune link)
 *   action: what lib/wspr/bandhop.js bandChangeAtu decided for this tune
 * @returns {{start: boolean, linkSkipped: boolean}}
 *   start: run the radio's ATU tune; linkSkipped: a due tune was skipped
 *   because a link asked for this frequency (log it, tell the notice).
 */
function tuneLinkAutoAtu(o) {
  const x = o || {};
  if (x.action !== 'tune') return { start: false, linkSkipped: false };
  if (x.origin === 'link') return { start: false, linkSkipped: true };
  return { start: true, linkSkipped: false };
}

/** The CAT log line when a link skipped the band-change ATU tune. */
function tuneLinkAtuLogLine(band) {
  return `[ATU] Tune link${band ? ' to ' + band : ''}: the automatic ATU tune was skipped; press Tune if you need it`;
}

/** The CAT log line; '' when nothing stopped (the usual tune log is enough). */
function tuneLinkLogLine(freqKhz, mode, plan) {
  const names = (plan && plan.stopped) || [];
  if (!names.length) return '';
  const m = mode ? ' ' + String(mode).toUpperCase() : '';
  return `[tune-link] potacat://tune to ${formatLinkMhz(freqKhz)} MHz${m}: stopping ${names.join(', ')} before tuning so nothing transmits on the new frequency`;
}

module.exports = { tuneLinkPlan, tuneLinkNotice, tuneLinkLogLine, tuneLinkAutoAtu, tuneLinkAtuLogLine, formatLinkMhz };
