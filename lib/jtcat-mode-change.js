'use strict';
/**
 * An OPERATOR mode change inside the FT family (FT8 / FT4 / FT2 / WSPR), #517.
 *
 * Casey's rule: when the operator changes JTCAT mode, (1) stop transmission,
 * including anything queued or armed (Run, Hunt, the WSPR beacon, a QSO in
 * progress), (2) clear the decode history, (3) clear the calling messages.
 * A family switch (to PSK31, JS8, JTTY) already does all three, because it goes
 * through startJtcat -> stopJtcat.
 *
 * This is for the operator only. An automatic mode hop (jtcatHopMode) calls the
 * engine's setMode directly and must keep Run going (docs/JTCAT.md, Mode hop).
 * Never move the halt into the engine's setMode.
 *
 * The Spot Target is not touched: a spot click on an FT4 spot sets the target
 * and then changes the mode, and the halt must not wipe the hunt the operator
 * just asked for. The decode handler still drops a target whose mode no longer
 * matches the engine ('qsy'), as before.
 *
 * Pure; main.js supplies the effects (jtcatOperatorModeChange).
 *
 * @param {string} mode  the mode the operator picked
 * @param {object} d     { engineMode(), halt(reason), clearDecodes(), setMode(m),
 *                         modeHopReset(), wsprSessionEnd(), pushActivityState() }
 * @param {object} [opts] { handBack: true } from the auto-RX hand-back (no halt)
 * @returns {boolean} true when the mode really changed (and TX was stopped)
 */
function operatorModeChange(mode, d, opts = {}) {
  const changed = !!mode && mode !== d.engineMode();
  if (changed) {
    // opts.handBack: an idle-receive session giving the window back. It never
    // transmitted, and the operator action that ended it (a spot click, Hunt)
    // may have just armed something this halt would undo.
    if (!opts.handBack) d.halt('Mode change');
    d.clearDecodes();
  }
  d.setMode(mode);
  d.modeHopReset(); // the operator just chose a mode: the idle clock starts here
  if (mode !== 'WSPR') d.wsprSessionEnd();
  d.pushActivityState();
  return changed;
}

module.exports = { operatorModeChange };
