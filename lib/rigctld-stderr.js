'use strict';

// What rigctld's stderr means to an operator. rigctld prints the errno of
// its LAST failure, which is rarely the cause: when a serial port is held by
// another process it says "already open" / "Access denied" and then, as the
// retry loop winds down, "COM3 No such file or directory" — and that last
// line is what a Test Connection result used to show (K5AWJ, FT-710 on
// rigctld, 2026-09-22: his live link was fine; Test raced the dying
// rigctld's port release and told him his COM port did not exist).

/**
 * @param {string} stderrText - everything rigctld printed for this run
 * @param {string} [fallback] - what to say when nothing here matches (usually the last line)
 * @returns {string}
 */
function explainRigctldFailure(stderrText, fallback) {
  const t = String(stderrText || '');
  const pm = t.match(/rig_pathname='([^']+)'/) || t.match(/serial port (\S+) is already open/i);
  const port = (pm && pm[1]) || 'the serial port';
  if (/already open|Access denied|Resource busy|Permission denied|EBUSY/i.test(t)) {
    return `${port} is in use — another program has it open (WSJT-X, wfview, 710 Console, a second POTACAT), `
      + 'or the previous rig link had not let go of it yet. Close the other program, or wait a few seconds and try again.';
  }
  if (/No such file or directory|ENOENT|cannot open/i.test(t)) {
    return `${port} does not exist — check the port name in Device Manager; the radio's USB driver may have renumbered it.`;
  }
  if (/timed out|ETIMEOUT/i.test(t)) {
    return `${port} opened but the radio did not answer — check the baud rate matches the radio's CAT rate, and that the radio is on.`;
  }
  return fallback || t.trim().split('\n').filter(Boolean).pop() || 'rigctld failed';
}

module.exports = { explainRigctldFailure };
