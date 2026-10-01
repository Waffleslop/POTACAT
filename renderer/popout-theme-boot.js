// Popout theme boot — the single rule that makes every POTACAT pop-out
// (VFO, JTCAT, Map, Spots, Cluster, Log, QSO, SSTV, Conditions, …) open in
// the operator's chosen light/dark theme on the FIRST painted frame, with no
// flash-then-switch.
//
// How it stays flicker-free: main.js passes the current theme on the window's
// loadFile URL — `?theme=light|dark&variant=<darkVariant>` — for every popout.
// This script is loaded as the first <script> in <head> (a classic, render-
// blocking script), so it runs and sets the data-theme / data-dark-variant
// attributes on <html> BEFORE the stylesheet paints. It mirrors the main
// window's applyTheme() exactly: data-theme is always set; data-dark-variant
// is set only for a non-default dark variant.
//
// It also exposes window.applyPopoutTheme() so a popout's live onTheme IPC
// (fired when the operator toggles the theme, or on did-finish-load) goes
// through the SAME logic. That matters: the IPC payload is an object
// { theme, variant }, and the old per-popout handlers did
// setAttribute('data-theme', payload) — stringifying the object to
// "[object Object]" and silently falling back to dark (the VFO popout opened
// dark in light mode for exactly this reason). Route every onTheme through
// window.applyPopoutTheme and the shape can't bite again.
(function () {
  // Accept a string ('light' | 'dark') OR an object { theme, variant }.
  function normalize(p) {
    if (typeof p === 'string') return { theme: p === 'light' ? 'light' : 'dark', variant: 'navy' };
    p = p || {};
    return { theme: p.theme === 'light' ? 'light' : 'dark', variant: p.variant || 'navy' };
  }

  function applyPopoutTheme(p) {
    var t = normalize(p);
    var el = document.documentElement;
    el.setAttribute('data-theme', t.theme);
    if (t.theme === 'dark' && t.variant && t.variant !== 'navy') {
      el.setAttribute('data-dark-variant', t.variant);
    } else {
      el.removeAttribute('data-dark-variant');
    }
  }

  window.applyPopoutTheme = applyPopoutTheme;

  // Apply from the loadFile query synchronously, before first paint.
  try {
    var q = new URLSearchParams(window.location.search || '');
    applyPopoutTheme({ theme: q.get('theme'), variant: q.get('variant') });
  } catch (e) {
    // No query / parse failure → leave the stylesheet's default (dark).
  }

  // macOS: every pop-out opens with titleBarStyle 'hiddenInset', so the
  // system traffic lights sit over the left of our title bar. Mark <html>
  // here, before first paint, so each pop-out's CSS can hide its own
  // minimize/maximize/close buttons and clear the traffic lights. Seven
  // pop-outs (Log, VFO, Spots, DX Cluster, JS8, SSTV, Mercury) never added
  // the class and showed both sets of buttons, with the title under the
  // traffic lights (N0KAH 2026-10-01).
  try {
    if (window.api && window.api.platform === 'darwin') document.documentElement.classList.add('platform-darwin');
  } catch (e) { /* no preload bridge: leave the Windows/Linux layout */ }
})();
