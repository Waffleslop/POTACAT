#!/usr/bin/env node
'use strict';
/**
 * The FT-710 on the phone's Pan tab (Casey 2026-10-28, via the phone
 * session): zoom through the radio's own SS05 span, CENTER on request
 * (SS06), and each device's frames sized (scope-subscribe bins) and paced
 * (LAN vs POTACAT Cloud) for that device.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const proto = require('../lib/echocat-protocol');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// A server with fake open sockets, to watch what each device is sent.
function rig(clients) {
  const s = Object.create(RemoteServer.prototype);
  const sent = new Map(clients.map((c) => [c, []]));
  s._openClients = () => clients;
  s._client = clients[0];
  s._sendTo = (c, m) => sent.get(c).push(m);
  return { s, sent };
}
const OPEN = 1;
const wf1 = Uint8Array.from({ length: 850 }, (_, i) => i % 256);

console.log('Frames per device');
check('each device gets the points it asked for, never more than the source has; 256 when it named none', () => {
  const pan = { readyState: OPEN, _scopeBins: 512 };
  const old = { readyState: OPEN };
  const greedy = { readyState: OPEN, _scopeBins: 1024 };
  const { s, sent } = rig([pan, old, greedy]);
  s.broadcastScopeFrame({ seq: 1, kind: 0, wf1, gapMs: 66, cloudGapMs: 100 });
  assert.strictEqual(sent.get(pan)[0].bins.length, 512);
  assert.strictEqual(sent.get(old)[0].bins.length, 256);
  assert.strictEqual(sent.get(greedy)[0].bins.length, 850);
});
check('a LAN device at 66 ms gets 15 fps out of a 20 fps source; a Cloud device 10 fps', () => {
  const lan = { readyState: OPEN };
  const cloud = { readyState: OPEN, _fromTunnel: true };
  const { s, sent } = rig([lan, cloud]);
  const realNow = Date.now;
  let t = 1e6;
  Date.now = () => t;
  try {
    for (let i = 0; i < 40; i++, t += 50) s.broadcastScopeFrame({ seq: i, kind: 0, wf1, gapMs: 1000 / 15, cloudGapMs: 100 });
  } finally { Date.now = realNow; }
  assert.strictEqual(sent.get(lan).length, 30, '2 s of frames: ' + sent.get(lan).length);
  assert.strictEqual(sent.get(cloud).length, 20, '2 s of frames: ' + sent.get(cloud).length);
});
check('scope-state tells each device its own pace', () => {
  const lan = { readyState: OPEN };
  const cloud = { readyState: OPEN, _fromTunnel: true };
  const { s, sent } = rig([lan, cloud]);
  s.broadcastScopeState({ status: 'live', frameMs: 67, frameMsCloud: 100 });
  assert.strictEqual(sent.get(lan)[0].frameMs, 67);
  assert.strictEqual(sent.get(cloud)[0].frameMs, 100);
  assert.ok(!('frameMsCloud' in sent.get(lan)[0]), 'not on the wire');
});

console.log('The wire');
const rs = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
check('capabilities scope-bins and scope-anchor; subscribe carries bins; anchor registered', () => {
  assert.ok(/capabilities: \[[\s\S]*'scope-bins',[\s\S]*'scope-anchor'\]/.test(rs));
  assert.ok(proto.MESSAGES['scope-subscribe'].fields.bins);
  assert.ok(proto.MESSAGES['scope-anchor']);
  assert.ok(/ws\._scopeBins = Number\.isFinite\(b\) && b > 0 \? Math\.max\(32, Math\.min\(1024, b\)\) : 256;/.test(rs));
  assert.ok(/this\.emit\('scope-anchor', \{ anchor: String\(msg\.anchor \|\| ''\), guest: !!ws\._passSession \}\);/.test(rs));
  assert.ok(/ws\._fromTunnel = fromTunnel;/.test(rs));
});

console.log('main.js');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const fnOf = (name, len = 2000) => main.slice(main.indexOf('function ' + name + '('), main.indexOf('function ' + name + '(') + len);
check('FT-710 zoom: the ten SS05 spans only when the CAT link answers the scope reads (never via rigctld)', () => {
  const w = fnOf('yaesuScopeCatWritable', 500);
  assert.ok(/s\.source === 'radio' && s\.kind === 0 && s\.spanCode != null && s\.catReads !== 'unanswered'/.test(w));
  assert.ok(/if \(yaesuScopeCatWritable\(\)\) return Object\.values\(YaesuScope\.SPAN_HZ_BY_CODE\)/.test(fnOf('scopeSpans', 400)));
  const set = fnOf('setScopeSpan');
  assert.ok(/cat\.sendRaw\(`SS05\$\{code\};`\);/.test(set) && /setTimeout\(\(\) => yaesuScopeReadRadio\(\), 300\)/.test(set), 'write, then the radio\'s reply is the truth');
  assert.ok(/if \(guest\) scopeGuestNote\('FT-710 span'\); else scopeGuestOwnerSet\('spanCode', code\);/.test(set), 'a guest may zoom; the owner\'s span is noted first');
});
check('CENTER keeps the radio\'s display and is logged as a radio write; a guest\'s is noted for undoing', () => {
  const a = fnOf('setScopeAnchor');
  assert.ok(/cat\.sendRaw\(`SS06\$\{code\};`\);/.test(a) && /radio write/.test(a));
  assert.ok(/if \(guest\) scopeGuestNote\('FT-710 scope mode'\); else scopeGuestOwnerSet\('modeCode', code\);/.test(a));
  const map = /const YAESU_CENTER_CODE_FOR = (\{[^}]+\});/.exec(main)[1];
  const t = eval('(' + map + ')');
  const ScopeAxis = require('../lib/scope-axis');
  for (const [from, to] of Object.entries(t)) {
    assert.strictEqual(ScopeAxis.MODE_BY_CODE[to].anchor, 'center', to);
    assert.strictEqual(ScopeAxis.MODE_BY_CODE[to].display, ScopeAxis.MODE_BY_CODE[from].display, from + ' keeps its display');
  }
  assert.ok(/remoteServer\.on\('scope-anchor', \(\{ anchor, guest \} = \{\}\) => \{ setScopeAnchor\(anchor, 'ECHOCAT device', \{ guest \}\); \}\);/.test(main));
});
check('the pace: 66 ms for the FT-710 on the LAN, 100 ms on Cloud and for every other source', () => {
  const g = fnOf('scopeRemoteGapMs', 300);
  assert.ok(/return !cloud && yaesuScopeState\.source === 'radio' \? 1000 \/ 15 : 100;/.test(g));
  assert.ok(/gapMs: scopeRemoteGapMs\(false\), cloudGapMs: scopeRemoteGapMs\(true\),/.test(main));
});

check('Guest Pass (Casey): the owner\'s span and mode come back when the session ends or the owner takes the radio', () => {
  const note = fnOf('scopeGuestNote', 600);
  assert.ok(/if \(!scopeGuestRestore\) \{/.test(note), 'noted once, at the guest\'s FIRST change');
  assert.ok(/spanCode: yaesuScopeState\.spanCode, modeCode: yaesuScopeState\.modeCode/.test(note));
  const back = fnOf('scopeGuestRestoreOwner', 4000);   // Flex, Icom and FT-710 branches
  assert.ok(/cat\.sendRaw\(`SS05\$\{r\.spanCode\};`\);/.test(back) && /cat\.sendRaw\(`SS06\$\{r\.modeCode\};`\);/.test(back));
  assert.ok(/smartSdr\.setPanBandwidth\(r\.spanHz\)/.test(back), 'the Flex pan too');
  assert.ok(/setTimeout\(\(\) => yaesuScopeReadRadio\(\), 300\);/.test(back) && /guest session over/.test(back), 'then re-read, and logged');
  assert.ok(/passLeaseStopTransmitters\(info\.reason\);\s*scopeGuestRestoreOwner\(info\.reason \|\| 'ended'\);/.test(main), 'pass ended');
  assert.ok(/if \(state === 'paused'\) scopeGuestRestoreOwner\('the owner took the radio'\);/.test(main), 'owner take-over');
  const flex = fnOf('setScopeSpan');
  assert.ok(/if \(guest\) \{\s*scopeGuestNote\('panadapter span'\);[^\n]*\n\s*\} else \{\s*scopeGuestOwnerSet\('spanHz', span\);\s*settings\.flexScopeSpanHz = span;/.test(flex), 'a guest\'s Flex zoom is never saved as the owner\'s');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
