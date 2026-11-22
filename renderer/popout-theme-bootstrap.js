// Pre-paint theme apply for popout windows. Read theme, dark-variant and the
// design-system column from the loadFile query string and stamp them onto
// <html> BEFORE the stylesheet evaluates, so a popout never flashes another
// theme first. Must be the FIRST <script> in every popout HTML and must sit
// BEFORE the <link rel="stylesheet"> so the parser sets the attrs before the
// render tree builds.
//
// Receives:  ?theme=light|dark&variant=navy&ds=<column>
//   from main.js: loadFile(path, { query: themeQuery() })
//
// It also exposes window.applyPopoutTheme(), the same rule as
// popout-theme-boot.js, so every pop-out's live theme handler (each
// _applyPopoutTheme delegates to it) sets data-ds as well (#376).
(function () {
  function applyPopoutTheme(p) {
    if (typeof p === 'string') p = { theme: p };
    p = p || {};
    var el = document.documentElement;
    var theme = p.theme === 'light' ? 'light' : 'dark';
    var variant = p.variant || 'navy';
    el.setAttribute('data-theme', theme);
    // A design-system theme (lib/app-theme.js): data-ds = its token column.
    // A payload without the key (the string form) leaves it alone.
    if (p.ds && /^[a-z]+$/.test(p.ds)) el.setAttribute('data-ds', p.ds);
    else if (p.ds !== undefined) el.removeAttribute('data-ds');
    if (theme === 'dark' && variant !== 'navy' && !p.ds) el.setAttribute('data-dark-variant', variant);
    else el.removeAttribute('data-dark-variant');
  }
  window.applyPopoutTheme = applyPopoutTheme;
  try {
    var q = new URLSearchParams(location.search);
    applyPopoutTheme({ theme: q.get('theme'), variant: q.get('variant'), ds: q.get('ds') || undefined });
  } catch (e) {
    // Falls through to :root defaults — better than crashing the popout.
  }
})();
