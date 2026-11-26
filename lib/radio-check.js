// The first run's radio check: two of Station Setup's steps shown inline,
// "POTACAT can control your radio" and "Hearing the radio". Station Setup
// (lib/station-setup.js, evaluated in main) still decides each step; this
// module only picks those two from its answer and keeps the buttons to the
// ones that read or listen.
//
// Nothing here transmits. The transmit steps ("Sending audio to the radio",
// the test transmit, PTT) and their confirmation stay in Station Setup's own
// window, opened by the operator. ACTIONS is the whole list of Station Setup
// actions the inline check can run; test/radio-check-test.js holds it to that.
//
// Pure. Dual-mode: require() in Node, window.RadioCheck in the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadioCheck = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP_IDS = ['radio-control', 'rx-audio'];
  //   recheck          ask main again (reads the CAT link and the frequency)
  //   rx-test          listen to the radio's sound input for 3 seconds
  //   open-rig-editor  in the first run: back to "which radio"
  const ACTIONS = ['recheck', 'rx-test', 'open-rig-editor'];
  const LABELS = { 'open-rig-editor': 'Change the radio settings' };
  // Audio sources that come over the radio's own link: no sound input to pick.
  const NETWORK_AUDIO = ['smartsdr', 'icom-network', 'yaesu-lan', 'tci'];

  /**
   * The two steps from a Station Setup answer (window.api.stationSetupGet),
   * with only the actions above, in that order.
   * @returns {{steps: object[], passed: boolean, controlOk: boolean, hearingOk: boolean}}
   */
  function inlineSteps(payload) {
    const all = (payload && Array.isArray(payload.steps)) ? payload.steps : [];
    const steps = [];
    for (const id of STEP_IDS) {
      const st = all.find((s) => s && s.id === id);
      if (!st) continue;
      steps.push({
        id: st.id,
        title: st.title,
        state: st.state,
        detail: st.detail || '',
        instructions: Array.isArray(st.instructions) ? st.instructions : [],
        actions: (st.actions || []).filter((a) => a && ACTIONS.includes(a.id))
          .map((a) => ({ id: a.id, label: LABELS[a.id] || a.label })),
      });
    }
    const ok = (id) => { const s = steps.find((x) => x.id === id); return !!s && s.state === 'ok'; };
    return { steps, controlOk: ok('radio-control'), hearingOk: ok('rx-audio'), passed: ok('radio-control') && ok('rx-audio') };
  }

  /** How the check ends on Done: 'passed' when both steps work, else 'failed'. */
  function outcome(payload) { return inlineSteps(payload).passed ? 'passed' : 'failed'; }

  /** True when the radio's sound comes over its own link (Flex, Icom Network, ...). */
  function audioIsNetwork(audioSource) { return NETWORK_AUDIO.includes(String(audioSource || '')); }

  function deviceGroup(label) {
    // Windows names a sound card's two halves "Microphone (USB Audio CODEC)" and
    // "Speakers (USB Audio CODEC)", sometimes "(2- USB Audio CODEC)".
    const m = /\(([^()]+)\)\s*$/.exec(String(label || ''));
    return (m ? m[1] : String(label || '')).replace(/^\d+-\s*/, '').trim().toLowerCase();
  }

  function usable(d, kind) {
    return d && d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications' && !d.isAlsaSeparator;
  }

  /**
   * The sound input that is plainly the radio's, or '' when none stands out.
   * Reads the names only. The TI "USB Audio CODEC" is what Icom, Yaesu and
   * Kenwood USB radios (and SignaLink) present; the model number or maker in
   * the name counts most. A webcam, headset or the computer's own microphone
   * array never counts.
   */
  function suggestInput(devices, model, brand) {
    const inputs = (devices || []).filter((d) => usable(d, 'audioinput'));
    const digits = (String(model || '').match(/\d{3,}/) || [])[0] || '';
    const b = String(brand || '').toLowerCase();
    const scored = inputs.map((d) => {
      const t = String(d.label || '').toLowerCase();
      let s = 0;
      if (digits && t.includes(digits)) s += 3;
      if (b && t.includes(b)) s += 2;
      if (/codec/.test(t)) s += 2;
      if (/signalink|digirig|dax|qmx|qdx|trusdx|xiegu/.test(t)) s += 1;
      if (/webcam|camera|headset|array|realtek|bluetooth|airpods/.test(t)) s -= 3;
      return { d, s };
    }).sort((x, y) => y.s - x.s);
    if (!scored.length || scored[0].s <= 0) return '';
    if (scored.length > 1 && scored[1].s === scored[0].s) return '';
    return scored[0].d.deviceId;
  }

  /** The output on the same sound card as that input (one exact match), or ''. */
  function matchingOutput(devices, inputId) {
    const list = devices || [];
    const inp = list.find((d) => usable(d, 'audioinput') && d.deviceId === inputId);
    if (!inp || !inp.label) return '';
    const g = deviceGroup(inp.label);
    const outs = list.filter((d) => usable(d, 'audiooutput') && d.label && deviceGroup(d.label) === g);
    return outs.length === 1 ? outs[0].deviceId : '';
  }

  /**
   * The save for a sound input chosen in the check: on the radio, and on the
   * global copy because it is the radio in use. The output is set too when it
   * was empty and one output plainly belongs to the same sound card.
   */
  function audioPatch(rigs, rigId, inputId, outputId) {
    const list = (Array.isArray(rigs) ? rigs : []).map((r) => (r && r.id === rigId ? { ...r } : r));
    const rig = list.find((r) => r && r.id === rigId);
    if (!rig) return null;
    rig.remoteAudioInput = inputId || '';
    if (!rig.remoteAudioOutput && outputId) rig.remoteAudioOutput = outputId;
    return { rigs: list, remoteAudioInput: rig.remoteAudioInput, remoteAudioOutput: rig.remoteAudioOutput || '' };
  }

  return { STEP_IDS, ACTIONS, NETWORK_AUDIO, inlineSteps, outcome, audioIsNetwork, suggestInput, matchingOutput, audioPatch, deviceGroup };
});
