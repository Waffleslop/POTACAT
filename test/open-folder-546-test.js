#!/usr/bin/env node
'use strict';
// #546: SSTV "Open folder" did nothing when Pictures/POTACAT/SSTV-RX was not
// there: shell.openPath() resolves with an error string on a missing folder
// and the handler ignored it. lib/open-folder.js makes the folder first, then
// opens it, and returns a plain-words failure the window shows.
// Run: node test/open-folder-546-test.js
const assert = require('assert');
const path = require('path');
const { readSrc: readRaw } = require('./_src');
const readSrc = (f) => readRaw(path.join(__dirname, '..', f));
const { openFolder } = require('../lib/open-folder');

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// In-memory fs.promises.mkdir with Node's recursive semantics: returns the
// first folder it made, or undefined when the whole path was there.
function fakeFsp({ dirs = [], mkdirError = null, mkdirHangs = false } = {}) {
  const d = new Set(dirs.map((x) => path.resolve(x)));
  const calls = [];
  return {
    dirs: d,
    calls,
    mkdir(dir, opts) {
      calls.push({ dir, opts });
      if (mkdirHangs) return new Promise(() => {});
      if (mkdirError) return Promise.reject(mkdirError);
      const missing = [];
      let p = path.resolve(dir);
      while (!d.has(p) && path.dirname(p) !== p) { missing.unshift(p); p = path.dirname(p); }
      if (missing.length && !(opts && opts.recursive)) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      for (const m of missing) d.add(m);
      return Promise.resolve(missing[0]);
    },
  };
}

// Electron's shell.openPath: resolves '' on success, an error string on failure.
function fakeShell(fsp, { fail = '' } = {}) {
  const opened = [];
  return {
    opened,
    openPath(dir) {
      opened.push(dir);
      if (fail) return Promise.resolve(fail);
      return Promise.resolve(fsp.dirs.has(path.resolve(dir)) ? '' : 'Failed to open path');
    },
  };
}

const ROOT = path.resolve('/home/op');
const DIR = path.join(ROOT, 'Pictures', 'POTACAT', 'SSTV-RX');

test('a missing folder is made, then opened', async () => {
  const fsp = fakeFsp({ dirs: [ROOT] });
  const shell = fakeShell(fsp);
  const r = await openFolder(DIR, { fsp, shell, label: 'SSTV pictures folder' });
  assert.deepStrictEqual(r, { ok: true, dir: DIR, created: true });
  assert.ok(fsp.calls[0].opts && fsp.calls[0].opts.recursive, 'made recursively');
  assert.ok(fsp.dirs.has(DIR), 'the folder now exists');
  assert.deepStrictEqual(shell.opened, [DIR], 'opened after it was made');
});

test('an existing folder opens and is not reported as made', async () => {
  const fsp = fakeFsp({ dirs: [DIR] });
  const shell = fakeShell(fsp);
  const r = await openFolder(DIR, { fsp, shell });
  assert.deepStrictEqual(r, { ok: true, dir: DIR, created: false });
  assert.deepStrictEqual(shell.opened, [DIR]);
});

test('a folder that cannot be made is reported in plain words, not opened', async () => {
  const fsp = fakeFsp({ mkdirError: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) });
  const shell = fakeShell(fsp);
  const r = await openFolder(DIR, { fsp, shell, label: 'SSTV pictures folder' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes(DIR), 'names the folder');
  assert.ok(/not allowed to write there/.test(r.error), r.error);
  assert.ok(!/EACCES/.test(r.error), 'no error code shown to the operator');
  assert.deepStrictEqual(shell.opened, [], 'nothing opened');
});

test('an open that fails is reported, not swallowed', async () => {
  const fsp = fakeFsp({ dirs: [DIR] });
  const shell = fakeShell(fsp, { fail: 'No application is associated with this folder' });
  const r = await openFolder(DIR, { fsp, shell, label: 'SSTV pictures folder' });
  assert.strictEqual(r.ok, false);
  assert.ok(/could not open the SSTV pictures folder/.test(r.error), r.error);
  assert.ok(/No application is associated/.test(r.error), 'carries the reason');
});

test('a shell that throws is reported, not swallowed', async () => {
  const fsp = fakeFsp({ dirs: [DIR] });
  const shell = { openPath() { return Promise.reject(new Error('no desktop')); } };
  const r = await openFolder(DIR, { fsp, shell });
  assert.strictEqual(r.ok, false);
  assert.ok(/no desktop/.test(r.error));
});

test('a folder that never answers gives up within the time limit', async () => {
  const fsp = fakeFsp({ mkdirHangs: true });
  const shell = fakeShell(fsp);
  const t0 = Date.now();
  const r = await openFolder(DIR, { fsp, shell, timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(r.ok, false);
  assert.ok(/did not answer/.test(r.error), r.error);
  assert.deepStrictEqual(shell.opened, []);
});

test('no path is a plain failure', async () => {
  const fsp = fakeFsp();
  const r = await openFolder('', { fsp, shell: fakeShell(fsp), label: 'Winlink folder' });
  assert.strictEqual(r.ok, false);
  assert.ok(/does not know where the Winlink folder is/.test(r.error));
});

test('every Open folder handler in main goes through the helper and returns its result', () => {
  const MAIN = readSrc('main.js');
  assert.ok(!/shell\.openPath\(/.test(MAIN.replace(/shell: require\('electron'\)\.shell/g, '')), 'no direct shell.openPath left in main.js');
  for (const ch of ['sstv-open-gallery-folder', 'winlink-open-folder', 'mercury-open-downloads']) {
    const i = MAIN.indexOf(`ipcMain.handle('${ch}',`);
    assert.ok(i >= 0, ch + ' is an invoke handler, so the window gets the result');
    assert.ok(/openFolderLogged\(/.test(MAIN.slice(i, i + 600)), ch + ' uses openFolderLogged');
  }
  const preloads = { 'preload-sstv-popout.js': 'sstv-open-gallery-folder', 'preload-winlink-popout.js': 'winlink-open-folder', 'preload-mercury-popout.js': 'mercury-open-downloads' };
  for (const [file, ch] of Object.entries(preloads)) {
    assert.ok(readSrc(file).includes(`ipcRenderer.invoke('${ch}')`), file + ' invokes ' + ch);
  }
});

test('the SSTV window shows a failure in its status line', () => {
  const R = readSrc('renderer/sstv-popout.js');
  assert.ok(/async function openGalleryFolder\(\)/.test(R));
  assert.ok(/r\.ok === false && statusBar\) statusBar\.textContent = r\.error/.test(R));
  assert.ok(/openFolderBtn\.addEventListener\('click', openGalleryFolder\)/.test(R), 'the button');
  assert.ok(/label: 'Open the pictures folder', action: openGalleryFolder/.test(R), 'the gallery menu item');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log('  ok  ' + name); }
    catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err && err.message)); }
  }
  console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nAll ${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
