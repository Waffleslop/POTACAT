'use strict';
/**
 * JTCAT chimes: when does the PC make a sound, and which one (scottg_178
 * 2026-11-24). Pure: main.js asks, the main window plays (lib/chime-sounds.js,
 * the engine "QSO logged chime" uses). Sound only. Nothing here stops, starts
 * or changes a transmission.
 *
 * Two chimes, both off by default, both machine-wide (GLOBAL_KEYS: they are
 * about this computer's speakers):
 *
 *   jtcatChimeCall  "Chime when a station calls me"
 *     A decode addressed to my callsign from another station that is not the
 *     station I am already working. An answer to my CQ counts: at that moment
 *     the QSO has nobody in it yet. Classified the way the red My Activity row
 *     is (JtcatParser.isAddressedTo) with the transmitter main.js already put
 *     on the decode (r.call); no message is parsed here.
 *       - One chime per decode period, however many stations call.
 *       - No repeat for a caller who keeps calling: a caller is new again only
 *         after CALLER_QUIET_MS without a call from them. The station of a QSO
 *         in progress is remembered the same way, so the last 73 they send
 *         after the QSO is logged and cleared is not "a new caller".
 *       - Never for my own transmission or echo (the transmitter is me).
 *       - Never while JTCAT is transmitting. A caller missed for that reason
 *         is not remembered, so the next time they are heard it chimes.
 *
 *   jtcatChimeStop  "Chime when transmitting stops by itself"
 *     Only the reasons in AUTO_STOP_REASONS, each sent from the one place in
 *     main.js where JTCAT gives up by itself. Anything the operator did (Halt,
 *     a Hunt or Run change, a mode change, the phone) has no reason here and
 *     is silent. Several stops in the same moment (Run and Hunt both ending at
 *     the 30-minute limit) are one chime.
 *
 * A setting holds a sound id from that chime's own list; anything else (a
 * missing key, 'off', a sound from the other list) is off.
 */
const JtcatParser = require('../renderer/jtcat-parser');
const ChimeSounds = require('./chime-sounds');

const CALLER_QUIET_MS = 10 * 60 * 1000; // a caller not heard calling for this long is a new caller
const STOP_REPEAT_MS = 5000;            // stops closer together than this are one event
const STOP_DELAY_MS = 800;              // the stop chime waits for the key-up

const AUTO_STOP_REASONS = Object.freeze([
  'tx-watchdog', // "Stop calling after N minutes with no answer"
  'hunt-idle',   // Hunt: 30 minutes with no QSO progress and nothing from the operator
  'run-idle',    // Run: the same 30-minute attended limit
  'run-paused',  // Run: the band is worked out; listening until someone new calls
]);

function pick(list, setting) {
  for (const s of list) if (s.id === setting) return s.id;
  return null;
}
const callSound = (setting) => pick(ChimeSounds.CALL_SOUNDS, setting);
const stopSound = (setting) => pick(ChimeSounds.STOP_SOUNDS, setting);
const isChimeSound = (id) => !!(callSound(id) || stopSound(id));

function createState() {
  return { callers: new Map(), lastPeriod: null, lastStopAt: null };
}

/**
 * One decode event. Returns the sound to play, or null.
 * @param {object} state  createState()
 * @param {object} a
 * @param {string} a.setting   settings.jtcatChimeCall
 * @param {string} a.myCall    my on-air callsign
 * @param {Array}  a.results   the decodes: { text, call } (call = the transmitter)
 * @param {Array}  a.qsoCalls  stations of the QSOs in progress
 * @param {string} a.period    the decode period (any stable key)
 * @param {number} a.now       ms
 * @param {boolean} a.txActive JTCAT is transmitting right now
 */
function callChime(state, a) {
  const now = a.now;
  for (const [call, at] of state.callers) if (now - at > CALLER_QUIET_MS) state.callers.delete(call);
  const me = JtcatParser.normalizeCall(a.myCall);
  if (!me) return null;
  const inQso = new Set((a.qsoCalls || []).map(JtcatParser.normalizeCall).filter(Boolean));
  const fresh = [];
  for (const r of a.results || []) {
    const from = JtcatParser.normalizeCall(r && r.call);
    if (!from || from === me) continue;                           // no transmitter, or me
    if (!JtcatParser.isAddressedTo(r.text, a.myCall)) continue;   // not to me
    if (inQso.has(from) || state.callers.has(from)) { state.callers.set(from, now); continue; }
    fresh.push(from);
  }
  if (!fresh.length || a.txActive) return null;
  for (const from of fresh) state.callers.set(from, now);
  if (state.lastPeriod === a.period) return null;
  const sound = callSound(a.setting);
  if (sound) state.lastPeriod = a.period;
  return sound;
}

/**
 * JTCAT stopped transmitting. Returns the sound to play, or null.
 * @param {object} a  { setting: settings.jtcatChimeStop, reason, now }
 */
function stopChime(state, a) {
  if (!AUTO_STOP_REASONS.includes(a.reason)) return null;
  const sound = stopSound(a.setting);
  if (!sound) return null;
  if (state.lastStopAt != null && a.now - state.lastStopAt < STOP_REPEAT_MS) return null;
  state.lastStopAt = a.now;
  return sound;
}

module.exports = {
  CALLER_QUIET_MS, STOP_REPEAT_MS, STOP_DELAY_MS, AUTO_STOP_REASONS,
  createState, callChime, stopChime, callSound, stopSound, isChimeSound,
};
