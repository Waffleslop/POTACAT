// The ARDOP link timeout is a setting (#425).
//
// Upstream Pat sets the modem's ARQTIMEOUT to 90 s every time it opens the
// modem. POTACAT's build of Pat (third_party/pat/potacat-arq-timeout.patch)
// reads POTACAT_ARDOP_ARQ_TIMEOUT; POTACAT passes its setting there when it
// starts Pat. This file holds the POTACAT side: the range and default, the
// environment, the sentence and the summary line, and the wiring. What the
// built Pat really sends the modem is proven on the built binaries by
// test/modem-loopback/pat-arq-timeout.js in the "winlink helpers" workflow.
// Run: node test/winlink-arq-timeout-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const W = require('../lib/winlink-pat');
const O = require('../lib/winlink-outcome');
const D = require('../lib/winlink-diag');

const root = path.join(__dirname, '..');
const read = (f) => readSrc(path.join(root, f));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('Winlink: the ARDOP link timeout (#425)');

test('default 120 s, held to 90..180, whole seconds', () => {
  assert.deepStrictEqual({ ...W.ARDOP_ARQ_TIMEOUT }, { env: 'POTACAT_ARDOP_ARQ_TIMEOUT', def: 120, min: 90, max: 180, upstream: 90 });
  const f = W.ardopArqTimeoutS;
  // never saved, or not a number: the default
  for (const v of [undefined, null, '', 'abc', NaN, {}, true, false, [1, 2]]) assert.strictEqual(f(v), 120, JSON.stringify(v));
  // in range: kept, numbers and the strings a settings file or an input may hold
  for (const [v, want] of [[90, 90], [120, 120], [180, 180], ['150', 150], [' 100 ', 100], [119.6, 120], ['90.4', 90]]) assert.strictEqual(f(v), want, JSON.stringify(v));
  // out of range: held to the nearest end, never passed on
  for (const [v, want] of [[89, 90], [30, 90], [0, 90], [-5, 90], [181, 180], [240, 180], [9999, 180], [Infinity, 120], [-Infinity, 120]]) assert.strictEqual(f(v), want, String(v));
  // every result is inside what the modem accepts (30..240), so Pat never ignores POTACAT's value
  for (const v of [undefined, 0, 1e9, -1e9, '7', 'x', 135]) { const n = f(v); assert.ok(Number.isInteger(n) && n >= 30 && n <= 240, String(v)); }
});

test('Pat\'s environment carries the value as whole seconds and keeps everything else', () => {
  const base = { PATH: '/bin', HOME: '/h' };
  assert.deepStrictEqual(W.patSpawnEnv(base, { arqTimeoutS: 150 }), { PATH: '/bin', HOME: '/h', POTACAT_ARDOP_ARQ_TIMEOUT: '150' });
  assert.deepStrictEqual(base, { PATH: '/bin', HOME: '/h' }, 'the caller\'s environment is not changed');
  assert.strictEqual(W.patSpawnEnv(base).POTACAT_ARDOP_ARQ_TIMEOUT, '120');
  assert.strictEqual(W.patSpawnEnv(base, {}).POTACAT_ARDOP_ARQ_TIMEOUT, '120');
  assert.strictEqual(W.patSpawnEnv(base, { arqTimeoutS: 9999 }).POTACAT_ARDOP_ARQ_TIMEOUT, '180');
  assert.strictEqual(W.patSpawnEnv(base, { arqTimeoutS: 'junk' }).POTACAT_ARDOP_ARQ_TIMEOUT, '120');
  // a value already in the environment never wins over the setting
  assert.strictEqual(W.patSpawnEnv({ POTACAT_ARDOP_ARQ_TIMEOUT: '30' }, { arqTimeoutS: 90 }).POTACAT_ARDOP_ARQ_TIMEOUT, '90');
  assert.strictEqual(W.patSpawnEnv(undefined, { arqTimeoutS: 90 }).POTACAT_ARDOP_ARQ_TIMEOUT, '90');
});

test('the dropped-link sentence says the timeout in force, and 90 when it is not known', () => {
  const base = { state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, modemEnd: { by: 'timeout' } };
  const title = (extra) => O.describeOutcome({ ...base, ...extra }).title;
  assert.strictEqual(title({ arqTimeoutS: 120 }), 'The link to KY4RY dropped before the mail exchange finished: nothing got through for 120 seconds, so the modem ended the link.');
  assert.strictEqual(title({ arqTimeoutS: 180 }), 'The link to KY4RY dropped before the mail exchange finished: nothing got through for 180 seconds, so the modem ended the link.');
  for (const v of [undefined, null, 0, 'x', 5, 9999]) assert.ok(title({ arqTimeoutS: v }).includes('for 90 seconds'), String(v));
  // only the timeout ending carries a number
  assert.ok(!/\d+ seconds/.test(O.describeOutcome({ ...base, modemEnd: { by: 'gateway' }, arqTimeoutS: 120 }).title));
});

test('the modem\'s log gives the value in force: the LAST ARQTIMEOUT Pat sent, kept across the call', () => {
  const c = D.classifyArdopDebugLine;
  assert.deepStrictEqual(c('19:24:54.681 D [Command Trace FROM host: ARQTIMEOUT 120]'), { kind: 'arq-timeout', quiet: true, seconds: 120, text: 'link timeout set to 120 s' });
  // the modem's answer is not the command
  const ans = c('19:24:54.681 D  Command Trace TO Host ARQTIMEOUT now 120');
  assert.ok(!ans || ans.kind !== 'arq-timeout');
  const s = new D.ArdopLinkStory();
  assert.strictEqual(s.snapshot().arqTimeoutS, 0, 'not seen yet');
  // ardopcf 1.0.4.1.3, POTACAT's Pat with the variable at 120 (the no-radio run of test/modem-loopback/pat-arq-timeout.js)
  for (const l of [
    '19:24:54.636 D [Command Trace FROM host: ARQTIMEOUT 90]',
    '19:24:54.636 D  Command Trace TO Host ARQTIMEOUT now 90',
    '19:24:54.681 D [Command Trace FROM host: ARQTIMEOUT 120]',
    '19:24:54.681 D  Command Trace TO Host ARQTIMEOUT now 120',
    '19:24:54.726 I [SendARQConnectRequest] MYCALL=N0CALL  TARGET=N0CALL-10 bytPendingSessionID=ad',
  ]) s.note(c(l));
  assert.strictEqual(s.snapshot().arqTimeoutS, 120, 'the call that follows does not forget it');
  // upstream Pat: one command, 90
  const u = new D.ArdopLinkStory();
  u.note(c('19:24:54.636 D [Command Trace FROM host: ARQTIMEOUT 90]'));
  assert.strictEqual(u.snapshot().arqTimeoutS, 90);
  // a value the modem would refuse is not taken as in force
  u.note(c('19:24:55.000 D [Command Trace FROM host: ARQTIMEOUT 999]'));
  assert.strictEqual(u.snapshot().arqTimeoutS, 90);
  // the line is kept for a Report a Bug even when the cap cuts the start of the log
  assert.ok(D.ardopReportTail(['x', '19:24:54.681 D [Command Trace FROM host: ARQTIMEOUT 120]'].concat(Array(900).fill('19:25:00.000 I Sending Frame Type IDLE')).join('\n')).key.some((l) => /ARQTIMEOUT 120/.test(l)));
});

test('the session summary line records the timeout: what the modem was given, or what was asked', () => {
  const base = { state: 'error', mode: 'ardop', gateway: 'KY4RY', dialKhz: 7100.5, dialed: true, connected: true, modemEnd: { by: 'timeout' } };
  const line = (extra) => { const f = { ...base, ...extra }; return O.summaryLine({ ...f, outcome: O.describeOutcome(f), ranMs: 1000 }); };
  assert.ok(line({ arqTimeoutSetS: 120, arqTimeoutAskedS: 120 }).includes('; mode ARDOP; link timeout 120 s (set in the modem); ran '));
  // the operator's own Pat, without the patch: asked 120, the modem was given 90
  assert.ok(line({ arqTimeoutSetS: 90, arqTimeoutAskedS: 120 }).includes('; link timeout 90 s (set in the modem; POTACAT asked for 120 s); '));
  assert.ok(line({ arqTimeoutSetS: 0, arqTimeoutAskedS: 150 }).includes('; link timeout 150 s asked (the modem\'s log did not show it being set); '));
  assert.ok(!/link timeout/.test(line({})), 'nothing known, nothing said');
  // not an ARDOP session: no ARDOP timeout
  assert.ok(!/link timeout/.test(line({ mode: 'packet', arqTimeoutSetS: 120, arqTimeoutAskedS: 120 })));
  assert.ok(!/link timeout/.test(line({ mode: 'telnet', arqTimeoutAskedS: 120 })));
});

test('main.js starts Pat with the setting in its environment, relaunches Pat when it changes, and hands the value in force to the outcome', () => {
  const main = read('main.js');
  const spawnPat = main.slice(main.indexOf('function spawnPat()'), main.indexOf('proc.stdout.on(\'data\', relay);', main.indexOf('function spawnPat()')));
  assert.ok(spawnPat.includes('const patEnv = WinlinkPat.patSpawnEnv(process.env, { arqTimeoutS: settings.winlinkArdopArqTimeout });'));
  assert.ok(/spawn\(bin\.path, args, \{[^}]*\benv: patEnv\b[^}]*\}\)/.test(spawnPat), 'Pat is spawned with that environment');
  assert.ok(spawnPat.includes('_patArqTimeoutAskedS = Number(patEnv[WinlinkPat.ARDOP_ARQ_TIMEOUT.env]);'));
  assert.ok(/winlinkLog\(`ARDOP link timeout asked of Pat: \$\{_patArqTimeoutAskedS\} s`\)/.test(spawnPat), 'said in the Winlink log');
  // the variable name is written in one place
  assert.ok(!main.includes('POTACAT_ARDOP_ARQ_TIMEOUT'), 'main.js takes the name from lib/winlink-pat.js');
  const changed = /const winlinkChanged = \[([^\]]+)\]/.exec(main);
  assert.ok(changed && changed[1].includes('\'winlinkArdopArqTimeout\''), 'a new value relaunches Pat');
  const facts = main.slice(main.indexOf('function winlinkOutcomeFacts('), main.indexOf('function winlinkOutcomeView('));
  assert.ok(facts.includes('arqTimeoutSetS: (story && story.arqTimeoutS) || 0, arqTimeoutAskedS: _patArqTimeoutAskedS,'));
  assert.ok(facts.includes('arqTimeoutS: (story && story.arqTimeoutS) || _patArqTimeoutAskedS || 0,'));
});

test('Settings > Station > Winlink has the field beside the other ARDOP options, with its range and one plain help line', () => {
  const html = read('renderer/index.html');
  const at = html.indexOf('id="set-winlink-ardop-arq-timeout"');
  assert.ok(at > 0);
  assert.ok(html.includes('<label style="margin-left:8px;">ARDOP link timeout:\n          <input type="number" id="set-winlink-ardop-arq-timeout" min="90" max="180" step="10" value="120" style="width:60px;"> seconds\n        </label>'));
  const drive = html.indexOf('id="set-winlink-ardop-drive"'), vara = html.indexOf('id="winlink-vara-section"');
  assert.ok(drive > 0 && drive < at && at < vara, 'after the drive level, before VARA');
  const help = 'ARDOP link timeout: how long the modem keeps trying when nothing is getting through, before it ends the link. A longer time (up to 180 seconds) helps when the signal fades in and out. The gateway has a time limit of its own and may still hang up first.';
  assert.ok(html.includes(`<span class="help-text" style="display:block;">${help}</span>`));
  assert.ok(!/ARQ\b/.test(help), 'no modem jargon in the help');
  const app = read('renderer/app.js');
  assert.ok(app.includes('const setWinlinkArdopArqTimeout = document.getElementById(\'set-winlink-ardop-arq-timeout\');'));
  assert.ok(app.includes('if (setWinlinkArdopArqTimeout) setWinlinkArdopArqTimeout.value = Math.max(90, Math.min(180, parseInt(s.winlinkArdopArqTimeout, 10) || 120));'), 'shown: 120 unless saved');
  assert.ok(app.includes('...(setWinlinkArdopArqTimeout ? { winlinkArdopArqTimeout: Math.max(90, Math.min(180, parseInt(setWinlinkArdopArqTimeout.value, 10) || 120)) } : {}),'), 'saved inside the range');
});

test('the Pat build applies the patch, fails loudly without it, and leaves wl2k-go as go.sum pins it', () => {
  const sh = read('scripts/build-winlink-helpers.sh');
  const pat = sh.slice(sh.indexOf('if [[ " $want " == *" pat "* ]]; then'), sh.indexOf('if [[ " $want " == *" ardop "* ]]; then'));
  const apply = pat.indexOf('git -C "$WORK/pat" apply --ignore-whitespace "$ROOT/third_party/pat/potacat-arq-timeout.patch" || { echo "::error::potacat-arq-timeout.patch did not apply to pat $PAT_TAG"; exit 1; }');
  const build = pat.indexOf('go build -trimpath');
  assert.ok(apply > 0 && build > apply, 'the patch is applied before the build, and a patch that does not apply ends the build');
  assert.ok(sh.startsWith('#!/usr/bin/env bash') && /^set -euo pipefail$/m.test(sh), 'any failing step ends the script');
  assert.ok(pat.includes('grep -q \'a.potacatApplyARQTimeout()\' "$WORK/pat/app/connect.go"'), 'the hook is checked in the tree');
  assert.ok(pat.includes('grep -a -q \'POTACAT_ARDOP_ARQ_TIMEOUT\' "$ROOT/assets/pat/pat$EXE" || { echo "::error::the built Pat does not carry the ARQ timeout patch"; exit 1; }'), 'and in the binary');
  assert.ok(/^WL2K_GO_VERSION=v1\.0\.1$/m.test(sh) && pat.includes('[ "$WL2K_VER" = "$WL2K_GO_VERSION" ] ||') && pat.includes('go mod verify'));
  assert.ok(pat.indexOf('go mod download') > 0 && pat.indexOf('go mod download') < pat.indexOf("go list -m -f '{{.Dir}}'"), 'the module is fetched before its folder is read (CI 2026-11-12: empty cache, empty .Dir)');
  assert.ok(!/go mod vendor|-mod=mod|\breplace\b/.test(pat), 'no vendored or replaced dependency');
  // The patch itself: Pat's own source only, LF, and the two files it is described as touching.
  const patchRaw = require('fs').readFileSync(path.join(root, 'third_party', 'pat', 'potacat-arq-timeout.patch'), 'utf8');
  const files = [...patchRaw.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(files, ['app/connect.go', 'app/potacat_arq_timeout.go']);
  assert.ok(patchRaw.includes('potacatARQTimeoutEnv = "POTACAT_ARDOP_ARQ_TIMEOUT"') && patchRaw.includes('potacatARQTimeoutMin = 30') && patchRaw.includes('potacatARQTimeoutMax = 240'));
  assert.ok(patchRaw.includes(`"${W.ARDOP_ARQ_TIMEOUT.env}"`), 'the same variable name on both sides');
  assert.ok(read('.gitattributes').includes('third_party/pat/potacat-arq-timeout.patch -text'), 'never rewritten by a checkout');
  // Recorded where the repo records third-party changes.
  assert.ok(/Pat \(Winlink client\)[\s\S]{0,500}Modified by POTACAT[\s\S]{0,300}potacat-arq-timeout\.patch/.test(read('NOTICE')));
  assert.ok(read('third_party/pat/README.md').includes('potacat-arq-timeout.patch'));
  // The licences, the modification notice and the patch itself go out inside every package.
  const pkgFiles = require("../package.json").build.files;
  for (const f of ['NOTICE', 'third_party/pat/LICENSE', 'third_party/pat/LICENSE-wl2k-go', 'third_party/pat/README.md', 'third_party/pat/potacat-arq-timeout.patch']) assert.ok(pkgFiles.includes(f), f + " is packaged");
  assert.ok(/Copyright \(c\) 2014-2017 Martin Hebnes Pedersen/.test(read('third_party/pat/LICENSE-wl2k-go')) && pat.includes('cp "$WL2K_DIR/LICENSE" "$ROOT/third_party/pat/LICENSE-wl2k-go"'));
  // And proven on the built binaries on every helper runner.
  const wf = read('.github/workflows/winlink-helpers.yml');
  assert.strictEqual(wf.split('run: node test/modem-loopback/pat-arq-timeout.js --out pat-arq-timeout-results.json --logs pat-arq-timeout-logs').length - 1, 3, 'windows, linux (x64 + arm64) and mac (arm64 + x64) jobs');
  assert.strictEqual(wf.split('run: node test/modem-loopback/pat-session.js --out pat-session-results.json --logs pat-session-logs').length - 1, 3, 'and the end-to-end Pat layer on every job');
  // The test Pats never use the PC's own Pat state and never reach winlink.org.
  const penv = read('test/modem-loopback/pat-env.js');
  assert.ok(penv.includes('XDG_STATE_HOME') && penv.includes("'account-confirmed', 'version_report'") && penv.includes("'http://127.0.0.1:9'"));
  for (const f of ['test/modem-loopback/pat-arq-timeout.js', 'test/modem-loopback/pat-session.js']) assert.ok(read(f).includes("require('./pat-env')"), f);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
