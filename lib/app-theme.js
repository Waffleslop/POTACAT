// Which theme a window paints (docs/design-system-plan.md Phase 3).
//
// settings.appTheme picks between the classic desktop themes ('classic', the
// default: lightMode + darkVariant as before) and the ECHOCAT design-system
// themes, which share their ids and colours with the phone. A design-system
// theme stamps data-ds="<token column>" on <html> (renderer/tokens.css +
// renderer/ds-bridge.css) and decides light vs dark itself, so data-theme
// follows the theme's scheme and lightMode is ignored while one is chosen.
//
// Dual-mode: require() in main, window.AppTheme in the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AppTheme = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The picker, in order. `column` is the tokens.json theme column. */
  const APP_THEMES = [
    { id: 'classic', name: 'Classic', column: null, scheme: null },
    { id: 'potacat-dark', name: 'POTACAT Dark', column: 'night', scheme: 'dark' },
    { id: 'midnight', name: 'Midnight', column: 'dark', scheme: 'dark' },
    { id: 'acid-burn', name: 'Acid Burn', column: 'acid', scheme: 'dark' },
    { id: 'miami-nights', name: 'Miami Nights', column: 'miami', scheme: 'dark' },
    { id: 'potacat-light', name: 'POTACAT Light', column: 'light', scheme: 'light' },
    { id: 'shes-on-frequency', name: "She's On Frequency", column: 'sof', scheme: 'light' },
  ];

  function findTheme(id) {
    return APP_THEMES.find((t) => t.id === id) || APP_THEMES[0];
  }

  /**
   * The attributes every window puts on <html>, from the settings.
   * @returns {{theme: 'light'|'dark', variant: string, ds: string|null, appTheme: string}}
   */
  function resolveAppTheme(s) {
    s = s || {};
    const t = findTheme(s.appTheme);
    if (t.column) return { theme: t.scheme, variant: 'navy', ds: t.column, appTheme: t.id };
    return {
      theme: s.lightMode === true ? 'light' : 'dark',
      variant: s.darkVariant || 'navy',
      ds: null,
      appTheme: 'classic',
    };
  }

  /** Apply a resolved state (or a bare {theme, variant, ds} payload) to a document. */
  function applyToDocument(doc, state) {
    const el = doc && doc.documentElement;
    if (!el || !state) return;
    el.setAttribute('data-theme', state.theme === 'light' ? 'light' : 'dark');
    if (state.theme !== 'light' && state.variant && state.variant !== 'navy' && !state.ds) {
      el.setAttribute('data-dark-variant', state.variant);
    } else {
      el.removeAttribute('data-dark-variant');
    }
    if (state.ds) el.setAttribute('data-ds', state.ds);
    else el.removeAttribute('data-ds');
  }

  /** The quick light/dark toggle while a design-system theme is chosen. */
  function toggledAppTheme(currentId, wantLight) {
    const t = findTheme(currentId);
    if (!t.column) return currentId;
    if (wantLight) return t.scheme === 'light' ? t.id : 'potacat-light';
    return t.scheme === 'dark' ? t.id : 'potacat-dark';
  }

  /**
   * The ONE theme picker (Casey 2026-11-04: "Change Theme" as a dropdown, not
   * a light/dark on/off). The classic themes' three looks are choices of
   * their own, so a single menu covers everything the old Theme select, the
   * Dark/Light switch and the Navy/Charcoal radios did.
   */
  const THEME_CHOICES = [
    { id: 'classic-navy', name: 'Classic Dark (Navy)', settings: { appTheme: 'classic', lightMode: false, darkVariant: 'navy' } },
    { id: 'classic-charcoal', name: 'Classic Dark (Charcoal)', settings: { appTheme: 'classic', lightMode: false, darkVariant: 'charcoal' } },
    { id: 'classic-light', name: 'Classic Light', settings: { appTheme: 'classic', lightMode: true } },
  ].concat(APP_THEMES.filter((t) => t.column).map((t) => ({
    id: t.id, name: t.name, settings: { appTheme: t.id, lightMode: t.scheme === 'light' },
  })));

  /** The picker entry the settings describe. */
  function choiceFor(s) {
    s = s || {};
    const t = findTheme(s.appTheme);
    if (t.column) return t.id;
    if (s.lightMode === true) return 'classic-light';
    return s.darkVariant === 'charcoal' ? 'classic-charcoal' : 'classic-navy';
  }

  /** The settings a picker entry writes: {appTheme, lightMode, darkVariant?}.
   *  A named theme leaves darkVariant alone (it ignores it). Unknown → Navy. */
  function settingsForChoice(id) {
    const c = THEME_CHOICES.find((x) => x.id === id) || THEME_CHOICES[0];
    return Object.assign({}, c.settings);
  }

  return { APP_THEMES, THEME_CHOICES, findTheme, resolveAppTheme, applyToDocument, toggledAppTheme, choiceFor, settingsForChoice };
});
