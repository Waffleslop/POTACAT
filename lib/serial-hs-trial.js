'use strict';
/**
 * Which serial radios get the RTS/CTS trial when they never answer with RTS
 * held low (main.js armSerialHandshakeNoAnswerTrial on connect, and the same
 * retry in Test Connection).
 *
 * Yaesu since #103 (a CAT RTS menu that is on waits for RTS). Kenwood since
 * jcoreyc's TS-480 (2026-11-05): commands reached the radio, not one reply
 * came back, and the link went red after 10 s. Hamlib lists the TS-480 with no
 * flow control, so RTS/CTS is not made its default; the trial finds the
 * radios that need it and saves it on that rig.
 *
 * Not the FT-817/818/857/897 legacy protocol (no handshake; RTS can key an
 * interface wired to it, KL4XQ), and not other brands that speak the Kenwood
 * protocol (Elecraft etc.), which have never needed it.
 *
 * Never on a port whose RTS keys PTT (catTarget.ptt 'rts', "RTS on the CAT
 * port"): the trial raises RTS, which keys the radio, and RTS/CTS saved on
 * that rig would make PTT impossible (#544, W5PLC FTDX10).
 */
function trialSkipReason(model, target) {
  if (!model || model.protocol === 'yaesu-legacy') return 'model';
  if (model.brand !== 'Yaesu' && model.brand !== 'Kenwood') return 'model';
  if (target && target.ptt === 'rts') return 'ptt-rts';
  return null;
}

function trialApplies(model, target) {
  return trialSkipReason(model, target) === null;
}

/** The one log line when the trial is skipped because RTS keys PTT. */
function pttRtsSkipLine(path) {
  return `[CAT] Not trying RTS/CTS flow control on ${path || 'the CAT port'}: RTS on this port keys PTT, and raising it would transmit. RTS stays low.`;
}

module.exports = { trialApplies, trialSkipReason, pttRtsSkipLine };
