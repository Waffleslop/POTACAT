'use strict';
// The received-SSTV gallery on disk: which pictures, in what order, and the
// record each one becomes. ONE implementation for the desktop SSTV window and
// ECHOCAT (potacat-meta sstv-gallery-sort-and-size-desktop,
// sstv-echocat-gallery-referenceerror-desktop, 2026-09-30).
//
// - Newest first by the time the picture was RECEIVED: the .json sidecar's
//   `timestamp`, else the date-time in the filename, else the file's mtime.
//   Sorting filenames put `sstv_scottie2_…` from June ahead of every Martin
//   picture since, because the mode comes before the date in the name.
// - Every filesystem touch is async: the folder is usually under Pictures,
//   which Windows redirects to OneDrive, and a synchronous read there once
//   froze the whole app (#75).
// - ECHOCAT asks for thumbnails (160 px JPEG, ~10 KB) and fetches a full
//   picture on tap; 30 full PNGs were ~9 MB in one WebSocket message.

const path = require('path');

const THUMB_WIDTH = 160;
const THUMB_QUALITY = 70;
const MAX_PAGE = 60;

// sstv_<mode>_[<freq>kHz_][<call>_]YYYY-MM-DD_HH-MM-SS.png (saveSstvImage).
function timeFromFilename(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.png$/i.exec(name || '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : null;
}

// …_14230kHz_… → 14230000 (saveSstvImage puts the kHz in the name).
function freqFromFilename(name) {
  const m = /_(\d{3,6})kHz_/i.exec(name || '');
  return m ? Number(m[1]) * 1000 : null;
}

/** A gallery filename a client may name: a bare .png, never a path. */
function safeGalleryName(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name);
  if (base !== name || !/^[A-Za-z0-9._-]+\.png$/i.test(base) || base.startsWith('.')) return null;
  return base;
}

/**
 * The gallery's pictures, newest first.
 * @returns {Promise<Array<{filename, time}>>}
 */
async function listGallery(dir, fsp) {
  const names = (await fsp.readdir(dir)).filter((f) => /\.png$/i.test(f));
  const out = await Promise.all(names.map(async (filename) => {
    let time = null;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, filename.replace(/\.png$/i, '.json')), 'utf-8'));
      if (Number.isFinite(meta.timestamp)) time = meta.timestamp;
    } catch {}
    if (time == null) time = timeFromFilename(filename);
    if (time == null) {
      try { time = (await fsp.stat(path.join(dir, filename))).mtimeMs; } catch { time = 0; }
    }
    return { filename, time };
  }));
  out.sort((a, b) => (b.time - a.time) || b.filename.localeCompare(a.filename));
  return out;
}

/**
 * One picture as the record the SSTV window and ECHOCAT show.
 * @param {object} deps { fsp, nativeImage }
 * @param {object} [opts] { thumb: true } → dataUrl is a 160 px JPEG, thumb:true
 */
async function galleryRecord(filePath, deps, opts) {
  const { fsp, nativeImage } = deps;
  const stat = await fsp.stat(filePath);
  const filename = path.basename(filePath);
  const png = await fsp.readFile(filePath);
  const img = nativeImage.createFromBuffer(png);
  const size = img.getSize();
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(filePath.replace(/\.png$/i, '.json'), 'utf-8')); } catch { meta = {}; }
  const parts = filename.replace(/\.png$/i, '').split('_');
  let dataUrl = 'data:image/png;base64,' + png.toString('base64');
  let thumb = false;
  if (opts && opts.thumb && size.width > 0) {
    const w = Math.min(THUMB_WIDTH, size.width);
    const small = img.resize({ width: w, height: Math.max(1, Math.round(size.height * w / size.width)), quality: 'good' });
    dataUrl = 'data:image/jpeg;base64,' + small.toJPEG(THUMB_QUALITY).toString('base64');
    thumb = true;
  }
  return {
    filename,
    filePath,
    dataUrl,
    thumb,
    mode: meta.mode || parts[1] || '',
    timestamp: Number.isFinite(meta.timestamp) ? meta.timestamp : (timeFromFilename(filename) || stat.mtimeMs),
    width: meta.width || size.width || 320,
    height: meta.height || size.height || 256,
    // Where it was heard (the dial when the picture began) and the radio's
    // mode then. Older pictures may only have the freq from the filename.
    freqHz: meta.freqHz || freqFromFilename(filename) || null,
    freqKhz: meta.freqKhz || (freqFromFilename(filename) ? Math.round(freqFromFilename(filename) / 1000) : null),
    rigMode: meta.rigMode || '',
    callsign: meta.callsign || '',
    // Their call: typed in the SSTV reply bar (theirCall) or decoded from
    // the FSK ID after the picture (fskCall).
    theirCall: meta.theirCall || meta.fskCall || '',
    fskCall: meta.fskCall || '',
  };
}

/**
 * One page of the gallery.
 * @returns {Promise<{images: Array, total: number, errors: string[]}>}
 */
async function galleryPage(dir, q, deps) {
  const offset = Math.max(0, Math.floor(Number(q && q.offset) || 0));
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(q && q.limit) || 10)));
  const list = await listGallery(dir, deps.fsp);
  const images = [];
  const errors = [];
  for (const e of list.slice(offset, offset + limit)) {
    try { images.push(await galleryRecord(path.join(dir, e.filename), deps, { thumb: !!(q && q.thumbs) })); }
    catch (err) { errors.push(`${e.filename}: ${err.message}`); }
  }
  return { images, total: list.length, errors };
}

module.exports = { listGallery, galleryRecord, galleryPage, timeFromFilename, freqFromFilename, safeGalleryName, THUMB_WIDTH, MAX_PAGE };
