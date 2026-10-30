// Channels: a saved frequency chart the operator edits, reorders and deletes
// (Casey 2026-10-30: "a saved frequency chart that users can edit and
// re-arrange as they feel fit, deleting things too. But it gives them all the
// interesting frequencies they may want"). The starter set is
// data/channels.json (FRS, GMRS, MURS, marine VHF, aviation, interop, EMS;
// the lists came from KL4XQ and KC8DHX); the operator's own channels come by
// hand or from a CHIRP CSV export, the file every programming cable makes.
//
// Dual-mode: `require` in main, `window.Channels` in the renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Channels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = ['FM', 'NFM', 'WFM', 'AM', 'USB', 'LSB', 'CW', 'DIG', 'DV'];
  var LIST_MAX = 2000;
  var NAME_MAX = 40;
  var NOTE_MAX = 300;
  var GROUP_MAX = 40;
  var TONE_MAX = 12;

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : NaN; }
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

  function normMode(m) {
    var u = String(m || '').trim().toUpperCase();
    if (u === 'NFM' || u === 'FMN') return 'NFM';
    if (u === 'FM') return 'FM';
    if (u === 'WFM') return 'WFM';
    if (u === 'AM') return 'AM';
    if (u === 'USB' || u === 'LSB' || u === 'CW') return u;
    if (u === 'DIG' || u === 'DMR' || u === 'C4FM' || u === 'P25' || u === 'NXDN' || u === 'DN') return 'DIG';
    if (u === 'DV' || u === 'DSTAR' || u === 'D-STAR') return 'DV';
    return 'FM';
  }

  /** The mode POTACAT tunes for a channel mode: a radio or an SDR demodulates FM for anything FM-shaped. */
  function tuneMode(mode) {
    var m = normMode(mode);
    if (m === 'NFM' || m === 'WFM' || m === 'DIG' || m === 'DV') return 'FM';
    return m;
  }

  function newId() { return 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** One channel, cleaned; null when it has no usable frequency. */
  function sanitizeChannel(c) {
    if (!c || typeof c !== 'object') return null;
    var khz = num(c.khz);
    if (!(khz > 0) || khz > 3e9) return null;
    var off = num(c.offsetKhz);
    return {
      id: str(c.id, 64) || newId(),
      name: str(c.name, NAME_MAX) || formatMhz(khz),
      khz: Math.round(khz * 1000) / 1000,
      mode: normMode(c.mode),
      offsetKhz: Number.isFinite(off) && Math.abs(off) < 1e6 ? Math.round(off * 10) / 10 : 0,
      tone: str(c.tone, TONE_MAX),
      group: str(c.group, GROUP_MAX),
      note: str(c.note, NOTE_MAX),
      src: c.src === 'starter' || c.src === 'chirp' ? c.src : 'user',
    };
  }

  function sanitizeList(list) {
    var out = [], seen = {};
    for (var i = 0; i < (Array.isArray(list) ? list.length : 0) && out.length < LIST_MAX; i++) {
      var c = sanitizeChannel(list[i]);
      if (!c) continue;
      if (seen[c.id]) c.id = newId();
      seen[c.id] = true;
      out.push(c);
    }
    return out;
  }

  /**
   * The saved shape: { v, list, removed, seeded }. `list` is the operator's
   * whole ordered chart (starter copies included); `removed` the starter ids
   * they deleted, so a later catalog never brings those back; `seeded` the
   * catalog version the list has been reconciled with.
   */
  function sanitizeSaved(saved) {
    var s = saved && typeof saved === 'object' ? saved : {};
    var removed = Array.isArray(s.removed) ? s.removed.map(function (x) { return str(x, 64); }).filter(Boolean).slice(0, LIST_MAX) : [];
    return { v: 1, list: sanitizeList(s.list), removed: removed, seeded: num(s.seeded) || 0 };
  }

  /**
   * Bring the saved chart up to the catalog: on first use every starter
   * channel is copied in (the operator owns the copies from then on); when
   * the catalog grows, only channels never seen are appended, and nothing
   * the operator deleted comes back. Returns the new saved object.
   */
  function reconcile(saved, catalog) {
    var s = sanitizeSaved(saved);
    var cat = catalog && typeof catalog === 'object' ? catalog : {};
    var version = num(cat.version) || 1;
    var starters = sanitizeList((cat.channels || []).map(function (c) { return Object.assign({}, c, { src: 'starter' }); }));
    if (s.seeded >= version && s.list.length) return s;
    var have = {};
    s.list.forEach(function (c) { have[c.id] = true; });
    var gone = {};
    s.removed.forEach(function (id) { gone[id] = true; });
    starters.forEach(function (c) { if (!have[c.id] && !gone[c.id]) s.list.push(c); });
    s.seeded = version;
    return s;
  }

  /** Remove by id; a starter channel is remembered as removed. */
  function remove(saved, id) {
    var s = sanitizeSaved(saved);
    var keep = [];
    s.list.forEach(function (c) {
      if (c.id !== id) { keep.push(c); return; }
      if (c.src === 'starter' && s.removed.indexOf(c.id) < 0) s.removed.push(c.id);
    });
    s.list = keep;
    return s;
  }

  /** Put the starter channels back (every one the catalog has, in its order, after what is there). */
  function restoreStarter(saved, catalog) {
    var s = sanitizeSaved(saved);
    s.removed = [];
    s.seeded = 0;
    return reconcile(s, catalog);
  }

  /** Move the channel `id` to `index` (0-based) in the list. */
  function move(saved, id, index) {
    var s = sanitizeSaved(saved);
    var from = -1;
    for (var i = 0; i < s.list.length; i++) if (s.list[i].id === id) { from = i; break; }
    if (from < 0) return s;
    var c = s.list.splice(from, 1)[0];
    var to = Math.max(0, Math.min(s.list.length, Math.round(num(index) || 0)));
    s.list.splice(to, 0, c);
    return s;
  }

  /** Replace or add one channel (by id). */
  function upsert(saved, channel) {
    var s = sanitizeSaved(saved);
    var c = sanitizeChannel(channel);
    if (!c) return s;
    for (var i = 0; i < s.list.length; i++) if (s.list[i].id === c.id) { s.list[i] = c; return s; }
    if (s.list.length < LIST_MAX) s.list.push(c);
    return s;
  }

  // ── CHIRP CSV ────────────────────────────────────────────────────────────
  // Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,
  // DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,
  // RPT1CALL,RPT2CALL,DVCODE. Frequency and Offset in MHz; Duplex '+', '-',
  // '' (simplex), 'off', 'split' (Offset is then the TX frequency).

  /** RFC-4180-ish CSV: quoted fields may hold commas, quotes ("") and newlines. */
  function parseCsv(text) {
    var rows = [], row = [], field = '', q = false;
    var s = String(text || '').replace(/^﻿/, '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function csvField(v) {
    var t = String(v == null ? '' : v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  /**
   * CHIRP CSV → channels. Header-driven (column order may vary; the first
   * line is matched by name, case-insensitive). Returns
   * { channels, skipped, reason } — reason only when the file is not CHIRP.
   */
  function parseChirpCsv(text, opts) {
    var o = opts || {};
    var rows = parseCsv(text);
    if (!rows.length) return { channels: [], skipped: 0, reason: 'The file is empty.' };
    var head = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var col = function (name) { return head.indexOf(name.toLowerCase()); };
    var iFreq = col('frequency'), iName = col('name');
    if (iFreq < 0) return { channels: [], skipped: 0, reason: 'Not a CHIRP export: no Frequency column. In CHIRP use File > Export to CSV.' };
    var iDup = col('duplex'), iOff = col('offset'), iTone = col('tone'), iRt = col('rtonefreq'), iCt = col('ctonefreq'), iDtcs = col('dtcscode'),
      iMode = col('mode'), iCmt = col('comment');
    var out = [], skipped = 0;
    for (var r = 1; r < rows.length; r++) {
      var f = rows[r];
      if (f.length < 2) continue;
      var mhz = num(f[iFreq]);
      if (!(mhz > 0)) { skipped++; continue; }
      var dup = iDup >= 0 ? String(f[iDup] || '').trim() : '';
      var offMhz = iOff >= 0 ? num(f[iOff]) : NaN;
      var offsetKhz = 0;
      if (dup === '+' && offMhz > 0) offsetKhz = offMhz * 1000;
      else if (dup === '-' && offMhz > 0) offsetKhz = -offMhz * 1000;
      else if (dup === 'split' && offMhz > 0) offsetKhz = (offMhz - mhz) * 1000;
      var toneKind = iTone >= 0 ? String(f[iTone] || '').trim() : '';
      var tone = '';
      if (toneKind === 'Tone') tone = str(f[iRt], TONE_MAX);
      else if (toneKind === 'TSQL') tone = str(f[iCt], TONE_MAX);
      else if (toneKind === 'DTCS') tone = iDtcs >= 0 ? 'D' + str(f[iDtcs], 6) : '';
      else if (toneKind === 'Cross' && iRt >= 0) tone = str(f[iRt], TONE_MAX);
      var name = iName >= 0 ? str(f[iName], NAME_MAX) : '';
      var note = iCmt >= 0 ? str(f[iCmt], NOTE_MAX) : '';
      out.push({
        id: newId(),
        name: name || note.slice(0, NAME_MAX) || formatMhz(mhz * 1000),
        khz: Math.round(mhz * 1e6) / 1000,
        mode: iMode >= 0 ? normMode(f[iMode]) : 'FM',
        offsetKhz: offsetKhz,
        tone: tone,
        group: str(o.group || 'Imported', GROUP_MAX),
        note: note,
        src: 'chirp',
      });
    }
    return { channels: sanitizeList(out), skipped: skipped, reason: null };
  }

  var CHIRP_HEADER = ['Location', 'Name', 'Frequency', 'Duplex', 'Offset', 'Tone', 'rToneFreq', 'cToneFreq', 'DtcsCode', 'DtcsPolarity', 'RxDtcsCode', 'CrossMode', 'Mode', 'TStep', 'Skip', 'Power', 'Comment', 'URCALL', 'RPT1CALL', 'RPT2CALL', 'DVCODE'];

  /** Channels → CHIRP CSV, importable by CHIRP and every radio it programs. */
  function toChirpCsv(list) {
    var lines = [CHIRP_HEADER.join(',')];
    sanitizeList(list).forEach(function (c, i) {
      var dup = c.offsetKhz > 0 ? '+' : c.offsetKhz < 0 ? '-' : '';
      var off = (Math.abs(c.offsetKhz) / 1000).toFixed(6);
      var isDtcs = /^D\d{3}$/.test(c.tone);
      var toneKind = c.tone ? (isDtcs ? 'DTCS' : 'Tone') : '';
      var rTone = c.tone && !isDtcs ? c.tone : '88.5';
      var dtcs = isDtcs ? c.tone.slice(1) : '023';
      var mode = c.mode === 'USB' || c.mode === 'LSB' || c.mode === 'CW' ? c.mode : c.mode;
      lines.push([i, csvField(c.name), (c.khz / 1000).toFixed(6), dup, off, toneKind, rTone, '88.5', dtcs, 'NN', '023', 'Tone->Tone', mode, '5.00', '', '', csvField(c.note), '', '', '', ''].join(','));
    });
    return lines.join('\n') + '\n';
  }

  function formatMhz(khz) {
    var v = Number(khz) / 1000;
    var s = v.toFixed(v >= 100 ? 4 : 5).replace(/0+$/, '').replace(/\.$/, '');
    return s + ' MHz';
  }

  /** "+5.000 MHz" / "-600 kHz" / "" for the table. */
  function formatOffset(offsetKhz) {
    var k = Number(offsetKhz) || 0;
    if (!k) return '';
    var sign = k > 0 ? '+' : '-';
    var a = Math.abs(k);
    return a >= 1000 ? sign + (a / 1000).toFixed(a % 1000 ? 3 : 1).replace(/\.0$/, '') + ' MHz' : sign + a + ' kHz';
  }

  /** Catalog checks for the test suite and the loader: every entry usable, ids unique. */
  function validateCatalog(cat) {
    var problems = [];
    var c = cat && typeof cat === 'object' ? cat : {};
    if (!(num(c.version) > 0)) problems.push('version missing');
    var ids = {};
    (c.channels || []).forEach(function (ch, i) {
      var s = sanitizeChannel(ch);
      if (!s) { problems.push('channel ' + i + ' unusable'); return; }
      if (!ch.id) problems.push('channel ' + i + ' has no id');
      if (ids[ch.id]) problems.push('duplicate id ' + ch.id);
      ids[ch.id] = true;
      if (!ch.group) problems.push(ch.id + ' has no group');
      if (MODES.indexOf(String(ch.mode).toUpperCase()) < 0) problems.push(ch.id + ' mode ' + ch.mode);
    });
    return problems;
  }

  return {
    MODES: MODES, LIST_MAX: LIST_MAX, CHIRP_HEADER: CHIRP_HEADER,
    normMode: normMode, tuneMode: tuneMode, newId: newId,
    sanitizeChannel: sanitizeChannel, sanitizeList: sanitizeList, sanitizeSaved: sanitizeSaved,
    reconcile: reconcile, remove: remove, restoreStarter: restoreStarter, move: move, upsert: upsert,
    parseCsv: parseCsv, parseChirpCsv: parseChirpCsv, toChirpCsv: toChirpCsv,
    formatMhz: formatMhz, formatOffset: formatOffset, validateCatalog: validateCatalog,
  };
});
