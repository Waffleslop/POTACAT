// The play worklet counts what damages a transmitted frame and nothing else
// can see (#300): silence BETWEEN two stretches of audio inside one over, and
// audio dropped as backlog. The dry tail after the last audio is not a gap.
// Runs renderer/modem-play-worklet.js itself with a stand-in AudioWorklet scope.
// Run: node test/modem-play-over-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');

function makeNode(rate = 48000, opts = { prebufferMs: 0, ringMs: 300 }) {
  let Proc = null;
  const posted = [];
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage: (m) => posted.push(m) }; } }
  const ctx = { AudioWorkletProcessor, sampleRate: rate, registerProcessor: (_n, c) => { Proc = c; }, Float32Array, Math };
  vm.runInNewContext(readSrc(path.join(root, 'renderer', 'modem-play-worklet.js')), ctx);
  const node = new Proc({ processorOptions: { sourceRate: 24000, ...opts } });
  const send = (m) => node.port.onmessage({ data: m });
  const play = (ms) => { for (let n = Math.round(rate * ms / 1000 / 128); n > 0; n--) node.process([], [[new Float32Array(128)]]); };
  const audio = (ms) => { const f = new Float32Array(Math.round(24000 * ms / 1000)); f.fill(0.5); send(f); };
  return { send, play, audio, posted };
}

console.log('modem play worklet: one over');

test('a clean over reports nothing, and its dry tail is not a gap', () => {
  const n = makeNode();
  n.send({ cmd: 'over-start' });
  n.play(50);               // keyed, the first audio not here yet: not a gap
  n.audio(200); n.play(100);
  n.audio(100); n.play(100);
  n.play(250);              // the unkey hold: ring dry, nothing follows
  n.send({ cmd: 'over-end' });
  assert.deepStrictEqual(n.posted, []);
});

test('audio that arrives late leaves a hole: counted, with its length', () => {
  const n = makeNode();
  n.send({ cmd: 'over-start' });
  n.audio(100); n.play(100);
  n.play(120);              // main stalled: 120 ms of silence inside the frame
  n.audio(100); n.play(100);
  n.send({ cmd: 'over-end' });
  assert.strictEqual(n.posted.length, 1);
  const o = n.posted[0].over;
  assert.strictEqual(o.gaps, 1);
  assert.ok(o.gapMs > 100 && o.gapMs < 140, `about 120 ms, got ${o.gapMs}`);
  assert.strictEqual(o.droppedMs, 0);
});

test('a backlog past the ring is cut: the dropped audio is counted', () => {
  const n = makeNode();
  n.send({ cmd: 'over-start' });
  n.audio(250); n.audio(250);   // 500 ms at once into a 300 ms ring
  n.play(200);
  n.send({ cmd: 'over-end' });
  assert.strictEqual(n.posted.length, 1);
  // Only what did not fit (500 into 300), counted; nothing more is thrown away (#187).
  assert.ok(Math.abs(n.posted[0].over.droppedMs - 200) < 5, `dropped ${n.posted[0].over.droppedMs} ms`);
});

test('as the bridge runs it (250 ms pre-buffer, 2 s ring, #187): late audio and a backlog do no harm', () => {
  const n = makeNode(48000, {});
  n.send({ cmd: 'over-start' });
  n.audio(100); n.play(100);
  n.play(120);              // 120 ms late: the over has not started playing yet
  n.audio(100); n.play(100);
  n.audio(250); n.audio(250); // a burst after a stall: the ring holds it
  n.play(900);
  n.send({ cmd: 'over-end' });
  assert.deepStrictEqual(n.posted, [], JSON.stringify(n.posted));
});

test('nothing is counted outside an over, and each over starts clean', () => {
  const n = makeNode();
  n.audio(100); n.play(300); n.audio(100); n.play(200);   // no over marked
  n.send({ cmd: 'over-end' });
  n.send({ cmd: 'over-start' }); n.audio(100); n.play(200); n.send({ cmd: 'over-end' });
  assert.deepStrictEqual(n.posted, []);
});

test('main.js marks each over for the bridge and logs a damaged one in plain words', () => {
  const main = readSrc(path.join(root, 'main.js'));
  assert.ok(/_winlinkTxBurst\.keyDown\(\);\n\s*modemBridgeOver\(true\);/.test(main), 'over starts at key-down');
  // #300: the burst line gains what reached the radio, inside an `if (burst) { ... }` block.
  assert.ok(/winlinkLog\(burst\.text \+ [^\n]*\n\s*\}\n\s*if \(burst\) modemBridgeOver\(false\);/.test(main), 'over ends with the burst line, on every unkey path');
  assert.ok(/if \(s\.txOver\) \{[^\n]*modemBridgeOverText\(/.test(main));
  const i = main.indexOf('function modemBridgeOverText(');
  const fn = new Function('return ' + main.slice(i, main.indexOf('\nfunction ', i + 10)))();
  assert.strictEqual(fn({ gaps: 0, gapMs: 0, droppedMs: 0 }), '');
  assert.ok(/2 gaps of silence inside the frame, 150 ms in all/.test(fn({ gaps: 2, gapMs: 150.2, droppedMs: 0 })));
  assert.ok(/80 ms of audio dropped as backlog/.test(fn({ gaps: 0, gapMs: 0, droppedMs: 80 })));
  assert.ok(/onOver: \(cb\) => ipcRenderer\.on\('modem-bridge-over'/.test(readSrc(path.join(root, 'preload-modem-audio-bridge.js'))));
  const page = readSrc(path.join(root, 'renderer', 'modem-audio-bridge.js'));
  assert.ok(/window\.bridge\.onOver\(\(d\) => radio\.over\(d\)\);/.test(page) && /status\(\{ txOver: e\.data\.over \}\)/.test(page));
  const list = readSrc(path.join(root, 'scripts', 'run-tests.js'));
  assert.ok(list.includes("'test/modem-play-over-test.js'"), 'this test is in the list CI runs');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
