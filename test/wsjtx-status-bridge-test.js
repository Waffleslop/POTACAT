// GridTracker2 drops every message from a WSJT-X source until that source has
// sent a Status (type 1): logged QSOs that arrived after heartbeats alone were
// thrown away (KC8ZPI 2026-10-24). The bridges now send one with every
// heartbeat and right before each QSO.
// Run: node test/wsjtx-status-bridge-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { encodeStatus, encodeHeartbeat, MSG } = require('../lib/wsjtx');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// A reader in GridTracker2's order (src/renderer/lib/wsjtxUdp.js, case 1).
function reader(buf) {
  let o = 0;
  const u8 = () => buf.readUInt8(o++);
  const u32 = () => { const v = buf.readUInt32BE(o); o += 4; return v; };
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const u64 = () => { const hi = u32(), lo = u32(); return hi * 0x100000000 + lo; };
  const utf8 = () => { const n = u32(); if (n === 0xFFFFFFFF) return null; const s = buf.toString('utf8', o, o + n); o += n; return s; };
  return { u8, u32, i32, u64, utf8, remaining: () => buf.length - o };
}

console.log('wsjtx status bridge');

test('Status decodes field by field the way GridTracker2 reads it', () => {
  const buf = encodeStatus('POTACAT', { dialFreqHz: 14074000, mode: 'FT8', deCall: 'KC8ZPI', deGrid: 'EN73' });
  const r = reader(buf);
  assert.strictEqual(r.u32(), 0xadbccbda, 'magic');
  r.u32();
  assert.strictEqual(r.u32(), MSG.STATUS);
  assert.strictEqual(r.utf8(), 'POTACAT');
  assert.strictEqual(r.u64(), 14074000);
  assert.strictEqual(r.utf8(), 'FT8');      // MO
  assert.strictEqual(r.utf8(), '');         // DXcall
  assert.strictEqual(r.utf8(), '');         // Report
  assert.strictEqual(r.utf8(), 'FT8');      // TxMode
  r.u8(); r.u8(); r.u8();                   // TxEnabled, Transmitting, Decoding
  r.i32(); r.i32();                         // RxDF, TxDF
  assert.strictEqual(r.utf8(), 'KC8ZPI');   // DEcall
  assert.strictEqual(r.utf8(), 'EN73');     // DEgrid
  assert.strictEqual(r.utf8(), '');         // DXgrid
  r.u8();                                   // TxWatchdog
  assert.strictEqual(r.utf8(), '');         // Submode
  r.u8();                                   // Fastmode
  assert.strictEqual(r.u8(), 0);            // SopMode
  r.i32(); r.i32();                         // FreqTol, TRP
  assert.strictEqual(r.utf8(), 'POTACAT');  // ConfName
  assert.strictEqual(r.utf8(), '');         // TxMessage
  assert.strictEqual(r.remaining(), 0, 'no trailing bytes');
});

test('the heartbeat is unchanged', () => {
  const r = reader(encodeHeartbeat('POTACAT', 3));
  r.u32(); r.u32();
  assert.strictEqual(r.u32(), MSG.HEARTBEAT);
});

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
test('every bridge sends a Status with each heartbeat and before each QSO', () => {
  const at = src.indexOf('function createWsjtxUdpBridge(label)');
  assert.ok(at > 0);
  const body = src.slice(at, at + 6000);
  assert.ok(/_sendHeartbeat\(\) \{[\s\S]{0,300}this\._sendStatus\(\);/.test(body), 'heartbeat sends status');
  const st = body.indexOf('this._sendStatus(freqHz > 0');
  const adif = body.indexOf('encodeLoggedAdif(this.id');
  assert.ok(st > 0 && adif > st, 'status goes out before the QSO');
  assert.ok(/function wsjtxBridgeStatus\(\)/.test(src));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
