// One over of an external modem as POTACAT saw it (lib/modem-tx-burst.js):
// PTT asked → audio start/end and peak → PTT off asked → carrier dropped,
// summarized in one log line at key-up. The #128 packet log had "PTT write"
// lines and nothing about what went out while keyed.
// Run: node test/modem-tx-burst-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const { TxBurst, describeBurst, dbfs } = require('../lib/modem-tx-burst');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

function clock(start = 1000) { let t = start; const now = () => t; now.advance = (ms) => { t += ms; }; return now; }
function tone(n, amp) { const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = amp * Math.sin(i / 7); return f; }

console.log('modem-tx-burst');

test('a normal over: audio starts after the key, ends before the carrier drops, peak in dBFS', () => {
  const now = clock();
  const b = new TxBurst({ now });
  assert.strictEqual(b.active, false);
  assert.strictEqual(b.keyUp(), null, 'nothing keyed, nothing to say');
  b.keyDown();
  assert.strictEqual(b.active, true);
  now.advance(115);
  b.noteAudio(tone(2400, 0.4), 24000);   // 100 ms
  now.advance(100);
  b.noteAudio(tone(2400, 0.25), 24000);
  now.advance(100);
  b.noteAudio(tone(2400, 0.1), 24000);
  now.advance(497);
  b.unkeyAsked();
  now.advance(250);                       // the drain hold
  const s = b.keyUp({ gainDb: 4.04 });
  assert.strictEqual(s.keyedMs, 1062);
  assert.strictEqual(s.audioMs, 300);
  assert.strictEqual(s.firstAudioMs, 115);
  assert.strictEqual(s.lastAudioMs, 315);
  assert.strictEqual(s.unkeyAskedMs, 812);
  assert.strictEqual(s.peakDbfs, dbfs(0.4));
  assert.strictEqual(s.gainDb, 4);
  assert.strictEqual(s.chunks, 3);
  assert.strictEqual(s.text, 'PTT held 1062 ms: modem audio 300 ms (started +115 ms, ended +315 ms), peak -8 dBFS (+4 dB applied on the way out); PTT off asked at +812 ms');
  assert.strictEqual(b.active, false, 'forgotten after key-up');
  assert.strictEqual(b.keyUp(), null);
});

test('a key with no audio says so, and audio outside a key is ignored', () => {
  const now = clock();
  const b = new TxBurst({ now });
  b.noteAudio(tone(240, 0.5), 24000);    // stray before the key
  b.keyDown();
  now.advance(800);
  const s = b.keyUp();
  assert.strictEqual(s.audioMs, 0);
  assert.strictEqual(s.peakDbfs, null);
  assert.strictEqual(s.text, 'PTT held 800 ms — the modem sent NO audio while keyed; PTT off was never asked for');
});

test('keyed again inside the drain hold continues the same over', () => {
  const now = clock();
  const b = new TxBurst({ now });
  b.keyDown();
  now.advance(500);
  b.noteAudio(tone(12000, 0.3), 24000);
  b.unkeyAsked();
  now.advance(100);
  b.rekeyed();
  now.advance(400);
  b.noteAudio(tone(12000, 0.3), 24000);
  b.unkeyAsked();
  const s = b.keyUp();
  assert.strictEqual(s.unkeyAskedMs, 1000, 'the first ask was withdrawn by the re-key');
  assert.strictEqual(s.audioMs, 1000);
});

test('dbfs and describeBurst edge values', () => {
  assert.strictEqual(dbfs(1), 0);
  assert.strictEqual(dbfs(0.5), -6);
  assert.strictEqual(dbfs(0), null);
  const t = describeBurst({ keyedMs: 10, audioMs: 5, firstAudioMs: 1, lastAudioMs: 6, unkeyAskedMs: null, peakDbfs: -20.5, gainDb: null, chunks: 1 });
  assert.strictEqual(t, 'PTT held 10 ms: modem audio 5 ms (started +1 ms, ended +6 ms), peak -20.5 dBFS; PTT off was never asked for');
});

test('main.js: the shim\'s PTT hooks, the modem audio \'tx\' event and every unkey path feed one TxBurst', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/const \{ TxBurst \} = require\('\.\/lib\/modem-tx-burst'\);/.test(main));
  assert.ok(/const _winlinkTxBurst = new TxBurst\(\);/.test(main));
  const shim = main.slice(main.indexOf('async function startWinlinkShim('), main.indexOf('function winlinkUnkeyNow('));
  assert.ok(/if \(_winlinkUnkeyTimer\) return true;\n\s*_winlinkTxBurst\.unkeyAsked\(\);/.test(shim), 'PTT off asked is noted before the drain hold');
  assert.ok(/_winlinkTxBurst\.rekeyed\(\);/.test(shim), 'a re-key inside the hold continues the over');
  assert.ok(/winlinkTxActive = true;\n\s*_winlinkTxBurst\.keyDown\(\);/.test(shim), 'key-down starts the over');
  assert.ok(/if \(!winlinkTxActive\) return; \/\/ the modem only sends while it has PTT; anything else is a stray\n\s*_winlinkTxBurst\.noteAudio\(mono24k, 24000\);/.test(main), 'the modem\'s audio is measured at the server, before the level trim');
  const unkeys = main.match(/winlinkTxBurstEnd\(\);/g) || [];
  assert.ok(unkeys.length >= 3, `every unkey path (drain, session end, failsafe) logs the over: ${unkeys.length}`);
  assert.ok(/function winlinkTxBurstEnd\(\) \{[\s\S]*?_winlinkTxBurst\.keyUp\(\{ gainDb: _modemTxLeveler \? _modemTxLeveler\.gainDb : 0 \}\)[\s\S]*?winlinkLog\(/.test(main), 'logged with the TX leveler\'s gain');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
