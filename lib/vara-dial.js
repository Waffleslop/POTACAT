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
//    The other way a first call can end at once (#1040): VARA answers Pat's
//    CONNECT with DISCONNECTED, and Pat says "connect timeout". Only the first
//    call sends VARA its setup and CONNECT in one burst. Within QUICK_END_MS,
//    with the radio never keyed, that is no call either, and it is placed again
//    on the same schedule.
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
 * Pat's line when VARA answered its CONNECT with DISCONNECTED. Pat's VARA
 * driver has one word for that, however soon it came: "connect timeout"
 * (Pat-Vara transport.go, DialURLContext). After a minute of calling it is a
 * gateway that did not answer. Within seconds, with the radio never keyed, no
 * call was made: see QUICK_END_MS.
 * @returns {{ended:true, why:string}|null}
 */
function patVaraCallEnded(line) {
  return /\bconnect timeout\b/i.test(String(line || '')) ? { ended: true, why: 'connect timeout' } : null;
}

/**
 * How soon after the dial "VARA ended the call" still means "no call was
 * made". VARA keys the radio within about a second of a CONNECT it acts on,
 * and an unanswered call runs for most of a minute, so a call that is over in
 * 5 s with the radio never keyed never went on the air. 5 s rather than 1 s
 * because VARA under Wine and Pat's first-call setup (two TCP connections and
 * five commands) are slow; the never-keyed rule is the one that keeps a real
 * no-answer from ever being repeated, the time only narrows it further.
 */
const QUICK_END_MS = 5000;

/**
 * May this failed dial be placed again?
 *   refusal      what Pat said of this dial: VARA refused its TCP connection
 *                (patVaraPortRefusal) or ended the call (patVaraCallEnded)
 *   msSinceDial  how long after Pat was asked the dial failed
 *   redials      dials already repeated in this attempt
 *   keyed        the radio was keyed at any time in this attempt
 *   connected    Pat reported a link in this attempt
 *   live         the attempt is still the running session (not stopped, not replaced)
 * Never after anything was keyed, never after a link, never for another modem,
 * and an ended call only when it ended within QUICK_END_MS.
 */
function shouldRedial({ mode, refusal, msSinceDial, redials = 0, keyed, connected, live, waits = REDIAL_WAITS_MS } = {}) {
  if (!isVaraMode(mode)) return { redial: false, why: 'not VARA' };
  if (!refusal) return { redial: false, why: 'not a refused connection or a call VARA ended' };
  if (!live) return { redial: false, why: 'the session was stopped' };
  if (keyed) return { redial: false, why: 'the radio was keyed' };
  if (connected) return { redial: false, why: 'the link came up' };
  if (refusal.ended && !(msSinceDial >= 0 && msSinceDial <= QUICK_END_MS)) return { redial: false, why: 'the call did not end at once' };
  if (redials >= waits.length) return { redial: false, why: 'tried ' + (redials + 1) + ' times' };
  return { redial: true, waitMs: waits[redials] };
}

/**
 * Ask Pat to call; when VARA refused Pat's TCP connection, or ended the call
 * at once, before anything was keyed, wait and ask again (shouldRedial). Every
 * other failure is thrown as it came. An error thrown after such dials carries
 * varaRefused ({port, why}) or varaEnded ({ended, why}), and varaDials (how
 * many times Pat was asked).
 *
 * The first call after POTACAT starts is the only one where Pat opens VARA's
 * two ports and sends its setup (PUBLIC ON, CWID ON, COMPRESSION TEXT, MYCALL,
 * LISTEN OFF, the bandwidth, WINLINK SESSION) and CONNECT in one burst, with
 * no wait for VARA's answers, and takes the first DISCONNECTED it sees after
 * that as the end of the call. On a second dial Pat already holds VARA: only
 * the bandwidth, the session type and CONNECT are sent.
 *
 * @param {object} o
 * @param {string} o.mode
 * @param {() => Promise<any>} o.connect        one /api/connect
 * @param {() => (object|null)} o.takeRefusal   what Pat logged of the dial since the last call, cleared by reading
 * @param {() => boolean} o.live
 * @param {() => boolean} o.keyed
 * @param {() => boolean} o.connected
 * @param {(info:{refusal:object, dial:number, of:number, waitMs:number, msSinceDial:number}) => void} [o.onRedial]
 * @param {(ms:number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @returns {Promise<any>} what connect resolved with
 */
async function dialWithRedial(o) {
  const waits = o.waits || REDIAL_WAITS_MS;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const graceMs = o.graceMs == null ? REFUSAL_GRACE_MS : o.graceMs;
  const mark = (e, k, v) => { if (e && typeof e === 'object') e[k] = v; };
  for (let redials = 0; ; redials++) {
    o.takeRefusal(); // a line from before this dial is not this dial's
    const dialAt = now();
    try {
      return await o.connect();
    } catch (e) {
      if (!isVaraMode(o.mode)) throw e;
      const msSinceDial = now() - dialAt;
      let refusal = o.takeRefusal();
      // Pat's line and its HTTP reply come by different pipes: give the line a moment,
      // but only where a redial could still follow.
      if (!refusal && !o.keyed() && !o.connected() && o.live() && msSinceDial <= QUICK_END_MS) { await sleep(graceMs); refusal = o.takeRefusal(); }
      if (refusal && (o.keyed() || o.connected())) refusal = null; // a call that got on the air ended there, whatever Pat called it
      if (refusal && refusal.ended && !(msSinceDial <= QUICK_END_MS)) refusal = null; // an ended call that took its time is a call
      const d = shouldRedial({ mode: o.mode, refusal, msSinceDial, redials, keyed: o.keyed(), connected: o.connected(), live: o.live(), waits });
      if (!d.redial) {
        if (refusal) { mark(e, refusal.ended ? 'varaEnded' : 'varaRefused', refusal); mark(e, 'varaDials', redials + 1); }
        throw e;
      }
      if (o.onRedial) o.onRedial({ refusal, dial: redials + 2, of: waits.length + 1, waitMs: d.waitMs, msSinceDial });
      await sleep(d.waitMs);
      if (!o.live()) { mark(e, 'varaStopped', true); throw e; }
      // VARA went on with the call after all (the DISCONNECTED Pat saw was not
      // this call's): never a second CONNECT on top of one that is on the air.
      if (o.keyed() || o.connected()) { mark(e, 'varaWentOn', true); throw e; }
    }
  }
}

/** The log line for one dial that is placed again. */
function redialLogText({ mode, where, refusal, dial, of, waitMs, sinceCheckMs, msSinceDial }) {
  const since = Number.isFinite(sinceCheckMs) ? `, ${Math.round(sinceCheckMs)} ms after POTACAT's own check of that port` : '';
  const again = `Calling again in ${waitMs} ms (try ${dial} of ${of})`;
  if (refusal.ended) {
    return `${varaName(mode)} at ${where} ended Pat's call ${Math.round(msSinceDial) || 0} ms after it was asked for${since} (Pat: ${refusal.why}). `
      + `The radio was never keyed, so nothing was transmitted. ${again}`;
  }
  return `${varaName(mode)} at ${where} refused Pat's connection to its ${refusal.port} port${since}${refusal.why ? ' (' + refusal.why + ')' : ''}. `
    + `Nothing was sent to VARA and nothing was transmitted. ${again}`;
}

/** What the operator reads when every dial was refused. Never "the gateway did not answer": no call was made. */
function refusedText({ mode, where, refusal, dials }) {
  const name = varaName(mode);
  return `${name} at ${where} refused the connection to its ${refusal.port} port ${dials} time${dials === 1 ? '' : 's'}, so no call was made and nothing was transmitted. `
    + `Check that no other program is connected to ${name}, or close ${name} and open it again, then try again`;
}

/** What the operator reads when VARA ended every call at once with the radio never keyed. */
function endedText({ mode, where, dials }) {
  const name = varaName(mode);
  return `${name} at ${where} ended the call at once ${dials} time${dials === 1 ? '' : 's'}, before the radio was keyed, so nothing was transmitted. `
    + `Close ${name} and open it again, check its sound card and that its PTT is set to VOX, then try again`;
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
  QUICK_END_MS,
  patVaraCallEnded,
  shouldRedial,
  dialWithRedial,
  redialLogText,
  refusedText,
  endedText,
  fastFailText,
  cableRoute,
  cableRouteText,
};
