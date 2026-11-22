#!/usr/bin/env node
'use strict';
// Startup read-ahead (lib/startup-prefetch.js) and the startup-order rules that
// keep the first window early (perf/startup-first-window, 2026-11-20):
//  - the read-ahead only reads files inside the app folder, never runs them;
//  - it starts before main.js's bulk requires;
//  - electron-updater (about 110 files) is not required before the window.
// Run: node test/startup-prefetch-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const SP = require('../lib/startup-prefetch');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// A fake fs that records reads and answers from a map.
function fakeFs(files) {
  const reads = [];
  const writes = [];
  return {
    reads, writes,
    readFile(p, enc, cb) {
      if (typeof enc === 'function') { cb = enc; enc = null; }
      reads.push(p);
      if (Object.prototype.hasOwnProperty.call(files, p)) cb(null, files[p]);
      else cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    },
    writeFile(p, text, cb) { writes.push([p, text]); cb && cb(null); },
  };
}

console.log('manifest');
test('relative paths inside the app folder only', () => {
  assert.ok(SP.isSafeRelative('lib/cat.js'));
  assert.ok(SP.isSafeRelative('node_modules/ws/index.js'));
  assert.ok(!SP.isSafeRelative('../secret.txt'));
  assert.ok(!SP.isSafeRelative('lib/../../x.js'));
  assert.ok(!SP.isSafeRelative('C:\\Windows\\x.dll'));
  assert.ok(!SP.isSafeRelative('/etc/passwd'));
  assert.ok(!SP.isSafeRelative(''));
  assert.ok(!SP.isSafeRelative(42));
});

test('a bad or hostile manifest gives an empty or cleaned list', () => {
  assert.deepStrictEqual(SP.parseManifest('not json'), []);
  assert.deepStrictEqual(SP.parseManifest('{"files":"x"}'), []);
  assert.deepStrictEqual(SP.parseManifest(JSON.stringify({ files: ['lib/a.js', '../b.js', 'lib/a.js', 7] })), ['lib/a.js']);
  const many = Array.from({ length: SP.MAX_FILES + 50 }, (_, i) => 'lib/f' + i + '.js');
  assert.strictEqual(SP.parseManifest(JSON.stringify({ files: many })).length, SP.MAX_FILES);
});

test('the manifest is this launch\'s modules, relative, in load order, no addons or built-ins', () => {
  const app = path.resolve('/app');
  const keys = [path.join(app, 'main.js'), 'electron', path.join(app, 'lib', 'cat.js'),
    path.join(app, 'lib', 'ft8_native', 'build', 'Release', 'ft8_native.node'),
    path.resolve('/elsewhere/x.js'), path.join(app, 'node_modules', 'ws', 'index.js')];
  assert.deepStrictEqual(SP.buildManifest(keys, app, path).files, ['main.js', 'lib/cat.js', 'node_modules/ws/index.js']);
});

test('the page\'s local scripts and stylesheets, relative to the app folder', () => {
  const html = '<link rel="stylesheet" href="styles.css"><script src="../lib/freq-dots.js"></script>' +
    '<script src="https://cdn.example/x.js"></script><script src="app.js?v=2"></script>' +
    '<link rel="icon" href="icon.png"><script src="../../outside.js"></script>' +
    '<link rel="stylesheet" href="../node_modules/leaflet/dist/leaflet.css">';
  assert.deepStrictEqual(SP.htmlRefs(html, 'renderer'),
    ['renderer/styles.css', 'lib/freq-dots.js', 'renderer/app.js', 'node_modules/leaflet/dist/leaflet.css']);
});

test('the real index.html yields its scripts', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  const refs = SP.htmlRefs(html, 'renderer');
  assert.ok(refs.includes('renderer/app.js'), 'app.js');
  assert.ok(refs.includes('renderer/popout-theme-bootstrap.js'), 'theme bootstrap');
  assert.ok(refs.length > 40, String(refs.length));
});

console.log('start / record');
// A fake Worker that records what each thread was given.
function fakeWorkerClass() {
  const made = [];
  class W { constructor(src, opts) { this.src = src; this.opts = opts; made.push(this); } on() { return this; } unref() {} }
  W.made = made;
  return W;
}

test('start gives the threads the page and the manifest files, in load order, and writes nothing', () => {
  const app = path.resolve('/app'), ud = path.resolve('/ud');
  const fs = fakeFs({ [path.join(ud, SP.MANIFEST)]: JSON.stringify({ version: 1, files: ['main.js', 'lib/cat.js', '../evil.js', 'lib/b.js'] }) });
  fs.readFileSync = (p) => { const r = []; fs.readFile(p, 'utf8', (e, t) => { if (e) throw e; r.push(t); }); return r[0]; };
  const W = fakeWorkerClass();
  const stats = SP.start({ appDir: app, userDataDir: ud, fs, path, Worker: W, pages: ['renderer/index.html'] });
  assert.strictEqual(stats.files, 3);
  assert.strictEqual(W.made.length, SP.THREADS);
  const all = [];
  W.made.forEach((w, t) => w.opts.workerData.items.forEach((it, k) => all[k * SP.THREADS + t] = it));
  assert.deepStrictEqual(all, [{ page: 'renderer/index.html' }, { rel: 'main.js' }, { rel: 'lib/cat.js' }, { rel: 'lib/b.js' }]);
  assert.ok(W.made.every((w) => w.opts.eval === true && w.opts.workerData.appDir === app));
  assert.strictEqual(fs.writes.length, 0, 'start never writes');
});

test('the thread code reads files and nothing else', () => {
  assert.ok(/readFileSync/.test(SP.WORKER_SRC));
  assert.ok(!/writeFile|unlink|rmSync|child_process|require\('\.\//.test(SP.WORKER_SRC));
});

test('no manifest yet (first launch): only the page is read ahead, no error', () => {
  const fs = fakeFs({});
  fs.readFileSync = () => { throw new Error('ENOENT'); };
  const W = fakeWorkerClass();
  const stats = SP.start({ appDir: '/a', userDataDir: '/u', fs, path, Worker: W, pages: ['renderer/index.html'] });
  assert.strictEqual(stats.files, 0);
  assert.strictEqual(W.made.length, 1);
});

test('a throwing fs or Worker never escapes start or record', () => {
  const fs = { readFile() { throw new Error('boom'); }, readFileSync() { throw new Error('boom'); }, writeFile() { throw new Error('boom'); } };
  const Bad = function () { throw new Error('no threads'); };
  assert.doesNotThrow(() => SP.start({ appDir: '/a', userDataDir: '/u', fs, path, Worker: Bad, pages: ['x.html'] }));
  assert.doesNotThrow(() => SP.start({ appDir: '/a', userDataDir: '/u', fs, path, pages: ['x.html'] }));
  assert.doesNotThrow(() => SP.record({ appDir: '/a', userDataDir: '/u', fs, path, moduleKeys: ['/a/main.js'] }));
});

test('record writes only when the list changed', () => {
  const app = path.resolve('/app'), ud = path.resolve('/ud');
  const keys = [path.join(app, 'main.js')];
  const same = JSON.stringify(SP.buildManifest(keys, app, path));
  const fs1 = fakeFs({ [path.join(ud, SP.MANIFEST)]: same });
  SP.record({ appDir: app, userDataDir: ud, fs: fs1, path, moduleKeys: keys });
  assert.strictEqual(fs1.writes.length, 0);
  const fs2 = fakeFs({});
  SP.record({ appDir: app, userDataDir: ud, fs: fs2, path, moduleKeys: keys });
  assert.strictEqual(fs2.writes.length, 1);
  assert.strictEqual(fs2.writes[0][0], path.join(ud, SP.MANIFEST));
});

console.log('startup order (main.js)');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
test('the read-ahead starts before the bulk requires', () => {
  const pf = main.indexOf('StartupPrefetch.start(');
  const bulk = main.indexOf("require('./lib/cat')");
  assert.ok(pf > 0 && bulk > 0 && pf < bulk, 'StartupPrefetch.start must come before lib/cat is required');
  assert.ok(main.indexOf('StartupPrefetch.start(') > main.indexOf('requestSingleInstanceLock()'), 'a second launch must not read ahead');
});

test('electron-updater is required only inside getAutoUpdater()', () => {
  const hits = [];
  const re = /require\('electron-updater'\)/g;
  let m;
  while ((m = re.exec(main))) hits.push(m.index);
  assert.strictEqual(hits.length, 1, 'one require of electron-updater');
  const fn = main.indexOf('function getAutoUpdater()');
  assert.ok(fn > 0 && hits[0] > fn && hits[0] < main.indexOf('\n}\n', fn), 'the require sits in getAutoUpdater()');
  assert.ok(main.includes('\nlet _autoUpdater = null;\n'), 'the lazy slot is a top-level let');
});

test('the main window is created before the CAT connect and after the settings load', () => {
  const ready = main.indexOf("logStartupStage('app.whenReady fired')");
  const settingsAt = main.indexOf('settings = loadSettings();', ready);
  const cw = main.indexOf('  createWindow();\n', ready);
  const cat = main.indexOf('connectCatWithStartupDelay()', ready);
  assert.ok(ready > 0 && settingsAt > ready && cw > settingsAt && cat > cw);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
