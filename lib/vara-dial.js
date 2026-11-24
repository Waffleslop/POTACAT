// Pat's first call through the operator's VARA, and what counts as a virtual
// cable. Pure: main.js supplies Pat, the clock and the log. Tests:
// test/vara-dial-test.js.
//
// 1. The refused dial. VARA serves one command client at a time and is not
//    listening again for a moment after a client leaves. POTACAT's own checks
//    before a session (the VERSION probe, then waitForPortAccept) are such
//    clients, so the first call after POTACAT starts could reach VARA while it
//    was not listening: Pat logged "couldn't connect to VARA command port ...
//    connection refused", and the operator read "<gateway> did not answer" at
//    once, with nothing sent. Once any session had connected, Pat kept VARA's
//    port for as long as Pat ran, so it only happened again after a restart.
//    A wait before the dial cannot close this by itself: every check leaves the
//    port the same way. So the dial is what is repeated: Pat never reached
//    VARA, nothing was asked of it and nothing was keyed, and the operator
//    asked for this call.
//
// 2. The cable that is not one. "Audio between VARA and the radio" names two
//    VIRTUAL cables. A box set to the radio's own sound card is not a cable:
//    POTACAT would play the radio's receive audio back into the radio's own
//    transmit audio input for the whole session, and send the receive audio
//    out again as if it were VARA's.

'use strict';

/** Waits before each further dial after VARA refused Pat's connection. Three more tries, 3.5 s in all. */
const REDIAL_WAITS_MS = Object.freeze([500, 1000, 2000]);
/** How long Pat's own line may trail its HTTP reply. */
const REFUSAL_GRACE_MS = 300;

function isVaraMode(mode) { return mode === 'vara' || mode === 'varafm'; }
function varaName(mode) { return mode === 'varafm' ? 'VARA FM' : 'VARA HF'; }

/**
 * Pat's line when it could not open one of VARA's two TCP ports
 * ("vara initialization failed: couldn't connect to VARA command port: dial
 * tcp 127.0.0.1:8300: connect: connection refused"). Pat connects the command
 * port, then the data port (command + 1); either can refuse.
 * @returns {{port:'command'|'data', why:string}|null}
 */
function patVaraPortRefusal(line) {
  const s = String(line || '');
  const m = /couldn'?t connect to VARA (command|data) port/i.exec(s);
  if (!m) return null;
  const tail = s.slice(m.index + m[0].length).replace(/^[:\s]+/, '').replace(/[\r\n]+/g, ' ').trim();
  return { port: m[1].toLowerCase(), why: tail.slice(0, 120) };
}

/**
 * Pat's refusal line can reach POTACAT twice, by Pat's own output and by its
 * log file, in either order and some time apart. Counted per source, so the
 * second copy of one line is never taken for a second refusal.
 */
class RefusalNotes {
  constructor() { this.reset(); }
  reset() { this._n = {}; this._taken = 0; this._last = null; }
  note(source, refusal) {
    if (!refusal) return;
    const k = String(source || 'pat');
    this._n[k] = (this._n[k] || 0) + 1;
    this._last = refusal;
  }
  /** The refusal noted since the last take, or null. */
  take() {
    let seen = 0;
    for (const k of Object.keys(this._n)) if (this._n[k] > seen) seen = this._n[k];
    if (seen <= this._taken) return null;
    this._taken = seen;
    return this._last;
  }
}

/**
 * May this failed dial be placed again?
 *   refusal    Pat said VARA refused its TCP connection (patVaraPortRefusal), this dial
 *   redials    dials already repeated in this attempt
 *   keyed      the radio was keyed at any time in this attempt
 *   connected  Pat reported a link in this attempt
 *   live       the attempt is still the running session (not stopped, not replaced)
 * Never after anything was keyed, never after a link, never for another modem.
 */
function shouldRedial({ mode, refusal, redials = 0, keyed, connected, live, waits = REDIAL_WAITS_MS } = {}) {
  if (!isVaraMode(mode)) return { redial: false, why: 'not VARA' };
  if (!refusal) return { redial: false, why: 'not a refused connection' };
  if (!live) return { redial: false, why: 'the session was stopped' };
  if (keyed) return { redial: false, why: 'the radio was keyed' };
  if (connected) return { redial: false, why: 'the link came up' };
  if (redials >= waits.length) return { redial: false, why: 'tried ' + (redials + 1) + ' times' };
  return { redial: true, waitMs: waits[redials] };
}

/**
 * Ask Pat to call; when VARA refused Pat's TCP connection before anything was
 * sent, wait and ask again (shouldRedial). Every other failure is thrown as it
 * came. An error thrown after refusals carries `varaRefused` ({port, why}) and
 * `varaDials` (how many times Pat was asked).
 *
 * @param {object} o
 * @param {string} o.mode
 * @param {() => Promise<any>} o.connect        one /api/connect
 * @param {() => ({port:string, why:string}|null)} o.takeRefusal  the refusal Pat logged since the last call, cleared by reading
 * @param {() => boolean} o.live
 * @param {() => boolean} o.keyed
 * @param {() => boolean} o.connected
 * @param {(info:{refusal:object, dial:number, of:number, waitMs:number}) => void} [o.onRedial]
 * @param {(ms:number) => Promise<void>} [o.sleep]
 * @returns {Promise<any>} what connect resolved with; `dials` is on the error only
 */
async function dialWithRedial(o) {
  const waits = o.waits || REDIAL_WAITS_MS;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = o.graceMs == null ? REFUSAL_GRACE_MS : o.graceMs;
  let last = null;
  for (let redials = 0; ; redials++) {
    o.takeRefusal(); // a line from before this dial is not this dial's
    try {
      return await o.connect();
    } catch (e) {
      if (!isVaraMode(o.mode)) throw e;
      let refusal = o.takeRefusal();
      // Pat's line and its HTTP reply come by different pipes: give the line a moment,
      // but only where a redial could still follow.
      if (!refusal && !o.keyed() && !o.connected() && o.live()) { await sleep(graceMs); refusal = o.takeRefusal(); }
      if (refusal && (o.keyed() || o.connected())) refusal = null; // a call that got further did not end on a refused port
      if (refusal) last = refusal;
      const d = shouldRedial({ mode: o.mode, refusal, redials, keyed: o.keyed(), connected: o.connected(), live: o.live(), waits });
      if (!d.redial) {
        if (e && typeof e === 'object' && refusal) { e.varaRefused = refusal; e.varaDials = redials + 1; }
        else if (e && typeof e === 'object' && last) { e.varaDials = redials + 1; }
        throw e;
      }
      if (o.onRedial) o.onRedial({ refusal, dial: redials + 2, of: waits.length + 1, waitMs: d.waitMs });
      await sleep(d.waitMs);
      if (!o.live()) { if (e && typeof e === 'object') e.varaStopped = true; throw e; }
    }
  }
}

/** The log line for one refused dial that is placed again. */
function redialLogText({ mode, where, refusal, dial, of, waitMs, sinceCheckMs }) {
  const since = Number.isFinite(sinceCheckMs) ? `, ${Math.round(sinceCheckMs)} ms after POTACAT's own check of that port` : '';
  return `${varaName(mode)} at ${where} refused Pat's connection to its ${refusal.port} port${since}${refusal.why ? ' (' + refusal.why + ')' : ''}. `
    + `Nothing was sent to VARA and nothing was transmitted. Calling again in ${waitMs} ms (try ${dial} of ${of})`;
}

/** What the operator reads when every dial was refused. Never "the gateway did not answer": no call was made. */
function refusedText({ mode, where, refusal, dials }) {
  const name = varaName(mode);
  return `${name} at ${where} refused the connection to its ${refusal.port} port ${dials} time${dials === 1 ? '' : 's'}, so no call was made and nothing was transmitted. `
    + `Check that no other program is connected to ${name}, or close ${name} and open it again, then try again`;
}

/**
 * One line when a VARA call ends almost at once with nothing keyed: it names
 * what a bug report needs to tell a refused port from a VARA that ended the
 * call itself.
 */
const FAST_FAIL_MS = 5000;
function fastFailText({ mode, where, msSinceDial, msSinceCheck, keyed, connected, patLine, route }) {
  if (!isVaraMode(mode) || keyed || connected) return '';
  if (!(msSinceDial >= 0) || msSinceDial > FAST_FAIL_MS) return '';
  const check = Number.isFinite(msSinceCheck) ? `, ${Math.round(msSinceCheck)} ms after POTACAT's check of the port` : '';
  const said = String(patLine || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return `${varaName(mode)} at ${where}: the call ended ${Math.round(msSinceDial)} ms after Pat was asked to place it${check}, and the radio was never keyed`
    + ` (audio: ${route || 'not known'}). Pat's reason: ${said || 'none logged'}`;
}

/**
 * Are the two "Audio between VARA and the radio" boxes a pair of virtual
 * cables POTACAT should carry?
 *   cable   { inputId, outputId }  the two boxes (From VARA, To VARA)
 *   radio   { inputId, outputId }  the radio's own sound card as POTACAT opens it
 *   ipAudio the radio's audio is Flex Direct / Icom Network (it has no sound card here)
 * Returns { use, half, loop: [] }: `use` only when both boxes are set and
 * neither is the radio's own device; `loop` names the boxes that are.
 */
function cableRoute({ cable, radio, ipAudio } = {}) {
  const c = cable || {}, r = radio || {};
  const inId = String(c.inputId || ''), outId = String(c.outputId || '');
  const both = !!(inId && outId);
  const loop = [];
  if (!ipAudio) {
    if (inId && inId === String(r.inputId || '')) loop.push('From VARA');
    if (outId && outId === String(r.outputId || '')) loop.push('To VARA');
  }
  return { use: both && loop.length === 0, half: !both && !!(inId || outId), loop };
}

/** Said once per session when a box is set and the cable is not used. */
function cableRouteText(route) {
  if (!route || route.use) return '';
  if (route.loop.length) {
    return `vara: ${route.loop.join(' and ')} in Settings > Station > Winlink ${route.loop.length > 1 ? 'are' : 'is'} set to this radio's own sound card, which is not a virtual cable. `
      + 'POTACAT does not carry audio through it: VARA opens the radio\'s sound card itself. Set both boxes to None, or to two virtual cables';
  }
  if (route.half) {
    return 'vara: only one of From VARA and To VARA is set in Settings > Station > Winlink, so no virtual cable is used: VARA opens the radio\'s sound card itself. '
      + 'Set both boxes to None, or to two virtual cables';
  }
  return '';
}

module.exports = {
  REDIAL_WAITS_MS,
  REFUSAL_GRACE_MS,
  FAST_FAIL_MS,
  isVaraMode,
  RefusalNotes,
  patVaraPortRefusal,
  shouldRedial,
  dialWithRedial,
  redialLogText,
  refusedText,
  fastFailText,
  cableRoute,
  cableRouteText,
};
