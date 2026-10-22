// Source guards for the Winlink integration (docs/winlink-integration-plan.md).
// The pure modules have their own tests; these pin the invariants that live
// in main.js / remote-server.js / packaging and would otherwise rot:
//   - a radio session starts only from an operator's Connect (never a timer);
//   - Pat and ardopcf never get flags that answer or key unattended;
//   - PTT from Pat goes through handleRemotePtt; the shim is loopback-only;
//   - the mailbox is the owner's (Guest Pass refused, no hydration);
//   - the password is a registered secret; shutdown unkeys before CAT goes.
// Run: node test/winlink-main-wiring-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const server = read('lib/remote-server.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  // The body starts at ") {" — a destructured parameter list has its own braces.
  let depth = 0, j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

console.log('operating rules');
test('the internet auto-check can only start a telnet session', () => {
  const body = fnBody(main, 'winlinkArmAutoCheck');
  const calls = body.match(/winlinkStartSession\(\{[^}]*\}/g) || [];
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(/mode: 'telnet'/.test(c), c);
});
test('winlinkStartSession is reached only from Connect paths and the auto-check', () => {
  const callers = main.split('\n').filter((l) => /winlinkStartSession\(/.test(l) && !/function winlinkStartSession/.test(l));
  const allowed = [/origin: 'mail window'/, /origin: 'ECHOCAT device'/, /mode: 'telnet', origin: 'auto-check/];
  for (const l of callers) assert.ok(allowed.some((r) => r.test(l)), 'unexpected caller: ' + l.trim());
});
test('Pat never gets --listen / --send-only; ardopcf never gets a PTT or CAT flag', () => {
  const { buildPatArgs } = require('../lib/winlink-pat');
  assert.ok(!buildPatArgs({ configPath: 'x' }).some((a) => /listen|send-only/.test(a)));
  assert.ok(!/--listen|'-l'/.test(fnBody(main, 'spawnPat')));
  const { FORBIDDEN_FLAGS } = require('../lib/ardop-process');
  const spawnArdop = fnBody(main, 'spawnArdop');
  for (const f of FORBIDDEN_FLAGS) assert.ok(!spawnArdop.includes(`'${f}'`), f);
  assert.ok(/ArdopProcess\.buildArdopArgs\(/.test(spawnArdop), 'args come from the guarded builder');
});

console.log('radio control');
test('the shim binds loopback and keys through handleRemotePtt with audio', () => {
  const shim = fnBody(main, 'startWinlinkShim');
  assert.ok(/createRigctldServer\(/.test(shim) && /host: '127\.0\.0\.1'/.test(shim));
  assert.ok(/handleRemotePtt\(true, \{ audio: true, forceDataMode: icom \}\)/.test(shim));
  assert.ok(/radioOwner !== 'winlink'/.test(shim), 'refuses outside a session');
  assert.ok(/_swrTripped/.test(shim), 'honours the SWR latch');
  assert.ok(/armWinlinkTxFailsafe\(\)/.test(shim), 'arms the failsafe on key-down');
});
test('a radio session takes the radio owner and gives it back', () => {
  assert.ok(/acquireRadio\('winlink'\)/.test(fnBody(main, 'winlinkStartSession')));
  assert.ok(/releaseRadio\('winlink'\)/.test(fnBody(main, 'winlinkEndSession')));
  assert.ok(/d\.preempted === 'winlink'\) winlinkAbortSession/.test(main));
  assert.ok(require('../lib/radio-owner').OWNERS.includes('winlink'));
});
test('shutdown ends the session before the CAT link goes', () => {
  const g = fnBody(main, 'gracefulCleanup');
  const w = g.indexOf('disconnectWinlink({ quit: true })');
  const r = g.indexOf('killRigctld();');
  assert.ok(w > 0 && r > 0 && w < r);
});

console.log('owner only');
test('every winlink-* request refuses a Guest Pass before main hears it', () => {
  const i = server.indexOf("case 'winlink-list':");
  const block = server.slice(i, server.indexOf('break;', server.indexOf("this.emit('winlink-request'", i)));
  assert.ok(/if \(ws\._passSession\) \{ this\._sendTo\(ws, \{ type: 'winlink-refused', reason: 'guest-pass'/.test(block));
  const proto = require('../lib/echocat-protocol');
  const c2s = Object.keys(proto.MESSAGES).filter((t) => t.startsWith('winlink-') && proto.MESSAGES[t].dir === 'c2s');
  for (const t of c2s) assert.ok(server.includes(`case '${t}':`), `${t} is in the guarded block`);
});
test('pushes and hydration skip Guest Pass sockets', () => {
  assert.ok(/_sendToOwners\(obj\) \{\n\s+for \(const c of this\._openClients\(\)\) if \(!c\._passSession\)/.test(server));
  assert.ok(/_sendWinlinkHydration\(ws\) \{\n\s+if \(!ws \|\| ws\._passSession/.test(server));
  assert.ok(server.includes("'winlink',"), 'hello capability');
});
test('the remote listener is attached through onRemoteServer', () => {
  assert.ok(/onRemoteServer\(\(rs\) => \{\n\s+rs\.on\('winlink-request'/.test(main));
});

console.log('secrets + packaging');
test('the Winlink password is a registered secret; machine paths are global', () => {
  assert.ok(require('../lib/settings-secrets').SECRET_KEYS.includes('winlinkPassword'));
  for (const k of ['winlinkPatPath', 'winlinkArdopPath', 'winlinkArdopPort', 'winlinkVaraPort']) assert.ok(main.includes(`'${k}',`), k);
  assert.ok(/mode: 0o600/.test(fnBody(main, 'writePatConfig')), 'pat-config.json written owner-only');
});
test('Pat and ardopcf are packaged, attributed and pinned', () => {
  const pkg = JSON.parse(read('package.json'));
  const from = pkg.build.extraResources.map((r) => r.from);
  assert.ok(from.includes('assets/pat') && from.includes('assets/ardopcf'));
  const notice = read('NOTICE');
  assert.ok(/Pat \(Winlink client\)/.test(notice) && /ardopcf \(ARDOP modem\)/.test(notice));
  const script = read('scripts/build-winlink-helpers.sh');
  const ver = (f) => read(f).split('\n')[1].replace('commit ', '').trim();
  assert.ok(script.includes(`PAT_SHA=${ver('third_party/pat/VERSION.txt')}`), 'Pat pin matches VERSION.txt');
  assert.ok(script.includes(`ARDOP_SHA=${ver('third_party/ardopcf/VERSION.txt')}`), 'ardopcf pin matches VERSION.txt');
  assert.ok(read('.github/workflows/release.yml').split('build-winlink-helpers.sh').length > 5, 'every release job builds them');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
