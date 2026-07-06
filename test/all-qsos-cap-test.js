// The legacy (non-chunked) all-qsos single frame must be bounded by BYTES,
// not just record count: 2000 verbose records serialized to ~9.6MB and
// 1009-killed iOS in a reconnect loop (BUG-N3VD-20260701-E442B8). Also
// covers the qso-added delta gate ('qso-delta' hello capability), which
// replaces the full-log re-push after every QSO save.
// Run: node test/all-qsos-cap-test.js
'use strict';

const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// Drive the real prototype methods against a stub server/client — no sockets.
function makeHarness(capabilities) {
  const sent = [];
  const logs = [];
  const ws = { readyState: 1 /* WebSocket.OPEN */, _clientCapabilities: capabilities };
  const self = {
    _client: ws,
    _sendTo(target, msg) { if (target === ws) sent.push(msg); },
    emit(ev, msg) { if (ev === 'log') logs.push(msg); },
  };
  return { sent, logs, ws, self };
}

// ~4.8KB per record reproduces the N3VD shape (2000 records ≈ 9.6MB).
function makeQsos(n, approxBytes = 4800) {
  const pad = 'x'.repeat(Math.max(1, approxBytes - 80));
  return Array.from({ length: n }, (_, i) => ({ idx: i, CALL: `K${i}ABC`, COMMENT: pad }));
}

console.log('legacy single-frame byte cap:');
{
  const { sent, logs, self } = makeHarness([]);
  RemoteServer.prototype.sendAllQsos.call(self, makeQsos(3000));
  check(sent.length === 1, 'one frame sent');
  const msg = sent[0];
  const bytes = JSON.stringify(msg).length;
  check(bytes <= 256_000, `frame ≤ 256KB (${bytes} bytes)`);
  check(msg.truncated === true, 'truncated flagged');
  check(msg.total === 3000, 'total reports full log length');
  const last = msg.data[msg.data.length - 1];
  check(last.idx === 2999, 'newest records kept, original idx preserved');
  check(logs.some(l => /truncated to newest/.test(l)), 'truncation logged');
}
{
  const { sent, self } = makeHarness([]);
  const small = makeQsos(50, 200);
  RemoteServer.prototype.sendAllQsos.call(self, small);
  check(sent.length === 1 && sent[0].data.length === 50, 'small log sent whole');
  check(!sent[0].truncated, 'small log not flagged truncated');
}

console.log('chunked clients unaffected:');
{
  const { sent, self } = makeHarness(['chunked-all-qsos']);
  RemoteServer.prototype.sendAllQsos.call(self, makeQsos(3000));
  check(sent.length > 1, `multiple chunks (${sent.length})`);
  const all = sent.flatMap(m => m.data);
  check(all.length === 3000, 'chunked path still delivers every record');
  check(sent.every(m => JSON.stringify(m).length <= 256_000), 'every chunk frame ≤ 256KB');
}

console.log('qso-added delta gate:');
{
  const { sent, self } = makeHarness(['chunked-all-qsos', 'qso-delta']);
  const ok = RemoteServer.prototype.sendQsoAdded.call(self, { idx: 41, CALL: 'N3VD' }, 42);
  check(ok === true, 'capable client → delta sent, returns true');
  check(sent.length === 1 && sent[0].type === 'qso-added', 'qso-added frame');
  check(sent[0].data.CALL === 'N3VD' && sent[0].total === 42, 'record + total carried');
}
{
  const { sent, self } = makeHarness(['chunked-all-qsos']);
  const ok = RemoteServer.prototype.sendQsoAdded.call(self, { idx: 0 }, 1);
  check(ok === false && sent.length === 0, 'non-capable client → false, nothing sent (caller falls back to sendAllQsos)');
}
{
  const { self } = makeHarness([]);
  self._client = null;
  const ok = RemoteServer.prototype.sendQsoAdded.call(self, { idx: 0 }, 1);
  check(ok === false, 'no client connected → false');
}

console.log('\n==================================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
