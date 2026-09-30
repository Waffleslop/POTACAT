// SSTV starter templates, per-station looks, SSTV-safe backgrounds and the
// style-pack interpreter. Pure drawing logic on a 2D canvas context, shared
// by the desktop SSTV window (window.SstvTemplates) and, later, the ECHOCAT
// app, so a template looks the same wherever it is composed.
//
// Design rules every piece follows (Casey 2026-09-29, the SSTV redesign):
//   - SSTV sends a picture line by line as audio. Detail ALONG a line smears
//     (audio bandwidth); detail DOWN the picture survives. So: big shapes,
//     horizontal bands, no fine texture, thick strokes only.
//   - Robot modes carry colour at half resolution: text contrast comes from
//     brightness (light lettering, dark outline), never from colour alone.
//   - A station's look (font, palette, accent, panel style) is worked out
//     from its callsign, so its pictures are recognisable across contacts.
//   - Style packs are DATA drawn by drawRecipe() from a fixed list of parts.
//     No code ever comes from a pack.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SstvTemplates = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 320, H = 256; // every template is designed at 320x256

  function rnd(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ---- The look --------------------------------------------------------------
  // Families are registered with @font-face in the SSTV window from the OFL
  // files in renderer/fonts/ (licences beside them), so pictures render the
  // same offline.
  const FONTS = [
    { id: 'bungee', name: 'Bungee', css: '"Bungee"', weight: 400 },
    { id: 'archivo', name: 'Archivo Black', css: '"Archivo Black"', weight: 400 },
    { id: 'russo', name: 'Russo One', css: '"Russo One"', weight: 400 },
    { id: 'rubik', name: 'Rubik ExtraBold', css: '"Rubik"', weight: 800 },
  ];
  const PALETTES = [
    { name: 'Dusk',   sky: ['#1d1b4a', '#6b3a7a', '#e0795a'], land: '#1a1030', glow: '#ffc56b' },
    { name: 'Dawn',   sky: ['#1f3a66', '#6d8fc9', '#f2b38a'], land: '#243048', glow: '#ffe0a8' },
    { name: 'Ocean',  sky: ['#062a45', '#0f5f86', '#3fa3c4'], land: '#04192b', glow: '#bff3ff' },
    { name: 'Forest', sky: ['#0e2a24', '#2f6b4f', '#9cc58f'], land: '#0a1d17', glow: '#e8ffb0' },
    { name: 'Aurora', sky: ['#050b1e', '#0d2a3f', '#1b4f5a'], land: '#030712', glow: '#7dffb5' },
    { name: 'Desert', sky: ['#3b1d2e', '#b5563c', '#f0b46a'], land: '#4a2418', glow: '#ffe3a0' },
    { name: 'Ember',  sky: ['#1a0606', '#6e1414', '#d9531e'], land: '#120404', glow: '#ffb347' },
    { name: 'Slate',  sky: ['#11161f', '#2c3a4f', '#5d7188'], land: '#0a0e14', glow: '#cfe3ff' },
  ];
  const ACCENTS = [
    { name: 'yellow', c: '#ffd23f' }, { name: 'mint', c: '#7ee8b7' }, { name: 'sky', c: '#8fd3ff' },
    { name: 'amber', c: '#ffb86b' }, { name: 'pink', c: '#ff9ecf' },
  ];
  const PANELS = ['band', 'card', 'outline'];

  /**
   * The station's look. Same call + same shuffle = same look, everywhere.
   * A pack swaps in its own palettes and accents but never the font: the
   * callsign lines keep the station's lettering in costume too.
   */
  function lookFor(opts) {
    const o = opts || {};
    const call = String(o.call || 'N0CALL').toUpperCase();
    const r = rnd(hash(call + '#' + (o.shuffle | 0)));
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const look = { font: pick(FONTS), pal: pick(PALETTES), accent: pick(ACCENTS).c, panel: pick(PANELS), seed: Math.floor(r() * 1e9), pack: null };
    if (o.pack && Array.isArray(o.pack.palettes) && o.pack.palettes.length) {
      look.pack = o.pack;
      look.pal = o.pack.palettes[Math.floor(r() * o.pack.palettes.length)];
      if (Array.isArray(o.pack.accents) && o.pack.accents.length) look.accent = o.pack.accents[Math.floor(r() * o.pack.accents.length)];
    }
    return look;
  }
  function describeLook(look) {
    const acc = ACCENTS.find((a) => a.c === look.accent);
    return look.font.name + ' · ' + look.pal.name + ' · ' + (acc ? acc.name : 'pack') + ' accent · ' + look.panel + ' panels';
  }

  // ---- Drawing helpers -------------------------------------------------------------
  function grad(ctx, stops) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  function mix(a, b, t) {
    const pa = parseInt(String(a).slice(1), 16), pb = parseInt(String(b).slice(1), 16);
    const ch = (s) => [(s >> 16) & 255, (s >> 8) & 255, s & 255];
    const A = ch(pa), B = ch(pb);
    return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',') + ')';
  }
  // A soft edge without ctx.filter (the ECHOCAT app draws this file with
  // react-native-skia, which has shadows but no CSS filter strings): paint the
  // shape far off the canvas and let its shadow land where the shape was.
  // shadowBlur is roughly twice the Gaussian radius, and shadow offset/blur
  // are in device pixels, so both follow the canvas scale.
  const SOFT_OFF = 4000;
  function blurred(ctx, px, color, paint) {
    if (!px) { paint(); return; }
    const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const sc = t && Number.isFinite(t.a) ? (Math.hypot(t.a, t.b) || 1) : 1;
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = px * 2 * sc;
    ctx.shadowOffsetX = SOFT_OFF * sc; ctx.shadowOffsetY = 0;
    ctx.translate(-SOFT_OFF, 0);
    paint();
    ctx.restore();
  }
  function glowCircle(ctx, x, y, rad, color, blur) {
    blurred(ctx, blur || 0, color, () => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill(); });
  }
  function ridge(ctx, base, amp, wav, phase, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) ctx.lineTo(x, base + Math.sin(x / wav + phase) * amp + Math.sin(x / (wav * 0.37) + phase * 2) * amp * 0.35);
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }
  // Lettering and its outline must differ in brightness or the text vanishes.
  function isDark(color) {
    const m = /^#([0-9a-f]{6})$/i.exec(color || '');
    if (!m) return false;
    const n = parseInt(m[1], 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 100;
  }

  // ---- 14 backgrounds -------------------------------------------------------------
  const BGS = {
    ridges: { name: 'Mountain ridges', draw(ctx, p, r) {
      grad(ctx, p.sky); glowCircle(ctx, 60 + r() * 200, 90 + r() * 30, 26, p.glow, 6);
      for (let k = 0; k < 3; k++) ridge(ctx, 150 + k * 32, 22 - k * 4, 34 + k * 10 + r() * 20, r() * 6, mix(p.sky[1], p.land, 0.45 + k * 0.25));
    } },
    aurora: { name: 'Aurora', draw(ctx, p, r) {
      grad(ctx, [p.land, p.sky[0], p.sky[1]]);
      ctx.save(); ctx.globalAlpha = 0.75;
      for (let k = 0; k < 3; k++) {
        const color = k === 1 ? p.glow : mix(p.glow, '#b58cff', 0.6);
        const y0 = 60 + k * 34 + r() * 20, ph = r() * 6;
        blurred(ctx, 10, color, () => {
          ctx.strokeStyle = color; ctx.lineWidth = 18 - k * 4; ctx.beginPath();
          for (let x = -10; x <= 330; x += 8) ctx.lineTo(x, y0 + Math.sin(x / 45 + ph) * 22);
          ctx.stroke();
        });
      }
      ctx.restore(); ridge(ctx, 214, 8, 50, r() * 6, p.land);
    } },
    ocean: { name: 'Ocean horizon', draw(ctx, p, r) {
      grad(ctx, [p.sky[0], p.sky[2]]);
      const hy = 150 + r() * 20;
      glowCircle(ctx, 80 + r() * 160, hy, 34, p.glow, 4);
      ctx.fillStyle = p.land; ctx.fillRect(0, hy, W, H - hy);
      for (let y = hy + 6; y < H; y += 10) { ctx.fillStyle = 'rgba(255,255,255,' + (0.05 + r() * 0.08) + ')'; ctx.fillRect(40 + r() * 60, y, 120 + r() * 120, 3); }
    } },
    forest: { name: 'Forest edge', draw(ctx, p, r) {
      grad(ctx, p.sky);
      [[0.35, 176, 55], [0.7, 206, 44]].forEach(([t, base, h]) => {
        ctx.fillStyle = mix(p.sky[1], p.land, t);
        for (let x = -12; x < 332; x += 12 + r() * 10) { const hh = h * (0.6 + r() * 0.6); ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x + 11, base - hh); ctx.lineTo(x + 22, base); ctx.fill(); }
        ctx.fillRect(0, base, W, H - base);
      });
    } },
    waves: { name: 'Radio waves', draw(ctx, p, r) {
      grad(ctx, [p.land, p.sky[0], p.sky[1]]);
      const cx = 40 + r() * 240, cy = 200;
      ctx.save(); ctx.lineWidth = 7;
      for (let k = 1; k <= 6; k++) { ctx.strokeStyle = p.glow; ctx.globalAlpha = 0.5 - k * 0.07; ctx.beginPath(); ctx.arc(cx, cy - 60, k * 34, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = p.land; ctx.beginPath(); ctx.moveTo(cx - 22, H); ctx.lineTo(cx - 3, cy - 64); ctx.lineTo(cx + 3, cy - 64); ctx.lineTo(cx + 22, H); ctx.fill();
      ridge(ctx, 236, 5, 60, 1, p.land);
    } },
    night: { name: 'Night sky', draw(ctx, p, r) {
      grad(ctx, [p.land, p.sky[0], p.sky[1]]);
      glowCircle(ctx, 60 + r() * 200, 60 + r() * 40, 30, '#f4f1dc', 8);
      for (let i = 0; i < 12; i++) glowCircle(ctx, r() * W, r() * 150, 2.5 + r() * 2, '#ffffff', 1);
      ridge(ctx, 210, 12, 40, r() * 6, p.land);
    } },
    synth: { name: 'Retro sunset', draw(ctx, p) {
      grad(ctx, [p.sky[0], p.sky[1], p.sky[2]]);
      const cx = 160, cy = 132;
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, 62, 0, Math.PI * 2); ctx.clip();
      grad(ctx, [p.glow, mix(p.glow, p.sky[2], 0.3), p.sky[2]]);
      ctx.fillStyle = p.sky[1]; for (let y = cy + 6; y < cy + 62; y += 11) ctx.fillRect(0, y, W, 4 + (y - cy) / 12);
      ctx.restore();
      ctx.fillStyle = p.land; ctx.fillRect(0, 160, W, 96);
      ctx.strokeStyle = mix(p.glow, p.sky[1], 0.4); ctx.lineWidth = 3;
      for (let y = 168, g = 6; y < H; y += g, g *= 1.35) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      for (let x = -400; x <= 720; x += 60) { ctx.beginPath(); ctx.moveTo(160, 160); ctx.lineTo(x, H); ctx.stroke(); }
    } },
    globe: { name: 'Globe', draw(ctx, p, r) {
      grad(ctx, [p.land, p.sky[0]]);
      const cx = 200 + r() * 60, cy = 150, R = 110;
      const g = ctx.createRadialGradient(cx - 40, cy - 45, 10, cx, cy, R);
      g.addColorStop(0, p.sky[2]); g.addColorStop(0.7, p.sky[1]); g.addColorStop(1, p.land);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 4;
      for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.ellipse(cx, cy + k * 36, R, 16, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    } },
    bokeh: { name: 'Soft lights', draw(ctx, p, r) {
      grad(ctx, [p.sky[0], p.sky[1]]);
      const g = mix(p.glow, p.sky[1], 0.2).replace('rgb', 'rgba').replace(')', ',0.35)');
      for (let i = 0; i < 14; i++) glowCircle(ctx, r() * W, r() * H, 14 + r() * 30, i % 3 ? 'rgba(255,255,255,0.10)' : g, 6);
    } },
    stripes: { name: 'Wide stripes', draw(ctx, p, r) {
      ctx.fillStyle = p.sky[0]; ctx.fillRect(0, 0, W, H);
      ctx.save(); ctx.translate(160, 128); ctx.rotate(-0.5 + r() * 0.2);
      ctx.fillStyle = mix(p.sky[0], p.sky[1], 0.5);
      for (let x = -400; x < 400; x += 72) ctx.fillRect(x, -300, 36, 600);
      ctx.restore();
      const v = ctx.createRadialGradient(160, 128, 60, 160, 128, 220); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    } },
    contours: { name: 'Topo contours', draw(ctx, p, r) {
      const cx = 80 + r() * 160, cy = 110 + r() * 60;
      for (let k = 9; k >= 0; k--) {
        ctx.fillStyle = mix(p.land, p.sky[2], k === 0 ? 0.95 : (9 - k) / 10);
        ctx.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.1) {
          const rad = (k + 1) * 30 * (1 + 0.18 * Math.sin(a * 3 + k) + 0.1 * Math.sin(a * 5 + cx));
          ctx.lineTo(cx + Math.cos(a) * rad * 1.3, cy + Math.sin(a) * rad);
        }
        ctx.fill();
      }
    } },
    burst: { name: 'Sunburst', draw(ctx, p, r) {
      ctx.fillStyle = p.sky[0]; ctx.fillRect(0, 0, W, H);
      const cx = 160 + (r() - 0.5) * 120, cy = 128 + (r() - 0.5) * 80;
      ctx.fillStyle = mix(p.sky[0], p.sky[1], 0.55);
      for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 400, a, a + Math.PI / 16); ctx.closePath(); ctx.fill(); }
      glowCircle(ctx, cx, cy, 40, mix(p.glow, p.sky[1], 0.3), 18);
    } },
    mesas: { name: 'Mesas', draw(ctx, p, r) {
      grad(ctx, p.sky);
      [[0.4, 170], [0.75, 200]].forEach(([t, base]) => {
        ctx.fillStyle = mix(p.sky[2], p.land, t);
        let x = -20;
        while (x < 330) { const w = 50 + r() * 70, h = 30 + r() * 50; ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x + 10, base - h); ctx.lineTo(x + w - 10, base - h); ctx.lineTo(x + w, base); ctx.fill(); x += w - 8; }
        ctx.fillRect(0, base, W, H - base);
      });
    } },
    clouds: { name: 'Clouds', draw(ctx, p, r) {
      grad(ctx, [p.sky[1], p.sky[2]]);
      for (let i = 0; i < 6; i++) {
        const x = r() * W, y = 40 + r() * 170;
        for (let j = 0; j < 4; j++) glowCircle(ctx, x + j * 22 - 30, y + (j % 2) * 8, 20 + r() * 12, 'rgba(255,255,255,0.28)', 8);
      }
      const v = ctx.createLinearGradient(0, 0, 0, H); v.addColorStop(0, 'rgba(0,0,0,0.35)'); v.addColorStop(1, 'rgba(0,0,0,0.15)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    } },
  };

  // ---- Style-pack interpreter --------------------------------------------------------
  // A pack is data (lib/sstv-pack-validate.js enforces it). These are the only
  // parts it can use.
  function packColor(c, pal) {
    if (typeof c !== 'string') return pal.land;
    const m = { $sky0: pal.sky[0], $sky1: pal.sky[1], $sky2: pal.sky[2], $land: pal.land, $glow: pal.glow, $ink: pal.ink || pal.glow, $ink2: pal.ink2 || pal.sky[2] };
    return m[c] || c;
  }
  const between = (v, r) => (Array.isArray(v) ? v[0] + r() * (v[1] - v[0]) : v);
  // Hand-cut edges: each side broken into ~12 px segments, every point nudged
  // from the seed, so a station always gets the same cut.
  function roughPts(pts, rough, r) {
    if (!rough) return pts;
    const out = [];
    for (let k = 0; k < pts.length; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % pts.length];
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 12));
      for (let j = 0; j < n; j++) {
        const t = j / n;
        out.push([x0 + (x1 - x0) * t + (r() - 0.5) * 2 * rough, y0 + (y1 - y0) * t + (r() - 0.5) * 2 * rough]);
      }
    }
    return out;
  }
  function fillPts(ctx, pts, color) {
    ctx.fillStyle = color; ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.fill();
  }
  function strokePaths(ctx, paths, width, color, map) {
    ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, width);
    paths.forEach((path) => { ctx.beginPath(); path.forEach((pt, k) => { const [x, y] = map(pt); return k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); });
  }
  function drawShape(ctx, pack, name, x, y, size, color, pal, r, rough) {
    const sh = pack.shapes && pack.shapes[name]; if (!sh) return;
    (sh.parts || [sh]).forEach((pt) => {
      const col = packColor(pt.color || color, pal);
      const map = ([px, py]) => [x + px * size, y + py * size];
      if (pt.poly) fillPts(ctx, roughPts(pt.poly.map(map), rough || 0, r), col);
      if (pt.paths) strokePaths(ctx, pt.paths, Math.max(3, (pt.width || sh.width || 0.04) * size), col, map);
    });
  }
  function drawOp(ctx, pack, op, pal, seed, override, images) {
    const r = rnd(seed);
    const col = (c) => (override ? packColor(override, pal) : packColor(c, pal));
    if (op.grad) grad(ctx, op.grad.map((c) => col(c)));
    else if (op.fill) { ctx.fillStyle = col(op.fill); ctx.fillRect(0, 0, W, H); }
    else if (op.circle) {
      const c = op.circle;
      ctx.save(); ctx.globalAlpha = c.alpha == null ? 1 : c.alpha;
      const color = col(c.color), cx = between(c.x, r), cy = between(c.y, r), cr = between(c.r, r);
      blurred(ctx, c.blur || 0, color, () => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill(); });
      ctx.restore();
    } else if (op.ridge) ridge(ctx, op.ridge.base, op.ridge.amp, op.ridge.wav, r() * 6, col(op.ridge.color));
    else if (op.blob) {
      const b = op.blob, pts = [];
      for (let k = 0; k < 44; k++) { const a = (k / 44) * Math.PI * 2; pts.push([b.x + Math.cos(a) * b.rx, b.y + Math.sin(a) * b.ry]); }
      fillPts(ctx, roughPts(pts, b.rough || 0, r), col(b.color));
    } else if (op.poly) fillPts(ctx, roughPts(op.poly.pts, op.poly.rough || 0, r), col(op.poly.color));
    else if (op.shape) {
      const at = Array.isArray(op.at) ? op.at : [0, 0];
      drawShape(ctx, pack, op.shape, between(at[0], r), between(at[1], r), op.size, override || op.color, pal, r, op.rough);
    } else if (op.scatter) {
      const [x0, y0, x1, y1] = op.box;
      for (let k = 0; k < op.n; k++) { const sz = between(op.size, r); drawShape(ctx, pack, op.scatter, x0 + r() * Math.max(0, x1 - x0 - sz), y0 + r() * Math.max(0, y1 - y0 - sz * 0.5), sz, override || op.color, pal, r, op.rough); }
    } else if (op.stripes) {
      const st = op.stripes;
      ctx.save(); if (st.alpha != null) ctx.globalAlpha = st.alpha;
      st.bands.forEach(([y, c], k) => {
        if (c === 'transparent') return;
        const yEnd = k + 1 < st.bands.length ? st.bands[k + 1][0] : H;
        const top = [], bottom = [];
        for (let x = -8; x <= 328; x += 16) top.push([x, y + (y > 0 ? (r() - 0.5) * 2 * (st.rough || 0) : 0)]);
        for (let x = 328; x >= -8; x -= 16) bottom.push([x, yEnd + (yEnd < H ? (r() - 0.5) * 2 * (st.rough || 0) : 0)]);
        fillPts(ctx, top.concat(bottom), col(c));
      });
      ctx.restore();
    } else if (op.band) {
      const color = col(op.band.color);
      blurred(ctx, op.band.blur || 0, color, () => { ctx.fillStyle = color; ctx.fillRect(-20, op.band.y, W + 40, op.band.h); });
    } else if (op.paths) strokePaths(ctx, op.paths, op.width || 3, col(op.color), (pt) => pt);
    else if (op.branch) {
      const b = op.branch; ctx.strokeStyle = col(b.color); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const [x0, y0] = b.from, [x1, y1] = b.to;
      let px = x0, py = y0;
      for (let k = 1; k <= 8; k++) {
        const t = k / 8, nx = x0 + (x1 - x0) * t + (r() - 0.5) * 8, ny = y0 + (y1 - y0) * t + (r() - 0.5) * 10;
        ctx.lineWidth = Math.max(3, b.width * (1 - t * 0.75));
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(nx, ny); ctx.stroke();
        if (k > 1 && k < 8 && r() < (b.twigs || 0) / 8) {
          ctx.lineWidth = Math.max(3, b.width * 0.35);
          ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(nx + 10 + r() * 24, ny - 18 - r() * 26); ctx.stroke();
        }
        px = nx; py = ny;
      }
    } else if (op.image) {
      const img = images && images[op.image.name];
      if (img) ctx.drawImage(img, op.image.x, op.image.y, op.image.w, op.image.h);
    }
  }
  // `print` draws a step first in a second ink, offset: the off-register look
  // of a two-colour screen print. Offset DOWNWARDS on purpose: SSTV keeps
  // detail down the picture and smears it along a line.
  function drawRecipe(ctx, pack, bg, pal, r, images) {
    (bg.draw || []).forEach((op) => {
      const seed = Math.floor(r() * 1e9);
      const inner = op.blob || op.poly || null;
      const pr = (inner && inner.print) || op.print;
      if (pr) { ctx.save(); ctx.translate(pr.dx || 0, pr.dy || 0); drawOp(ctx, pack, op, pal, seed, pr.color, images); ctx.restore(); }
      drawOp(ctx, pack, op, pal, seed, null, images);
    });
  }

  // ---- Panels and scenery ---------------------------------------------------------
  function panel(ctx, look, x, y, w, h) {
    if (look.panel === 'outline') return;
    ctx.fillStyle = 'rgba(6,8,20,0.62)';
    if (look.panel === 'band') { ctx.fillRect(0, y, W, h); return; }
    const rr = 10; ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.fill();
  }
  function scenery(ctx, look, families, idx, images) {
    const r = rnd(look.seed + idx * 7919);
    if (look.pack && Array.isArray(look.pack.backgrounds) && look.pack.backgrounds.length) {
      const bgs = look.pack.backgrounds;
      const bg = bgs[(Math.floor(r() * 997) + idx) % bgs.length];
      drawRecipe(ctx, look.pack, bg, look.pal, r, images);
      return bg.name;
    }
    const key = families[Math.floor(r() * families.length)];
    BGS[key].draw(ctx, look.pal, r);
    return BGS[key].name;
  }

  // ---- Starters -------------------------------------------------------------------
  // scene(): everything that is NOT editable text (scenery, panels, strips).
  // texts: editable text layers. role 'headline' lines may be restyled by a
  // pack; 'body' lines (calls, grids, parks) never are. color 'accent' = the
  // station's accent. slot: where the reply picture goes.
  const ALL = ['ridges', 'aurora', 'ocean', 'forest', 'waves', 'night', 'synth', 'globe', 'bokeh', 'mesas', 'clouds', 'contours'];
  const STARTERS = [
    { id: 'cq', category: 'cq', name: 'CQ SSTV', why: 'The first picture anyone sends: call large, grid, and an invitation.',
      scene(ctx, L, i, im) { scenery(ctx, L, ALL, i, im); panel(ctx, L, 40, 26, 240, 48); panel(ctx, L, 20, 148, 280, 88); },
      texts: [
        { text: 'CQ SSTV', x: 160, y: 64, size: 36, color: 'accent', align: 'center', role: 'headline' },
        { text: '{MYCALL}', x: 160, y: 200, size: 46, color: '#ffffff', align: 'center', role: 'body' },
        { text: 'Grid {GRID}', x: 160, y: 226, size: 17, color: '#e8eefc', align: 'center', role: 'body' },
      ] },
    { id: 'reply', category: 'reply', name: 'Reply with report', why: 'Their picture inset, your report and call. Most SSTV is replies.', reply: true,
      slot: { x: 180, y: 28, w: 124, h: 99 },
      scene(ctx, L, i, im) { scenery(ctx, L, ['bokeh', 'stripes', 'globe', 'clouds', 'aurora', 'night'], i, im); panel(ctx, L, 10, 26, 160, 76); panel(ctx, L, 10, 140, 300, 92); },
      texts: [
        { text: '{CALL}', x: 18, y: 60, size: 30, color: 'accent', align: 'left', role: 'body' },
        { text: 'DE {MYCALL}', x: 18, y: 92, size: 20, color: '#ffffff', align: 'left', role: 'body' },
        { text: 'UR RSV {RSV}', x: 18, y: 176, size: 30, color: 'accent', align: 'left', role: 'body' },
        { text: 'TNX FB PIC!', x: 18, y: 218, size: 26, color: '#ffffff', align: 'left', role: 'headline' },
      ] },
    { id: 'reply-big', category: 'reply', name: 'Reply: big picture', why: 'Their picture large, your words in a band underneath. The classic SSTV reply.', reply: true,
      slot: { x: 48, y: 16, w: 224, h: 179 },
      scene(ctx, L, i, im) { scenery(ctx, L, ['bokeh', 'stripes', 'aurora', 'night', 'clouds'], i, im); panel(ctx, L, 8, 202, 304, 50); },
      texts: [
        { text: '{CALL} DE {MYCALL}', x: 160, y: 226, size: 22, color: '#ffffff', align: 'center', role: 'body' },
        { text: 'UR RSV {RSV} · TNX PIC', x: 160, y: 246, size: 15, color: 'accent', align: 'center', role: 'body' },
      ] },
    { id: 'pota', category: 'pota', name: 'POTA activation', why: 'For activators on SSTV. The reference comes from activator mode.',
      scene(ctx, L, i, im) {
        scenery(ctx, L, ['ridges', 'forest', 'mesas', 'contours', 'clouds', 'night'], i, im);
        // Deep green strip, white lettering, POTA-green rule. Dark lettering on
        // a bright strip vanished under the outline (Casey 2026-09-29).
        ctx.fillStyle = '#0f3b2b'; ctx.fillRect(0, 20, W, 40);
        ctx.fillStyle = '#4ecca3'; ctx.fillRect(0, 60, W, 4);
        panel(ctx, L, 30, 76, 260, 90);
      },
      texts: [
        { text: 'CQ POTA', x: 160, y: 51, size: 26, color: '#ffffff', align: 'center', role: 'body' },
        { text: '{PARK}', x: 160, y: 116, size: 38, color: '#ffffff', align: 'center', role: 'body' },
        { text: '{MYCALL}', x: 160, y: 154, size: 30, color: 'accent', align: 'center', role: 'body' },
        { text: 'Grid {GRID} · 73 from the park', x: 160, y: 234, size: 15, color: '#ffffff', align: 'center', role: 'body' },
      ] },
    { id: 'qsl', category: 'reply', name: '73 and QSL', why: 'Closes the contact with a date and time they can log. Their picture rides along small.', reply: true,
      slot: { x: 214, y: 26, w: 92, h: 74 },
      scene(ctx, L, i, im) { scenery(ctx, L, ['ocean', 'ridges', 'synth', 'night', 'aurora', 'clouds'], i, im); panel(ctx, L, 10, 24, 196, 88); panel(ctx, L, 10, 180, 300, 66); },
      texts: [
        { text: 'TNX QSO', x: 18, y: 58, size: 28, color: '#ffffff', align: 'left', role: 'headline' },
        { text: '{CALL}', x: 18, y: 100, size: 34, color: 'accent', align: 'left', role: 'body' },
        { text: '73 DE {MYCALL}', x: 18, y: 214, size: 28, color: '#ffffff', align: 'left', role: 'body' },
        { text: '{UTC}', x: 18, y: 238, size: 14, color: '#e8eefc', align: 'left', role: 'body' },
      ] },
    { id: 'card', category: 'qso', name: 'Station card', why: 'Name, grid and rig: what people send once they are chatting.',
      scene(ctx, L, i, im) { scenery(ctx, L, ['globe', 'waves', 'stripes', 'contours', 'bokeh'], i, im); panel(ctx, L, 16, 24, 288, 210); },
      texts: [
        { text: '{MYCALL}', x: 160, y: 78, size: 46, color: '#ffffff', align: 'center', role: 'body' },
        { text: 'OP {NAME}', x: 160, y: 122, size: 24, color: 'accent', align: 'center', role: 'body' },
        { text: 'Grid {GRID}', x: 160, y: 160, size: 20, color: '#e8eefc', align: 'center', role: 'body' },
        { text: '{RIG}', x: 160, y: 194, size: 18, color: '#e8eefc', align: 'center', role: 'body' },
      ] },
    { id: 'report', category: 'cq', name: 'Please report', why: 'Asks for a report. The scene is darkened so the words read even when weak.',
      scene(ctx, L, i, im) {
        scenery(ctx, L, ['stripes', 'burst', 'waves'], i, im);
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = L.accent; ctx.fillRect(12, 20, 296, 8); ctx.fillRect(12, 228, 296, 8);
      },
      texts: [
        { text: 'PSE RPT', x: 160, y: 92, size: 46, color: '#ffffff', align: 'center', role: 'headline' },
        { text: 'RSV?', x: 160, y: 150, size: 44, color: 'accent', align: 'center', role: 'headline' },
        { text: 'DE {MYCALL}', x: 160, y: 204, size: 28, color: '#ffffff', align: 'center', role: 'body' },
      ] },
    { id: 'test', category: 'test', name: 'Test pattern', why: 'Colour bars and a grey ramp with your call, to check a path.',
      scene(ctx) {
        const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
        bars.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(k * W / 7, 0, W / 7 + 1, 170); });
        for (let k = 0; k < 8; k++) { const v = Math.round(k * 255 / 7); ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; ctx.fillRect(k * 40, 170, 40, 26); }
        ctx.fillStyle = '#101010'; ctx.fillRect(0, 196, W, 60);
      },
      texts: [{ text: '{MYCALL} TEST', x: 160, y: 236, size: 30, color: '#ffffff', align: 'center', role: 'body' }] },
    { id: 'event', category: 'event', name: 'Event station', why: 'For special events: the event big, then your call and the time.',
      scene(ctx, L, i, im) { scenery(ctx, L, ['burst', 'synth', 'bokeh', 'waves', 'stripes', 'globe'], i, im); panel(ctx, L, 16, 28, 288, 76); panel(ctx, L, 30, 124, 260, 110); },
      texts: [
        { text: 'SSTV ACTIVITY', x: 160, y: 62, size: 28, color: 'accent', align: 'center', role: 'headline' },
        { text: 'WEEKEND', x: 160, y: 94, size: 26, color: 'accent', align: 'center', role: 'headline' },
        { text: '{MYCALL}', x: 160, y: 176, size: 44, color: '#ffffff', align: 'center', role: 'body' },
        { text: '{UTC}', x: 160, y: 218, size: 15, color: '#e8eefc', align: 'center', role: 'body' },
      ] },
  ];
  const starter = (id) => STARTERS.find((s) => s.id === id) || null;
  // Tray filter chips, in order. 'mine' is the operator's own saved ones.
  const CATEGORIES = [
    { id: 'all', name: 'All' }, { id: 'cq', name: 'CQ' }, { id: 'reply', name: 'Reply' },
    { id: 'pota', name: 'POTA' }, { id: 'qso', name: 'QSO' }, { id: 'event', name: 'Event' },
    { id: 'test', name: 'Test' }, { id: 'mine', name: 'Mine' },
  ];

  /** Draw a starter's scene (no text) at the canvas's own size. */
  function renderScene(canvas, id, look, images) {
    const s = starter(id); if (!s) return null;
    const ctx = canvas.getContext('2d');
    const idx = STARTERS.indexOf(s);
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / W, canvas.height / H);
    s.scene(ctx, look, idx, images);
    ctx.restore();
    return s;
  }

  /**
   * Editable text layers for a starter, scaled to the canvas. Starters are
   * designed at 320x256; y follows the height (Robot is 240 lines), x and the
   * lettering follow the width (PD 240/290 are 640 wide, where 320-space text
   * sat small in the left half until 2026-09-30). width defaults to 320.
   */
  function textLayers(id, height, width) {
    const s = starter(id); if (!s) return [];
    const ky = (height || H) / H, kx = (width || W) / W;
    return s.texts.map((t, i) => ({
      key: 'tpl-' + id + '-' + i, label: t.text, x: Math.round(t.x * kx), y: Math.round(t.y * ky),
      fontSize: Math.round(t.size * kx), bold: false, italic: false, color: t.color, rotation: 0, visible: true,
      align: t.align, outline: true, role: t.role, tpl: true,
    }));
  }

  /** The reply slot scaled to the canvas (width defaults to 320), or null. */
  function replySlot(id, height, width) {
    const s = starter(id); if (!s || !s.slot) return null;
    const ky = (height || H) / H, kx = (width || W) / W;
    return { x: Math.round(s.slot.x * kx), y: Math.round(s.slot.y * ky), w: Math.round(s.slot.w * kx), h: Math.round(s.slot.h * ky) };
  }

  const VAR_KEYS = ['MYCALL', 'GRID', 'CALL', 'RSV', 'PARK', 'UTC', 'NAME', 'RIG'];
  // A known placeholder with no value comes out blank (never a literal
  // "{PARK}" on air); a missing {CALL} shows "?" so it gets noticed before
  // transmitting. Unknown braces are left as typed.
  function fillVars(text, vars) {
    return String(text || '').replace(/\{(\w+)\}/g, (m, k) => {
      if (vars && vars[k] != null && vars[k] !== '') return String(vars[k]);
      if (k === 'CALL') return '?';
      return VAR_KEYS.indexOf(k) !== -1 ? '' : m;
    });
  }

  /**
   * How a text layer draws right now: its words (a pack may reword a
   * headline) and its font (the station's, or the pack's headline face).
   * Body lines are never touched by a pack.
   */
  function textStyle(t, look) {
    let label = t.label;
    let fontCss = null, weight = 700;
    if (t.tpl) { fontCss = look.font.css; weight = look.font.weight; }
    const pack = look.pack;
    if (t.tpl && t.role === 'headline' && pack && pack.text && Array.isArray(pack.text.headlines) && pack.text.headlines.indexOf(t.label) !== -1) {
      if (pack.text.replace && pack.text.replace[t.label]) label = pack.text.replace[t.label];
      if (pack.text.headlineFont) { fontCss = '"' + pack.text.headlineFont + '"'; weight = 400; }
    }
    return { label, fontCss, weight, color: t.color === 'accent' ? look.accent : t.color };
  }

  return {
    W, H, rnd, hash, FONTS, PALETTES, ACCENTS, PANELS, BGS, STARTERS, CATEGORIES, VAR_KEYS,
    lookFor, describeLook, isDark, fillVars, textStyle, textLayers, replySlot, renderScene, starter,
    drawRecipe, packColor, roughPts,
  };
}));
