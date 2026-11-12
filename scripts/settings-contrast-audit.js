// Settings contrast audit (Casey 2026-11-11: "Set up VARA HF for me" was black
// text on dark green in She's On Frequency). Opens the real Settings dialog in
// a scratch Electron window, shows every tab (hidden callouts and closed
// <details> included), and measures WCAG contrast for every element that
// draws text, in all ten themes. Never touches a running POTACAT: its own
// user-data dir, a stub preload, no main process.
//
// Run: npx electron scripts/settings-contrast-audit.js [--json out.json] [--shot dir]
//   prints one line per failure and a count per theme; exit 1 on any failure.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const shotDir = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
// --shot-id <id>: which control to photograph in each theme (its label and the help text under it).
const shotId = args.includes('--shot-id') ? args[args.indexOf('--shot-id') + 1] : 'vara-setup-hf';

const THEMES = [
  ['Navy', { theme: 'dark', variant: '', ds: '' }],
  ['Charcoal', { theme: 'dark', variant: 'charcoal', ds: '' }],
  ['Classic light', { theme: 'light', variant: '', ds: '' }],
  ['Night', { theme: 'dark', variant: '', ds: 'night' }],
  ['Dark', { theme: 'dark', variant: '', ds: 'dark' }],
  ['Acid Burn', { theme: 'dark', variant: '', ds: 'acid' }],
  ['Miami', { theme: 'dark', variant: '', ds: 'miami' }],
  ['Light', { theme: 'light', variant: '', ds: 'light' }],
  ["She's On Frequency", { theme: 'light', variant: '', ds: 'sof' }],
  ['Halloween', { theme: 'dark', variant: '', ds: 'halloween' }],
];

const STUB = path.join(os.tmpdir(), 'potacat-settings-audit-stub.js');
fs.writeFileSync(STUB, `
(function () {
  var noop = function () { return Promise.resolve(undefined); };
  window.api = new Proxy({ platform: 'win32' }, { get: function (t, k) {
    if (k in t) return t[k];
    if (k === 'then') return undefined;
    return /^on[A-Z]/.test(String(k)) ? function () { return function () {}; } : noop;
  } });
  window.addEventListener('error', function (e) { e.preventDefault(); });
  window.addEventListener('unhandledrejection', function (e) { e.preventDefault(); });
})();
`);

// Runs in the page: show every tab's content, then measure.
const MEASURE = `(function () {
  function parse(c) {
    if (!c) return null;
    var m = /^rgba?\\(([^)]+)\\)/.exec(c);
    var p;
    if (m) p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    else { m = /^color\\(srgb ([^)]+)\\)/.exec(c); if (!m) return null; p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); p = [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(top, under) {
    var a = top.a;
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
  }
  function lum(c) {
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  // The colour behind an element: its own background over its ancestors', down to the page.
  function bgOf(el) {
    var stack = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      var c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    var base = { r: 255, g: 255, b: 255, a: 1 };
    var dlg = document.getElementById('settings-dialog');
    if (stack.length && stack[stack.length - 1].a < 1) base = parse(getComputedStyle(document.body).backgroundColor) || base;
    for (var i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  }
  function opacityOf(el) { var o = 1; for (var n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity) || 1; return o; }
  function label(el) {
    var t = (el.matches('input,select,textarea') ? (el.value || el.placeholder || el.id) : el.textContent) || '';
    t = t.replace(/\\s+/g, ' ').trim().slice(0, 50);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + ' "' + t + '"';
  }
  var dlg = document.getElementById('settings-dialog');
  var out = [], seen = new Set();
  var all = dlg.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!el.getClientRects().length) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    var hasText = el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),select,textarea') ||
      [].some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim(); });
    if (!hasText) continue;
    var fg = parse(cs.color); if (!fg) continue;
    var bg = bgOf(el);
    if (fg.a < 1) fg = over(fg, bg);
    var r = ratio(fg, bg);
    var size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    var need = (size >= 24 || (bold && size >= 18.66)) ? 3 : 4.5;
    var op = opacityOf(el);
    var disabled = el.disabled || (el.closest && el.closest('[disabled], fieldset:disabled')) || op < 0.99;
    if (r + 1e-6 < need) {
      var key = label(el);
      if (seen.has(key)) continue; seen.add(key);
      out.push({ el: key, ratio: Math.round(r * 100) / 100, need: need, fg: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')', disabled: !!disabled });
    }
  }
  return out;
})()`;

// Show every tab's fieldsets, every hidden callout and every <details>.
const SHOW_ALL = `(function () {
  // Colours change at once between themes (no transitions to wait out).
  var st = document.createElement('style');
  st.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(st);
  var dlg = document.getElementById('settings-dialog');
  if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
  dlg.classList.add('tabbed');
  dlg.querySelectorAll('fieldset[data-settings-tab]').forEach(function (fs) { fs.classList.add('tab-visible'); });
  dlg.querySelectorAll('.hidden').forEach(function (e) { e.classList.remove('hidden'); });
  dlg.querySelectorAll('[hidden]').forEach(function (e) { e.hidden = false; });
  dlg.querySelectorAll('details').forEach(function (d) { d.open = true; });
  dlg.querySelectorAll('[style*="display:none"], [style*="display: none"]').forEach(function (e) { e.style.display = ''; });
  return dlg.querySelectorAll('*').length;
})()`;

app.on('window-all-closed', () => {});
app.setPath('userData', path.join(os.tmpdir(), 'potacat-settings-audit-ud'));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1100, height: 900, show: false, webPreferences: { preload: STUB, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await w.loadFile(path.join(ROOT, 'renderer', 'index.html')).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const n = await w.webContents.executeJavaScript(SHOW_ALL);
  const report = {};
  let total = 0;
  for (const [name, t] of THEMES) {
    await w.webContents.executeJavaScript(`(function(){ var e = document.documentElement;
      e.setAttribute('data-theme', ${JSON.stringify(t.theme)});
      if (${JSON.stringify(t.variant)}) e.setAttribute('data-dark-variant', ${JSON.stringify(t.variant)}); else e.removeAttribute('data-dark-variant');
      if (${JSON.stringify(t.ds)}) e.setAttribute('data-ds', ${JSON.stringify(t.ds)}); else e.removeAttribute('data-ds');
      e.removeAttribute('data-wcag'); return true; })()`);
    await new Promise((r) => setTimeout(r, 250));
    const fails = await w.webContents.executeJavaScript(MEASURE);
    report[name] = fails;
    const live = fails.filter((f) => !f.disabled);
    total += live.length;
    console.log(`${name}: ${live.length} under the rule${fails.length - live.length ? ` (+${fails.length - live.length} disabled)` : ''}`);
    for (const f of live.sort((a, b) => a.ratio - b.ratio).slice(0, 40)) console.log(`  ${f.ratio.toFixed(2)} < ${f.need}  ${f.el}  ${f.fg} on ${f.bg}`);
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      const ok = await w.webContents.executeJavaScript(`(function(){ var b = document.getElementById(${JSON.stringify(shotId)}); if (!b) return false; b.scrollIntoView({ block: 'center' }); return true; })()`);
      if (ok) {
        const r = await w.webContents.executeJavaScript(`(function(){ var el = document.getElementById(${JSON.stringify(shotId)}); var box = el.closest('label') || el.parentElement; var b = box.getBoundingClientRect(); var n = box.nextElementSibling; if (n && n.classList.contains('help-text')) { var h = n.getBoundingClientRect(); b = { left: Math.min(b.left, h.left), top: b.top, width: Math.max(b.right, h.right) - Math.min(b.left, h.left), height: h.bottom - b.top }; } return { x: Math.max(0, Math.floor(b.left) - 10), y: Math.max(0, Math.floor(b.top) - 10), width: Math.ceil(b.width) + 20, height: Math.ceil(b.height) + 20 }; })()`);
        const img = await w.webContents.capturePage(r);
        fs.writeFileSync(path.join(shotDir, shotId + '-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png'), img.toPNG());
      }
    }
  }
  console.log(`elements in Settings: ${n}; failures in all themes: ${total}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
  app.exit(total ? 1 : 0);
});
