// The Winlink session summary lines survive a restart (#425).
//
// Each session ends with one "session summary:" line, and the last 8 radio
// sessions go into Report a Bug. They lived in memory only: an operator whose
// link dropped, who restarted POTACAT and then pressed Report a Bug, sent a
// report without the session that dropped.
//
// Now: written to session-summaries.json in the profile's Winlink folder when
// a session ends, read back when they are next needed.
// Run: node test/winlink-summary-store-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js')).replace(/\r\n/g, '\n');
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let depth = 0;
  for (let k = src.indexOf(') {', i) + 2; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(name + ': unbalanced');
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-wl-summaries-'));
/** The modules as a freshly started POTACAT has them: nothing kept from before. */
function freshModules() {
  for (const k of Object.keys(require.cache)) if (/winlink-(summary-store|outcome)\.js$/.test(k)) delete require.cache[k];
  return { S: require('../lib/winlink-summary-store'), O: require('../lib/winlink-outcome') };
}
const DROP = 'session summary: the link dropped after it connected; gateway KY4RY; dial 7103.0 kHz; mode ARDOP; ran 3 min 11 s (connected for 2 min 50 s); moved: 0 sent, 0 received, 2 in the Outbox; last modem state: IRS; ended by: this station\'s modem, on its ARQ timeout; Pat\'s reply: connect: HTTP 500 — Session failure {"NumReceived":0}';
const GOOD = 'session summary: mail exchanged; gateway KY4RY; dial 7103.0 kHz; mode ARDOP; ran 2 min 07 s (connected for 1 min 58 s); moved: 2 sent, 0 received, 0 in the Outbox';

console.log('winlink: session summaries across a restart (#425)');

test('write, restart, read: the lines come back as they were, oldest first, with their times', () => {
  const file = path.join(tmp, 'a', 'winlink', 'session-summaries.json');
  let { S, O } = freshModules();
  const list = [];
  O.keepSummary(list, { at: Date.UTC(2026, 10, 12, 1, 4, 30), radio: true, line: DROP });
  O.keepSummary(list, { at: Date.UTC(2026, 10, 12, 1, 9, 2), radio: true, line: GOOD });
  assert.strictEqual(S.save(file, list), true, 'the folder is made if it is not there');
  ({ S, O } = freshModules());                 // POTACAT restarts: nothing in memory
  const back = S.load(file);
  assert.deepStrictEqual(back, list);
  assert.deepStrictEqual(O.summaryLines(back), ['2026-11-12T01:04:30Z ' + DROP, '2026-11-12T01:09:02Z ' + GOOD]);
  assert.strictEqual(S.fileIn(path.join(tmp, 'a', 'winlink')), file);
});

test('Report a Bug after a restart holds the session from before it (main.js\'s own functions, run twice)', () => {
  const dir = path.join(tmp, 'b', 'winlink');
  const decl = (name) => { const m = new RegExp(`^(?:let|const) ${name} = [^;]+;`, 'm').exec(main); assert.ok(m, `${name} is declared in main.js`); return m[0]; };
  // One "run" of POTACAT: main.js's declarations and functions, in a context of their own.
  const run = () => {
    const { S, O } = freshModules();
    const logs = [];
    const ctx = vm.createContext({
      WinlinkSummaryStore: S, WinlinkOutcome: O, WinlinkDiag: require('../lib/winlink-diag'), fs, path,
      settings: { winlinkPassword: 'HUNTER22' }, winlinkDir: () => dir, winlinkPaths: () => ({ ardopLogs: path.join(dir, 'ardop-logs') }),
      newestModemLog: () => null, _direwolfRing: [], winlinkLog: (m) => logs.push(m), Date,
    });
    vm.runInContext([decl('_winlinkSummaries'), decl('_winlinkSummariesFile'), fnBody(main, 'winlinkSummariesLoad'), fnBody(main, 'winlinkSummariesSave'), fnBody(main, 'winlinkModemReport'),
      // What winlinkSettleOutcome does with a finished session's line: the three statements, as they stand in main.js.
      `function keep(endedAt, radio, line) { const s = { mode: radio ? 'ardop' : 'telnet' }; const WinlinkModes = { isRadioMode: (m) => m !== 'telnet' };
         ${/winlinkSummariesLoad\(\);[^\n]*\n\s*WinlinkOutcome\.keepSummary\(_winlinkSummaries, \{ at: endedAt, radio: WinlinkModes\.isRadioMode\(s\.mode\), line \}\);\n\s*winlinkSummariesSave\(\);/.exec(fnBody(main, 'winlinkSettleOutcome'))[0]} }`,
      'globalThis.api = { keep, report: winlinkModemReport };'].join('\n'), ctx, { filename: 'main.js (the summary functions)' });
    return { api: ctx.api, logs };
  };
  // First run: a session drops, then one is finished.
  const first = run();
  assert.deepStrictEqual(Array.from(first.api.report().sessions), [], 'nothing yet');
  first.api.keep(Date.UTC(2026, 10, 12, 1, 4, 30), true, DROP);
  first.api.keep(Date.UTC(2026, 10, 12, 1, 9, 2), true, GOOD);
  assert.strictEqual(first.api.report().sessions.length, 2);
  assert.deepStrictEqual(first.logs, [], 'nothing to say when the write works');
  // The operator restarts POTACAT and presses Report a Bug.
  const second = run();
  const rep = Array.from(second.api.report().sessions);
  assert.deepStrictEqual(rep, ['2026-11-12T01:04:30Z ' + DROP, '2026-11-12T01:09:02Z ' + GOOD], 'the report after the restart');
  // A session in the second run is added to them, not written over them.
  second.api.keep(Date.UTC(2026, 10, 12, 2, 0, 0), true, 'session summary: never connected (no answer); gateway W4XYZ');
  const third = run();
  const rep3 = Array.from(third.api.report().sessions);
  assert.strictEqual(rep3.length, 3);
  assert.ok(/KY4RY/.test(rep3[0]) && /W4XYZ/.test(rep3[2]), 'oldest first, latest last');
});

test('the caps hold on disk: 8 radio sessions, 2 internet ones, and the half-hourly internet check never pushes a radio session out', () => {
  const file = path.join(tmp, 'c', 'session-summaries.json');
  const { S, O } = freshModules();
  const list = [];
  O.keepSummary(list, { at: 1000, radio: true, line: DROP });
  for (let i = 0; i < 40; i++) O.keepSummary(list, { at: 2000 + i, radio: false, line: 'session summary: mail exchanged; mode internet #' + i });
  S.save(file, list);
  let back = S.load(file);
  assert.strictEqual(back.filter((e) => e.radio).length, 1, 'the dropped radio session is still there');
  assert.strictEqual(back.filter((e) => !e.radio).length, 2);
  // A file with more than the caps (written by hand, or by a later version) is cut to them on the way in.
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ at: 5000 + i, radio: true, line: 'radio #' + i });
  fs.writeFileSync(file, JSON.stringify({ v: S.VERSION, sessions: many }));
  back = S.load(file);
  assert.strictEqual(back.length, 8);
  assert.strictEqual(back[0].line, 'radio #22');
  assert.strictEqual(back[7].line, 'radio #29');
  assert.deepStrictEqual(S.CAPS, { radio: 8, internet: 2 });
});

test('the file stays small: a line is one line, cut at MAX_LINE; the whole file is under 25 kB at its fullest', () => {
  const file = path.join(tmp, 'd', 'session-summaries.json');
  const { S } = freshModules();
  const list = [];
  for (let i = 0; i < 12; i++) list.push({ at: 1000 + i, radio: i < 10, line: 'session summary: ' + 'x'.repeat(9000) + '\nsecond line\ttabbed' });
  assert.ok(S.save(file, list));
  const back = S.load(file);
  assert.strictEqual(back.length, 10);
  for (const e of back) { assert.ok(e.line.length <= S.MAX_LINE); assert.ok(!/[\r\n\t]/.test(e.line)); assert.ok(e.line.endsWith('…')); }
  assert.ok(fs.statSync(file).size < 25 * 1024, 'size ' + fs.statSync(file).size);
});

test('no secrets: the file holds times and lines only, and a password that reached a line is struck out', () => {
  const file = path.join(tmp, 'e', 'session-summaries.json');
  const { S } = freshModules();
  S.save(file, [{ at: 1000, radio: true, line: 'session summary: ended; Pat\'s reply: login HUNTER22 refused', password: 'HUNTER22', extra: { token: 'abc' } }], { secrets: ['HUNTER22', '', null, 'ab'] });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/HUNTER22/.test(text), text);
  assert.ok(/login \*\*\* refused/.test(text));
  assert.deepStrictEqual(Object.keys(JSON.parse(text).sessions[0]).sort(), ['at', 'line', 'radio'], 'only the three fields are written');
  // main.js passes the Winlink password to be struck out.
  assert.ok(/WinlinkSummaryStore\.save\(_winlinkSummariesFile, _winlinkSummaries, \{ secrets: \[settings\.winlinkPassword\] \}\)/.test(fnBody(main, 'winlinkSummariesSave')));
  // A real summary line carries no password: it is built from these and nothing else.
  const O = require('../lib/winlink-outcome');
  assert.ok(!/password/i.test(O.summaryLine.toString().replace(/Winlink refused the password/g, '')), 'summaryLine reads no password field');
});

test('a missing, empty, broken or foreign file reads as no lines, and never throws', () => {
  const { S } = freshModules();
  const dir = path.join(tmp, 'f'); fs.mkdirSync(dir, { recursive: true });
  assert.deepStrictEqual(S.load(path.join(dir, 'none.json')), []);
  const f = path.join(dir, 'session-summaries.json');
  for (const body of ['', '{', 'null', '[]', '{"v":99,"sessions":[{"at":1,"radio":true,"line":"x"}]}', '{"v":1,"sessions":"no"}', '{"v":1}']) {
    fs.writeFileSync(f, body);
    assert.deepStrictEqual(S.load(f), [], JSON.stringify(body));
  }
  fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: [null, 7, { at: 'x', line: 'no time' }, { at: 5, radio: true }, { at: 6, radio: 1, line: '  kept  ' }, { at: -1, line: 'bad time' }] }));
  assert.deepStrictEqual(S.load(f), [{ at: 6, radio: true, line: 'kept' }], 'whole entries only');
});

test('a write that fails says so once in the log and leaves the old file whole', () => {
  const { S } = freshModules();
  const dir = path.join(tmp, 'g'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session-summaries.json');
  assert.ok(S.save(file, [{ at: 1, radio: true, line: 'first' }]));
  // The target is a folder: the rename cannot happen.
  const blocked = path.join(dir, 'blocked.json'); fs.mkdirSync(blocked);
  assert.strictEqual(S.save(blocked, [{ at: 2, radio: true, line: 'second' }]), false);
  assert.ok(!fs.existsSync(blocked + '.tmp'), 'no temporary file left behind');
  assert.deepStrictEqual(S.load(file), [{ at: 1, radio: true, line: 'first' }]);
  assert.ok(/could not be saved for the next start/.test(fnBody(main, 'winlinkSummariesSave')));
});

test('wired: read before the first use and after a profile switch, written when a session ends, in the profile\'s Winlink folder', () => {
  const load = fnBody(main, 'winlinkSummariesLoad');
  assert.ok(/file = WinlinkSummaryStore\.fileIn\(winlinkDir\(\)\);/.test(load), 'beside Pat\'s own log, per profile');
  assert.ok(/if \(file === _winlinkSummariesFile\) return;/.test(load), 'read once per profile, not on every report');
  assert.ok(/_winlinkSummaries\.length = 0;/.test(load), 'another profile\'s lines are not mixed in');
  const settle = fnBody(main, 'winlinkSettleOutcome');
  const a = settle.indexOf('winlinkSummariesLoad();'), b = settle.indexOf('WinlinkOutcome.keepSummary(_winlinkSummaries,'), c = settle.indexOf('winlinkSummariesSave();');
  assert.ok(a > 0 && b > a && c > b, 'load, keep, save, in that order');
  assert.ok(/^function winlinkModemReport\(\) \{\n {2}winlinkSummariesLoad\(\);/.test(fnBody(main, 'winlinkModemReport')), 'Report a Bug reads them first');
  const app = readSrc(path.join(root, 'renderer', 'app.js'));
  assert.ok(/### Winlink sessions \(latest last\)/.test(app) && /wm\.sessions\.join\('\\n'\)/.test(app), 'the report section is unchanged');
  assert.ok(/sessions: clean\(m\.sessions \|\| \[\]\)/.test(main), 'and still masked like the session log');
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-summary-store-test.js'"));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
