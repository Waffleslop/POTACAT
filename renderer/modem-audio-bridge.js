// Modem audio bridge window (docs/modem-audio-bridge-plan.md, phase 1).
//
// RX: the rig's input device → AudioWorklet 'modem-capture' → 20 ms batches →
//     main (modem-bridge-rx) → ModemAudioServer → the modem's socket.
// TX: main (modem-bridge-tx, 24 kHz chunks from the server) → AudioWorklet
//     'modem-play' ring → GainNode(txGain) → an AudioContext whose sink is the
//     rig's output device (setSinkId).
//
// Rules, the same as the ECHOCAT bridge (renderer/remote-audio.html): the
// device the operator chose, exactly, or no audio at all — never the system
// default, which on a Mac is the built-in microphone (KF0WWL). Every failure
// is reported with its name so the session can end with the reason.
'use strict';

let capCtx = null, capStream = null, capNode = null, capGain = null;
let playCtx = null, playNode = null, playGain = null;
let cfg = null;
let levelTimer = null, lastPeak = 0;

function describe(err) { return [err && err.name, err && err.message].filter(Boolean).join(': ') || String(err); }

async function labelFor(kind, id) {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const d = devs.find((x) => x.kind === kind && x.deviceId === id);
    return d ? (d.label || id) : '';
  } catch { return ''; }
}

async function startCapture(c) {
  stopCapture();
  if (!c.inputId) throw new Error('No audio input is chosen for this radio — Settings > My Rigs > Audio');
  if (String(c.inputId).indexOf('alsa:') === 0) {
    throw new Error('The radio audio input is a raw ALSA device ("' + c.inputId + '"), which the audio bridge cannot open. Pick the PulseAudio/PipeWire entry for the same card in Settings > My Rigs > Audio.');
  }
  try {
    capStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: c.inputId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (e) {
    throw new Error('Radio audio input not found, so no audio was captured (the microphone was NOT used). Pick the radio\'s input again in Settings > My Rigs > Audio. Reason: ' + describe(e));
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
    window.bridge.rx(d.pcm, d.sampleRate, d.peak);
  };
  src.connect(capGain); capGain.connect(capNode);
  const track = capStream.getAudioTracks()[0];
  track.onended = () => window.bridge.status({ error: 'The radio audio input went away (unplugged?) — the session cannot continue', captureEnded: true });
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
  if (!c.outputId) throw new Error('No audio output is chosen for this radio — Settings > My Rigs > Audio');
  if (String(c.outputId).indexOf('alsa:') === 0) throw new Error('The radio audio output is a raw ALSA device ("' + c.outputId + '"), which the audio bridge cannot open. Pick the PulseAudio/PipeWire entry in Settings > My Rigs > Audio.');
  playCtx = new AudioContext({ latencyHint: 'interactive' });
  if (typeof playCtx.setSinkId !== 'function') throw new Error('This build cannot choose an output device for the modem (AudioContext.setSinkId missing)');
  try { await playCtx.setSinkId(c.outputId); }
  catch (e) { throw new Error('The radio\'s audio output could not be opened, so the modem\'s transmit audio has nowhere to go. Pick the radio\'s output again in Settings > My Rigs > Audio. Reason: ' + describe(e)); }
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

window.bridge.onStart(async (c) => {
  cfg = c || {};
  try {
    const cap = await startCapture(cfg);
    let play = {};
    if (cfg.playback) play = await startPlayback(cfg);
    window.bridge.status({ ok: true, ...cap, ...play, playback: !!cfg.playback });
    clearInterval(levelTimer);
    levelTimer = setInterval(() => { window.bridge.status({ level: lastPeak }); lastPeak = 0; }, 500);
  } catch (e) {
    stopCapture(); stopPlayback();
    window.bridge.status({ ok: false, error: (e && e.message) || String(e) });
  }
});

window.bridge.onPlayback(async (c) => {
  try {
    if (c && c.on) {
      const play = await startPlayback({ ...(cfg || {}), ...c });
      window.bridge.status({ ok: true, playback: true, ...play });
    } else {
      stopPlayback();
      window.bridge.status({ ok: true, playback: false });
    }
  } catch (e) {
    stopPlayback();
    window.bridge.status({ ok: false, playback: true, error: (e && e.message) || String(e) });
  }
});

window.bridge.onTx((d) => {
  if (!playNode || !d) return;
  const pcm = d.pcm instanceof Float32Array ? d.pcm : new Float32Array(d.pcm);
  playNode.port.postMessage(pcm);
});

window.bridge.onStop(() => {
  clearInterval(levelTimer); levelTimer = null;
  stopCapture(); stopPlayback();
  window.bridge.status({ stopped: true });
});
