'use strict';
// SSTV style pack validator (pure; test/sstv-packs-test.js).
//
// A pack restyles SSTV templates for a season or event: palettes, scenery
// recipes drawn by POTACAT's own interpreter (lib/sstv-templates.js), headline
// wording and an OFL font. It arrives from packs.potacat.com like the
// DXpedition list, so it must be PURE DATA: this validator is the contract.
// Anything not listed here is rejected, including unknown keys at any depth,
// so a pack can never smuggle in a script, a URL, or a field some future
// renderer might act on.
//
// It runs in three places, all with the same rules: the repo CI
// (scripts/validate-sstv-packs.js), the publish step, and the app before it
// installs or draws a pack (lib/sstv-packs.js).

const W = 320;
const H = 256;
const MAX_PACK_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024;
const MAX_TEXT = 24;

const TOKENS = new Set(['$sky0', '$sky1', '$sky2', '$land', '$glow', '$ink', '$ink2']);
const HEX = /^#[0-9a-fA-F]{6}$/;
const RGBA = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 '&.,:()-]{0,39}$/;

class Checker {
  constructor() { this.errors = []; }
  err(path, msg) { if (this.errors.length < 50) this.errors.push(`${path}: ${msg}`); }

  obj(v, path, allowed, required) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { this.err(path, 'must be an object'); return false; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.err(path, `unknown key "${k}"`);
    for (const k of required || []) if (!(k in v)) this.err(path, `missing "${k}"`);
    return true;
  }

  arr(v, path, min, max) {
    if (!Array.isArray(v)) { this.err(path, 'must be an array'); return false; }
    if (v.length < min || v.length > max) { this.err(path, `must have ${min}-${max} items (has ${v.length})`); return false; }
    return true;
  }

  str(v, path, max, re) {
    if (typeof v !== 'string') { this.err(path, 'must be a string'); return false; }
    if (v.length > max) { this.err(path, `longer than ${max} characters`); return false; }
    if (re && !re.test(v)) { this.err(path, 'has an invalid form'); return false; }
    return true;
  }

  num(v, path, min, max, int) {
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.err(path, 'must be a number'); return false; }
    if (int && !Number.isInteger(v)) { this.err(path, 'must be a whole number'); return false; }
    if (v < min || v > max) { this.err(path, `must be between ${min} and ${max}`); return false; }
    return true;
  }

  // A number, or a [min, max] range the interpreter picks from with the seed.
  numOrRange(v, path, min, max) {
    if (Array.isArray(v)) {
      if (v.length !== 2) { this.err(path, 'a range is [min, max]'); return false; }
      const ok = this.num(v[0], `${path}[0]`, min, max) && this.num(v[1], `${path}[1]`, min, max);
      if (ok && v[0] > v[1]) this.err(path, 'range min is above max');
      return ok;
    }
    return this.num(v, path, min, max);
  }

  color(v, path, opts) {
    if (typeof v !== 'string') { this.err(path, 'colour must be a string'); return false; }
    if (HEX.test(v) || TOKENS.has(v)) return true;
    if (opts && opts.transparent && v === 'transparent') return true;
    const m = RGBA.exec(v);
    if (m && [m[1], m[2], m[3]].every((c) => Number(c) <= 255)) return true;
    this.err(path, `not a colour ("${String(v).slice(0, 20)}"): use #rrggbb, rgba(r,g,b,a), or a palette token`);
    return false;
  }

  point(v, path) {
    if (!Array.isArray(v) || v.length !== 2) { this.err(path, 'a point is [x, y]'); return false; }
    return this.num(v[0], `${path}[0]`, -W, 2 * W) && this.num(v[1], `${path}[1]`, -H, 2 * H);
  }

  // Shape coordinates are in a unit box (0..1), scaled by the op's size.
  unitPoint(v, path) {
    if (!Array.isArray(v) || v.length !== 2) { this.err(path, 'a point is [x, y]'); return false; }
    return this.num(v[0], `${path}[0]`, -1, 2) && this.num(v[1], `${path}[1]`, -1, 2);
  }

  pointList(v, path, min, max, unit) {
    if (!this.arr(v, path, min, max)) return;
    v.forEach((p, i) => (unit ? this.unitPoint(p, `${path}[${i}]`) : this.point(p, `${path}[${i}]`)));
  }

  print(v, path) {
    if (!this.obj(v, path, ['dx', 'dy', 'color'], ['color'])) return;
    if ('dx' in v) this.num(v.dx, `${path}.dx`, -12, 12);
    if ('dy' in v) this.num(v.dy, `${path}.dy`, -12, 12);
    this.color(v.color, `${path}.color`);
  }
}

// Every string in the pack, checked once for anything that isn't text.
function scanStrings(v, path, c, images) {
  if (typeof v === 'string') {
    // data:image/png is allowed only as an image value (checked in images).
    if (images && v.startsWith('data:')) return;
    const low = v.toLowerCase();
    if (v.includes('<') || low.includes('javascript:') || low.includes('url(') || /https?:\/\//.test(low) || low.includes('data:')) {
      c.err(path, 'contains markup, a URL or a script-like string');
    }
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => scanStrings(x, `${path}[${i}]`, c, false)); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') c.err(path, `forbidden key "${k}"`);
      // Values directly under pack.images may be data:image/png URLs (their
      // form is checked in the images section); nothing else may.
      scanStrings(x, `${path}.${k}`, c, images || (path === 'pack' && k === 'images'));
    }
  }
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function base64Bytes(b64) {
  const clean = b64.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const OPS = ['grad', 'fill', 'circle', 'ridge', 'blob', 'poly', 'shape', 'scatter', 'stripes', 'band', 'paths', 'branch', 'image'];
// Keys that may sit beside the op's own key (shape/scatter/paths carry theirs flat).
const OP_SIDE_KEYS = {
  shape: ['at', 'size', 'color', 'rough', 'print'],
  scatter: ['n', 'box', 'size', 'color'],
  paths: ['width', 'color'],
};

function checkOp(op, path, c, pack) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) { c.err(path, 'an op must be an object'); return; }
  const keys = Object.keys(op).filter((k) => OPS.includes(k));
  if (keys.length !== 1) { c.err(path, `must have exactly one of ${OPS.join(', ')}`); return; }
  const kind = keys[0];
  const side = OP_SIDE_KEYS[kind] || [];
  for (const k of Object.keys(op)) if (k !== kind && !side.includes(k)) c.err(path, `unknown key "${k}"`);
  const v = op[kind];
  const p = `${path}.${kind}`;
  switch (kind) {
    case 'grad':
      if (c.arr(v, p, 2, 6)) v.forEach((x, i) => c.color(x, `${p}[${i}]`));
      break;
    case 'fill':
      c.color(v, p);
      break;
    case 'circle':
      if (!c.obj(v, p, ['x', 'y', 'r', 'color', 'blur', 'alpha'], ['x', 'y', 'r', 'color'])) break;
      c.numOrRange(v.x, `${p}.x`, -W, 2 * W); c.numOrRange(v.y, `${p}.y`, -H, 2 * H);
      c.num(v.r, `${p}.r`, 1, 400); c.color(v.color, `${p}.color`);
      if ('blur' in v) c.num(v.blur, `${p}.blur`, 0, 20);
      if ('alpha' in v) c.num(v.alpha, `${p}.alpha`, 0, 1);
      break;
    case 'ridge':
      if (!c.obj(v, p, ['base', 'amp', 'wav', 'color'], ['base', 'amp', 'wav', 'color'])) break;
      c.num(v.base, `${p}.base`, 0, H); c.num(v.amp, `${p}.amp`, 0, 128); c.num(v.wav, `${p}.wav`, 4, 400); c.color(v.color, `${p}.color`);
      break;
    case 'blob':
      if (!c.obj(v, p, ['x', 'y', 'rx', 'ry', 'color', 'rough', 'print'], ['x', 'y', 'rx', 'ry', 'color'])) break;
      c.numOrRange(v.x, `${p}.x`, -W, 2 * W); c.numOrRange(v.y, `${p}.y`, -H, 2 * H);
      c.num(v.rx, `${p}.rx`, 1, 400); c.num(v.ry, `${p}.ry`, 1, 400); c.color(v.color, `${p}.color`);
      if ('rough' in v) c.num(v.rough, `${p}.rough`, 0, 12);
      if ('print' in v) c.print(v.print, `${p}.print`);
      break;
    case 'poly':
      if (!c.obj(v, p, ['pts', 'color', 'rough', 'print'], ['pts', 'color'])) break;
      c.pointList(v.pts, `${p}.pts`, 3, 200, false); c.color(v.color, `${p}.color`);
      if ('rough' in v) c.num(v.rough, `${p}.rough`, 0, 12);
      if ('print' in v) c.print(v.print, `${p}.print`);
      break;
    case 'shape':
    case 'scatter': {
      if (typeof v !== 'string' || !pack.shapes || !Object.prototype.hasOwnProperty.call(pack.shapes, v)) { c.err(p, `names no shape in this pack ("${v}")`); break; }
      if (kind === 'shape') {
        if (!('at' in op) || !('size' in op)) { c.err(path, 'a shape needs at and size'); break; }
        if (!Array.isArray(op.at) || op.at.length !== 2) c.err(`${path}.at`, 'is [x, y] or [[x0, x1], [y0, y1]]');
        else { c.numOrRange(op.at[0], `${path}.at[0]`, -W, 2 * W); c.numOrRange(op.at[1], `${path}.at[1]`, -H, 2 * H); }
        c.num(op.size, `${path}.size`, 2, 600);
        if ('color' in op) c.color(op.color, `${path}.color`);
        if ('rough' in op) c.num(op.rough, `${path}.rough`, 0, 12);
        if ('print' in op) c.print(op.print, `${path}.print`);
      } else {
        c.num(op.n, `${path}.n`, 1, 60, true);
        if (c.arr(op.box, `${path}.box`, 4, 4)) op.box.forEach((x, i) => c.num(x, `${path}.box[${i}]`, -W, 2 * W));
        if (c.arr(op.size, `${path}.size`, 2, 2)) c.numOrRange(op.size, `${path}.size`, 2, 400);
        c.color(op.color, `${path}.color`);
      }
      break;
    }
    case 'stripes':
      if (!c.obj(v, p, ['bands', 'rough', 'alpha'], ['bands'])) break;
      if (c.arr(v.bands, `${p}.bands`, 1, 32)) {
        v.bands.forEach((b, i) => {
          const bp = `${p}.bands[${i}]`;
          if (!Array.isArray(b) || b.length !== 2) { c.err(bp, 'a band is [y, colour]'); return; }
          c.num(b[0], `${bp}[0]`, 0, H); c.color(b[1], `${bp}[1]`, { transparent: true });
        });
      }
      if ('rough' in v) c.num(v.rough, `${p}.rough`, 0, 12);
      if ('alpha' in v) c.num(v.alpha, `${p}.alpha`, 0, 1);
      break;
    case 'band':
      if (!c.obj(v, p, ['y', 'h', 'color', 'blur'], ['y', 'h', 'color'])) break;
      c.num(v.y, `${p}.y`, -H, H); c.num(v.h, `${p}.h`, 1, 2 * H); c.color(v.color, `${p}.color`);
      if ('blur' in v) c.num(v.blur, `${p}.blur`, 0, 20);
      break;
    case 'paths':
      if (c.arr(v, p, 1, 40)) v.forEach((path2, i) => c.pointList(path2, `${p}[${i}]`, 2, 100, false));
      c.num(op.width, `${path}.width`, 1, 40); c.color(op.color, `${path}.color`);
      break;
    case 'branch':
      if (!c.obj(v, p, ['from', 'to', 'width', 'color', 'twigs'], ['from', 'to', 'width', 'color'])) break;
      c.point(v.from, `${p}.from`); c.point(v.to, `${p}.to`);
      c.num(v.width, `${p}.width`, 1, 40); c.color(v.color, `${p}.color`);
      if ('twigs' in v) c.num(v.twigs, `${p}.twigs`, 0, 8, true);
      break;
    case 'image':
      if (!c.obj(v, p, ['name', 'x', 'y', 'w', 'h'], ['name', 'x', 'y', 'w', 'h'])) break;
      if (!pack.images || !Object.prototype.hasOwnProperty.call(pack.images, v.name)) c.err(`${p}.name`, `names no image in this pack ("${v.name}")`);
      c.num(v.x, `${p}.x`, -W, 2 * W); c.num(v.y, `${p}.y`, -H, 2 * H); c.num(v.w, `${p}.w`, 1, 2 * W); c.num(v.h, `${p}.h`, 1, 2 * H);
      break;
    default:
  }
}

function checkShape(sh, path, c) {
  if (!sh || typeof sh !== 'object' || Array.isArray(sh)) { c.err(path, 'must be an object'); return; }
  if ('parts' in sh) {
    if (!c.obj(sh, path, ['parts'], ['parts'])) return;
    if (c.arr(sh.parts, `${path}.parts`, 1, 20)) {
      sh.parts.forEach((pt, i) => {
        const pp = `${path}.parts[${i}]`;
        if (!c.obj(pt, pp, ['poly', 'color'], ['poly'])) return;
        c.pointList(pt.poly, `${pp}.poly`, 3, 200, true);
        if ('color' in pt) c.color(pt.color, `${pp}.color`);
      });
    }
  } else if ('paths' in sh) {
    if (!c.obj(sh, path, ['paths', 'width'], ['paths', 'width'])) return;
    if (c.arr(sh.paths, `${path}.paths`, 1, 40)) sh.paths.forEach((pp, i) => c.pointList(pp, `${path}.paths[${i}]`, 2, 100, true));
    c.num(sh.width, `${path}.width`, 0.005, 0.3);
  } else {
    if (!c.obj(sh, path, ['poly'], ['poly'])) return;
    c.pointList(sh.poly, `${path}.poly`, 3, 200, true);
  }
}

/**
 * @param {object} pack  a parsed pack.json
 * @param {object} [opts]  { bytes } the JSON's size, when the caller has it
 * @returns {{ok: boolean, errors: string[]}}
 */
function validatePack(pack, opts) {
  const c = new Checker();
  let bytes = opts && opts.bytes;
  if (bytes == null) { try { bytes = Buffer.byteLength(JSON.stringify(pack)); } catch { bytes = Infinity; } }
  if (bytes > MAX_PACK_BYTES) c.err('pack', `is ${bytes} bytes; the limit is ${MAX_PACK_BYTES}`);

  const TOP = ['schema', 'id', 'version', 'name', 'season', 'by', 'minApp', 'style', 'fonts', 'palettes', 'accents', 'text', 'shapes', 'images', 'backgrounds'];
  if (!c.obj(pack, 'pack', TOP, ['schema', 'id', 'version', 'name', 'season', 'by', 'minApp', 'palettes', 'accents', 'text', 'shapes', 'backgrounds'])) {
    return { ok: false, errors: c.errors };
  }
  scanStrings(pack, 'pack', c, false);

  if (pack.schema !== 1) c.err('pack.schema', 'must be 1');
  c.str(pack.id, 'pack.id', 40, /^[a-z0-9][a-z0-9-]*$/);
  c.num(pack.version, 'pack.version', 1, 1e6, true);
  c.str(pack.name, 'pack.name', 40, NAME);
  c.str(pack.by, 'pack.by', 40, NAME);
  c.str(pack.minApp, 'pack.minApp', 16, /^\d+\.\d+\.\d+$/);
  if ('style' in pack) c.str(pack.style, 'pack.style', 280);

  if (pack.season !== null) {
    if (c.obj(pack.season, 'pack.season', ['from', 'to'], ['from', 'to'])) {
      c.str(pack.season.from, 'pack.season.from', 5, MMDD);
      c.str(pack.season.to, 'pack.season.to', 5, MMDD);
    }
  }

  if ('fonts' in pack && c.arr(pack.fonts, 'pack.fonts', 0, 2)) {
    pack.fonts.forEach((f, i) => {
      const p = `pack.fonts[${i}]`;
      if (!c.obj(f, p, ['family', 'file', 'license', 'licenseFile', 'use'], ['family', 'file', 'license', 'use'])) return;
      c.str(f.family, `${p}.family`, 40, /^[A-Za-z0-9][A-Za-z0-9 ]*$/);
      c.str(f.file, `${p}.file`, 60, /^[A-Za-z0-9._-]+\.woff2$/);
      if (f.license !== 'OFL-1.1') c.err(`${p}.license`, 'must be OFL-1.1');
      if ('licenseFile' in f) c.str(f.licenseFile, `${p}.licenseFile`, 60, /^[A-Za-z0-9._-]+\.txt$/);
      if (f.use !== 'headlines') c.err(`${p}.use`, 'must be "headlines" (a pack never sets the callsign font)');
    });
  }

  if (c.arr(pack.palettes, 'pack.palettes', 1, 8)) {
    pack.palettes.forEach((pal, i) => {
      const p = `pack.palettes[${i}]`;
      if (!c.obj(pal, p, ['name', 'sky', 'land', 'glow', 'ink', 'ink2'], ['name', 'sky', 'land', 'glow'])) return;
      c.str(pal.name, `${p}.name`, 40, NAME);
      let hexOk = true;
      if (c.arr(pal.sky, `${p}.sky`, 3, 3)) pal.sky.forEach((x, j) => { if (!(typeof x === 'string' && HEX.test(x))) { c.err(`${p}.sky[${j}]`, 'must be #rrggbb'); hexOk = false; } });
      else hexOk = false;
      for (const k of ['land', 'glow', 'ink', 'ink2']) {
        if (!(k in pal)) continue;
        if (!(typeof pal[k] === 'string' && HEX.test(pal[k]))) { c.err(`${p}.${k}`, 'must be #rrggbb'); hexOk = false; }
      }
      // What the templates letter in (glow, ink) must stand off the sky.
      if (hexOk) {
        for (const k of ['glow', 'ink']) {
          if (!(k in pal)) continue;
          const ratio = contrast(pal[k], pal.sky[0]);
          if (ratio < 3) c.err(`${p}.${k}`, `contrast ${ratio.toFixed(2)}:1 against sky0 is below 3:1`);
        }
      }
    });
  }

  if (c.arr(pack.accents, 'pack.accents', 1, 6)) {
    pack.accents.forEach((a, i) => {
      if (!(typeof a === 'string' && HEX.test(a))) c.err(`pack.accents[${i}]`, 'must be #rrggbb');
      else if (luminance(a) < 0.18) c.err(`pack.accents[${i}]`, 'is too dark to letter in');
    });
  }

  if (c.obj(pack.text, 'pack.text', ['headlineFont', 'headlines', 'replace'], ['headlines', 'replace'])) {
    const t = pack.text;
    if ('headlineFont' in t) {
      c.str(t.headlineFont, 'pack.text.headlineFont', 40);
      if (!(pack.fonts || []).some((f) => f && f.family === t.headlineFont)) c.err('pack.text.headlineFont', 'is not one of the pack\'s fonts');
    }
    if (c.arr(t.headlines, 'pack.text.headlines', 0, 20)) {
      t.headlines.forEach((h, i) => {
        c.str(h, `pack.text.headlines[${i}]`, MAX_TEXT);
        if (typeof h === 'string' && /[{}]/.test(h)) c.err(`pack.text.headlines[${i}]`, 'may not contain { } (fill-ins such as {MYCALL} are never restyled)');
      });
    }
    if (c.obj(t.replace, 'pack.text.replace', Object.keys(t.replace || {}), [])) {
      for (const [k, v] of Object.entries(t.replace)) {
        const p = `pack.text.replace["${k}"]`;
        if (!Array.isArray(t.headlines) || !t.headlines.includes(k)) c.err(p, 'replaces a string that is not in headlines');
        if (/[{}]/.test(k)) c.err(p, 'may not touch fill-ins such as {MYCALL}');
        if (c.str(v, p, MAX_TEXT) && /[{}]/.test(v)) c.err(p, 'may not contain { } (fill-ins such as {MYCALL} are never restyled)');
      }
    }
  }

  if (c.obj(pack.shapes, 'pack.shapes', Object.keys(pack.shapes || {}), [])) {
    const names = Object.keys(pack.shapes);
    if (names.length > 40) c.err('pack.shapes', 'more than 40 shapes');
    for (const n of names) {
      if (!/^[a-z][a-z0-9-]{0,23}$/i.test(n)) c.err(`pack.shapes.${n}`, 'name must be letters, digits and dashes');
      checkShape(pack.shapes[n], `pack.shapes.${n}`, c);
    }
  }

  if ('images' in pack) {
    if (c.obj(pack.images, 'pack.images', Object.keys(pack.images || {}), [])) {
      for (const [n, v] of Object.entries(pack.images)) {
        const p = `pack.images.${n}`;
        if (!/^[a-z][a-z0-9-]{0,23}$/i.test(n)) c.err(p, 'name must be letters, digits and dashes');
        const m = typeof v === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(v) : null;
        if (!m) { c.err(p, 'must be a data:image/png;base64 string'); continue; }
        const b = base64Bytes(m[1]);
        if (b > MAX_IMAGE_BYTES) c.err(p, `is ${b} bytes; the limit is ${MAX_IMAGE_BYTES}`);
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        let sig = '';
        try { sig = Buffer.from(m[1].slice(0, 12), 'base64').toString('hex').slice(0, 16); } catch { /* */ }
        if (sig !== '89504e470d0a1a0a') c.err(p, 'is not a PNG');
      }
    }
  }

  if (c.arr(pack.backgrounds, 'pack.backgrounds', 1, 16)) {
    pack.backgrounds.forEach((bg, i) => {
      const p = `pack.backgrounds[${i}]`;
      if (!c.obj(bg, p, ['name', 'draw'], ['name', 'draw'])) return;
      c.str(bg.name, `${p}.name`, 40, NAME);
      if (c.arr(bg.draw, `${p}.draw`, 1, 40)) bg.draw.forEach((op, j) => checkOp(op, `${p}.draw[${j}]`, c, pack));
    });
  }

  return { ok: c.errors.length === 0, errors: c.errors };
}

/** Is a MM-DD season in force on `date` (UTC)? A window may wrap the new year. */
function inSeason(season, date) {
  if (!season) return true;
  const d = date || new Date();
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const val = (s) => Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5));
  const from = val(season.from), to = val(season.to);
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

module.exports = { validatePack, inSeason, contrast, MAX_PACK_BYTES, MAX_IMAGE_BYTES, TOKENS };
