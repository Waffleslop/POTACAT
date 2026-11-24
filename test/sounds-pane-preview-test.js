#!/usr/bin/env node
'use strict';
// Settings > Sounds: hear a sound before you pick it (Casey 2026-11-24: "I go
// to Sound: Coin ... and I can't hear what the sounds will sound like. Give it
// a play button.").
//
// Pins:
//   - lib/qso-sounds.js previewSound(): which sound each Play / Hear button plays
//     (the select's choice, not always the coin; Dupe, Not saved, each milestone);
//   - the pane: Play beside "Sound:", the Hear row with its exact labels, an
//     aria-label on each, real <button>s (keyboard), no Test button, no emoji;
//   - renderer/sounds.js preview(), run for real in a vm with a fake audio
//     device: it plays at the pane's unsaved volume and output, through the
//     transmit guard, and a new preview replaces the one before (never stacks);
//   - app.js: the select's change, the Volume slider's change (not input) and
//     every button play through PotacatSounds.preview with the pane's choices.
// Run: node test/sounds-pane-preview-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const Q = require('../lib/qso-sounds');

const root = path.join(__dirname, '..');
const html = readSrc(path.join(root, 'renderer', 'index.html'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const soundsSrc = readSrc(path.join(root, 'renderer', 'sounds.js'));
const css = readSrc(path.join(root, 'renderer', 'styles.css'));
const pane = (() => {
  const i = html.indexOf('data-settings-tab="sounds"');
  return html.slice(i, html.indexOf('</fieldset>', i));
})();

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Results made inside the vm have its own Object prototype: compare as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
console.log('Sounds pane previews: which sound each button plays');

test('Play plays the sound chosen in the select, not always the coin', () => {
  assert.strictEqual(typeof Q.previewSound, 'function', 'QsoSounds.previewSound exists');
  assert.deepStrictEqual(Q.previewSound('coin'), { file: Q.COIN });
  assert.deepStrictEqual(Q.previewSound('soft'), { chime: 'soft' });
  assert.deepStrictEqual(Q.previewSound('twotone'), { chime: 'twotone' });
  assert.deepStrictEqual(Q.previewSound('bell'), { chime: 'bell' });
  assert.deepStrictEqual(Q.previewSound('morse-r'), { chime: 'morse-r' });
  assert.deepStrictEqual(Q.previewSound(''), { file: Q.COIN }, 'nothing picked is the coin');
  assert.deepStrictEqual(Q.previewSound('off'), { file: Q.COIN }, 'as a contact plays it');
});

test('each Hear button maps to its own sound', () => {
  assert.deepStrictEqual(Q.previewSound('dupe'), { file: 'potacat-dupe' });
  assert.deepStrictEqual(Q.previewSound('save-failed'), { file: 'potacat-save-failed' });
  assert.deepStrictEqual(Q.previewSound('10'), { file: 'potacat-010-pickup' });
  assert.deepStrictEqual(Q.previewSound('25'), { file: 'potacat-025-power-up' });
  assert.deepStrictEqual(Q.previewSound('50'), { file: 'potacat-050-stage-get' });
  assert.deepStrictEqual(Q.previewSound('100'), { file: 'potacat-100-boss-down' });
  assert.deepStrictEqual(Q.previewSound('250'), { file: 'potacat-250-world-clear' });
  for (const k of ['dupe', 'save-failed', '10', '25', '50', '100', '250']) {
    assert.ok(Q.FILES.includes(Q.previewSound(k).file), k + ' is a shipped file');
  }
});

// ---------------------------------------------------------------------------
console.log('Sounds pane previews: the pane');

function buttonsIn(src) {
  const out = [];
  const re = /<button\b([^>]*)>([^<]*)<\/button>/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    const attr = (n) => { const a = new RegExp('\\b' + n + '="([^"]*)"').exec(attrs); return a ? a[1] : null; };
    out.push({ attrs, text: m[2], id: attr('id'), sound: attr('data-sound'), aria: attr('aria-label'), type: attr('type'), cls: attr('class') });
  }
  return out;
}

test('a Play button right beside the Sound select', () => {
  const sel = pane.indexOf('<select id="set-qso-chime">');
  assert.ok(sel > 0);
  const after = pane.slice(pane.indexOf('</select>', sel), pane.indexOf('</select>', sel) + 300);
  const b = buttonsIn(after)[0];
  assert.ok(b, 'a button follows the select');
  assert.strictEqual(b.text, 'Play');
  assert.strictEqual(b.id, 'set-qso-chime-play');
  assert.strictEqual(b.type, 'button');
  assert.strictEqual(b.aria, 'Play the chosen sound');
  assert.ok(/<label for="set-qso-chime">Sound:<\/label>/.test(pane), 'the select keeps its label');
});

test('the old Test button is gone', () => {
  assert.ok(!/id="set-qso-chime-test"/.test(html));
  assert.ok(!buttonsIn(pane).some((b) => b.text === 'Test'));
  assert.ok(!/set-qso-chime-test|setQsoChimeTest|testSoundsPane/.test(app));
});

test('the Hear row: Dupe, Not saved, 10, 25, 50, 100, 250, under the milestone help', () => {
  const help = pane.indexOf('At 1, 10, 25, 50, 100 and 250 contacts in a UTC day');
  const row = pane.indexOf('class="sounds-row sounds-hear"');
  assert.ok(help > 0 && row > help, 'after the milestone help text');
  assert.ok(row < pane.indexOf('Volume:'), 'and before Volume');
  const rowSrc = pane.slice(row, pane.indexOf('</div>', row));
  assert.ok(/<span class="sounds-hear-label">Hear:<\/span>/.test(rowSrc));
  const bs = buttonsIn(rowSrc);
  assert.deepStrictEqual(bs.map((b) => b.text), ['Dupe', 'Not saved', '10', '25', '50', '100', '250']);
  assert.deepStrictEqual(bs.map((b) => b.sound), ['dupe', 'save-failed', '10', '25', '50', '100', '250']);
  assert.deepStrictEqual(bs.map((b) => b.aria), [
    'Play the dupe sound, two falling notes',
    'Play the not saved sound, a low buzz',
    'Play the 10 contacts tune',
    'Play the 25 contacts tune',
    'Play the 50 contacts tune',
    'Play the 100 contacts tune',
    'Play the 250 contacts tune',
  ]);
  for (const b of bs) {
    assert.strictEqual(b.type, 'button', b.text + ' is a real button (keyboard)');
    assert.ok(!/tabindex="-1"/.test(b.attrs), b.text + ' is in the tab order');
    assert.strictEqual(b.cls, 'btn btn-sm', b.text + ' uses the Settings small button');
  }
  assert.ok(/role="group" aria-label="Hear the other sounds"/.test(rowSrc));
});

test('the rows wrap at narrow widths, and nothing in the pane is an emoji', () => {
  assert.ok(/\.sounds-pane \.sounds-row \{[^}]*flex-wrap: wrap;/.test(css), 'sounds rows wrap');
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿▶⏵]/u.test(pane), 'no emoji, no play glyph');
});

// ---------------------------------------------------------------------------
console.log('Sounds pane previews: app.js wiring');

test('every preview goes through PotacatSounds.preview with the pane\'s unsaved choices', () => {
  const i = app.indexOf('function soundsPaneUsing()');
  assert.ok(i > 0, 'soundsPaneUsing exists');
  const fn = app.slice(i, app.indexOf('\n}\n', i));
  assert.ok(/\.\.\.soundSettings, \.\.\.readSoundsPane\(\)/.test(fn), 'saved settings overlaid with the pane as it is now');
  const p = app.indexOf('async function previewSoundsPane(');
  assert.ok(p > 0, 'previewSoundsPane exists');
  const body = app.slice(p, app.indexOf('\n}\n', p));
  assert.ok(/PotacatSounds\.preview\(QsoSounds\.previewSound\(key\), using\)/.test(body));
  assert.ok(!/audioCtx|new AudioContext|ChimeSounds\.play/.test(body), 'no way round the guard');
});

test('Play, a new choice in the select, the Volume slider released and each Hear button all play', () => {
  assert.ok(/setQsoChimePlay\.addEventListener\('click', \(\) => previewSoundsPane\(setQsoChime\.value\)\)/.test(app), 'Play');
  assert.ok(/setQsoChime\.addEventListener\('change', \(\) => previewSoundsPane\(setQsoChime\.value\)\)/.test(app), 'the select, like a ringtone picker');
  assert.ok(/soundsPane\.volume\.addEventListener\('change', \(\) => previewSoundsPane\(setQsoChime \? setQsoChime\.value : 'coin'\)\)/.test(app), 'the slider, once, on release');
  assert.ok(!/soundsPane\.volume\.addEventListener\('input', [^\n]*preview/.test(app), 'not on every input step');
  assert.ok(/querySelectorAll\('\.sounds-hear \[data-sound\]'\)\.forEach\(\(b\) => b\.addEventListener\('click', \(\) => previewSoundsPane\(b\.dataset\.sound\)\)\)/.test(app), 'each Hear button');
});

test('a held or dropped preview says why, in plain words', () => {
  const p = app.indexOf('async function previewSoundsPane(');
  const body = app.slice(p, app.indexOf('\n}\n', p));
  assert.ok(/r\.reason === 'replaced'/.test(body), 'a preview replaced by the next one says nothing');
  assert.ok(body.includes("'Not played: the radio is transmitting. Sounds wait for the transmission to end.'"));
  assert.ok(body.includes('SoundGuard.NO_OUTPUT_TEXT'));
  assert.ok(body.includes("'Not played: that sound output could not be opened.'"));
  assert.ok(/soundsPane\.status/.test(body));
});

// ---------------------------------------------------------------------------
console.log('Sounds pane previews: renderer/sounds.js, run with a fake sound device');

function makeWorld() {
  const w = {
    tx: false,
    txAsked: 0,
    devices: [
      { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (Realtek Audio)', groupId: 'g-spk' },
      { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers (Realtek Audio)', groupId: 'g-spk' },
      { kind: 'audiooutput', deviceId: 'head', label: 'Headphones (Jabra)', groupId: 'g-head' },
      { kind: 'audiooutput', deviceId: 'radio', label: 'Speakers (USB Audio CODEC)', groupId: 'g-radio' },
    ],
    txDevices: ['radio'],
    contexts: [],
    started: [],   // { kind: 'file'|'osc', what, at, gain }
    gains: [],
  };
  class FakeAudioContext {
    constructor(opts) {
      this.sinkId = (opts && opts.sinkId) || '';
      this.state = 'running';
      this.currentTime = 0;
      this.destination = { node: 'destination' };
      w.contexts.push(this);
    }
    async setSinkId(id) { this.sinkId = id; }
    async resume() {}
    createGain() {
      const set = []; // every value written to gain.value, in order
      let v = 1;
      const g = {
        set,
        gain: { get value() { return v; }, set value(x) { v = x; set.push(x); }, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connected: false,
        connect(x) { this.connected = true; return x; },
        disconnect() { this.connected = false; },
      };
      w.gains.push(g);
      return g;
    }
    createOscillator() {
      const ctx = this;
      return {
        type: 'sine', frequency: { value: 0 },
        connect(x) { return x; },
        start() { w.started.push({ kind: 'osc', what: this.frequency.value, at: Date.now(), sink: ctx.sinkId }); },
        stop() {},
      };
    }
    createBufferSource() {
      const ctx = this;
      let out = null;
      return {
        buffer: null,
        connect(x) { out = x; return x; },
        start() { w.started.push({ kind: 'file', what: this.buffer.file, at: Date.now(), sink: ctx.sinkId, out }); },
      };
    }
  }
  const DURATION = { 'potacat-100-boss-down': 1.5 };
  class FakeOffline {
    decodeAudioData(bytes) { return Promise.resolve({ file: bytes.file, duration: DURATION[bytes.file] || 0.15 }); }
  }
  const sandbox = {
    console: { log() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, Number, Set, Map, Error,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOffline,
    fetch: (url) => Promise.resolve({ arrayBuffer: () => Promise.resolve({ file: String(url).replace(/^sounds\//, '').replace(/\.wav$/, '') }) }),
    navigator: { mediaDevices: { enumerateDevices: () => Promise.resolve(w.devices), addEventListener() {} } },
    QsoSounds: Q,
    SoundGuard: require('../lib/sound-guard'),
    ChimeSounds: require('../lib/chime-sounds'),
  };
  sandbox.window = sandbox;
  sandbox.api = {
    soundTxState: async () => { w.txAsked++; return { tx: w.tx, txDevices: w.txDevices }; },
    onRemoteTxState() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(soundsSrc, sandbox, { filename: 'renderer/sounds.js' });
  w.S = sandbox.PotacatSounds;
  return w;
}

test('a chime preview plays that chime, at the unsaved volume, on the unsaved output', async () => {
  const w = makeWorld();
  assert.strictEqual(typeof w.S.preview, 'function', 'PotacatSounds.preview exists');
  w.S.configure({ soundVolume: 80, soundOutput: '' }); // saved: 80 %, Automatic
  const r = await w.S.preview({ chime: 'bell' }, { soundVolume: 40, soundOutput: 'head', soundOutputLabel: 'Headphones (Jabra)' });
  assert.deepStrictEqual(plain(r), { played: true });
  assert.deepStrictEqual(w.started.map((s) => s.what), [1320, 1980, 2640], 'the bell, not the coin');
  assert.ok(w.started.every((s) => s.sink === 'head'), 'on the output picked in the pane, not the saved one');
  assert.ok(Math.abs(w.gains[0].set[0] - 0.16) < 1e-9, 'volume 40 % (by ear: 0.4 squared), not the saved 80 %');
});

test('a file preview plays that file', async () => {
  const w = makeWorld();
  w.S.configure({});
  const r = await w.S.preview({ file: 'potacat-dupe' }, { soundVolume: 100 });
  assert.deepStrictEqual(plain(r), { played: true });
  assert.deepStrictEqual(w.started.map((s) => s.what), ['potacat-dupe']);
});

test('the guard applies: never the radio\'s sound card, and not while transmitting', async () => {
  const w = makeWorld();
  w.S.configure({});
  // The pane names the radio's sound card: the guard moves the sound off it.
  let r = await w.S.preview({ chime: 'soft' }, { soundOutput: 'radio', soundOutputLabel: 'Speakers (USB Audio CODEC)' });
  assert.ok(r.played);
  assert.ok(w.started.length && w.started.every((s) => s.sink !== 'radio'), 'not on the radio');
  assert.ok(w.txAsked > 0, 'the TX state was asked');
  // Transmitting: held, nothing sounds; when the radio unkeys it plays.
  w.started.length = 0;
  w.tx = true;
  const p = w.S.preview({ chime: 'twotone' }, {});
  await sleep(350);
  assert.strictEqual(w.started.length, 0, 'held while transmitting');
  w.tx = false;
  r = await p;
  assert.deepStrictEqual(plain(r), { played: true });
  assert.deepStrictEqual(w.started.map((s) => s.what), [660, 990]);
});

test('previews never stack: a new one stops the one playing', async () => {
  const w = makeWorld();
  w.S.configure({});
  const first = w.S.preview({ file: 'potacat-100-boss-down' }, {}); // 1.5 s
  await sleep(120);
  assert.strictEqual(w.started.length, 1, 'the 100 tune is playing');
  const g = w.gains[0];
  const t = Date.now();
  const second = w.S.preview({ chime: 'soft' }, {});
  const r1 = await first;
  assert.deepStrictEqual(plain(r1), { played: false, reason: 'replaced' });
  assert.ok(Date.now() - t < 500, 'stopped at once, not played out');
  assert.strictEqual(g.gain.value, 0, 'its output silenced');
  assert.strictEqual(g.connected, false, 'and disconnected');
  assert.deepStrictEqual(plain(await second), { played: true });
  assert.deepStrictEqual(w.started.map((s) => s.what), ['potacat-100-boss-down', 880]);
});

test('previews never stack: one still waiting is skipped for the newest', async () => {
  const w = makeWorld();
  w.S.configure({});
  w.tx = true; // all three wait
  const a = w.S.preview({ chime: 'soft' }, {});
  const b = w.S.preview({ chime: 'bell' }, {});
  const c = w.S.preview({ chime: 'twotone' }, {});
  await sleep(150);
  w.tx = false;
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.deepStrictEqual(plain(ra), { played: false, reason: 'replaced' });
  assert.deepStrictEqual(plain(rb), { played: false, reason: 'replaced' });
  assert.deepStrictEqual(plain(rc), { played: true });
  assert.deepStrictEqual(w.started.map((s) => s.what), [660, 990], 'only the last one sounded');
});

test('a preview does not cut a real contact sound', async () => {
  const w = makeWorld();
  w.S.configure({});
  const real = w.S.playFile('potacat-dupe');
  await sleep(30);
  const prev = w.S.preview({ chime: 'soft' }, {});
  assert.deepStrictEqual(plain(await real), { played: true });
  assert.deepStrictEqual(plain(await prev), { played: true });
});

test('a transmission still cuts a preview, and says so', async () => {
  const w = makeWorld();
  w.S.configure({});
  const p = w.S.preview({ file: 'potacat-100-boss-down' }, {});
  await sleep(100);
  w.S.cutAll();
  assert.deepStrictEqual(plain(await p), { played: false, reason: 'transmitting' });
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
