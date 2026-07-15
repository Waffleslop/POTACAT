// Tests for lib/mercury-app-protocol.js — the framing over Mercury's raw data
// socket. Run: node test/mercury-app-protocol-test.js
'use strict';

const assert = require('assert');
const {
  TYPE, encodeChat, encodeFileMeta, encodeFileData, encodeFileEnd,
  interpretFrame, FrameReassembler,
} = require('../lib/mercury-app-protocol');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

test('chat frame round-trips (utf8, incl. multibyte)', () => {
  const r = new FrameReassembler();
  const frames = r.push(encodeChat('hello ☃ CQ'));
  assert.strictEqual(frames.length, 1);
  assert.deepStrictEqual(interpretFrame(frames[0]), { kind: 'chat', text: 'hello ☃ CQ' });
});

test('multiple frames in one push are all returned in order', () => {
  const r = new FrameReassembler();
  const buf = Buffer.concat([encodeChat('one'), encodeChat('two'), encodeChat('three')]);
  const frames = r.push(buf).map((f) => interpretFrame(f).text);
  assert.deepStrictEqual(frames, ['one', 'two', 'three']);
});

test('a frame split across two pushes reassembles', () => {
  const r = new FrameReassembler();
  const whole = encodeChat('a longer message split mid-frame');
  const cut = 8;
  assert.deepStrictEqual(r.push(whole.subarray(0, cut)), []); // partial → nothing yet
  const frames = r.push(whole.subarray(cut));
  assert.strictEqual(interpretFrame(frames[0]).text, 'a longer message split mid-frame');
});

test('byte-by-byte delivery still yields exactly one frame', () => {
  const r = new FrameReassembler();
  const whole = encodeChat('drip');
  let frames = [];
  for (const b of whole) frames = frames.concat(r.push(Buffer.from([b])));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(interpretFrame(frames[0]).text, 'drip');
});

test('file meta / data / end round-trip', () => {
  const r = new FrameReassembler();
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const buf = Buffer.concat([
    encodeFileMeta({ name: 'log.adi', size: 5 }),
    encodeFileData(payload),
    encodeFileEnd(),
  ]);
  const parts = r.push(buf).map(interpretFrame);
  assert.deepStrictEqual(parts[0], { kind: 'file-meta', name: 'log.adi', size: 5 });
  assert.strictEqual(parts[1].kind, 'file-data');
  assert.ok(parts[1].bytes.equals(payload));
  assert.deepStrictEqual(parts[2], { kind: 'file-end' });
});

test('type constants are stable on the wire', () => {
  assert.strictEqual(encodeChat('x').readUInt8(0), TYPE.CHAT);
  assert.strictEqual(encodeFileMeta({}).readUInt8(0), TYPE.FILE_META);
  assert.strictEqual(encodeFileData(Buffer.alloc(0)).readUInt8(0), TYPE.FILE_DATA);
  assert.strictEqual(encodeFileEnd().readUInt8(0), TYPE.FILE_END);
});

test('a bogus oversize length resets rather than hangs/allocates', () => {
  const r = new FrameReassembler();
  const bad = Buffer.alloc(5);
  bad.writeUInt8(99, 0);
  bad.writeUInt32BE(0xFFFFFFFF, 1); // > MAX_PAYLOAD
  assert.deepStrictEqual(r.push(bad), []);
  // Recovers for the next well-formed frame.
  assert.strictEqual(interpretFrame(r.push(encodeChat('recovered'))[0]).text, 'recovered');
});

test('empty chat frame is valid', () => {
  const r = new FrameReassembler();
  const frames = r.push(encodeChat(''));
  assert.deepStrictEqual(interpretFrame(frames[0]), { kind: 'chat', text: '' });
});

console.log(`\nMercury app protocol: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
