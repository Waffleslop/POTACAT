#!/usr/bin/env node
'use strict';
// The received-SSTV gallery (lib/sstv-gallery.js) and the ECHOCAT handlers in
// main.js (potacat-meta sstv-echocat-gallery-referenceerror-desktop and
// sstv-gallery-sort-and-size-desktop, 2026-09-30).
//
// The ECHOCAT handler in connectRemote() called a record builder declared
// inside app.whenReady(): a ReferenceError on every request, swallowed into an
// empty gallery for six weeks. The scope guard below fails the build if any
// function the gallery handlers call is not declared at module scope.
// Run: node test/sstv-gallery-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../lib/sstv-gallery');

const ROOT = path.join(__dirname, '..');
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// A stand-in for Electron's nativeImage: a 320x256 picture whose PNG bytes
// are ~200 KB (a real Martin picture) and whose JPEG thumbnail is ~10 KB.
const fakeNativeImage = {
  createFromBuffer(buf) {
    const w = 320, h = 256;
    return {
      getSize: () => ({ width: w, height: h }),
      resize: ({ width, height }) => ({ toJPEG: (q) => Buffer.alloc(Math.round(width * height * 0.25 * (q / 70)), 7), width, height }),
    };
  },
};

function galleryDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstv-gallery-'));
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f.name), Buffer.alloc(f.bytes || 200 * 1024, 1));
    if (f.meta) fs.writeFileSync(path.join(dir, f.name.replace(/\.png$/, '.json')), JSON.stringify(f.meta));
    if (f.mtime) fs.utimesSync(path.join(dir, f.name), f.mtime / 1000, f.mtime / 1000);
  }
  return dir;
}
const deps = { fsp: fs.promises, nativeImage: fakeNativeImage };
const t = (s) => Date.parse(s);

console.log('SSTV gallery');

test('newest RECEIVED first, not alphabetically last (mode sorts before date in the name)', async () => {
  const dir = galleryDir([
    { name: 'sstv_scottie2_2026-06-14_00-32-31.png' },                                  // June, no sidecar
    { name: 'sstv_martin1_14230kHz_K3SBP_2026-09-29_23-10-05.png', meta: { timestamp: t('2026-09-29T23:10:05Z') } },
    { name: 'sstv_martin1_14230kHz_K3SBP_2026-09-30_01-02-03.png', meta: { timestamp: t('2026-09-30T01:02:03Z') } },
    { name: 'sstv_robot36_2026-08-01_12-00-00.png' },
    { name: 'imported.png', mtime: t('2026-07-04T12:00:00Z') },                           // no date in the name: mtime
  ]);
  const list = await G.listGallery(dir, fs.promises);
  assert.deepStrictEqual(list.map((e) => e.filename), [
    'sstv_martin1_14230kHz_K3SBP_2026-09-30_01-02-03.png',
    'sstv_martin1_14230kHz_K3SBP_2026-09-29_23-10-05.png',
    'sstv_robot36_2026-08-01_12-00-00.png',
    'imported.png',
    'sstv_scottie2_2026-06-14_00-32-31.png',
  ]);
});

test('the sidecar timestamp outranks the name, the name outranks mtime', async () => {
  const dir = galleryDir([
    { name: 'sstv_martin1_2026-01-01_00-00-00.png', meta: { timestamp: t('2026-09-01T00:00:00Z') }, mtime: t('2025-01-01T00:00:00Z') },
    { name: 'sstv_martin2_2026-08-01_00-00-00.png', mtime: t('2027-01-01T00:00:00Z') },
  ]);
  const list = await G.listGallery(dir, fs.promises);
  assert.strictEqual(list[0].filename, 'sstv_martin1_2026-01-01_00-00-00.png');
  assert.strictEqual(list[1].time, t('2026-08-01T00:00:00Z'));
});

test('pages: limit and offset, capped at 60, with the real total', async () => {
  const files = Array.from({ length: 45 }, (_, i) => ({ name: `sstv_martin1_2026-09-${String(1 + (i % 28)).padStart(2, '0')}_00-00-${String(i).padStart(2, '0')}.png`, bytes: 10 }));
  const dir = galleryDir(files);
  const p1 = await G.galleryPage(dir, { limit: 30, offset: 0, thumbs: true }, deps);
  const p2 = await G.galleryPage(dir, { limit: 30, offset: 30, thumbs: true }, deps);
  assert.strictEqual(p1.total, 45);
  assert.strictEqual(p1.images.length, 30);
  assert.strictEqual(p2.images.length, 15);
  assert.ok(!p1.images.some((a) => p2.images.some((b) => b.filename === a.filename)), 'no overlap');
  assert.ok(p1.images[0].timestamp >= p2.images[0].timestamp);
  assert.strictEqual((await G.galleryPage(dir, { limit: 999 }, deps)).images.length, 45);
  assert.strictEqual((await G.galleryPage(galleryDir(files.concat(Array.from({ length: 30 }, (_, i) => ({ name: `x${i}.png`, bytes: 10 })))), { limit: 999 }, deps)).images.length, G.MAX_PAGE);
});

test('30 thumbnails are well under 1 MB; 30 full pictures were ~9 MB', async () => {
  const dir = galleryDir(Array.from({ length: 30 }, (_, i) => ({ name: `sstv_martin1_2026-09-29_22-${String(i).padStart(2, '0')}-00.png`, bytes: 224 * 1024 })));
  const thumbs = await G.galleryPage(dir, { limit: 30, thumbs: true }, deps);
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'sstv-gallery', images: thumbs.images, total: thumbs.total }));
  assert.ok(bytes < 1024 * 1024, `thumbnail page is ${bytes} bytes`);
  assert.ok(thumbs.images.every((r) => r.thumb === true && r.dataUrl.startsWith('data:image/jpeg;base64,')));
  const full = await G.galleryPage(dir, { limit: 30 }, deps);
  const fullBytes = Buffer.byteLength(JSON.stringify({ images: full.images }));
  assert.ok(fullBytes > 8 * 1024 * 1024, 'the old message really was ~9 MB: ' + fullBytes);
  assert.ok(full.images.every((r) => r.thumb === false && r.dataUrl.startsWith('data:image/png;base64,')));
});

test('a record carries mode, times and their call from the sidecar', async () => {
  const dir = galleryDir([{ name: 'sstv_martin1_14230kHz_K3SBP_2026-09-30_01-02-03.png', meta: { mode: 'Martin M1', timestamp: 5, freqKhz: 14230, theirCall: 'N4ABC', fskCall: 'N4ABC' } }]);
  const r = await G.galleryRecord(path.join(dir, 'sstv_martin1_14230kHz_K3SBP_2026-09-30_01-02-03.png'), deps);
  assert.strictEqual(r.mode, 'Martin M1');
  assert.strictEqual(r.timestamp, 5);
  assert.strictEqual(r.theirCall, 'N4ABC');
  assert.strictEqual(r.width, 320);
});

test('an unreadable folder is an error the caller reports, not an empty gallery', async () => {
  await assert.rejects(G.galleryPage(path.join(os.tmpdir(), 'no-such-sstv-gallery-' + Date.now()), { limit: 10 }, deps), /ENOENT/);
});

test('a picture name from a client is a bare .png, never a path', () => {
  assert.strictEqual(G.safeGalleryName('sstv_martin1_2026-09-30_01-02-03.png'), 'sstv_martin1_2026-09-30_01-02-03.png');
  for (const bad of ['../settings.json', '..\\x.png', 'sub/x.png', 'C:\\x.png', 'x.json', '.png', '', null, 5]) {
    assert.strictEqual(G.safeGalleryName(bad), null, String(bad));
  }
});

// ---- main.js wiring ------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
function handlerBody(marker) {
  const i = MAIN.indexOf(marker);
  assert.ok(i >= 0, 'missing ' + marker);
  const j = MAIN.indexOf('\n  });', i);
  return MAIN.slice(i, j);
}
const topLevel = (name) => new RegExp(`^(async )?function ${name}\\(|^(const|let) ${name} =`, 'm').test(MAIN);

test('scope guard: every function the gallery handlers call is declared at module scope', () => {
  const GLOBALS = new Set(['require', 'String', 'Number', 'Math', 'JSON', 'Buffer', 'Date', 'setTimeout', 'if', 'for', 'catch', 'return', 'function', 'async', 'await', 'typeof']);
  for (const marker of ["remoteServer.on('sstv-get-gallery',", "remoteServer.on('sstv-get-gallery-image',", "ipcMain.handle('sstv-get-gallery',"]) {
    const body = handlerBody(marker).replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const called = new Set([...body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    for (const name of called) {
      if (GLOBALS.has(name)) continue;
      assert.ok(topLevel(name), `${marker} calls ${name}(), which is not declared at module scope`);
    }
  }
  assert.ok(topLevel('sstvGalleryRecordFromFile'), 'the record builder lives at module scope');
  assert.ok(!/^ {2,}(async )?function sstvGalleryRecordFromFile\(/m.test(MAIN), 'and nowhere nested');
});

test('the ECHOCAT handler reports a failure in the CAT log and to the client', () => {
  const body = handlerBody("remoteServer.on('sstv-get-gallery',");
  assert.ok(/sendCatLog\('\[SSTV\] Gallery for ECHOCAT failed/.test(body));
  assert.ok(/sendSstvGallery\(\[\], requestId, undefined, 'The pictures folder could not be read: '/.test(body));
  assert.ok(/thumbs \? limit : Math\.min\(limit \|\| 10, 10\)/.test(body), 'full pictures are at most 10 per page');
});

test('protocol: thumbs, the full-picture request, and the capability', () => {
  const { MESSAGES } = require('../lib/echocat-protocol');
  assert.ok(MESSAGES['sstv-get-gallery'].fields.thumbs);
  assert.ok(MESSAGES['sstv-gallery'].fields.error);
  assert.ok(MESSAGES['sstv-get-gallery-image'] && MESSAGES['sstv-gallery-image']);
  const rs = fs.readFileSync(path.join(ROOT, 'lib', 'remote-server.js'), 'utf8');
  assert.ok(/'sstv-gallery-thumbs'\]/.test(rs));
  assert.ok(/case 'sstv-get-gallery-image':/.test(rs) && /thumbs: msg\.thumbs === true/.test(rs));
});

// ---- where it was heard ------------------------------------------------------------
test('a record says where the picture was heard: sidecar first, else the kHz in the name', async () => {
  const dir = galleryDir([
    { name: 'sstv_martin1_14230kHz_K3SBP_2026-09-30_01-02-03.png', meta: { freqHz: 14230500, freqKhz: 14231, rigMode: 'USB' } },
    { name: 'sstv_scottie1_7171kHz_2026-09-01_00-00-00.png' },
    { name: 'sstv_robot36_2026-08-01_12-00-00.png' },
  ]);
  const rec = (n) => G.galleryRecord(path.join(dir, n), deps);
  const a = await rec('sstv_martin1_14230kHz_K3SBP_2026-09-30_01-02-03.png');
  assert.deepStrictEqual([a.freqHz, a.freqKhz, a.rigMode], [14230500, 14231, 'USB']);
  const b = await rec('sstv_scottie1_7171kHz_2026-09-01_00-00-00.png');
  assert.deepStrictEqual([b.freqHz, b.freqKhz, b.rigMode], [7171000, 7171, '']);
  const c = await rec('sstv_robot36_2026-08-01_12-00-00.png');
  assert.deepStrictEqual([c.freqHz, c.freqKhz], [null, null]);
});

test('main takes the frequency when the picture STARTS and sends it everywhere', () => {
  const vis = MAIN.slice(MAIN.indexOf("sstvEngine.on('rx-vis'"), MAIN.indexOf("sstvEngine.on('fskid'"));
  assert.ok(/_sstvRxQrg = sstvRxQrgNow\(\);/.test(vis), 'captured at the VIS header');
  const img = MAIN.slice(MAIN.indexOf("sstvEngine.on('rx-image'"), MAIN.indexOf("sstvEngine.on('rx-lock-lost'"));
  assert.ok(/data\.freqHz = qrg\.freqHz;/.test(img) && /\(data\.redecode && _sstvLastRxQrg\)/.test(img), 'a redecode keeps its original frequency');
  assert.ok((img.match(/freqHz: data\.freqHz/g) || []).length >= 2, 'to the SSTV window and to ECHOCAT');
  const save = MAIN.slice(MAIN.indexOf('async function saveSstvImage('), MAIN.indexOf('async function saveSstvImage(') + 3000);
  assert.ok(/const heardHz = data\.freqHz !== undefined/.test(save) && /freqHz: heardHz \|\| null/.test(save) && /rigMode:/.test(save), 'saved as heard, with the mode');
  const multi = fs.readFileSync(path.join(ROOT, 'lib', 'sstv-manager.js'), 'utf8');
  assert.ok(/freqHz: freqKhz > 0 \? Math\.round\(freqKhz \* 1000\)/.test(multi), 'each Flex slice tags its own frequency');
});

test('ECHOCAT sstv-rx-image carries freqHz, rigMode and filename (and is cached for hydration)', () => {
  const { RemoteServer } = require('../lib/remote-server');
  const rs = Object.create(RemoteServer.prototype);
  rs._client = null;
  rs.broadcastSstvRxImage({ base64: 'data:image/png;base64,AA', mode: 'Martin M1', width: 320, height: 256, freqHz: 14230000, rigMode: 'USB', filename: 'x.png', weak: true });
  const p = rs._sstvLastImage;
  assert.deepStrictEqual([p.freqHz, p.rigMode, p.filename, p.weak], [14230000, 'USB', 'x.png', true]);
  rs.broadcastSstvRxImage({ base64: 'x', mode: 'm', freqHz: NaN });
  assert.strictEqual(rs._sstvLastImage.freqHz, null);
  const { MESSAGES } = require('../lib/echocat-protocol');
  assert.ok(MESSAGES['sstv-rx-image'].fields.freqHz && MESSAGES['sstv-rx-image'].fields.rigMode);
});

test('the reply bar shows where they were heard, and offers to go back when the dial is elsewhere', () => {
  const js = fs.readFileSync(path.join(ROOT, 'renderer', 'sstv-popout.js'), 'utf8');
  assert.ok(/freqHz: entryQrgHz\(entry\), rigMode: entry\.rigMode/.test(js));
  assert.ok(/Math\.abs\(_dialHz - hz\) > 500/.test(js) && /'Go to ' \+ fmtQrg\(hz\)/.test(js));
  assert.ok(/const offSide = !!have && have !== want;/.test(js), 'the wrong sideband is not "on"');
  assert.ok(/window\.api\.onCatMode\(/.test(js) && /sstvPopoutWin\.webContents\.send\('cat-mode', mode\)/.test(MAIN), 'the window hears the radio\'s mode');
  // The same rules the ECHOCAT app uses, run for real.
  const src = js.replace(/\r\n/g, '\n');
  const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    const line = src.slice(i, src.indexOf('\n', i));
    return /\}\s*$/.test(line) ? line + '\n' : src.slice(i, src.indexOf('\n}\n', i) + 2); // one-liner or block
  };
  const fns = new Function(grab('getFreqMode') + grab('sideOf') + grab('fmtQrg') + 'return { getFreqMode, sideOf, fmtQrg };')();
  assert.strictEqual(fns.fmtQrg(7171500), '7.172', 'whole kHz first');
  assert.strictEqual(fns.fmtQrg(14230000), '14.230');
  assert.deepStrictEqual(['3845', '5357', '7171', '14230', '28680'].map(fns.getFreqMode), ['LSB', 'USB', 'LSB', 'USB', 'USB'], '60 m is USB');
  assert.deepStrictEqual(['PKTUSB', 'USB-D', 'DIGU', 'LSB', 'DIGL', 'CW', ''].map(fns.sideOf), ['USB', 'USB', 'USB', 'LSB', 'LSB', 'OTHER', '']);
  assert.ok(/tuneToFreq\(String\(khz\), mode\)/.test(js));
  assert.ok(/sstvLogContact\(\{ call: replySession\.call, rsvSent: replySession\.rsv, freqHz: replySession\.freqHz/.test(js), 'Log uses the heard frequency');
  assert.ok(/const hz = Number\(freqHz\) > 0 \? Number\(freqHz\) : _currentFreqHz;/.test(MAIN));
  assert.ok(/id="rb-qrg"/.test(fs.readFileSync(path.join(ROOT, 'renderer', 'sstv-popout.html'), 'utf8')));
  assert.ok(/msg\.freqHz \? ' ' \+ \(Math\.round\(msg\.freqHz \/ 1000\)/.test(fs.readFileSync(path.join(ROOT, 'renderer', 'remote.js'), 'utf8')), 'the web client shows it too');
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
  }
  console.log(`\nSSTV gallery: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
