// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Which socket a Kenwood keys its transmit audio from (GitHub #594).
//
// The TS-480, TS-590S/SG, TS-890S and TS-990S choose the transmit audio input
// with the CAT key-down itself: `TX;` (TX0) keys from the FRONT microphone,
// `TX1;` keys with the REAR data input (ACC2, or the radio's USB audio where it
// has one). The rigctld path says the same with `T 1` (RIG_PTT_ON = TX;) and
// `T 3` (RIG_PTT_ON_DATA = TX1;), verified against the bundled Hamlib 4.7.0
// (lib/codecs/rigctld-codec.js).
//
// Both wirings exist in the field. 1.14.5 moved the TS-480 to `TX1;` for an
// operator on the ACC cable (#511), and an operator whose interface feeds the
// front mic jack got a carrier with no audio, on SSB and FT8 alike (#594). So
// the choice is the operator's, per rig:
//   - TS-590S/SG, TS-890S, TS-990S: Rear unless the operator picks Front
//     (their behaviour since June 2026).
//   - TS-480: no default (Casey 2026-11-15, "ask on first transmit"). Until the
//     operator answers, a CAT key-down is not sent; the shack asks which socket
//     the interface is plugged into, and the next transmission uses the answer.
// A Commands-tab "PTT On" override (settings.rigCommandOverrides) still wins
// over all of this: the operator typed that command for this model.
//
// Dual-mode: Node `require()` gets module.exports; the browser gets
// window.TxAudioInput. Pure.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TxAudioInput = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FRONT = 'front';
  var REAR = 'rear';

  // Model name (lib/rig-models.js key) -> its default; null = ask first.
  var MODELS = {
    'TS-480': null,
    'TS-590S/SG': REAR,
    'TS-890S': REAR,
    'TS-990S': REAR,
  };

  var KENWOOD_CMD = { front: 'TX;', rear: 'TX1;' };
  var RIGCTLD_CMD = { front: 'T 1', rear: 'T 3' };

  var LABELS = {
    front: 'Front (microphone jack)',
    rear: 'Rear (data / ACC2 socket)',
  };

  var QUESTION_TITLE = 'Where is your audio interface plugged into the radio?';
  var QUESTION_HELP = 'POTACAT has to tell the radio which socket to send when it transmits. '
    + 'Pick the socket your sound card interface (SignaLink, Digirig, USB interface) is plugged into. '
    + 'You can change this later in Settings > Radio, in this rig’s settings.';

  function hasChoice(modelName) {
    return Object.prototype.hasOwnProperty.call(MODELS, String(modelName || ''));
  }

  function savedChoice(rig) {
    var v = rig && rig.txAudioInput;
    return v === FRONT || v === REAR ? v : null;
  }

  /** 'front' | 'rear' | null (= ask first) for this rig, or null for a model with no choice. */
  function choiceFor(rig, modelName) {
    var name = modelName != null ? modelName : (rig && rig.model);
    if (!hasChoice(name)) return null;
    return savedChoice(rig) || MODELS[name];
  }

  /** The model with its key-down command set from the rig's choice. Unanswered
   *  TS-480: unchanged (the key-down is held back by needsAnswer instead). */
  function applyToModel(model, rig, modelName) {
    if (!model) return model;
    var name = modelName != null ? modelName : (rig && rig.model);
    var choice = choiceFor(rig, name);
    if (!choice) return model;
    var cmd = KENWOOD_CMD[choice];
    if (model.commands && model.commands.setTransmitOn === cmd) return model;
    var commands = {};
    var k;
    if (model.commands) for (k in model.commands) commands[k] = model.commands[k];
    commands.setTransmitOn = cmd;
    var out = {};
    for (k in model) out[k] = model[k];
    out.commands = commands;
    return out;
  }

  /**
   * True when a CAT key-down must wait for the operator's answer.
   * @param {object} rig            the active rig
   * @param {object} o
   * @param {string} [o.modelName]  defaults to rig.model
   * @param {string} [o.catType]    catTarget.type ('serial', 'rigctld', 'rigctldnet', ...)
   * @param {string} [o.ptt]        catTarget.ptt ('vox', 'rts', 'dtr' key elsewhere)
   * @param {string} [o.pttOverride] a Commands-tab PTT On override for this model
   */
  function needsAnswer(rig, o) {
    o = o || {};
    var name = o.modelName != null ? o.modelName : (rig && rig.model);
    if (!hasChoice(name)) return false;
    if (choiceFor(rig, name)) return false;
    if (o.pttOverride) return false;
    // Only the links whose key-down is the CAT TX command: our serial codec,
    // and Hamlib (bundled rigctld or the operator's own rigctld server).
    if (o.catType !== 'serial' && o.catType !== 'rigctld' && o.catType !== 'rigctldnet') return false;
    if (o.ptt === 'vox' || o.ptt === 'rts' || o.ptt === 'dtr') return false;
    return true;
  }

  /** The refusal said to every surface that asked for a key-down. */
  function refusalText(radioName) {
    return 'Not transmitted: POTACAT needs to know which socket of the '
      + (radioName || 'radio') + ' your audio interface uses. Answer the question on the shack PC, '
      + 'or set "Transmit audio input" in Settings > Radio, in this rig’s settings.';
  }

  return {
    FRONT: FRONT,
    REAR: REAR,
    MODELS: MODELS,
    KENWOOD_CMD: KENWOOD_CMD,
    RIGCTLD_CMD: RIGCTLD_CMD,
    LABELS: LABELS,
    QUESTION_TITLE: QUESTION_TITLE,
    QUESTION_HELP: QUESTION_HELP,
    hasChoice: hasChoice,
    savedChoice: savedChoice,
    choiceFor: choiceFor,
    applyToModel: applyToModel,
    needsAnswer: needsAnswer,
    refusalText: refusalText,
  };
});
