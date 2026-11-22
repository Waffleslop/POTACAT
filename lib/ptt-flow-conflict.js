'use strict';
/**
 * PTT on RTS and RTS/CTS flow control on the same serial port (#544).
 *
 * Under RTS/CTS flow control the serial driver owns RTS: it holds it up so
 * the radio may send, and nothing else can drive it. "RTS line = Asserted"
 * holds it high the same way. So a radio set to key on RTS of that port can
 * never be keyed (main.js gatedSetTransmit refuses it at the moment of
 * transmit). W5PLC's FTDX10 had both set, and nothing said so until he tried
 * to transmit. The rig editor and Station Setup ask this module and show the
 * conflict while the settings are being chosen, with a fix the operator
 * presses; nothing here changes a setting.
 *
 * Per port: RTS on one port and flow control on another are no conflict.
 *
 * Dual mode: require() in main and the tests, window.PttFlowConflict in the
 * rig editor (renderer/index.html loads it).
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PttFlowConflict = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function samePort(a, b) {
    const n = (p) => String(p || '').trim().toUpperCase();
    return !!n(a) && n(a) === n(b);
  }

  /**
   * The core rule for one port.
   * @param {object} p
   *   flowPort  the port whose RTS line is set by `flow`
   *   flow      'hardware' (RTS/CTS flow control) | 'asserted' (RTS held high) | anything else
   *   pttPort   the port whose line keys PTT
   *   pttLine   'rts' | 'dtr' | anything else
   * @returns {null | {line:'RTS', port:string, flow:string}}
   */
  function rtsConflict({ flowPort, flow, pttPort, pttLine } = {}) {
    if (pttLine !== 'rts') return null;
    if (flow !== 'hardware' && flow !== 'asserted') return null;
    if (!samePort(flowPort, pttPort)) return null;
    return { line: 'RTS', port: String(pttPort).trim(), flow };
  }

  const MESSAGES = {
    hardware: "PTT on RTS can't work while RTS/CTS flow control is on for this port. Turn one off.",
    asserted: "PTT on RTS can't work while RTS is held high for this port (RTS line: Asserted). Turn one off.",
  };

  // The two ways out, both pressed by the operator. "Hold RTS low" keeps the
  // RTS keying; "Key over CAT" keeps the flow control.
  const FIXES = [
    { id: 'rts-held-low', label: 'Hold RTS low', patch: { serialHandshake: 'none' } },
    { id: 'ptt-over-cat', label: 'Key over CAT instead', patch: { ptt: null } },
  ];

  /**
   * A saved or edited serial CAT target (catTarget shape: type 'serial', path,
   * ptt 'rts' | 'dtr' | 'vox' | absent for CAT, serialHandshake 'auto' |
   * 'none' | 'hardware' | 'asserted').
   * @param {object} target
   * @param {string} [modelHandshake] the radio model's default ('hardware' for
   *   the TS-590/TS-990/TS-2000), which "Auto" follows
   * @returns {null | {line, port, flow, source:'rig'|'model', message, fixes}}
   *   fixes: what the operator can press, each a patch for the catTarget
   *   (a null value means: remove the field).
   */
  function pttFlowConflict(target, modelHandshake) {
    if (!target || target.type !== 'serial') return null;
    const own = target.serialHandshake;
    let flow, source;
    if (own === 'hardware' || own === 'asserted') { flow = own; source = 'rig'; }
    else if ((own == null || own === '' || own === 'auto') && modelHandshake === 'hardware') { flow = 'hardware'; source = 'model'; }
    else return null;
    // "RTS on the CAT port": the PTT line is on the port CAT holds.
    // Said before a port is picked too: it is the same port whichever one it is.
    const port = String(target.path || '').trim() || 'the CAT port';
    const c = rtsConflict({ flowPort: port, flow, pttPort: port, pttLine: target.ptt });
    if (!c) return null;
    return {
      ...c,
      source,
      message: MESSAGES[flow],
      fixes: FIXES,
    };
  }

  /** Apply one of the fixes to a copy of the target (an unknown id changes nothing). */
  function applyFix(target, fixId) {
    const fix = FIXES.find((f) => f.id === fixId);
    const out = { ...(target || {}) };
    for (const [k, v] of Object.entries(fix ? fix.patch : {})) {
      if (v === null) delete out[k];
      else out[k] = v;
    }
    return out;
  }

  return { rtsConflict, pttFlowConflict, applyFix, MESSAGES, FIXES };
});
