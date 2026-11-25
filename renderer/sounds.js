// The one door every operator sound in the main window goes through (#1041):
// the contact sounds, the milestone sounds, the QSO logged chime flavours and
// the Sounds pane's Play and Hear buttons (preview).
//
// Before every play it asks lib/sound-guard.js "may this sound play now, and
// where", with the computer's live output list, the radio's TX audio devices
// and whether the station is transmitting, and if so whether it is voice
// (main, sound-tx-state), and does what it is told:
//   play    on the output named, at the Volume set in Settings > Sounds
//           (also during FT8, CW, SSTV, a tune: no microphone is on the air)
//   hold    voice TX: wait for the radio to unkey, asking again every HOLD_POLL_MS
//   drop    the voice TX lasted more than 3 s: this sound is not played
//   silent  the only output is the radio's sound card: nothing plays
// A sound that is playing when a voice transmission starts is cut at once.
//
// Sounds play one after another, never two at the same time: on a milestone
// contact the coin, then the milestone sound.
//
// It has its own AudioContext, opened on the output the guard chose. It never
// touches the shared default-output context or any transmit audio path, and it
// sends nothing to the radio.
(function () {
  'use strict';

  const MAX_WAITING = 4;        // more contact sounds than this in the queue are not added
  let ctx = null;               // the sound output, made on first use
  let sinkNow = null;           // the output ctx is on ('' = system default)
  let settings = {};            // the settings object (configure)
  let waiting = 0;
  let tail = Promise.resolve(); // the queue
  const live = new Set();       // what is sounding now: { stop() }
  let watch = null;
  let lastStatus = { ok: true, text: '', label: '' };
  const buffers = new Map();    // file id -> Promise<AudioBuffer>, decoded

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** The settings to use from now on (app.js calls this on load and on Save). */
  function configure(s) {
    settings = s || {};
    // The files are read once, ahead of the first contact, so the coin is not late.
    for (const id of QsoSounds.FILES) loadFile(id);
    outputs();
  }

  // The computer's outputs, asked once and again whenever a device comes or goes.
  let deviceList = null;
  function outputs() {
    if (!deviceList) deviceList = navigator.mediaDevices.enumerateDevices().catch(() => { deviceList = null; return []; });
    return deviceList;
  }
  try { navigator.mediaDevices.addEventListener('devicechange', () => { deviceList = null; }); } catch {}
  /**
   * { tx, voice, txDevices } from main. voice is false only when main says the
   * transmission carries no microphone (FT8, CW, a tune...); missing is voice.
   * If main cannot be asked, the answer is "transmitting voice": silence is the safe side.
   */
  async function txState() {
    try {
      const st = await window.api.soundTxState();
      return { tx: !!(st && st.tx), voice: !(st && st.voice === false), txDevices: (st && st.txDevices) || [] };
    } catch { return { tx: true, voice: true, txDevices: [] }; }
  }
  /** A voice transmission is on: what cuts a playing sound. */
  const voiceOn = (st) => !!(st && st.tx && st.voice);

  /** The context, on the output the guard chose. False when that output cannot be opened. */
  async function openOn(sinkId) {
    try {
      if (!ctx) {
        ctx = sinkId ? new AudioContext({ sinkId }) : new AudioContext();
        sinkNow = sinkId;
      } else if (sinkNow !== sinkId) {
        if (typeof ctx.setSinkId !== 'function') return false;
        await ctx.setSinkId(sinkId);
        sinkNow = sinkId;
      }
      if (ctx.state === 'suspended') await ctx.resume();
      return true;
    } catch (err) {
      console.warn('[Sounds] output not opened:', err && err.message);
      return false;
    }
  }

  // A file is read and decoded once (the decoder needs no output device).
  function loadFile(id) {
    if (!buffers.has(id)) {
      buffers.set(id, fetch('sounds/' + id + '.wav')
        .then((r) => r.arrayBuffer())
        .then((bytes) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes))
        .catch(() => { buffers.delete(id); return null; }));
    }
    return buffers.get(id);
  }

  /** Stop everything that is sounding (a transmission started). */
  function cutAll() {
    for (const s of live) { try { s.stop(); } catch {} }
    live.clear();
  }
  // The TX state main already pushes (PTT, JTCAT, SSTV, CW text): the fastest
  // cut, once main says the transmission is voice. FT8, CW or a tune does not cut.
  if (window.api && window.api.onRemoteTxState) window.api.onRemoteTxState((on) => { if (on && live.size) txState().then((st) => { if (voiceOn(st)) cutAll(); }); });
  // Every other kind of transmission (the radio keyed by hand): asked while a sound plays.
  function watchWhilePlaying() {
    if (watch) return;
    watch = setInterval(async () => {
      if (!live.size) { clearInterval(watch); watch = null; return; }
      if (voiceOn(await txState())) cutAll();
    }, SoundGuard.HOLD_POLL_MS);
  }

  /**
   * One sound, from "it is due" to "it has finished".
   * @param {function} draw  (ctx, out) => seconds: connects its sources to `out`, starts them, says how long they last
   * @param {object} [using]  settings to use instead of the saved ones (the Sounds pane's previews)
   * @returns {Promise<{played: boolean, reason?: string}>}
   */
  async function start(draw, using, opts) {
    const due = Date.now();
    const cfg = QsoSounds.readSettings(using || settings);
    const stale = (opts && opts.stale) || (() => false);
    for (;;) {
      if (stale()) return { played: false, reason: 'replaced' }; // a newer preview took its place
      const st = await txState();
      const d = SoundGuard.decide({
        chosenId: cfg.output, chosenLabel: cfg.outputLabel,
        devices: await outputs(), txDevices: st.txDevices,
        txActive: st.tx, txVoice: st.voice, heldMs: Date.now() - due,
      });
      if (d.action === 'hold') { await sleep(SoundGuard.HOLD_POLL_MS); continue; }
      if (d.action === 'drop') return { played: false, reason: 'transmitting' };
      if (d.action === 'silent') {
        lastStatus = { ok: false, text: d.text, label: '' };
        return { played: false, reason: d.reason };
      }
      lastStatus = { ok: true, text: '', label: d.label };
      if (!(await openOn(d.sinkId))) return { played: false, reason: 'output' };
      const out = ctx.createGain();
      const v = cfg.volume / 100;
      out.gain.value = v * v; // the slider is by ear: half way is a quarter of the power
      out.connect(ctx.destination);
      let wake = null; // ends the wait below when the sound is cut
      // stop(why): why it was cut ('replaced' by a newer preview; a transmission otherwise).
      const handle = {
        preview: !!(opts && opts.preview), cutBy: null,
        stop(why) { if (why && !this.cutBy) this.cutBy = why; try { out.gain.value = 0; out.disconnect(); } catch {} if (wake) wake(); },
      };
      let seconds = 0;
      try { seconds = Number(await draw(ctx, out)) || 0; } catch (err) { console.warn('[Sounds]', err && err.message); handle.stop(); return { played: false, reason: 'error' }; }
      live.add(handle);
      watchWhilePlaying();
      await new Promise((r) => { wake = r; setTimeout(r, Math.ceil(seconds * 1000) + 20); });
      const cut = !live.has(handle);
      live.delete(handle);
      handle.stop();
      return cut ? { played: false, reason: handle.cutBy || 'transmitting' } : { played: true };
    }
  }
  // --- end of start

  /** Put a sound at the end of the queue. */
  function enqueue(draw, using, opts) {
    if (waiting >= MAX_WAITING) return Promise.resolve({ played: false, reason: 'busy' });
    waiting++;
    const run = tail.then(() => start(draw, using, opts)).catch(() => ({ played: false, reason: 'error' })).then((r) => { waiting--; return r; });
    tail = run;
    return run;
  }

  /** Play one of renderer/sounds/*.wav (an id from QsoSounds.FILES). */
  function playFile(id, using) {
    return enqueue(fileDraw(id), using);
  }
  function fileDraw(id) {
    const loaded = loadFile(id);
    return async (c, out) => {
      const buf = await loaded;
      if (!buf) throw new Error('sound file not found: ' + id);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(out);
      src.start();
      return buf.duration;
    };
  }

  /** Play a synthesized chime: draw(ctx, out) connects its oscillators to `out` and returns its length in seconds. */
  function playChime(draw, using) {
    return enqueue(draw, using);
  }

  // The Sounds pane's Play and Hear buttons (Casey 2026-11-24). A new preview
  // replaces the one before it: the one sounding stops at once and one still
  // waiting is skipped, so previews never stack. A real contact sound is not
  // cut by a preview; the preview waits its turn in the queue.
  let previewGen = 0;
  /**
   * @param {{ file?: string, chime?: string }} sound  QsoSounds.previewSound(key)
   * @param {object} using  the pane's unsaved choices (volume, output)
   * @returns {Promise<{played: boolean, reason?: string}>}  reason 'replaced': a newer preview took its place
   */
  function preview(sound, using) {
    const gen = ++previewGen;
    for (const s of [...live]) if (s.preview) { live.delete(s); s.stop('replaced'); }
    let draw = null;
    if (sound && sound.file) draw = fileDraw(sound.file);
    else if (sound && sound.chime && ChimeSounds.notesOf(sound.chime).length) {
      draw = (c, out) => { ChimeSounds.play(c, sound.chime, out); return ChimeSounds.lengthOf(sound.chime); };
    }
    if (!draw) return Promise.resolve({ played: false, reason: 'error' });
    return enqueue(draw, using, { preview: true, stale: () => gen !== previewGen });
  }

  /**
   * For the Sounds pane: the outputs to offer (the radio's sound card left
   * out), where a sound would play now, the line to show when it cannot, and
   * what became of the output the operator chose (SoundGuard.chosenState).
   */
  async function describe(chosenId, chosenLabel) {
    const st = await txState();
    const devices = await outputs();
    const list = SoundGuard.listOutputs(devices, st.txDevices);
    const ask = { chosenId: chosenId || '', chosenLabel: chosenLabel || '', devices, txDevices: st.txDevices };
    return { list, where: SoundGuard.resolveOutput(ask), chosen: SoundGuard.chosenState(ask) };
  }

  window.PotacatSounds = { configure, playFile, playChime, preview, describe, cutAll, status: () => lastStatus };
})();
