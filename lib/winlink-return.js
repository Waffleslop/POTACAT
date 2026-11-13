'use strict';
/**
 * Where a Winlink radio session leaves the radio, and when it goes back
 * (GitHub #187, decision 2026-11-07).
 *
 * After an attempt ends the radio stays where the session put it. It goes
 * back to the operator's dial and mode once: when the Winlink mail window
 * closes, when Winlink is stopped, or when POTACAT quits. Going back after
 * every attempt meant two band changes per attempt, each starting an ATU
 * tune, and NA4DQ's log shows a frame lost to such a tune.
 *
 * The return point is the dial from before the FIRST gateway pick (or the
 * dial at the first Connect). A second attempt, another gateway or a retry,
 * starts from wherever the radio is and never replaces it.
 *
 * Pure decisions only; main.js holds the state, tunes and logs.
 */

const PICK = 'before the gateway pick';
const QUIT_RETURN_MS = 1500;   // the wait before quit carries on; under the 4 s log-review flush budget
const HAND_TUNE_HZ = 100;      // a dial this far from where POTACAT left it was moved by hand

/** Did POTACAT move the radio away from the return point? */
function radioWasMoved({ tuned, returnTo } = {}) {
  if (!returnTo || !returnTo.freqHz) return false;
  return !!tuned || !!returnTo.moved || returnTo.from === PICK;
}

/**
 * A radio session ended. 'keep': the radio stays, the return point is kept
 * until the mail window closes. 'return': no mail window is open (a session
 * from an ECHOCAT device, or the window closed during the session), so go
 * back now. 'none': the radio was never moved.
 */
function atSessionEnd({ tuned, returnTo, windowOpen } = {}) {
  if (!radioWasMoved({ tuned, returnTo })) return 'none';
  return windowOpen ? 'keep' : 'return';
}

/**
 * Is the radio still where Winlink last left it (#357)? Going back is only
 * for undoing Winlink's own move: once anything else has taken the radio
 * since (SSTV tuned to 14.230 for a picture from the phone, a spot click, the
 * knob), closing the mail window must leave it alone. NA4DQ's radio was sent
 * from 14.230 back to 18.1046 MHz in the middle of SSTV.
 *   leftAtHz  where Winlink last put the dial (0 = it never recorded one)
 *   nowHz     the dial now (0 = not known: nothing says it moved)
 */
function stillWhereLeft(leftAtHz, nowHz) {
  if (!leftAtHz) return false;
  if (!nowHz) return true;
  return Math.abs(nowHz - leftAtHz) <= HAND_TUNE_HZ;
}

/**
 * The mail window closed. 'after-session': a session is running; it goes
 * back when that session ends (the window is closed by then). 'return': go
 * back now. 'moved': the radio was moved since Winlink left it, so it stays
 * and the return point is dropped. 'none': nothing to go back to.
 */
function atClose({ pending, sessionActive, sessionReturn, leftAtHz, nowHz } = {}) {
  if (sessionActive) return sessionReturn && sessionReturn.freqHz ? 'after-session' : 'none';
  if (!pending || !pending.freqHz) return 'none';
  return stillWhereLeft(leftAtHz, nowHz) ? 'return' : 'moved';
}

/**
 * Winlink stopped (Pat torn down). With the mail window still open this is a
 * relaunch for a settings change, so the return point is kept. On quit the
 * CAT link is already closed by the time Winlink stops: 'skip'. 'moved': as
 * atClose.
 */
function atStop({ pending, windowOpen, quit, leftAtHz, nowHz } = {}) {
  if (!pending || !pending.freqHz) return 'none';
  if (quit) return 'skip';
  if (windowOpen) return 'keep';
  return stillWhereLeft(leftAtHz, nowHz) ? 'return' : 'moved';
}

/**
 * POTACAT is quitting with a return pending. Go back only when it can be
 * sent now and land within QUIT_RETURN_MS, and only while the radio is still
 * where Winlink left it; otherwise say why it was skipped.
 */
function atQuit({ pending, catUp, atuBusy, leftAtHz, nowHz } = {}) {
  if (!pending || !pending.freqHz) return { act: 'none' };
  if (!stillWhereLeft(leftAtHz, nowHz)) return { act: 'skip', why: 'the radio was moved since Winlink left it' };
  if (!catUp) return { act: 'skip', why: 'the radio link is down' };
  if (atuBusy) return { act: 'skip', why: 'an ATU tune is running and quit does not wait for it' };
  return { act: 'return', waitMs: QUIT_RETURN_MS };
}

/** The dial was moved by hand since POTACAT last put it somewhere. */
function movedByHand(leftAtHz, nowHz) {
  if (!leftAtHz || !nowHz) return false;
  return Math.abs(nowHz - leftAtHz) > HAND_TUNE_HZ;
}

module.exports = { PICK, QUIT_RETURN_MS, HAND_TUNE_HZ, radioWasMoved, atSessionEnd, stillWhereLeft, atClose, atStop, atQuit, movedByHand };
