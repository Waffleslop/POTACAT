#!/usr/bin/env node
'use strict';
/**
 * Makes every sound file in renderer/sounds/ (#1041): the contact sounds
 * (coin, short coin, dupe, save failed) and the five milestone sounds.
 *
 * Every sample in those files is computed here, from the note lists below, by
 * three oscillators written out in this file: a pulse wave, a triangle wave
 * and a shift-register noise. No recording, no sample library and no audio
 * file is read. The output is the same bytes on every machine: only + - * /
 * and Math.floor / Math.round are used (the note frequencies are a table, so
 * no pow, sin or random), and test/qso-sound-files-test.js renders them again
 * and compares them with the committed files.
 *
 * The milestone sounds follow the operator's reference set note for note
 * (which notes, on which 1/60 s step, on which voice). The coin, the dupe and
 * the save-failed buzz are new, made in the same style.
 *
 * Style: two pulse channels, a triangle and a noise channel, volumes stepped
 * every 1/60 s.
 *
 *   node scripts/make-qso-sounds.js           write renderer/sounds/*.wav
 *   node scripts/make-qso-sounds.js --check   exit 1 when a file differs
 */
const fs = require('fs');
const path = require('path');

const RATE = 44100;       // samples per second
const STEP = 735;         // samples in one 1/60 s step
const OVERSAMPLE = 4;     // waveform points averaged into one sample
const EDGE = 64;          // samples a volume change is spread over (no clicks)
const OUT_DIR = path.join(__dirname, '..', 'renderer', 'sounds');

// Equal temperament, A4 = 440 Hz, to two decimals.
const HZ = {
  A2: 110.00, 'A#2': 116.54,
  C3: 130.81, E3: 164.81, F3: 174.61, G3: 196.00,
  C4: 261.63, 'F#4': 369.99, G4: 392.00, 'G#4': 415.30, 'A#4': 466.16, B4: 493.88,
  C5: 523.25, 'C#5': 554.37, D5: 587.33, 'D#5': 622.25, E5: 659.26, F5: 698.46, 'F#5': 739.99,
  G5: 783.99, 'G#5': 830.61, A5: 880.00, B5: 987.77,
  C6: 1046.50, 'C#6': 1108.73, D6: 1174.66, E6: 1318.51, G6: 1567.98, A6: 1760.00,
  C7: 2093.00,
};

/** n volumes going evenly from a to b. */
function ramp(n, a, b) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(n === 1 ? a : a + (b - a) * i / (n - 1));
  return out;
}
const scale = (vols, k) => vols.map((v) => v * k);

// Volume shapes read off the reference set, one value per 1/60 s step.
const SHORT3 = [1, 0.58, 0.25];
const SHORT5 = [1, 0.75, 0.52, 0.31, 0.12];
const SHORT6 = [1, 0.82, 0.59, 0.38, 0.19, 0.1];
const LONG8 = [1, 0.8, 0.62, 0.46, 0.5, 0.38, 0.25, 0.14];

// Channel levels: the triangle carries the bass, the lead pulse sits over it.
const LEAD = 0.26, HARM = 0.11, BASS = 0.58, ECHO = 0.08;

/**
 * A note: { wave, at, note | hz, vols }.
 *   wave  'p50' | 'p25' | 'p12' (pulse, by duty), 'tri', 'noise'
 *   at    the step it starts on
 *   note  a name in HZ; or hz: one frequency per step, glided between steps;
 *         for noise, hz is the shift register's clock rate
 *   vols  one volume per step
 */
function note(wave, at, name, vols) { return { wave, at, note: name, vols }; }

// --- The contact sounds (new) ----------------------------------------------

// Coin: two quick notes up a fifth. About 0.1 s.
const COIN = { steps: 7, peak: 0.42, notes: [
  note('p25', 0, 'D6', [0.9, 0.7]),
  note('p25', 2, 'A6', [1, 0.7, 0.42, 0.18]),
] };
// The same coin for a pileup: about 0.06 s.
const COIN_SHORT = { steps: 4, peak: 0.42, notes: [
  note('p25', 0, 'D6', [0.9]),
  note('p25', 1, 'A6', [1, 0.45]),
] };
// Dupe: two notes going down.
const DUPE = { steps: 12, peak: 0.42, notes: [
  note('p50', 0, 'A5', [1, 0.8, 0.6, 0.4]),
  note('p50', 5, 'E5', [1, 0.82, 0.64, 0.46, 0.28, 0.12]),
] };
// Save failed: a low buzz, two pulses a semitone apart.
const SAVE_FAILED = { steps: 20, peak: 0.6, notes: [
  note('p25', 0, 'A2', ramp(18, 1, 0.75)),
  note('p50', 0, 'A#2', ramp(18, 0.8, 0.6)),
] };

// --- The milestone sounds (the reference set) ------------------------------

// 10 contacts.
const PICKUP = { steps: 14, peak: 0.89, notes: [
  note('p12', 0, 'A5', [1, 0.45]),
  note('p12', 2, 'E6', ramp(9, 0.62, 0.04)),
] };

// 25 contacts: a rising sweep, then an arpeggio.
const POWER_UP = { steps: 38, peak: 0.89, notes: [
  { wave: 'p25', at: 0, vols: ramp(12, 0.8, 0.03),
    hz: [352, 394, 440, 506, 586, 678, 783, 906, 1047, 1210, HZ.E6, HZ.E6, HZ.E6] },
  note('p12', 12, 'E5', scale([1, 0.69, 0.4], 0.7)),
  note('p12', 15, 'G#5', scale([1, 0.69, 0.4], 0.7)),
  note('p12', 18, 'B5', scale([1, 0.69, 0.4], 0.7)),
  note('p12', 21, 'E6', ramp(14, 0.7, 0.02)),
] };

// 50 contacts.
function stageGet() {
  const notes = [];
  const lead = [['C5', 0], ['E5', 5], ['G5', 10], ['C6', 15], ['G5', 20], ['C6', 25]];
  const up = { C5: 'C6', E5: 'E6', G5: 'G6', C6: 'C7' };
  for (const [n, at] of lead) {
    notes.push(note('p50', at, n, scale(SHORT5, LEAD)));
    notes.push(note('p25', at + 1, up[n], [ECHO, ECHO * 0.7])); // the octave echo
  }
  notes.push(note('p50', 30, 'E6', ramp(20, LEAD * 1.14, LEAD * 0.08)));
  notes.push(note('tri', 0, 'C3', ramp(6, BASS, BASS)));
  notes.push(note('tri', 10, 'G3', ramp(6, BASS, BASS)));
  notes.push(note('tri', 20, 'C4', ramp(6, BASS, BASS)));
  notes.push(note('tri', 30, 'C3', ramp(14, BASS, BASS)));
  return { steps: 55, peak: 0.89, notes };
}

// 100 contacts: a rumble, then the answer.
function bossDown() {
  const notes = [];
  // Two noise voices, one twice the other, fading out together.
  notes.push({ wave: 'noise', at: 0, hz: [3600], vols: ramp(22, 0.4, 0.02) });
  notes.push({ wave: 'noise', at: 0, hz: [2400], vols: ramp(22, 0.2, 0.01) });
  const lead = [['E5', 30, 'C5', 'C3'], ['G5', 37, 'E5', 'E3'], ['C6', 44, 'G5', 'G3'], ['B5', 51, 'G5', 'G3']];
  for (const [n, at, under, bass] of lead) {
    notes.push(note('p50', at, n, scale(SHORT6, LEAD)));
    notes.push(note('p25', at, under, scale(SHORT5, HARM)));
    notes.push(note('tri', at, bass, ramp(5, BASS, BASS)));
  }
  notes.push(note('p50', 58, 'C6', ramp(18, LEAD, LEAD * 0.06)));
  notes.push(note('p25', 58, 'G5', ramp(14, HARM, HARM * 0.25)));
  notes.push(note('tri', 58, 'G3', ramp(19, BASS, BASS)));
  return { steps: 81, peak: 0.89, notes };
}

// 250 contacts: the whole tune, then 73 in Morse.
function worldClear() {
  const notes = [];
  const lead = [
    ['C5', 0, LONG8], ['C5', 8, SHORT3], ['C5', 12, SHORT3],
    ['G5', 16, ramp(15, 1, 0.08)],
    ['F5', 32, LONG8], ['E5', 40, SHORT3], ['D5', 44, SHORT3],
    ['E5', 48, ramp(15, 1, 0.08)],
    ['F5', 64, LONG8], ['G5', 72, SHORT3], ['A5', 76, SHORT3],
    ['B5', 80, LONG8], ['G5', 88, LONG8],
    ['C6', 96, ramp(35, 1, 0.02)],
  ];
  for (const [n, at, vols] of lead) notes.push(note('p50', at, n, scale(vols, LEAD)));
  const under = [
    ['G4', 0, 4], ['G4', 8, 3], ['G4', 12, 2],
    ['E5', 16, 8],
    ['C5', 32, 6], ['C5', 40, 4], ['B4', 44, 2],
    ['C5', 48, 9],
    ['C5', 64, 5], ['E5', 72, 3], ['F5', 76, 2],
    ['G5', 80, 5], ['E5', 88, 4],
    ['G5', 96, 20],
  ];
  for (const [n, at, len] of under) notes.push(note('p25', at, n, ramp(len, HARM, HARM * 0.3)));
  const bass = ['C3', 'C3', 'G3', 'G3', 'F3', 'F3', 'G3', 'G3', 'C3', 'C3', 'C3'];
  bass.forEach((n, i) => notes.push(note('tri', i * 8, n, ramp(6, BASS, BASS))));
  // A quiet sparkle over the last note.
  [['C7', 114], ['G6', 116], ['E6', 118], ['C7', 120]].forEach(([n, at]) => notes.push(note('p12', at, n, [0.03, 0.02])));
  // 73: dah dah dit dit dit, dit dit dit dah dah. One unit is three steps.
  const DAH = ramp(9, 0.075, 0.005), DIT = [0.075, 0.05, 0.022];
  [[134, DAH], [146, DAH], [158, DIT], [164, DIT], [170, DIT],
    [182, DIT], [188, DIT], [194, DIT], [200, DAH], [212, DAH]].forEach(([at, vols]) => notes.push(note('p12', at, 'A5', vols)));
  return { steps: 224, peak: 0.89, notes };
}

/** File name (no extension) to its score. The ids are lib/qso-sounds.js FILES. */
const SOUNDS = {
  'potacat-coin': COIN,
  'potacat-coin-short': COIN_SHORT,
  'potacat-dupe': DUPE,
  'potacat-save-failed': SAVE_FAILED,
  'potacat-010-pickup': PICKUP,
  'potacat-025-power-up': POWER_UP,
  'potacat-050-stage-get': stageGet(),
  'potacat-100-boss-down': bossDown(),
  'potacat-250-world-clear': worldClear(),
};

const DUTY = { p50: 0.5, p25: 0.25, p12: 0.125 };

/** Add one note to the buffer. */
function addNote(buf, n) {
  const steps = n.vols.length;
  const start = n.at * STEP;
  const len = steps * STEP + EDGE; // the last volume falls to nothing over EDGE samples
  const fixed = n.note ? HZ[n.note] : null;
  if (n.note && !fixed) throw new Error('no frequency for ' + n.note);
  const duty = DUTY[n.wave];
  let phase = 0;       // 0..1 through one cycle
  let reg = 1;         // the noise shift register (15 bits)
  let clock = 0;       // the noise clock's phase
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const step = Math.floor(i / STEP);
    const into = i - step * STEP;
    // Volume: this step's, eased in from the step before over EDGE samples.
    const now = step < steps ? n.vols[step] : 0;
    const before = step === 0 ? 0 : n.vols[step - 1];
    const vol = into < EDGE ? before + (now - before) * into / EDGE : now;
    // Frequency: fixed, or glided from this step's value to the next.
    let hz = fixed;
    if (!hz) {
      const a = n.hz[Math.min(step, n.hz.length - 1)];
      const b = n.hz[Math.min(step + 1, n.hz.length - 1)];
      hz = n.wave === 'noise' ? a : a + (b - a) * into / STEP;
    }
    let sum = 0;
    const inc = hz / (RATE * OVERSAMPLE);
    for (let k = 0; k < OVERSAMPLE; k++) {
      if (n.wave === 'noise') {
        clock += inc;
        if (clock >= 1) {
          clock -= 1;
          const bit = (reg ^ (reg >> 1)) & 1;
          reg = (reg >> 1) | (bit << 14);
        }
        sum += (reg & 1) ? 1 : -1;
      } else {
        phase += inc;
        if (phase >= 1) phase -= 1;
        if (n.wave === 'tri') sum += phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
        else sum += (phase < duty ? 1 : -1) - (2 * duty - 1); // no DC: a pulse sits around zero
      }
    }
    buf[start + i] += vol * sum / OVERSAMPLE;
  }
}

/** A score to 16-bit samples, its loudest sample at score.peak of full scale. */
function render(score) {
  const buf = new Float64Array(score.steps * STEP);
  for (const n of score.notes) addNote(buf, n);
  let top = 0;
  for (let i = 0; i < buf.length; i++) { const a = buf[i] < 0 ? -buf[i] : buf[i]; if (a > top) top = a; }
  const k = top > 0 ? score.peak * 32767 / top : 0;
  const pcm = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) pcm[i] = Math.round(buf[i] * k);
  return pcm;
}

/** 16-bit mono PCM in a WAV container. */
function wav(pcm) {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);        // PCM
  out.writeUInt16LE(1, 22);        // mono
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28); // bytes per second
  out.writeUInt16LE(2, 32);        // bytes per sample
  out.writeUInt16LE(16, 34);       // bits
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], 44 + i * 2);
  return out;
}

/** Every file: [{ name: 'potacat-coin.wav', bytes: Buffer, seconds }]. */
function build() {
  return Object.keys(SOUNDS).map((id) => {
    const pcm = render(SOUNDS[id]);
    return { name: id + '.wav', bytes: wav(pcm), seconds: pcm.length / RATE };
  });
}

module.exports = { RATE, STEP, SOUNDS, OUT_DIR, render, wav, build };

if (require.main === module) {
  const check = process.argv.includes('--check');
  let differ = 0;
  for (const f of build()) {
    const file = path.join(OUT_DIR, f.name);
    if (check) {
      const same = fs.existsSync(file) && fs.readFileSync(file).equals(f.bytes);
      if (!same) differ++;
      console.log((same ? 'same    ' : 'DIFFERS ') + f.name);
    } else {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(file, f.bytes);
      console.log(`${f.name}  ${f.seconds.toFixed(3)} s  ${f.bytes.length} bytes`);
    }
  }
  if (check && differ) { console.error(`${differ} file(s) differ: run node scripts/make-qso-sounds.js`); process.exit(1); }
}
