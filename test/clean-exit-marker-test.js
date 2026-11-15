'use strict';
// #550: a Launcher run consumed the GUI's clean-exit marker and rotated its
// startup.log, so the next GUI start reported a crash that never happened.
// These tests drive lib/clean-exit-marker.js against a real temp folder the
// way main.js does: prepareStartupLog at the first log line, then a fresh
// log written, then stampCleanExit as the last step of a graceful shutdown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../lib/clean-exit-marker');

const GUI = ['electron', '.'];
const LAUNCHER = ['POTACAT.exe', '--launcher'];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-cem-'));
}

// One launch as main.js does it. Returns the startup facts; `exit` decides
// whether the run ends cleanly (marker stamped) or dies (nothing written).
function launch(dir, argv, { exit = 'clean', body = 'run' } = {}) {
  const prep = M.prepareStartupLog({ dir, argv, fs });
  fs.writeFileSync(prep.logPath, `header ${argv.join(' ')}\n${body}\n`);
  if (exit === 'clean') M.stampCleanExit(prep.markerPath, fs);
  return prep;
}

const marker = (dir) => path.join(dir, M.MARKER_NAME);
const guiLog = (dir) => path.join(dir, M.GUI_LOG_NAME);
const read = (p) => fs.readFileSync(p, 'utf8');

test('a clean GUI exit, then a Launcher run, then a GUI start reports no crash', () => {
  const dir = tmpDir();
  launch(dir, GUI, { exit: 'clean' });
  // The Launcher starts at login and keeps running while the GUI starts.
  launch(dir, LAUNCHER, { exit: 'crash' });
  const next = launch(dir, GUI);
  assert.strictEqual(next.prevRunUnclean, false, 'the clean quit must not read as a crash');
});

test('the same holds when the Launcher run also ends cleanly', () => {
  const dir = tmpDir();
  launch(dir, GUI, { exit: 'clean' });
  launch(dir, LAUNCHER, { exit: 'clean' });
  launch(dir, LAUNCHER, { exit: 'clean' });
  assert.strictEqual(launch(dir, GUI).prevRunUnclean, false);
});

test('a real crash (no marker) is still reported, Launcher or not', () => {
  const dir = tmpDir();
  launch(dir, GUI, { exit: 'clean' });
  launch(dir, GUI, { exit: 'crash' });
  assert.strictEqual(launch(dir, GUI).prevRunUnclean, true, 'crash with no Launcher in between');

  const dir2 = tmpDir();
  launch(dir2, GUI, { exit: 'clean' });
  launch(dir2, GUI, { exit: 'crash' });
  launch(dir2, LAUNCHER, { exit: 'clean' }); // a clean Launcher exit must not hide it
  assert.strictEqual(launch(dir2, GUI).prevRunUnclean, true, 'crash with a Launcher run in between');
});

test('the very first GUI start (no marker ever written) reads as unclean, as before', () => {
  assert.strictEqual(launch(tmpDir(), GUI).prevRunUnclean, true);
});

test('a Launcher run leaves the marker and the GUI log untouched', () => {
  const dir = tmpDir();
  launch(dir, GUI, { exit: 'clean', body: 'the GUI session' });
  const markerBefore = read(marker(dir));
  const logBefore = read(guiLog(dir));
  assert.ok(!fs.existsSync(guiLog(dir) + '.old'), 'precondition: no rotated GUI log yet');

  const prep = launch(dir, LAUNCHER, { exit: 'clean', body: 'the launcher' });

  assert.strictEqual(read(marker(dir)), markerBefore, 'marker unchanged');
  assert.strictEqual(read(guiLog(dir)), logBefore, 'startup.log unchanged');
  assert.ok(!fs.existsSync(guiLog(dir) + '.old'), 'startup.log not rotated');
  assert.strictEqual(prep.markerPath, null, 'a side mode gets no marker path to stamp');
  assert.strictEqual(prep.prevRunUnclean, false);
  assert.strictEqual(path.basename(prep.logPath), 'launcher-startup.log');
  assert.match(read(prep.logPath), /the launcher/);
});

test('a Launcher run does not stamp the marker over a GUI run that is still alive', () => {
  // GUI running (marker consumed at its start) when the Launcher starts and
  // quits: the GUI's later crash must still be visible.
  const dir = tmpDir();
  launch(dir, GUI, { exit: 'clean' });
  M.prepareStartupLog({ dir, argv: GUI, fs }); // GUI starts, marker gone
  launch(dir, LAUNCHER, { exit: 'clean' });
  assert.ok(!fs.existsSync(marker(dir)), 'the Launcher must not write the marker');
});

test('the Launcher keeps its own previous log, like the GUI does', () => {
  const dir = tmpDir();
  launch(dir, LAUNCHER, { body: 'first launcher run' });
  const prep = launch(dir, LAUNCHER, { body: 'second launcher run' });
  assert.match(read(prep.logPath + '.old'), /first launcher run/);
  assert.match(read(prep.logPath), /second launcher run/);
});

test('modes: only the GUI session (including --headless) owns the marker', () => {
  assert.strictEqual(M.ownsSession(GUI), true);
  assert.strictEqual(M.ownsSession(['POTACAT', '--headless']), true);
  assert.strictEqual(M.ownsSession(LAUNCHER), false);
  assert.strictEqual(M.ownsSession(['POTACAT', '--print-cert-fingerprint']), false);
  assert.strictEqual(M.startupLogName(GUI), 'startup.log');
  assert.strictEqual(M.startupLogName(['POTACAT', '--print-cert-fingerprint']), 'cli-startup.log');
  assert.strictEqual(M.ownsSession(undefined), true);
  assert.strictEqual(M.stampCleanExit(null, fs), false);
});

test('wiring: main.js takes rotation and the marker from the lib, nowhere else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/CleanExitMarker\.prepareStartupLog\(\{ dir, argv: process\.argv, fs: fsx \}\)/.test(src),
    'the first log line prepares the log through the lib with the real argv');
  const req = src.indexOf("const CleanExitMarker = require('./lib/clean-exit-marker');");
  const firstStage = src.search(/^logStartupStage\(/m);
  assert.ok(req > 0 && firstStage > 0 && req < firstStage,
    'the lib is required before the first log line, or _appendStartupLog hits the const before it exists');
  assert.ok(/stampCleanExit\(_cleanExitMarkerPath, fs\)/.test(src), 'graceful shutdown stamps through the lib');
  assert.ok(!/unlinkSync\(_cleanExitMarkerPath\)/.test(src), 'no second marker removal in main.js');
  assert.ok(!/writeFileSync\(_cleanExitMarkerPath/.test(src), 'no second marker write in main.js');
  assert.ok(!/join\(dir, 'startup\.log'\)/.test(src.slice(0, src.indexOf('function logStartupStage'))),
    'the startup log name comes from the lib, so a side mode cannot rotate startup.log');
});
