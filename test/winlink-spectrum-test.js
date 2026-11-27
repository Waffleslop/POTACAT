'use strict';
// The Winlink waterfall's shared rules: lib/winlink-spectrum.js (band markers,
// the Busy / Clear detector, the wire bins). Run: node test/winlink-spectrum-test.js
const assert = require('assert');
const S = require('../lib/winlink-spectrum');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

function tone(hz, rate, seconds, amp, noise) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * i / rate) + noise * rnd();
  return out;
}
// A modem-width signal: carriers every 25 Hz across the band (what an ARDOP
// frame looks like on the waterfall). The Busy rule is the 90th percentile of
// the band, so a lone tone is deliberately NOT busy — a carrier is not a modem.
function modem(centerHz, bwHz, rate, seconds, amp, noise) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const tones = [];
  for (let hz = centerHz - bwHz / 2; hz <= centerHz + bwHz / 2; hz += 25) tones.push(hz);
  for (let i = 0; i < n; i++) {
    let v = noise * rnd();
    for (let t = 0; t < tones.length; t++) v += (amp / tones.length) * Math.sin(2 * Math.PI * tones[t] * i / rate + t);
    out[i] = v;
  }
  return out;
}
function framesOf(pcm, rate) {
  const frames = [];
  const acc = new S.SpectrumAccumulator((m) => frames.push(Float32Array.from(m)));
  acc.push(pcm, rate);
  return frames;
}
// Feed the same frame for `ms` at the shack's cadence (85 ms per frame); returns the last verdict.
function feed(det, frame, from, ms) {
  let v = null;
  for (let t = from; t <= from + ms; t += 85) v = det.update(frame, t);
  return v;
}
const NOISE = framesOf(tone(1500, 24000, 0.4, 0, 0.02), 24000)[1];
const MODEM = framesOf(modem(1500, 500, 24000, 0.4, 0.3, 0.02), 24000)[1];
const CARRIER = framesOf(tone(1500, 24000, 0.4, 0.3, 0.02), 24000)[1];

console.log('winlink-spectrum');
test('a 1500 Hz tone lands in the middle of the span, at 24 kHz and at 48 kHz alike', () => {
  for (const rate of [24000, 48000]) {
    const frames = framesOf(tone(1500, rate, 0.5, 0.3, 0.001), rate);
    assert.ok(frames.length >= 4, `frames at ${rate}`);
    const m = frames[2];
    let peak = 0; for (let b = 1; b < m.length; b++) if (m[b] > m[peak]) peak = b;
    assert.ok(Math.abs(peak - 128) <= 1, `peak bin ${peak} at ${rate} Hz`);
    const wire = S.wireBins(m);
    assert.strictEqual(wire.length, S.WIRE_BINS);
    let wpeak = 0; for (let b = 1; b < wire.length; b++) if (wire[b] > wire[wpeak]) wpeak = b;
    assert.ok(wpeak === 63 || wpeak === 64, 'wire peak ' + wpeak);
    assert.ok(wire[wpeak] > 200 && wire[10] < 90, `scaled ${wire[wpeak]} / ${wire[10]}`);
  }
});

test('busy: a modem in the band says Busy once it has lasted 150 ms, holds 4 s past the last frame, then Clear', () => {
  const band = S.markerBand('ardop', { ardop: 500 });
  const det = new S.BusyDetector(band.lo, band.hi);
  assert.strictEqual(det.update(MODEM, 1000).busy, false, 'one frame is not a signal');
  const v = feed(det, MODEM, 1085, 300);
  assert.strictEqual(v.busy, true, 'sustained');
  assert.ok(v.peakDb >= S.BUSY_DB, 'peak ' + v.peakDb);
  assert.strictEqual(feed(det, NOISE, 1500, 3500).busy, true, 'held through 3.5 s of noise');
  assert.strictEqual(det.update(NOISE, 1500 + 4100).busy, false, 'released after the hold');
  // A tone OUTSIDE the marked band is not Busy for this modem.
  const off = framesOf(modem(2400, 500, 24000, 0.4, 0.3, 0.02), 24000)[1];
  assert.strictEqual(feed(new S.BusyDetector(band.lo, band.hi), off, 1000, 600).busy, false, 'off-band modem');
  // Noise alone, at any level, is Clear (like compared with like).
  for (const lvl of [0.002, 0.02, 0.2]) {
    const noise = framesOf(tone(1500, 24000, 0.6, 0, lvl), 24000);
    const d = new S.BusyDetector(band.lo, band.hi);
    let t = 1000;
    for (const f of noise) { assert.strictEqual(d.update(f, t).busy, false, 'noise ' + lvl); t += 85; }
  }
  // A strong lone carrier in the band (CW, somebody tuning) IS busy; a weak one is not a modem.
  assert.strictEqual(feed(new S.BusyDetector(band.lo, band.hi), CARRIER, 1000, 300).busy, true, 'strong carrier');
  const weak = framesOf(tone(1500, 24000, 0.4, 0.004, 0.02), 24000)[1];
  assert.strictEqual(feed(new S.BusyDetector(band.lo, band.hi), weak, 1000, 600).busy, false, 'weak carrier');
});

test('busy does not blink: a static crash is one frame, and a signal fading through the threshold stays Busy', () => {
  const band = S.markerBand('ardop', { ardop: 500 });
  const det = new S.BusyDetector(band.lo, band.hi);
  // crashes: single hot frames 1 s apart in noise never enter
  let t = 1000, flips = 0, last = false;
  for (let i = 0; i < 60; i++, t += 85) {
    const v = det.update(i % 12 === 0 ? MODEM : NOISE, t);
    if (v.busy !== last) { flips++; last = v.busy; }
  }
  assert.strictEqual(flips, 0, 'crashes flipped the badge ' + flips + ' times');
  // a marginal signal: alternate a frame just over the enter threshold with one just under it → enters once, stays
  const strong = framesOf(modem(1500, 500, 24000, 0.4, 0.3, 0.02), 24000)[1];
  const marginal = framesOf(modem(1500, 500, 24000, 0.4, 0.09, 0.02), 24000)[1]; // ~6 dB: under enter, over stay
  const d2 = new S.BusyDetector(band.lo, band.hi);
  feed(d2, strong, 1000, 300);
  let flips2 = 0, was = true;
  for (let i = 0, tt = 1400; i < 100; i++, tt += 85) {
    const v = d2.update(i % 2 ? strong : marginal, tt);
    if (v.busy !== was) { flips2++; was = v.busy; }
  }
  assert.strictEqual(flips2, 0, 'a fading signal flipped the badge ' + flips2 + ' times');
  assert.strictEqual(d2.busy, true);
});

test('busy: a wide band whose outside is only the receiver filter skirt reads Clear on noise once the floor is tracked', () => {
  const band = S.markerBand('vara', { vara: 2750 }); // outside = 0–125 Hz and 2875–3000 Hz
  // noise inside the receiver passband, nothing in the skirts: the outside bins are far below the band
  const skirt = Float32Array.from(NOISE, (v, b) => (b < 12 || b > 244 ? v - 6 : v)); // 26 dB down outside
  const det = new S.BusyDetector(band.lo, band.hi);
  const v = feed(det, skirt, 1000, S.FLOOR_WARM_MS + 5000);
  assert.strictEqual(v.busy, false, 'noise with deep skirts is Clear');
  // and a modem filling that band, after the floor is tracked on noise, is still Busy
  const wide = framesOf(modem(1500, 2300, 24000, 0.4, 0.4, 0.02), 24000)[1];
  const v2 = feed(det, wide, 1000 + S.FLOOR_WARM_MS + 5100, 400);
  assert.strictEqual(v2.busy, true, 'a wide modem over the tracked floor is Busy');
});

// #1096: a strong block OUTSIDE the band (an operator's radio with its receive
// filter sitting at about 650-1300 Hz, below ARDOP's 1250-1750 Hz) lifted the
// old reference 70 dB, so the badge read Clear while the modem read Busy.
const DB = 1 / 4.3429; // dB → ln
// Raise bins [from, to] of a frame by `db`, with a skirt falling `skirtDb` per bin
// on each side (the recording's skirt is ~4 dB per bin).
function withBlock(frame, fromHz, toHz, db, skirtDb) {
  const out = Float32Array.from(frame);
  const lo = Math.round(fromHz / (3000 / 256)), hi = Math.round(toHz / (3000 / 256));
  for (let b = 0; b < out.length; b++) {
    const away = b < lo ? lo - b : b > hi ? b - hi : 0;
    const lift = Math.max(0, db - away * skirtDb);
    if (lift > 0) out[b] = Math.max(out[b], frame[b] + lift * DB);
  }
  return out;
}
function noiseFrames(count, lvl) { return framesOf(tone(1500, 24000, (count + 2) * 2048 / 24000, 0, lvl || 0.02), 24000).slice(1, count + 1); }
// Feed a list of frames round and round for `ms`; returns {last, busyFrames, total}.
function feedCycle(det, frames, from, ms) {
  let v = null, busy = 0, total = 0;
  for (let t = from, i = 0; t <= from + ms; t += 85, i++) { v = det.update(frames[i % frames.length], t); total++; if (v.busy) busy++; }
  return { last: v, busyFrames: busy, total: total };
}
const ARDOP = S.markerBand('ardop', { ardop: 500 });
const RECORDING = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'winlink', 'rx-filter-below-ardop-band.json'), 'utf8'));

test('#1096 recording: the receive filter edge in the ARDOP band reads Busy, as the modem read it (the old reference read Clear)', () => {
  assert.strictEqual(RECORDING.frames.length, 12);
  assert.ok(RECORDING.frames.every((f) => f.length === S.MAGS));
  const frames = RECORDING.frames.map((f) => Float32Array.from(f));
  const r = feedCycle(new S.BusyDetector(ARDOP.lo, ARDOP.hi), frames, 1000, 6000);
  assert.strictEqual(r.last.busy, true, 'the band with the filter edge in it is Busy');
  assert.ok(r.last.peakDb >= S.CARRIER_DB, 'peak ' + r.last.peakDb);
  assert.ok(r.busyFrames >= r.total - 3, 'Busy from the first 150 ms on: ' + r.busyFrames + '/' + r.total);
});

test('#1096 synthetic: a 70 dB block below the band with its skirt in the band is Busy; a narrow signal beside a block is Busy', () => {
  const noise = noiseFrames(12);
  const edge = noise.map((f) => withBlock(f, 650, 1300, 70, 4)); // the recording's shape
  assert.strictEqual(feedCycle(new S.BusyDetector(ARDOP.lo, ARDOP.hi), edge, 1000, 6000).last.busy, true, 'filter edge in the band');
  // a signal 150 Hz wide in the band (under half of it), beside a 70 dB block that stops 100 Hz short of the band
  const narrow = framesOf(modem(1425, 150, 24000, 1.2, 0.3, 0.02), 24000).slice(1, 12);
  const beside = narrow.map((f) => withBlock(f, 650, 1150, 70, 6));
  assert.strictEqual(feedCycle(new S.BusyDetector(ARDOP.lo, ARDOP.hi), beside, 1000, 6000).last.busy, true, 'narrow signal beside a block');
  // (a modem filling more than half the band lifts the band's own median, and the earlier rule decides, as before #1096)
});

test('#1096: a truly quiet ARDOP band with a strong block just outside it reads Clear, before and after the floor is tracked', () => {
  const noise = noiseFrames(12);
  const outside = noise.map((f) => withBlock(f, 650, 1150, 70, 6)); // skirt gone by ~1220 Hz, the band starts at 1250 Hz
  const det = new S.BusyDetector(ARDOP.lo, ARDOP.hi);
  const r = feedCycle(det, outside, 1000, S.FLOOR_WARM_MS + 8000);
  assert.strictEqual(r.busyFrames, 0, 'never Busy: ' + r.busyFrames + '/' + r.total);
  // the same above the band, and a block on both sides
  const above = noise.map((f) => withBlock(f, 1850, 2600, 60, 6));
  assert.strictEqual(feedCycle(new S.BusyDetector(ARDOP.lo, ARDOP.hi), above, 1000, 6000).busyFrames, 0, 'block above');
  const both = noise.map((f) => withBlock(withBlock(f, 300, 1150, 50, 6), 1850, 2700, 50, 6));
  assert.strictEqual(feedCycle(new S.BusyDetector(ARDOP.lo, ARDOP.hi), both, 1000, 6000).busyFrames, 0, 'blocks either side');
});

test('busyBadge: the detector\'s verdict, and the modem\'s while Pat\'s busy-channel prompt is up (#1096)', () => {
  assert.deepStrictEqual(S.busyBadge(null, null), { state: 'idle', text: '\u2014', title: '', source: 'detector' });
  assert.strictEqual(S.busyBadge({ busy: false, peakDb: 0 }, {}).text, 'Clear');
  assert.strictEqual(S.busyBadge({ busy: false, peakDb: 0 }, {}).state, 'clear');
  assert.strictEqual(S.busyBadge({ busy: true, peakDb: 23 }, { prompt: null }).text, 'BUSY +23 dB');
  const prompt = { prompt: { id: 'p1', kind: 'busy-channel', message: 'busy' } };
  // the contradiction from the report: our check says Clear, the modem is busy
  const b = S.busyBadge({ busy: false, peakDb: 0 }, prompt);
  assert.strictEqual(b.state, 'busy');
  assert.strictEqual(b.text, 'Busy (modem)');
  assert.ok(/modem hears the channel as busy/.test(b.title) && /own check hears nothing/.test(b.title), b.title);
  const agree = S.busyBadge({ busy: true, peakDb: 41 }, prompt);
  assert.strictEqual(agree.text, 'Busy (modem)');
  assert.ok(/agrees: a signal 41 dB/.test(agree.title), agree.title);
  assert.strictEqual(S.busyBadge(null, prompt).text, 'Busy (modem)', 'before the first frame too');
  // any other prompt is not a busy reading
  assert.strictEqual(S.busyBadge({ busy: false, peakDb: 0 }, { prompt: { id: 'p2', kind: 'password' } }).text, 'Clear');
  for (const x of [b, agree]) assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(x.text + x.title), 'no emoji');
});

test('busyBadge says whose verdict it is: modem during the busy prompt, detector otherwise (#1096, the phone\'s badge)', () => {
  const prompt = { prompt: { id: 'p1', kind: 'busy-channel', message: 'busy' } };
  assert.strictEqual(S.busyBadge({ busy: false, peakDb: 0 }, prompt).source, 'modem');
  assert.strictEqual(S.busyBadge({ busy: true, peakDb: 30 }, prompt).source, 'modem');
  assert.strictEqual(S.busyBadge(null, prompt).source, 'modem');
  assert.strictEqual(S.busyBadge({ busy: true, peakDb: 30 }, {}).source, 'detector');
  assert.strictEqual(S.busyBadge({ busy: false, peakDb: 0 }, { prompt: null }).source, 'detector');
  assert.strictEqual(S.busyBadge({ busy: false, peakDb: 0 }, { prompt: { id: 'p2', kind: 'password' } }).source, 'detector');
  // the wire carries the whole object: four plain fields, nothing else
  assert.deepStrictEqual(Object.keys(S.busyBadge({ busy: true, peakDb: 30 }, {})).sort(), ['source', 'state', 'text', 'title']);
  assert.deepStrictEqual(Object.keys(S.busyBadge({ busy: false, peakDb: 0 }, prompt)).sort(), ['source', 'state', 'text', 'title']);
});

test('the mail window draws the badge from busyBadge, on every frame and every session push', () => {
  const popout = require('./_src').readSrc(require('path').join(__dirname, '..', 'renderer', 'winlink-popout.js'));
  assert.ok(/var b = WinlinkSpectrum\.busyBadge\(busyLast, state && state\.session\);/.test(popout));
  assert.ok(/window\.api\.onSession\(function \(ss\) \{[^\n]*busyRender\(\); \}\);/.test(popout), 'a session push redraws it');
  assert.ok(!/BUSY \+' \+ v\.peakDb/.test(popout), 'no second copy of the wording in the window');
});

test('marker bands follow the mode and each modem\'s own bandwidth, labelled center', () => {
  assert.deepStrictEqual(S.markerBand('ardop', { ardop: 2000 }), { lo: 500 / 3000, hi: 2500 / 3000, label: 'ARDOP center 1500 Hz, 2000 Hz wide' });
  assert.strictEqual(S.markerBand('ardop', {}).lo, 1250 / 3000);
  assert.strictEqual(S.markerBand('vara', { vara: 2300 }).label, 'VARA HF center 1500 Hz, 2300 Hz wide');
  assert.strictEqual(S.markerBand('vara', { vara: 2750 }).hi, 2875 / 3000);
  assert.strictEqual(S.markerBand('vara', undefined).label, 'VARA HF center 1500 Hz, 2300 Hz wide');
  assert.strictEqual(S.markerBand('mercury', { mercury: 500 }).label, 'Mercury center 1500 Hz, 500 Hz wide');
  assert.strictEqual(S.markerBand('varafm').label, 'VARA FM, the whole audio passband');
  assert.strictEqual(S.markerBand('packet').label, 'Packet tones 1200 / 2200 Hz');
  assert.strictEqual(S.markerBand('telnet', { ardop: 500 }).label, 'ARDOP center 1500 Hz, 500 Hz wide');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
