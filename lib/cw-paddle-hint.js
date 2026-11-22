'use strict';
// The log line POTACAT writes when a paddle or straight key (ECHOCAT, a MIDI
// key, a Vail adapter) cannot make CW on a Kenwood-protocol or legacy Yaesu
// rig, because that CAT protocol has no command that keys one element at a
// time and no CW Key Port is open.
//
// Elecraft KX2/KX3 owners used to get the Yaesu wording (second USB port,
// PC KEYING), which names menus and ports their radio does not have
// (idthetarget, KX2 with a Vail adapter through ECHOCAT, 2026-11-15).
// Elecraft facts, from the documents in hand:
//   - KY sends text only, through the radio's own keyer (K3S/K3/KX3/KX2
//     Programmer's Reference rev G5, p. 15). No CAT command keys a single
//     element.
//   - The KEY jack takes a hand key or "an input for an external keying
//     device (keyer, computer, etc.)" with MENU:CW KEY1 = HAND (KX2 Owner's
//     Manual rev B2, p. 45; the KX3 has the same entry, KX3 Owner's Manual
//     rev C5, p. 4).
//   - Neither owner's manual has a menu that keys CW from DTR or RTS on the
//     serial (ACC) jack, so nothing here tells an owner to look for one.

function isElecraft(rigModel) {
  return !!rigModel && String(rigModel.brand || '').toLowerCase() === 'elecraft';
}

function txrxPttOnlyHint(rigModel) {
  if (isElecraft(rigModel)) {
    return '[CW] This Elecraft radio has no CAT command that keys CW one element at a time ' +
      '(KY sends typed text through the radio\'s own keyer), so a paddle or straight key from ECHOCAT, ' +
      'a MIDI key or a Vail adapter cannot make CW over the CAT cable alone. ' +
      'Typed CW works: use the CW text box, which makes real RF. ' +
      'For a live key: use a separate USB-serial keying interface whose DTR or RTS line closes the radio\'s KEY jack, ' +
      'set the radio\'s MENU:CW KEY1 to HAND, select that interface as the CW Key Port in Settings > ECHOCAT, ' +
      'and set "CW keying line" in the rig editor (Settings > Radio) to the line it uses.';
  }
  return '[CW] Paddle keying on this Yaesu/Kenwood rig would only key PTT (TX1;/TX0;) — no CW output or sidetone. ' +
    'For a real paddle: connect the rig\'s OTHER USB COM port (the one not used for CAT — "Standard" on the FTDX10, "Enhanced/CAT-2" on FT-710/991), ' +
    'set the rig menu PC KEYING (or USB Keying (CW)) = DTR or RTS, and select that port as the CW Key Port in Settings > ECHOCAT — then set "CW keying line" in the rig editor (Settings > Radio) to match, and enable BK-IN. ' +
    'Or type in the CW text box — that uses the rig\'s internal keyer and makes real RF. See docs/linux-cw-keying.md.';
}

module.exports = { txrxPttOnlyHint, isElecraft };
