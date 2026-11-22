// VARA's 1 January 2027 cut-off (Casey's request 2026-11-22): VARA HF before
// 4.9.1 and VARA FM before 4.4.1 stop working that day. POTACAT reads the
// version VARA itself gives on its TCP command port (`VERSION` ->
// `VERSION VARA HF v4.8.9`, the reply Pat logs) and says so, once per app run
// per modem. Unknown or garbage input gives no notice: never a guess.
// Pure rules in lib/vara-version.js; source guards on main.js and the windows.
// Run: node test/vara-version-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const VV = require('../lib/vara-version');

const ROOT = path.join(__dirname, '..');
const read = (f) => readSrc(path.join(ROOT, f)).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}

const BEFORE = new Date(2026, 10, 22, 12, 0, 0);  // 22 November 2026, local
const AFTER = new Date(2027, 0, 2, 12, 0, 0);     // 2 January 2027, local
const LAST_DAY = new Date(2026, 11, 31, 23, 59, 0);
const FIRST_DAY = new Date(2027, 0, 1, 0, 1, 0);

console.log('VARA 2027 update notice');

test('parses the reply VARA gives on its command port, with or without the VERSION word', () => {
  assert.deepStrictEqual(VV.parseVaraVersionText('VARA HF v4.8.9'), { kind: 'hf', major: 4, minor: 8, patch: 9, version: '4.8.9' });
  assert.deepStrictEqual(VV.parseVaraVersionText('VERSION VARA HF v4.8.9'), { kind: 'hf', major: 4, minor: 8, patch: 9, version: '4.8.9' });
  assert.deepStrictEqual(VV.parseVaraVersionText('VARA FM v4.4.1'), { kind: 'fm', major: 4, minor: 4, patch: 1, version: '4.4.1' });
  assert.deepStrictEqual(VV.parseVaraVersionText('  vara hf V4.9.1\r'), { kind: 'hf', major: 4, minor: 9, patch: 1, version: '4.9.1' });
  assert.deepStrictEqual(VV.parseVaraVersionText('VARA SAT v1.2.3'), { kind: 'sat', major: 1, minor: 2, patch: 3, version: '1.2.3' });
  // A build that does not name HF or FM: the kind comes from the port it answered on.
  assert.deepStrictEqual(VV.parseVaraVersionText('VARA v4.9.0'), { kind: null, major: 4, minor: 9, patch: 0, version: '4.9.0' });
});

test('unknown or garbage input parses to null', () => {
  for (const bad of [undefined, null, '', '   ', 'VERSION', 'VARA HF', 'VARA HF v4.9', 'VARA HF vX.Y.Z', 'hello 4.8.9',
    'Mercury v2.1.0', 'WRONG', 42, {}, 'VARA HF v99999999999999999999.1.1']) {
    assert.strictEqual(VV.parseVaraVersionText(bad), null, JSON.stringify(bad));
  }
});

test('the versions that keep working are HF 4.9.1 and FM 4.4.1, from 1 January 2027', () => {
  assert.deepStrictEqual(VV.VARA_MIN_2027, { hf: [4, 9, 1], fm: [4, 4, 1] });
  assert.strictEqual(VV.varaCutoffPassed(LAST_DAY), false);
  assert.strictEqual(VV.varaCutoffPassed(FIRST_DAY), true);
});

test('an old VARA HF before the cut-off: plain notice naming the version, the date and where to update', () => {
  assert.strictEqual(VV.varaUpdateNotice('VARA HF v4.8.9', { kind: 'hf', now: BEFORE }),
    'Your VARA HF is version 4.8.9. VARA HF before 4.9.1 stops working on 1 January 2027. Update VARA from its author\'s site, rosmodem.wordpress.com.');
  assert.strictEqual(VV.varaUpdateNotice('VARA HF v4.9.0', { kind: 'hf', now: LAST_DAY }),
    'Your VARA HF is version 4.9.0. VARA HF before 4.9.1 stops working on 1 January 2027. Update VARA from its author\'s site, rosmodem.wordpress.com.');
});

test('an old VARA FM before the cut-off', () => {
  assert.strictEqual(VV.varaUpdateNotice('VARA FM v4.4.0', { kind: 'fm', now: BEFORE }),
    'Your VARA FM is version 4.4.0. VARA FM before 4.4.1 stops working on 1 January 2027. Update VARA from its author\'s site, rosmodem.wordpress.com.');
  assert.ok(VV.varaUpdateNotice('VARA FM v3.0.5', { kind: 'fm', now: BEFORE }));
});

test('after 1 January 2027 the wording says it is too old to work', () => {
  assert.strictEqual(VV.varaUpdateNotice('VARA HF v4.8.9', { kind: 'hf', now: AFTER }),
    'Your VARA HF (version 4.8.9) is too old to work since 1 January 2027. Update VARA from its author\'s site, rosmodem.wordpress.com.');
  assert.strictEqual(VV.varaUpdateNotice('VARA FM v4.4.0', { kind: 'fm', now: FIRST_DAY }),
    'Your VARA FM (version 4.4.0) is too old to work since 1 January 2027. Update VARA from its author\'s site, rosmodem.wordpress.com.');
});

test('current or newer versions give no notice, before or after the date', () => {
  for (const now of [BEFORE, AFTER]) {
    assert.strictEqual(VV.varaUpdateNotice('VARA HF v4.9.1', { kind: 'hf', now }), null);
    assert.strictEqual(VV.varaUpdateNotice('VARA HF v4.9.3', { kind: 'hf', now }), null);
    assert.strictEqual(VV.varaUpdateNotice('VARA HF v4.10.0', { kind: 'hf', now }), null);
    assert.strictEqual(VV.varaUpdateNotice('VARA HF v5.0.0', { kind: 'hf', now }), null);
    assert.strictEqual(VV.varaUpdateNotice('VARA FM v4.4.1', { kind: 'fm', now }), null);
    assert.strictEqual(VV.varaUpdateNotice('VARA FM v4.4.3', { kind: 'fm', now }), null);
  }
});

test('the version string names the modem; the port kind is only the fallback', () => {
  // VARA FM 4.5.0 is new enough even though HF's line is 4.9.1.
  assert.strictEqual(VV.varaUpdateNotice('VARA FM v4.5.0', { kind: 'hf', now: BEFORE }), null);
  // VARA HF 4.8.9 answering on the FM port is still an old VARA HF.
  assert.ok(/^Your VARA HF is version 4\.8\.9\./.test(VV.varaUpdateNotice('VARA HF v4.8.9', { kind: 'fm', now: BEFORE })));
  // No HF/FM in the string: the configured kind decides.
  assert.ok(/^Your VARA FM is version 4\.4\.0\./.test(VV.varaUpdateNotice('VARA v4.4.0', { kind: 'fm', now: BEFORE })));
  assert.strictEqual(VV.varaUpdateNotice('VARA v4.4.0', { now: BEFORE }), null);
  // VARA SAT is not part of this cut-off.
  assert.strictEqual(VV.varaUpdateNotice('VARA SAT v1.0.0', { kind: 'hf', now: BEFORE }), null);
});

test('unknown, silent or garbage replies give no notice', () => {
  for (const bad of [undefined, null, '', 'garbage', 'VARA HF', 'Mercury v2.1.0', 'VARA HF v4.9']) {
    assert.strictEqual(VV.varaUpdateNotice(bad, { kind: 'hf', now: BEFORE }), null, JSON.stringify(bad));
  }
  assert.strictEqual(VV.varaUpdateNotice('VARA HF v4.8.9', { kind: 'hf', now: new Date('nonsense') }), null);
});

test('the notice is plain: no emoji, no other download site, never blocks', () => {
  const texts = [VV.varaUpdateNotice('VARA HF v4.8.9', { kind: 'hf', now: BEFORE }), VV.varaUpdateNotice('VARA FM v4.4.0', { kind: 'fm', now: AFTER })];
  for (const t of texts) {
    assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t), 'no emoji');
    assert.ok(!/https?:\/\//.test(t), 'no URL in the text');
    const hosts = t.match(/\b[a-z0-9.-]+\.(com|org|net|io)\b/gi) || [];
    assert.deepStrictEqual(hosts, ['rosmodem.wordpress.com']);
  }
});

test('once per app run per modem: the second report of the same kind is quiet', () => {
  const once = VV.createVaraNoticeOnce();
  assert.strictEqual(once.take('hf', 'text A'), true);
  assert.strictEqual(once.take('hf', 'text A'), false);
  assert.strictEqual(once.take('hf', 'text B'), false);
  assert.strictEqual(once.take('fm', 'text C'), true);
  assert.strictEqual(once.take('fm', 'text C'), false);
  assert.strictEqual(VV.createVaraNoticeOnce().take('hf', null), false, 'no notice is never shown');
  assert.deepStrictEqual(once.current(), { hf: 'text B', fm: 'text C' }, 'the latest text stays for the window');
  // A newer VARA found later in the same run clears the window line
  // (main.js calls take only when VARA gave a version: silence changes nothing).
  once.take('hf', null);
  assert.deepStrictEqual(once.current(), { hf: null, fm: 'text C' });
});

// ── wiring (source guards) ──────────────────────────────────────────────
const main = read('main.js');

test('main.js checks the version where VARA is found ready, and never throws or blocks on it', () => {
  const i = main.indexOf('async function winlinkVaraReady(');
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/winlinkVaraVersionNotice\(\s*kind\s*,\s*probe\.version\s*\)/.test(body), 'winlinkVaraReady reports probe.version');
  const j = main.indexOf('function winlinkVaraVersionNotice(');
  assert.ok(j > 0, 'winlinkVaraVersionNotice exists');
  const fn = main.slice(j, main.indexOf('\n}\n', j));
  assert.ok(/VaraVersion\.varaUpdateNotice\(/.test(fn));
  assert.ok(/_varaNoticeOnce\.take\(/.test(fn), 'once per app run per kind');
  assert.ok(/winlinkLog\(/.test(fn), 'the session log line');
  assert.ok(/'app-notice'/.test(fn), 'the app notice');
  assert.ok(!/throw\b/.test(fn), 'information only: never throws');
});

test('the Winlink payload carries the notice; the window and ECHOCAT Web show it', () => {
  assert.ok(/varaNotice:\s*_varaNoticeOnce\.current\(\)/.test(main), 'payload field');
  const pop = read('renderer/winlink-popout.js');
  assert.ok(/varaNotice/.test(pop), 'popout renders varaNotice');
  const web = read('renderer/remote.js');
  assert.ok(/varaNotice/.test(web), 'ECHOCAT Web renders varaNotice');
});

test('the Settings Test button adds the notice to what it says', () => {
  const i = main.indexOf("ipcMain.handle('winlink-vara-find'");
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n  });\n', i));
  assert.ok(/VaraVersion\.varaUpdateNotice\(/.test(body));
});

test('the only site the notice names is already on the open-external allowlist', () => {
  assert.ok(main.includes("'https://rosmodem.wordpress.com/'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
