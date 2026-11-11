'use strict';
// Where a Winlink radio session may go. Casey 2026-11-11: "a user should
// never be able to attempt to send winlink via a freq they can't reach".
// K3SBP's FLEX-8600 was offered packet gateway W9OU-10 on 149.09 MHz (in no
// amateur band, so the band filter kept it "never dropped on a guess"); the
// pick sent listening to an HF-only WebSDR, Dire Wolf keyed three times and
// every key-down was refused. A gateway is offered, picked and called only
// when it is on an amateur band this radio is set up for and inside its range.
const { freqToBand } = require('./bands');
const ListenSource = require('./listen-source');

/**
 * Can this radio call a gateway on khz?
 * @param {number} khz          the gateway's dial (or centre) frequency, kHz
 * @param {object} o
 * @param {string[]|null} o.bands  the bands the radio is set up for (null = not known)
 * @param {Array|null} o.reach     the radio's frequency ranges in Hz (null = not known)
 * @param {string} o.rigName
 * @returns {{ok: true, band: string} | {ok: false, why: string}}
 */
function gatewayReach(khz, { bands = null, reach = null, rigName = 'the radio' } = {}) {
  const k = Number(khz);
  if (!(k > 0)) return { ok: false, why: 'This gateway has no frequency to call it on' };
  const hz = Math.round(k * 1000);
  const f = ListenSource.fmtMhz(hz);
  const band = freqToBand(k / 1000);
  if (!band) return { ok: false, why: `${f} is not in an amateur band, so POTACAT will not transmit there` };
  if (Array.isArray(bands) && bands.length && !bands.some((b) => String(b).toLowerCase() === band.toLowerCase())) {
    return { ok: false, why: `${f} is on ${band}, a band ${rigName} is not set up for (Settings > My Rigs > Bands)` };
  }
  if (Array.isArray(reach) && reach.length && !ListenSource.covers(reach, hz)) {
    return { ok: false, why: `${rigName} cannot transmit on ${f}` };
  }
  return { ok: true, band };
}

/** The gateways this radio can call; the rest are counted, never shown. */
function gatewaysInReach(list, opts = {}) {
  const rows = Array.isArray(list) ? list : [];
  const kept = rows.filter((g) => gatewayReach(g && (g.dialKhz || g.freqKhz), opts).ok);
  return { list: kept, dropped: rows.length - kept.length };
}

/**
 * The reason a refused key-down gives, from the log line that refused it
 * ("[CAT 12:00:00.000] [PTT] refused — 149.09 MHz is on the SDR; ...").
 */
function pttRefusalText(line) {
  const s = String(line || '')
    .replace(/^\[CAT [^\]]*\]\s*/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^(?:PTT|CAT transmit)?\s*(?:refused|blocked)\s*[—-]\s*/i, '')
    .trim();
  return s || 'the [PTT] line in the log says why';
}

module.exports = { gatewayReach, gatewaysInReach, pttRefusalText };
