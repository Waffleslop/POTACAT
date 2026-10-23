// Modem audio bridge window (docs/modem-audio-bridge-plan.md, phases 1 and 4).
//
// Two SIDES, each its own capture + playback pair, each the same code:
//
// radio: RX: the rig's input device → AudioWorklet 'modem-capture' → 20 ms
//            batches → main (modem-bridge-rx) → ModemAudioServer → the modem.
//        TX: main (modem-bridge-tx, 24 kHz chunks from the server) →
//            AudioWorklet 'modem-play' ring → GainNode(txGain) → an
//            AudioContext whose sink is the rig's output device (setSinkId).
// cable: the virtual audio cable VARA is wired to (rig.modemCable). Capture =
//        the cable VARA plays its transmit audio INTO (modem-bridge-cable-rx →
//        main → the radio, while VARA has PTT); playback = the cable VARA
//        listens to (main sends the radio's receive audio as
//        modem-bridge-cable-tx). Same worklets, same rules, other direction.
//
// Rules, the same as the ECHOCAT bridge (renderer/remote-audio.html): the
// device the operator chose, exactly, or no audio at all — never the system
// default, which on a Mac is the built-in microphone (KF0WWL). Every failure
// is reported with its name so the session can end with the reason.
'use strict';

function describe(err) { return [err && err.name, err && err.message].filter(Boolean).join(': ') || String(err); }

async function labelFor(kind, id) {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const d = devs.find((x) => x.kind === kind && x.deviceId === id);
    return d ? (d.label || id) : '';
  } catch { return ''; }
}

/**
 * One capture + playback pair. `what` names the device in messages ("radio"
 * or "virtual cable"); `where` is the Settings path that fixes a bad pick.
 */
function makeSide({ name, what, where, rx, status }) {
  let capCtx = null, capStream = null, capNode = null, capGain = null;
  let playCtx = null, playNode = null, playGain = null;
  let cfg = null;
  let levelTimer = null, lastPeak = 0;

  async function startCapture(c) {
    stopCapture();
    if (!c.inputId) throw new Error(`No audio input is chosen for the ${what} — ${where}`);
    if (String(c.inputId).indexOf('alsa:') === 0) {
      throw new Error(`The ${what} audio input is a raw ALSA device ("` + c.inputId + `"), which the audio bridge cannot open. Pick the PulseAudio/PipeWire entry for the same card in ${where}.`);
    }
    try {
      capStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: c.inputId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      throw new Error(`${name === 'radio' ? 'Radio' : 'Virtual cable'} audio input not found, so no audio was captured (the microphone was NOT used). Pick the ${what}'s input again in ${where}. Reason: ` + describe(e));
    }
    capCtx = new AudioContext({ latencyHint: 'interactive' });
    if (capCtx.state === 'suspended') await capCtx.resume();
    await capCtx.audioWorklet.addModule('modem-capture-worklet.js');
    const src = capCtx.createMediaStreamSource(capStream);
    capGain = capCtx.createGain(); capGain.gain.value = 1;
    capNode = new AudioWorkletNode(capCtx, 'modem-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    capNode.port.onmessage = (e) => {
      const d = e.data;
      if (!d || !d.pcm) return;
      if (d.peak > lastPeak) lastPeak = d.peak;
      rx(d.pcm, d.sampleRate, d.peak);
    };
    src.connect(capGain); capGain.connect(capNode);
    const track = capStream.getAudioTracks()[0];
    track.onended = () => status({ error: `The ${what} audio input went away (unplugged?) — the session cannot continue`, captureEnded: true });
    return { captureLabel: (track && track.label) || (await labelFor('audioinput', c.inputId)) || c.inputId, sampleRate: capCtx.sampleRate };
  }

  function stopCapture() {
    try { if (capNode) capNode.disconnect(); } catch {}
    try { if (capStream) capStream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (capCtx) capCtx.close(); } catch {}
    capNode = null; capGain = null; capStream = null; capCtx = null;
  }

  async function startPlayback(c) {
    stopPlayback();
    if (!c.outputId) throw new Error(`No audio output is chosen for the ${what} — ${where}`);
    if (String(c.outputId).indexOf('alsa:') === 0) throw new Error(`The ${what} audio output is a raw ALSA device ("` + c.outputId + `"), which the audio bridge cannot open. Pick the PulseAudio/PipeWire entry in ${where}.`);
    playCtx = new AudioContext({ latencyHint: 'interactive' });
    if (typeof playCtx.setSinkId !== 'function') throw new Error('This build cannot choose an output device for the modem (AudioContext.setSinkId missing)');
    try { await playCtx.setSinkId(c.outputId); }
    catch (e) { throw new Error(`The ${what}'s audio output could not be opened, so the audio has nowhere to go. Pick the ${what}'s output again in ${where}. Reason: ` + describe(e)); }
    if (playCtx.state === 'suspended') await playCtx.resume();
    await playCtx.audioWorklet.addModule('modem-play-worklet.js');
    playNode = new AudioWorkletNode(playCtx, 'modem-play', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { sourceRate: 24000 } });
    playGain = playCtx.createGain();
    playGain.gain.value = (typeof c.txGain === 'number' && isFinite(c.txGain)) ? Math.max(0, Math.min(2, c.txGain)) : 1;
    playNode.connect(playGain); playGain.connect(playCtx.destination);
    return { playbackLabel: (await labelFor('audiooutput', c.outputId)) || c.outputId };
  }

  function stopPlayback() {
    try { if (playNode) playNode.disconnect(); } catch {}
    try { if (playCtx) playCtx.close(); } catch {}
    playNode = null; playGain = null; playCtx = null;
  }

  async function start(c) {
    cfg = c || {};
    try {
      const cap = await startCapture(cfg);
      let play = {};
      if (cfg.playback) play = await startPlayback(cfg);
      status({ ok: true, ...cap, ...play, playback: !!cfg.playback });
      clearInterval(levelTimer);
      levelTimer = setInterval(() => { status({ level: lastPeak }); lastPeak = 0; }, 500);
    } catch (e) {
      stopCapture(); stopPlayback();
      status({ ok: false, error: (e && e.message) || String(e) });
    }
  }

  async function playback(c) {
    try {
      if (c && c.on) {
        const play = await startPlayback({ ...(cfg || {}), ...c });
        status({ ok: true, playback: true, ...play });
      } else {
        stopPlayback();
        status({ ok: true, playback: false });
      }
    } catch (e) {
      stopPlayback();
      status({ ok: false, playback: true, error: (e && e.message) || String(e) });
    }
  }

  function tx(d) {
    if (!playNode || !d) return;
    const pcm = d.pcm instanceof Float32Array ? d.pcm : new Float32Array(d.pcm);
    playNode.port.postMessage(pcm);
  }

  function stop() {
    clearInterval(levelTimer); levelTimer = null;
    stopCapture(); stopPlayback();
    status({ stopped: true });
  }

  return { start, playback, tx, stop };
}

const radio = makeSide({
  name: 'radio', what: 'radio', where: 'Settings > My Rigs > Audio',
  rx: (pcm, sampleRate, peak) => window.bridge.rx(pcm, sampleRate, peak),
  status: (s) => window.bridge.status(s),
});
const cable = makeSide({
  name: 'cable', what: 'virtual cable', where: 'Settings > Station > Winlink (VARA)',
  rx: (pcm, sampleRate, peak) => window.bridge.cableRx(pcm, sampleRate, peak),
  status: (s) => window.bridge.cableStatus(s),
});

window.bridge.onStart((c) => radio.start(c));
window.bridge.onPlayback((c) => radio.playback(c));
window.bridge.onTx((d) => radio.tx(d));
window.bridge.onStop(() => { radio.stop(); cable.stop(); });
window.bridge.onStopRadio(() => radio.stop());
window.bridge.onCableStart((c) => cable.start({ ...(c || {}), playback: true }));
window.bridge.onCableStop(() => cable.stop());
window.bridge.onCableTx((d) => cable.tx(d));
