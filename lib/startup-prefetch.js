'use strict';
// Startup read-ahead. main.js loads about 600 files synchronously, one at a
// time, before the first window can exist; renderer/index.html then loads
// about 70 more. Warm, that is half a second. Cold (after a reboot, after a
// git pull, after an update, on a hard disk, with an antivirus scanning each
// new file) every one of those reads waits on the disk in turn, and the
// window took 5 to 12 s to appear (measured 2026-11-20 on a hard disk).
//
// start() hands the same list of files to a few worker threads the moment
// main.js begins, so the disk and the scanner work on several files at once
// while the main thread is still requiring the first ones; each require then
// finds its file already read. Reads only: nothing is parsed or run, a
// missing file is ignored, and the app behaves exactly as before.
//
// The list is learned, not maintained: record() writes the modules this
// launch actually loaded (require.cache, in load order) to
// <userData>/startup-files.json once the main window has loaded, so the next
// launch reads ahead exactly what it will need. The renderer's scripts and
// styles come from renderer/index.html itself.

const { posix } = require('path');

const MANIFEST = 'startup-files.json';
const MAX_FILES = 3000;

/** Paths in the manifest are relative to the app folder and never leave it. */
function isSafeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return false;
  if (/^[\\/]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  return !rel.split(/[\\/]/).some((part) => part === '..');
}

/** The relative files a manifest lists, safe and de-duplicated. */
function parseManifest(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const list = data && Array.isArray(data.files) ? data.files : [];
  const out = [];
  const seen = new Set();
  for (const rel of list) {
    if (!isSafeRelative(rel) || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/** The local scripts and stylesheets an HTML page loads, relative to the app folder. */
function htmlRefs(html, pageRelDir) {
  const out = [];
  const re = /<(?:script[^>]*\ssrc|link[^>]*\shref)\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const ref = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue; // http:, data:, ...
    if (!/\.(js|css)(\?|#|$)/i.test(ref)) continue;
    const rel = posix.normalize((pageRelDir ? pageRelDir + '/' : '') + ref.replace(/[?#].*$/, ''));
    if (isSafeRelative(rel)) out.push(rel);
  }
  return out;
}

/**
 * The manifest for this launch: every loaded module under appDir, relative,
 * in load order, native addons left out (they are loaded later and are big).
 */
function buildManifest(moduleKeys, appDir, path) {
  const files = [];
  const base = path.resolve(appDir);
  for (const key of moduleKeys || []) {
    // Built-ins ('electron', ...) are keys too, but not files.
    if (typeof key !== 'string' || !path.isAbsolute(key) || /\.node$/i.test(key)) continue;
    const rel = path.relative(base, key);
    if (!rel || !isSafeRelative(rel)) continue;
    files.push(rel.split(path.sep).join('/'));
    if (files.length >= MAX_FILES) break;
  }
  return { version: 1, files };
}

// Runs in each read-ahead thread. readFileSync, not fs.readFile: an async
// readFile is open, stat, read, close, and each step waits for the main
// thread's event loop, which is busy with main.js's requires until the window
// exists. A worker thread reads on its own.
const WORKER_SRC = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { posix } = path;
${isSafeRelative.toString()}
${htmlRefs.toString()}
for (const item of workerData.items) {
  try {
    if (item.page) {
      const html = fs.readFileSync(path.join(workerData.appDir, item.page), 'utf8');
      const dir = item.page.includes('/') ? item.page.slice(0, item.page.lastIndexOf('/')) : '';
      for (const rel of htmlRefs(html, dir)) { try { fs.readFileSync(path.join(workerData.appDir, rel)); } catch {} }
    } else {
      fs.readFileSync(path.join(workerData.appDir, item.rel));
    }
  } catch {}
}
`;

/**
 * Read ahead in THREADS worker threads (each takes every THREADS-th file, so
 * all of them move through the list in load order). Returns at once; never
 * throws. opts: { appDir, userDataDir, fs, path, Worker, pages }
 */
const THREADS = 3;
function start(opts) {
  const { appDir, userDataDir, fs, path, Worker } = opts;
  const stats = { files: 0, threads: 0 };
  try {
    let list = [];
    try { list = parseManifest(fs.readFileSync(path.join(userDataDir, MANIFEST), 'utf8')); } catch {}
    const items = (opts.pages || []).map((page) => ({ page })).concat(list.map((rel) => ({ rel })));
    stats.files = list.length;
    if (!items.length || typeof Worker !== 'function') return stats;
    for (let t = 0; t < THREADS; t++) {
      const mine = items.filter((_, i) => i % THREADS === t);
      if (!mine.length) continue;
      const w = new Worker(WORKER_SRC, { eval: true, workerData: { appDir, items: mine } });
      w.on('error', () => {});
      if (typeof w.unref === 'function') w.unref();
      stats.threads++;
    }
  } catch {}
  return stats;
}

/** Write this launch's manifest (async, only when it changed). Never throws. */
function record(opts) {
  const { appDir, userDataDir, fs, path, moduleKeys } = opts;
  try {
    const text = JSON.stringify(buildManifest(moduleKeys, appDir, path));
    const file = path.join(userDataDir, MANIFEST);
    fs.readFile(file, 'utf8', (_err, prev) => {
      if (prev === text) return;
      fs.writeFile(file, text, () => {});
    });
  } catch {}
}

module.exports = { MANIFEST, MAX_FILES, THREADS, WORKER_SRC, isSafeRelative, parseManifest, htmlRefs, buildManifest, start, record };
