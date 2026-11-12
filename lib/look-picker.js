// The look picker (#376): Appearance (Light, Dark, System) and a swatch card
// for each theme, in Casey's order (lib/app-theme.js APP_THEMES). One builder
// for Settings > Display, the Welcome screen's "Pick your look" step and
// ECHOCAT Web, so every surface shows the same six looks the same way.
//
// Each card paints a small sample in its own theme: the card's swatch carries
// data-ds="<column>", and renderer/tokens.css scopes every --ds-* role to that
// attribute, so the sample reads that theme's colours (and Acid Burn's mono
// face) whatever the page is painted in. The picker's own chrome reads the
// page's --ds-* roles, which every window has since #376.
//
// render() only draws and reports: the caller saves and applies the theme
// (onChange gets the new {appearance, themeLight, themeDark}).
//
// Dual-mode: require() in tests, window.LookPicker in the renderer and ECHOCAT Web.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LookPicker = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const STYLE_ID = 'look-picker-style';
  const CSS = [
    '.look-picker { display: flex; flex-direction: column; gap: 10px; margin: 4px 0 8px; color: var(--ds-ink); }',
    '.look-picker .look-seg { display: inline-flex; align-self: flex-start; border: 1px solid var(--ds-line); border-radius: 8px; overflow: hidden; }',
    '.look-picker .look-seg-btn { font: inherit; font-size: 14px; font-weight: 600; min-width: 84px; min-height: 36px; padding: 6px 16px; margin: 0; border: 0; border-radius: 0; border-left: 1px solid var(--ds-line); background: var(--ds-fill); color: var(--ds-ink); cursor: pointer; }',
    '.look-picker .look-seg-btn:first-child { border-left: 0; }',
    '.look-picker .look-seg-btn[aria-checked="true"] { background: var(--ds-tint); color: var(--ds-on-tint); }',
    '.look-picker .look-seg-btn:focus-visible, .look-picker .look-card:focus-visible { outline: 2px solid var(--ds-tint); outline-offset: 2px; }',
    '.look-picker .look-system-note { font-size: 13px; color: var(--ds-ink-muted); }',
    '.look-picker .look-group-label { font-size: 13px; font-weight: 700; color: var(--ds-ink-muted); margin-bottom: 6px; }',
    '.look-picker .look-cards { display: flex; flex-wrap: wrap; gap: 10px; }',
    '.look-picker .look-card { font: inherit; display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 156px; padding: 6px; margin: 0; border: 2px solid var(--ds-line); border-radius: 10px; background: var(--ds-surface); color: var(--ds-ink); cursor: pointer; text-align: left; }',
    '.look-picker .look-card[aria-checked="true"] { border-color: var(--ds-tint); box-shadow: 0 0 0 1px var(--ds-tint); }',
    '.look-picker .look-swatch { display: flex; flex-direction: column; gap: 4px; padding: 0 0 6px; border-radius: 6px; overflow: hidden; border: 1px solid var(--ds-line); background: var(--ds-bg); color: var(--ds-ink); font-family: var(--ds-font-body); font-size: 12px; line-height: 16px; }',
    '.look-picker .lsw-bar { display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: var(--ds-surface); border-bottom: 1px solid var(--ds-line); font-weight: 800; }',
    '.look-picker .lsw-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ds-brand); flex: none; }',
    '.look-picker .lsw-row { display: flex; justify-content: space-between; gap: 6px; padding: 0 6px; }',
    '.look-picker .lsw-call { font-weight: 800; color: var(--ds-ink); }',
    '.look-picker .lsw-park { color: var(--ds-ok); font-weight: 700; }',
    '.look-picker .lsw-freq { color: var(--ds-tint); font-weight: 700; font-variant-numeric: tabular-nums; }',
    '.look-picker .lsw-air { background: var(--ds-air); color: var(--ds-on-air); border-radius: 4px; padding: 0 5px; font-size: 11px; font-weight: 800; }',
    '.look-picker .look-name { font-size: 14px; font-weight: 600; padding: 0 2px; }',
    '.look-picker .look-card[aria-checked="true"] .look-name { font-weight: 800; }',
    '.look-picker .look-chosen { font-size: 12px; font-weight: 700; color: var(--ds-tint); padding: 0 2px; min-height: 16px; }',
    '.look-picker .look-preview { border: 1px solid var(--ds-line); border-radius: 8px; overflow: hidden; background: var(--ds-surface); font-family: var(--ds-font-body); font-size: 13px; }',
    '.look-picker .lp-title { padding: 5px 10px; font-size: 12px; font-weight: 700; color: var(--ds-ink-muted); border-bottom: 1px solid var(--ds-line); }',
    '.look-picker .lp-row { display: grid; grid-template-columns: 1.2fr 1fr 1.2fr 0.8fr; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--ds-line); background: var(--ds-bg); }',
    '.look-picker .lp-row:last-child { border-bottom: 0; }',
    '.look-picker .lp-call { font-weight: 800; color: var(--ds-ink); }',
    '.look-picker .lp-park { color: var(--ds-ok); font-weight: 700; }',
    '.look-picker .lp-freq { color: var(--ds-tint); font-variant-numeric: tabular-nums; }',
    '.look-picker .lp-age { color: var(--ds-ink-muted); text-align: right; }',
  ].join('\n');

  function ensureStyle(doc) {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function el(doc, tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function appTheme() {
    return root && root.AppTheme ? root.AppTheme : (typeof require === 'function' ? require('./app-theme') : null);
  }

  /** What the picker shows: which groups, in order, and which card is chosen in each. */
  function model(state, systemDark, scope) {
    const AT = appTheme();
    const st = Object.assign({}, AT.DEFAULTS, state || {});
    const mode = AT.modeFor(st, systemDark);
    const modes = scope === 'active' ? [mode] : ['light', 'dark'];
    return {
      appearance: AT.APPEARANCES.map((a) => ({ id: a.id, name: a.name, checked: st.appearance === a.id })),
      mode,
      systemNote: st.appearance === 'system' ? 'Following your computer: ' + (mode === 'dark' ? 'Dark' : 'Light') + ' now.' : '',
      groups: modes.map((m) => {
        const chosen = AT.themeForMode(m === 'light' ? st.themeLight : st.themeDark, m).id;
        return {
          mode: m,
          label: (m === 'light' ? 'Light theme' : 'Dark theme') + (scope !== 'active' && m === mode ? ' (in use now)' : ''),
          cards: (m === 'light' ? AT.LIGHT_THEMES : AT.DARK_THEMES).map((t) => ({ id: t.id, name: t.name, column: t.column, checked: t.id === chosen })),
        };
      }),
      state: st,
    };
  }

  /**
   * Draw the picker into container.
   * @param {Element} container
   * @param {{state: object, systemDark: boolean, scope?: 'all'|'active', preview?: boolean, onChange: function}} opts
   */
  function render(container, opts) {
    if (!container) return;
    const doc = container.ownerDocument;
    ensureStyle(doc);
    const m = model(opts.state, opts.systemDark, opts.scope);
    const change = (patch) => { if (typeof opts.onChange === 'function') opts.onChange(Object.assign({}, m.state, patch)); };
    // A re-render after a click keeps keyboard focus on the same control.
    const act = doc.activeElement;
    const refocus = act && container.contains(act) ? (act.dataset.themeId ? '[data-theme-id="' + act.dataset.themeId + '"]' : act.dataset.appearance ? '[data-appearance="' + act.dataset.appearance + '"]' : null) : null;
    container.textContent = '';
    container.classList.add('look-picker');

    const seg = el(doc, 'div', 'look-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Appearance');
    for (const a of m.appearance) {
      const b = el(doc, 'button', 'look-seg-btn', a.name);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(a.checked));
      b.dataset.appearance = a.id;
      b.addEventListener('click', () => change({ appearance: a.id }));
      seg.appendChild(b);
    }
    container.appendChild(seg);
    if (m.systemNote) container.appendChild(el(doc, 'div', 'look-system-note', m.systemNote));

    for (const g of m.groups) {
      const wrap = el(doc, 'div', 'look-group');
      wrap.dataset.mode = g.mode;
      wrap.appendChild(el(doc, 'div', 'look-group-label', g.label));
      const cards = el(doc, 'div', 'look-cards');
      cards.setAttribute('role', 'radiogroup');
      cards.setAttribute('aria-label', g.label);
      for (const c of g.cards) {
        const b = el(doc, 'button', 'look-card');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(c.checked));
        b.dataset.themeId = c.id;
        b.title = c.name;
        const sw = el(doc, 'span', 'look-swatch');
        sw.setAttribute('data-ds', c.column);
        sw.setAttribute('aria-hidden', 'true');
        const bar = el(doc, 'span', 'lsw-bar');
        bar.appendChild(el(doc, 'span', 'lsw-dot'));
        bar.appendChild(el(doc, 'span', '', 'POTACAT'));
        sw.appendChild(bar);
        const r1 = el(doc, 'span', 'lsw-row');
        r1.appendChild(el(doc, 'span', 'lsw-call', 'K3SBP'));
        r1.appendChild(el(doc, 'span', 'lsw-park', 'US-1234'));
        sw.appendChild(r1);
        const r2 = el(doc, 'span', 'lsw-row');
        r2.appendChild(el(doc, 'span', 'lsw-freq', '14.062'));
        r2.appendChild(el(doc, 'span', 'lsw-air', 'ON AIR'));
        sw.appendChild(r2);
        b.appendChild(sw);
        b.appendChild(el(doc, 'span', 'look-name', c.name));
        b.appendChild(el(doc, 'span', 'look-chosen', c.checked ? 'Chosen' : ''));
        // Picking a theme of the other mode while Appearance is fixed switches
        // the appearance too, so the click always shows what was picked.
        b.addEventListener('click', () => {
          const patch = g.mode === 'light' ? { themeLight: c.id } : { themeDark: c.id };
          if (m.state.appearance !== 'system' && g.mode !== m.mode) patch.appearance = g.mode;
          change(patch);
        });
        cards.appendChild(b);
      }
      wrap.appendChild(cards);
      container.appendChild(wrap);
    }

    if (opts.preview) {
      const p = el(doc, 'div', 'look-preview');
      p.appendChild(el(doc, 'div', 'lp-title', 'Live preview: spots as you will see them'));
      for (const row of [['K3SBP', 'US-1234', '14.062 CW', '2 min'], ['N0KAH', 'US-4567', '7.188 SSB', '5 min'], ['G4BFG', 'GB-0012', '14.074 FT8', '9 min']]) {
        const r = el(doc, 'div', 'lp-row');
        r.appendChild(el(doc, 'span', 'lp-call', row[0]));
        r.appendChild(el(doc, 'span', 'lp-park', row[1]));
        r.appendChild(el(doc, 'span', 'lp-freq', row[2]));
        r.appendChild(el(doc, 'span', 'lp-age', row[3]));
        p.appendChild(r);
      }
      container.appendChild(p);
    }
    if (refocus) { const n = container.querySelector(refocus); if (n) n.focus(); }
  }

  return { render, model, CSS, STYLE_ID };
});
