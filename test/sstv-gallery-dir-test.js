#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// #123: the whole app froze when the SSTV window opened with no radio. Both
// renderers kept painting (the clock, the waterfall), so the MAIN process was
// stuck. The last synchronous filesystem work on the window-open path was the
// gallery folder: existsSync + mkdirSync on the Pictures known folder, and a
// readdirSync/copyFileSync legacy copy, on every open. A Pictures folder that
// is slow or unreachable blocked the whole app there. The folder is now
// prepared asynchronously with a time limit (lib/sstv-gallery.js
// prepareGalleryDir) and a folder that does not answer is skipped, with a log
// line, instead of freezing POTACAT.
// Run: node test/sstv-gallery-dir-test.js
require('./ws-stub-if-missing');
const assert = require('assert');
const path = require('path');
const G = require('../lib/sstv-gallery');
const { resolveSstvAudio } = require('../lib/sstv-audio-device');

const ROOT = path.join(__dirname, '..');
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// An in-memory fs.promises: dirs and files by path, and a mkdir that can be
// told to never answer (a stuck network share / sync client).
function fakeFsp({ files = {}, dirs = [], mkdirHangs = false } = {}) {
  const f = new Map(Object.entries(files));
  const d = new Set(dirs);
  const calls = [];
  return {
    calls, files: f, dirs: d,
    mkdir: (p) => { calls.push(['mkdir', p]); if (mkdirHangs) return new Promise(() => {}); d.add(p); return Promise.resolve(); },
    readdir: (p) => {
      calls.push(['readdir', p]);
      if (!d.has(p)) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const pre = p + path.sep;
      return Promise.resolve([...f.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)));
    },
    access: (p) => { calls.push(['access', p]); return f.has(p) || d.has(p) ? Promise.resolve() : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); },
    copyFile: (a, b) => { calls.push(['copyFile', a, b]); f.set(b, f.get(a)); return Promise.resolve(); },
  };
}

test('a Pictures folder that never answers is skipped within the time limit, with a log line', async () => {
  const fsp = fakeFsp({ mkdirHangs: true });
  const logs = [];
  const t0 = Date.now();
  const r = await G.prepareGalleryDir(path.join('P', 'POTACAT', 'SSTV-RX'), { fsp, timeoutMs: 60, log: (m) => logs.push(m) });
  const took = Date.now() - t0;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.ok(took < 1000, 'returned in ' + took + ' ms, not when the folder answered');
  assert.strictEqual(logs.length, 1, 'one log line');
  assert.ok(logs[0].includes(path.join('P', 'POTACAT', 'SSTV-RX')), 'it names the folder: ' + logs[0]);
  assert.ok(/skipped/i.test(logs[0]), 'it says what it skipped: ' + logs[0]);
});

test('a folder that answers is made and the legacy pictures are copied once, in the background', async () => {
  const dir = path.join('P', 'SSTV-RX');
  const legacy = path.join('U', 'sstv-gallery');
  const fsp = fakeFsp({
    dirs: [legacy],
    files: {
      [path.join(legacy, 'a.png')]: 'A', [path.join(legacy, 'a.json')]: '{}',
      [path.join(legacy, 'b.png')]: 'B-old', [path.join(dir, 'b.png')]: 'B-new',
      [path.join(legacy, 'notes.txt')]: 'x',
    },
  });
  const logs = [];
  const r = await G.prepareGalleryDir(dir, { fsp, legacyDir: legacy, timeoutMs: 1000, log: (m) => logs.push(m) });
  assert.strictEqual(r.ok, true);
  assert.ok(fsp.dirs.has(dir));
  const copied = await r.migrated;
  assert.strictEqual(copied, 2, 'a.png and a.json; b.png is already there; notes.txt is not a picture');
  assert.strictEqual(fsp.files.get(path.join(dir, 'b.png')), 'B-new', 'an existing picture is never overwritten');
  assert.strictEqual(fsp.files.get(path.join(dir, 'a.png')), 'A');
  assert.ok(logs.some((m) => /Copied 2 legacy gallery file/.test(m)));
});

test('no legacy folder, or the legacy folder IS the gallery: nothing to copy', async () => {
  const dir = path.join('P', 'SSTV-RX');
  for (const legacyDir of [null, path.join('U', 'missing'), dir]) {
    const fsp = fakeFsp({ dirs: [dir] });
    const r = await G.prepareGalleryDir(dir, { fsp, legacyDir, timeoutMs: 1000, log: () => {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(await r.migrated, 0);
    assert.ok(!fsp.calls.some((c) => c[0] === 'copyFile'));
  }
});

test('a mkdir error is reported, not thrown', async () => {
  const fsp = fakeFsp();
  fsp.mkdir = () => Promise.reject(new Error('EACCES: permission denied'));
  const logs = [];
  const r = await G.prepareGalleryDir(path.join('P', 'X'), { fsp, timeoutMs: 1000, log: (m) => logs.push(m) });
  assert.strictEqual(r.ok, false);
  assert.ok(/EACCES/.test(r.error));
  assert.ok(logs.length === 1 && /EACCES/.test(logs[0]));
});

// The no-radio open, with fakes: no CAT link, the radio's audio input not
// plugged in. The window must say so instead of opening anything.
test('no radio: the SSTV window says the radio audio is not connected', () => {
  const pick = resolveSstvAudio({ sstvId: '', rigId: 'usb-codec-id', devices: [], kind: 'input' });
  assert.strictEqual(pick.ok, false);
  assert.ok(/not connected/.test(pick.message));
});

// ---- main.js wiring ----------------------------------------------------------
const MAIN = readSrc(path.join(ROOT, 'main.js'));
function handlerBody(marker) {
  const i = MAIN.indexOf(marker);
  assert.ok(i >= 0, 'missing ' + marker);
  return MAIN.slice(i, MAIN.indexOf('\n  });', i));
}
function fnBody(sig) {
  const i = MAIN.indexOf(sig);
  assert.ok(i >= 0, 'missing ' + sig);
  return MAIN.slice(i, MAIN.indexOf('\n}\n', i));
}

test('opening the SSTV window prepares the gallery folder asynchronously', () => {
  assert.ok(/^async function ensureSstvGalleryDirAsync\(/m.test(MAIN), 'declared at module scope');
  const body = fnBody('async function ensureSstvGalleryDirAsync(');
  assert.ok(/SstvGallery\.prepareGalleryDir\(/.test(body));
  assert.ok(!/Sync\(/.test(body), 'no synchronous fs in the async prepare');
  for (const marker of ["ipcMain.handle('sstv-get-gallery',", "remoteServer.on('sstv-get-gallery',"]) {
    const h = handlerBody(marker);
    assert.ok(/await ensureSstvGalleryDirAsync\(\)/.test(h), marker + ' awaits the async prepare');
    assert.ok(!/ensureSstvGalleryDir\(\)/.test(h), marker + ' no longer calls the synchronous one');
  }
});

test('the legacy copy is no longer synchronous, and the sync helper skips the disk once prepared', () => {
  assert.ok(!/function migrateLegacySstvGalleryIfNeeded\(/.test(MAIN), 'the synchronous legacy copy is gone');
  const sync = fnBody('function ensureSstvGalleryDir(');
  assert.ok(/_sstvGalleryDirReady === dir\) return dir/.test(sync), 'returns before touching the disk once prepared');
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
