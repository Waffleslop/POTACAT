// Modem audio bridge — playback side. The modem's TX audio arrives as 24 kHz
// Float32 chunks and lands in a ring buffer; process() drains it with linear
// interpolation to the AudioContext's native rate.
//
// Where it comes from (#187): straight from the modem audio lane
// (lib/modem-audio-lane.js) on a MessagePort handed to THIS worklet, so the
// audio thread receives it with no main-process or page thread in between.
// The older path (chunks posted by the page) still works the same.
//
// Survives a stall upstream (docs/ardop-macos-plan.md L4): each over is
// held back until PREBUFFER_MS of it is queued (or its audio stopped coming,
// a short frame), then played; the ring holds RING_MS. The lane never sends
// more than the ring holds (it is told what is queued after every chunk), so
// nothing is dropped here; if something must be, it is counted and reported.
class ModemPlayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = opts.sourceRate || 24000;
    this.targetRate = sampleRate;
    this.step = this.sourceRate / this.targetRate;
    this.bufSize = Math.ceil(this.sourceRate * (opts.ringMs != null ? opts.ringMs : 2000) / 1000);
    this.prebuffer = Math.round(this.sourceRate * (opts.prebufferMs != null ? opts.prebufferMs : 250) / 1000);
    // A frame shorter than the pre-buffer starts when its PTT-off arrives (the
    // drain); this is only the backstop. It must outlast a stall, or late audio
    // inside a long frame would start it early and leave holes.
    this.idleStartFrames = Math.round(this.targetRate * ((opts.prebufferMs != null ? opts.prebufferMs : 250) + 50) / 1000);
    this.buf = new Float32Array(this.bufSize);
    this.bufRead = 0; this.bufWrite = 0; this.bufAvailable = 0;
    this.fracPos = 0;
    this.underruns = 0; this.overflows = 0; this.droppedTotal = 0;
    this.lane = null; this.lastSeq = 0; this.reportEvery = 8; this.quanta = 0;
    // One over (key-down to carrier drop): silence between two stretches of
    // audio is a hole in the frame; audio that had to be dropped is a cut.
    this.over = null;
    this.port.onmessage = (e) => this.onMsg(e.data, e.ports);
  }
  newOver() {
    return { seen: false, pending: 0, gaps: 0, gapFrames: 0, dropped: 0, holding: this.prebuffer > 0, sinceAudio: 0, ending: false, leave: 0 };
  }
  report(o) {
    return { gaps: o.gaps, gapMs: o.gapFrames * 1000 / this.targetRate, droppedMs: o.dropped * 1000 / this.sourceRate };
  }
  post(m) {
    if (this.lane) { try { this.lane.postMessage(m); } catch (e) { /* lane gone */ } }
    else this.port.postMessage(m);
  }
  closeOver(drained) {
    const o = this.over; this.over = null;
    const bad = o && (o.gaps || o.dropped);
    if (drained) this.post({ drained: true, over: bad ? this.report(o) : null, q: this.bufAvailable, seq: this.lastSeq });
    else if (bad) this.post({ over: this.report(o) });
  }
  onMsg(msg, ports) {
    if (msg && msg.cmd === 'lane' && ports && ports[0]) {
      this.lane = ports[0];
      this.lane.onmessage = (e) => this.onMsg(e.data);
      this.post({ q: this.bufAvailable, seq: this.lastSeq, cap: this.bufSize }); // the lane never sends more than this holds
      return;
    }
    if (msg && msg.cmd === 'over-start') { this.over = this.newOver(); return; }
    if (msg && msg.cmd === 'over-end') {
      // drain: play what is queued (all but `leave` samples), then say so.
      if (msg.drain && this.over) { this.over.ending = true; this.over.leave = msg.leave || 0; this.over.holding = false; this.checkDrained(); return; }
      if (msg.drain) { this.post({ drained: true, over: null, q: this.bufAvailable, seq: this.lastSeq }); return; }
      this.closeOver(false);
      return;
    }
    if (msg && msg.cmd === 'cancel-end') { if (this.over) this.over.ending = false; return; }
    if (msg && msg.cmd === 'reset') { this.bufRead = this.bufWrite = this.bufAvailable = 0; this.fracPos = 0; return; }
    if (msg && msg.cmd === 'stats') { this.post({ stats: { underruns: this.underruns, overflows: this.overflows, queued: this.bufAvailable, droppedMs: this.droppedTotal * 1000 / this.sourceRate } }); return; }
    let pcm = msg, seq = null;
    if (msg && msg.pcm) { pcm = msg.pcm; seq = msg.seq; }
    if (!pcm || !pcm.length) return;
    if (this.bufAvailable + pcm.length > this.bufSize) {
      // Never by design from the lane (it waits for room); the page path can.
      const drop = (this.bufAvailable + pcm.length) - this.bufSize;
      this.bufRead = (this.bufRead + drop) % this.bufSize;
      this.bufAvailable -= drop;
      this.overflows++;
      this.droppedTotal += drop;
      if (this.over) this.over.dropped += drop;
    }
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.bufWrite] = pcm[i];
      this.bufWrite = (this.bufWrite + 1) % this.bufSize;
    }
    this.bufAvailable += pcm.length;
    if (this.over) this.over.sinceAudio = 0;
    if (seq != null) { this.lastSeq = seq; this.post({ q: this.bufAvailable, seq }); }
  }
  checkDrained() {
    const o = this.over;
    if (o && o.ending && this.bufAvailable <= Math.max(1, o.leave)) this.closeOver(true);
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const o = this.over;
    if (o && o.holding) {
      o.sinceAudio += out.length;
      if (this.bufAvailable >= this.prebuffer || (this.bufAvailable > 0 && o.sinceAudio >= this.idleStartFrames)) o.holding = false;
      else { out.fill(0); return true; }
    }
    for (let i = 0; i < out.length; i++) {
      if (this.bufAvailable < 2) {
        out[i] = 0;
        if (this.bufAvailable === 0) this.underruns++;
        if (this.over && this.over.seen) this.over.pending++; // dry after audio: a hole if more audio follows, the tail if not
        continue;
      }
      if (this.over) {
        if (this.over.pending) { this.over.gaps++; this.over.gapFrames += this.over.pending; this.over.pending = 0; }
        this.over.seen = true;
      }
      const i0 = this.bufRead, i1 = (this.bufRead + 1) % this.bufSize;
      out[i] = this.buf[i0] + (this.buf[i1] - this.buf[i0]) * this.fracPos;
      this.fracPos += this.step;
      while (this.fracPos >= 1 && this.bufAvailable > 1) {
        this.fracPos -= 1;
        this.bufRead = (this.bufRead + 1) % this.bufSize;
        this.bufAvailable--;
      }
    }
    if (this.over && this.over.ending) this.checkDrained();
    // Tell the lane how much is queued now and then, so it can send more.
    if (this.lane && ++this.quanta >= this.reportEvery) { this.quanta = 0; this.post({ q: this.bufAvailable, seq: this.lastSeq }); }
    return true;
  }
}
registerProcessor('modem-play', ModemPlayProcessor);
