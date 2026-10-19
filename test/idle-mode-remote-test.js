'use strict';
// Idle Mode over ECHOCAT (capability 'idle-mode', K3SBP 2026-10-19): one
// per-field setter (set-idle-rx), an echo after every set, owner-only, and
// JTTY as an idle program that follows the sun (20 m day / 40 m night) with a
// marker row in the JTTY feed at each band change.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const RS = fs.readFileSync(path.join(root, 'lib', 'remote-server.js'), 'utf8');
const POP = fs.readFileSync(path.join(root, 'renderer', 'jtcat-popout.js'), 'utf8');
const WEB = fs.readFileSync(path.join(root, 'renderer', 'remote.js'), 'utf8');
const { MESSAGES } = require('../lib/echocat-protocol.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); }
}
function bodyOf(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let d = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  return src.slice(start, i + 1);
}
function constLine(name) {
  const m = MAIN.match(new RegExp('const ' + name + ' = [^;]+;'));
  assert.ok(m, name);
  return m[0];
}
function handler(src, on, ev) {
  const at = src.indexOf(`${on}('${ev}'`);
  assert.ok(at > 0, ev);
  return src.slice(at, src.indexOf('\n  });', at));
}

// applyIdleModeChange run for real against a fake settings object.
const PSK = MAIN.match(/const PSK_IDLE_DIALS = \{[\s\S]*?\};/);
assert.ok(PSK, 'PSK_IDLE_DIALS');
// eslint-disable-next-line no-new-func
const makeApply = new Function('settings', 'calls', `
  ${PSK[0]}
  ${constLine('IDLE_RX_MODES')}
  ${constLine('IDLE_WSPR_BANDS')}
  ${constLine('IDLE_TIMEOUT_MIN')}
  let autoSstvActive = calls.active;
  const saveSettings = () => calls.push('save');
  const stopAutoSstvTimer = () => calls.push('stop');
  const startAutoSstvTimer = () => calls.push('start');
  const cancelAutoSstv = () => calls.push('cancel');
  ${bodyOf(MAIN, 'applyIdleModeChange')}
  return applyIdleModeChange;`);
function run(settings, msg, active) {
  const calls = []; calls.active = !!active;
  return { r: makeApply(settings, calls)(msg), calls };
}

test('one field alone is valid and never falls back to SSTV', () => {
  const s = { idleRxMode: 'wspr', enableAutoSstv: false };
  const { r, calls } = run(s, { enabled: true });
  assert.strictEqual(s.idleRxMode, 'wspr', 'program untouched');
  assert.strictEqual(s.enableAutoSstv, true);
  assert.deepStrictEqual(r.applied, ['enabled']);
  assert.ok(calls.includes('start'), 'timer restarted on enable');
});
test('an unknown program is refused, the rest still apply', () => {
  const s = { idleRxMode: 'wspr', idlePskBand: '20m' };
  const { r } = run(s, { mode: 'rtty', pskBand: '40m' });
  assert.strictEqual(s.idleRxMode, 'wspr');
  assert.strictEqual(s.idlePskBand, '40m');
  assert.deepStrictEqual(r.rejected, ['mode']);
});
test('JTTY is an idle program', () => {
  const s = {};
  run(s, { mode: 'jtty' });
  assert.strictEqual(s.idleRxMode, 'jtty');
});
test('timeout 5-1440 whole minutes; out of range is refused, not clamped', () => {
  const s = { autoSstvInactivityMin: 90 };
  let x = run(s, { timeoutMin: 1440 });
  assert.strictEqual(s.autoSstvInactivityMin, 1440);
  assert.ok(x.calls.includes('start'), 'timer restarted on timeout change');
  x = run(s, { timeoutMin: 2 });
  assert.strictEqual(s.autoSstvInactivityMin, 1440);
  assert.deepStrictEqual(x.r.rejected, ['timeoutMin']);
  x = run(s, { timeoutMin: 1441 });
  assert.deepStrictEqual(x.r.rejected, ['timeoutMin']);
});
test('turning Idle Mode off ends a running session; other changes leave it alone', () => {
  let x = run({ enableAutoSstv: true }, { enabled: false }, true);
  assert.ok(x.calls.includes('stop') && x.calls.includes('cancel'));
  x = run({ enableAutoSstv: true, idleRxMode: 'wspr' }, { mode: 'psk31', wsprHop: true }, true);
  assert.ok(!x.calls.includes('cancel'), 'mid-session change applies next idle');
});
test('a no-op set changes nothing and saves nothing', () => {
  const x = run({ idleWsprBand: '20m' }, { wsprBand: '20m' });
  assert.deepStrictEqual(x.r.changed, []);
  assert.ok(!x.calls.includes('save'));
});

test('set-idle-rx keeps the session (selfDriven) and always echoes', () => {
  const h = handler(MAIN, 'remoteServer.on', 'set-idle-rx');
  assert.ok(/markUserActive\(\{ selfDriven: true \}\)/.test(h), 'selfDriven');
  assert.ok(/sendIdleModeResult\(/.test(h));
  assert.ok(/updateRemoteSettings\(\);/.test(h));
  const a = handler(MAIN, 'remoteServer.on', 'sstv-set-auto-enabled');
  assert.ok(!/return;/.test(a), 'no early return that skips the echo');
  assert.ok(/updateRemoteSettings\(\);/.test(a));
  assert.ok(/autoRxKind\(\) === 'sstv' \? 'auto-rx'/.test(a), "'auto-rx' only for SSTV");
});
test('demux forwards every field and refuses guests on both messages', () => {
  const i = RS.indexOf("case 'set-idle-rx':");
  const c = RS.slice(i, RS.indexOf('break;', RS.indexOf('this.emit', i)));
  for (const k of ['mode', 'enabled', 'timeoutMin', 'wsprBand', 'wsprHop', 'pskBand', 'reqId']) {
    assert.ok(new RegExp('\\b' + k + ':').test(c), k);
  }
  assert.ok(/_passSession/.test(c));
  const j = RS.indexOf("case 'sstv-set-auto-enabled':");
  assert.ok(/if \(ws\._passSession\) break;/.test(RS.slice(j, j + 300)), 'guest refused');
  assert.ok(/capabilities: \['idle-mode'/.test(RS), 'capability advertised');
});
test('protocol: set-idle-rx is filed under idle-mode with every field', () => {
  const m = MESSAGES['set-idle-rx'];
  assert.strictEqual(m.feature, 'idle-mode');
  for (const k of ['mode', 'enabled', 'timeoutMin', 'wsprBand', 'wsprHop', 'pskBand', 'reqId']) assert.ok(m.fields[k], k);
  assert.ok(MESSAGES['idle-mode-result']);
});
test('settings blob echoes all six values; the Settings window pushes them', () => {
  for (const k of ['idleRxMode:', 'enableAutoSstv:', 'autoSstvInactivityMin:', 'idleWsprBand:', 'idleWsprBandHop:', 'idlePskBand:']) {
    assert.ok(bodyOf(MAIN, 'updateRemoteSettings').includes(k) || MAIN.includes('    ' + k), k);
  }
  assert.ok(/has\('enableAutoSstv'\) \|\| has\('autoSstvInactivityMin'\) \|\| has\('idleRxMode'\)/.test(MAIN));
});
test('JTTY idle: dials 14090/7090 (never FT4\'s 14080), day/night follow, marker row', () => {
  assert.ok(/const JTTY_IDLE_DIALS = \{ '20m': 14090, '40m': 7090 \};/.test(MAIN));
  assert.ok(/autoIdleRxLabel === 'JTTY' \? 'jtty'/.test(bodyOf(MAIN, 'autoRxKind')));
  const f = bodyOf(MAIN, 'autoIdleJttyFollowSun');
  assert.ok(/marker: true/.test(f) && /jtcatJttyRxQueue\(/.test(f), 'marker on the JTTY row stream');
  assert.ok(/'jtcat-idle-qsy'/.test(f));
  assert.ok(/d\.complete && !d\.marker/.test(bodyOf(MAIN, 'jtcatJttyRxQueue')), 'a marker is not logged as a decode');
  assert.ok(/autoIdleJttyFollowSun\(\)/.test(bodyOf(MAIN, 'startAutoSstvTimer')));
  assert.ok(/if \(u\.marker\) \{ jttyApplyMarker\(u\); return; \}/.test(POP), 'pop-out draws the marker');
  assert.ok(/onJtcatIdleQsy/.test(POP));
  assert.ok(/if \(u\.marker\) \{/.test(WEB), 'ECHOCAT Web draws the marker');
});

console.log(`\nIdle Mode over ECHOCAT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
