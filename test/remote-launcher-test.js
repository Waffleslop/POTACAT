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
  const soft = stop.indexOf('taskkill /PID ${pid} /T`'), hard = stop.indexOf('taskkill /PID ${pid} /T /F');
  assert.ok(soft >= 0 && hard > soft, 'a plain taskkill (WM_CLOSE) before the /F kill');
  assert.ok(/GRACEFUL_STOP_MS = (\d+)/.test(src) && +/GRACEFUL_STOP_MS = (\d+)/.exec(src)[1] > 5000,
    'the wait outlasts the app\'s 5 s before-quit watchdog');
  assert.ok(/getOtherPids\(\) : pids\)/.test(stop), 'the forced pass re-reads the table after the graceful wait');
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
