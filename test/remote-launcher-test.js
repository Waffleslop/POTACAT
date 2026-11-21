// Remote Launcher (scripts/launcher.js) — the "Start said it worked but no
// window appeared" family (officiallor GitHub #84, KB2UXB 2026-06-25) and the
// launcher copy that never updated.
//
// launcher.js starts its HTTP server when it is loaded, so the pure pieces
// are lifted out of the source text and evaluated on their own.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
const src = R('scripts/launcher.js');
const main = R('main.js');

function lift(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, i + 1) + '\nreturn ' + name + ';')();
}
const appPidsFromProcessTable = lift('appPidsFromProcessTable');
// appMainPidsFromProcessTable calls appPidsFromProcessTable, so lift the two together.
function liftWith(name, deps) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), src.slice(start, i + 1) + '\nreturn ' + name + ';')(...Object.values(deps));
}
const appMainPidsFromProcessTable = liftWith('appMainPidsFromProcessTable', { appPidsFromProcessTable });
const appEnv = lift('appEnv');

test('Start never hands the app ELECTRON_RUN_AS_NODE (it started as bare Node and exited)', () => {
  const env = appEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: 'x', APPDATA: 'y' });
  assert.ok(!('ELECTRON_RUN_AS_NODE' in env) && !('ELECTRON_NO_ATTACH_CONSOLE' in env));
  assert.strictEqual(env.PATH, 'x');
  const start = src.slice(src.indexOf('async function startPotacat('), src.indexOf('async function stopPotacat('));
  assert.ok(/env: appEnv\(process\.env\)/.test(start), 'spawn passes the cleaned environment');
});

test('Start reports success only if the app is still running after START_CONFIRM_MS', () => {
  const start = src.slice(src.indexOf('async function startPotacat('), src.indexOf('async function stopPotacat('));
  assert.ok(/child\.once\('exit'/.test(start) && /setTimeout\(\(\) => resolve\(null\), START_CONFIRM_MS\)/.test(start));
  assert.ok(/if \(exited\) \{[\s\S]{0,400}return \{ ok: false/.test(start));
  assert.ok(/const result = await startPotacat\(\);/.test(src), 'the /start endpoint waits for the verdict');
});

// Process tables as Win32_Process reports them.
const ME = 5000;
test('a full-Electron launcher and its GPU/utility children are not "POTACAT is running"', () => {
  const rows = [
    { ProcessId: ME, ParentProcessId: 1, CommandLine: '"C:\\POTACAT\\POTACAT.exe" --launcher' },
    { ProcessId: 5001, ParentProcessId: ME, CommandLine: '"C:\\POTACAT\\POTACAT.exe" --type=gpu-process' },
    { ProcessId: 5002, ParentProcessId: ME, CommandLine: '"C:\\POTACAT\\POTACAT.exe" --type=utility' },
  ];
  assert.deepStrictEqual(appPidsFromProcessTable(rows, ME), []);
});

test('the real app and its children are found, next to a launcher', () => {
  const rows = [
    { ProcessId: ME, ParentProcessId: 1, CommandLine: '"C:\\POTACAT\\POTACAT.exe" C:\\Users\\x\\AppData\\Roaming\\POTACAT\\launcher.js' },
    { ProcessId: 7000, ParentProcessId: 900, CommandLine: '"C:\\POTACAT\\POTACAT.exe"' },
    { ProcessId: 7001, ParentProcessId: 7000, CommandLine: '"C:\\POTACAT\\POTACAT.exe" --type=renderer' },
  ];
  assert.deepStrictEqual(appPidsFromProcessTable(rows, ME), [7000, 7001]);
  // /status names the MAIN process even when a child is listed first.
  assert.deepStrictEqual(appPidsFromProcessTable([rows[2], rows[1]], ME), [7000, 7001]);
});

// 1.10.24 (officiallor #84): Stop made the window vanish while POTACAT kept
// running. The app the LAUNCHER started has the launcher as its parent, and
// the filter dropped every launcher child — so only the app's renderer/GPU
// were killed and the main process survived with no window.
test('the app the launcher STARTED is the app; only the launcher\'s own helpers are excluded', () => {
  const rows = [
    { ProcessId: ME, ParentProcessId: 1, CommandLine: '"C:\POTACAT\POTACAT.exe" --launcher' },
    { ProcessId: 5001, ParentProcessId: ME, CommandLine: '"C:\POTACAT\POTACAT.exe" --type=gpu-process' },
    { ProcessId: 7001, ParentProcessId: 7000, CommandLine: '"C:\POTACAT\POTACAT.exe" --type=renderer' },
    { ProcessId: 7000, ParentProcessId: ME, CommandLine: '"C:\POTACAT\POTACAT.exe"' },
  ];
  assert.deepStrictEqual(appPidsFromProcessTable(rows, ME), [7000, 7001]);
  assert.deepStrictEqual(appMainPidsFromProcessTable(rows, ME), [7000], 'the graceful close goes to the main process');
});

test('Stop closes the app gracefully first and force-kills only what is left', () => {
  const stop = src.slice(src.indexOf('async function stopPotacat('), src.indexOf('async function restartPotacat('));
  const soft = stop.indexOf('taskkillEach(plan.kill, false)'), hard = stop.indexOf('taskkillEach(forced.kill, true)');
  assert.ok(soft >= 0 && hard > soft, 'a plain taskkill (WM_CLOSE) before the /F kill');
  assert.ok(/GRACEFUL_STOP_MS = (\d+)/.test(src) && +/GRACEFUL_STOP_MS = (\d+)/.exec(src)[1] > 5000,
    'the wait outlasts the app\'s 5 s before-quit watchdog');
  assert.ok(/const now = readWindowsProcessTable\(\);/.test(stop) && /getOtherPids\(\), \.\.\.stillAlive\(/.test(stop),
    'the forced pass re-reads the table after the graceful wait');
});

// #819: POTACAT's Install / Start now buttons spawn the launcher, so the
// launcher is a child in POTACAT's tree, and `taskkill /T` on POTACAT killed
// it with the app: a restart from the phone stopped POTACAT and never started
// it again. Process tables below are { pid, ppid, created (ms) }.
const L = require('../scripts/launcher.js');

test('#819: the launcher POTACAT started survives the stop; the app and every helper do not', () => {
  const t = 1000;
  const rows = [
    { pid: 900, ppid: 4, created: 1 },               // explorer
    { pid: 7000, ppid: 900, created: t },             // POTACAT main
    { pid: 7001, ppid: 7000, created: t + 1 },        // renderer
    { pid: 7002, ppid: 7000, created: t + 1 },        // GPU
    { pid: 7100, ppid: 7000, created: t + 5 },        // rigctld (holds COM3, TCP 4532)
    { pid: 7101, ppid: 7000, created: t + 6 },        // direwolf
    { pid: 7102, ppid: 7000, created: t + 7 },        // cloudflared (POTACAT's tunnel)
    { pid: 7103, ppid: 7000, created: t + 8 },        // pat
    { pid: 7104, ppid: 7103, created: t + 9 },        // conhost under pat
    { pid: ME, ppid: 7000, created: t + 10 },         // this launcher (Start now)
    { pid: 5100, ppid: ME, created: t + 11 },         // the launcher's own cloudflared replica
    { pid: 8000, ppid: 900, created: t + 12 },        // something unrelated
  ];
  const plan = L.treeKillPlan(rows, [7000, 7001, 7002], ME);
  assert.deepStrictEqual(plan.kill, [7000, 7001, 7002, 7100, 7101, 7102, 7103, 7104]);
  assert.ok(plan.launcherInTree);
  assert.ok(!plan.kill.includes(ME) && !plan.kill.includes(5100), 'the launcher and its replica live');
  assert.ok(!plan.kill.includes(8000) && !plan.kill.includes(900), 'nothing outside the app is touched');
  assert.strictEqual(plan.kill[0], 7000, 'the parent goes first, so it cannot start a new child');
});

test('#819: the app the launcher started (the launcher\'s child) is still stopped, with its helpers', () => {
  const rows = [
    { pid: ME, ppid: 4, created: 10 },
    { pid: 5100, ppid: ME, created: 11 },   // replica cloudflared
    { pid: 5001, ppid: ME, created: 11 },   // the launcher's GPU helper (--launcher mode)
    { pid: 7000, ppid: ME, created: 20 },   // POTACAT, started by the launcher
    { pid: 7001, ppid: 7000, created: 21 },
    { pid: 7100, ppid: 7000, created: 25 },  // rigctld
  ];
  const plan = L.treeKillPlan(rows, [7000, 7001], ME);
  assert.deepStrictEqual(plan.kill, [7000, 7001, 7100]);
  assert.ok(!plan.launcherInTree);
  assert.deepStrictEqual(plan.spared.sort((a, b) => a - b), [ME, 5001, 5100]);
});

test('#819: a reused parent PID does not adopt an older, unrelated process', () => {
  const rows = [
    { pid: 7000, ppid: 900, created: 5000 },  // POTACAT, got a PID that an old process's parent once had
    { pid: 6000, ppid: 7000, created: 100 },  // older than POTACAT: not its child
    { pid: 7100, ppid: 7000, created: 5005 },
  ];
  assert.deepStrictEqual(L.treeKillPlan(rows, [7000], ME).kill, [7000, 7100]);
});

test('#819: a helper whose POTACAT already exited is still found from the first snapshot', () => {
  const before = [
    { pid: 7000, ppid: 900, created: 1000 },
    { pid: 7100, ppid: 7000, created: 1005 },  // rigctld
    { pid: 7101, ppid: 7000, created: 1006 },  // exited during the graceful wait
    { pid: 7102, ppid: 7000, created: 1007 },  // PID reused by a new process since
  ];
  const now = [
    { pid: 7100, ppid: 7000, created: 1005 },
    { pid: 7102, ppid: 900, created: 9000 },
  ];
  assert.deepStrictEqual(L.stillAlive([7000, 7100, 7101, 7102], before, now), [7100]);
  assert.deepStrictEqual(L.treeKillPlan(now, [7100], ME).kill, [7100]);
});

test('#819: the Windows process-table lines parse (and junk lines are skipped)', () => {
  const rows = L.parseProcessTable('0 0 0\r\n4 0 13400000000000\r\n\r\nWARNING: x\r\n7000 900 13400000005000\r\n');
  assert.deepStrictEqual(rows, [
    { pid: 0, ppid: 0, created: null },
    { pid: 4, ppid: 0, created: 13400000000000 },
    { pid: 7000, ppid: 900, created: 13400000005000 },
  ]);
});

test('#819: the stop never walks the tree with /T while the process table can be read', () => {
  const stop = src.slice(src.indexOf('async function stopPotacat('), src.indexOf('async function restartPotacat('));
  assert.ok(/plan = treeKillPlan\(table, pids, MY_PID\)/.test(stop));
  // /T remains only in the fallbacks for a machine where PowerShell/CIM fails.
  const each = src.slice(src.indexOf('function taskkillEach('), src.indexOf('/** Get all PIDs of POTACAT.exe'));
  assert.ok(!/\/T\b/.test(each), 'the planned kill names each PID alone');
  assert.ok(/if \(plan\) \{\s*if \(mains\.length\) taskkillEach\(plan\.kill, false\);\s*\} else \{/.test(stop));
  assert.ok(/if \(forced\) \{/.test(stop));
});

test('a SECOND launcher (old --launcher login item + new launcher.js) is not the app either', () => {
  const rows = [
    { ProcessId: ME, ParentProcessId: 1, CommandLine: 'node launcher.js' },
    { ProcessId: 6000, ParentProcessId: 1, CommandLine: '"C:\\POTACAT\\POTACAT.exe" --launcher' },
    { ProcessId: 6001, ParentProcessId: 6000, CommandLine: '"C:\\POTACAT\\POTACAT.exe" --type=gpu-process' },
  ];
  assert.deepStrictEqual(appPidsFromProcessTable(rows, ME), []);
});

test('Linux: settings folder case, real process names, deb/rpm paths', () => {
  const cfg = src.slice(src.indexOf('function getConfigDir('), src.indexOf('const CONFIG_DIR'));
  assert.ok(/'\.config', 'POTACAT'/.test(cfg) && /settings\.json/.test(cfg));
  assert.ok(/LINUX_PROCESS_NAMES = \['potacat\.bin', 'potacat', 'POTACAT'\]/.test(src));
  assert.ok(/'\/usr\/bin\/potacat'/.test(src) && /'\/opt\/POTACAT\/potacat'/.test(src));
  assert.ok(/else launcherCfgDir = userData;/.test(main), 'main and the launcher agree on the Linux folder');
});

test('an installed launcher copy is brought up to this build at launch', () => {
  const r = main.slice(main.indexOf('async function _refreshInstalledLauncher('), main.indexOf('async function _uninstallLauncher('));
  assert.ok(/if \(fs\.readFileSync\(launcherDest, 'utf8'\) === bundled\) return;/.test(r), 'only when it differs');
  assert.ok(/fs\.writeFileSync\(launcherDest, bundled\)/.test(r));
  assert.ok(/process\.kill\(pid\);[\s\S]*_spawnLauncherProc\(launcherDest\)/.test(r), 'a running launcher is restarted on the new code');
  assert.ok(/_refreshInstalledLauncher\(\)\.catch/.test(main), 'called at launch');
});

console.log(`\nRemote launcher: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
