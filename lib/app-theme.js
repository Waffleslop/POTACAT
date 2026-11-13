// Which theme a window paints (#376, Casey 2026-11-12: the six ECHOCAT themes,
// "logical from light to dark to weird").
//
// The model is the phone's: an Appearance (Light, Dark or System) and one
// chosen theme per mode. System follows the operating system live. The six
// themes share their ids and colours with ECHOCAT; each stamps
// data-ds="<token column>" on <html> (renderer/tokens.css + ds-bridge.css) and
// decides data-theme (light or dark) by its scheme.
//
// Settings (machine-global, main.js GLOBAL_KEYS):
//   appearance  'light' | 'dark' | 'system'
//   themeLight  a light theme id (POTACAT Light, She's On Frequency)
//   themeDark   a dark theme id (POTACAT Dark, Midnight, Acid Burn, Miami Nights)
//   appTheme, lightMode  the theme in force when last saved, kept for older
//                        readers and a downgrade; never read when appearance is set
//   themeLegacy  the pre-#376 values, remembered once by the migration
//
// The classic Navy / Charcoal / Classic light looks and Halloween are no longer
// choices; migrateThemeSettings() moves them once (classic CSS stays as the
// fallback when no data-ds is set).
//
// Dual-mode: require() in main, window.AppTheme in the renderer and ECHOCAT Web.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AppTheme = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Every list, in this order: light to dark to weird (Casey 2026-11-12).
   *  `column` is the tokens.json theme column. */
  const APP_THEMES = [
    { id: 'potacat-light', name: 'POTACAT Light', column: 'light', scheme: 'light' },
    { id: 'shes-on-frequency', name: "She's On Frequency", column: 'sof', scheme: 'light' },
    { id: 'potacat-dark', name: 'POTACAT Dark', column: 'night', scheme: 'dark' },
    { id: 'midnight', name: 'Midnight', column: 'dark', scheme: 'dark' },
    { id: 'acid-burn', name: 'Acid Burn', column: 'acid', scheme: 'dark' },
    { id: 'miami-nights', name: 'Miami Nights', column: 'miami', scheme: 'dark' },
  ];
  const LIGHT_THEMES = APP_THEMES.filter((t) => t.scheme === 'light');
  const DARK_THEMES = APP_THEMES.filter((t) => t.scheme === 'dark');

  const APPEARANCES = [
    { id: 'light', name: 'Light' },
    { id: 'dark', name: 'Dark' },
    { id: 'system', name: 'System' },
  ];

  /** A new install: follow the computer, POTACAT Light by day, POTACAT Dark by night. */
  const DEFAULTS = { appearance: 'system', themeLight: 'potacat-light', themeDark: 'potacat-dark' };

  function findTheme(id) {
    return APP_THEMES.find((t) => t.id === id) || null;
  }

  /** The theme for a mode: the id when it belongs to that mode's list, else the list's first. */
  function themeForMode(id, mode) {
    const list = mode === 'light' ? LIGHT_THEMES : DARK_THEMES;
    return list.find((t) => t.id === id) || list[0];
  }

  function normalAppearance(a) {
    return a === 'light' || a === 'dark' || a === 'system' ? a : DEFAULTS.appearance;
  }

  /**
   * The one-time move from the old picker (appTheme 'classic' + lightMode +
   * darkVariant, a design-system appTheme, or Halloween) to Appearance + one
   * theme per mode. Returns null when the settings already have an appearance.
   * The current mode keeps the look it had (mapped); the other mode gets its
   * default; appearance is fixed to that mode, so nothing changes under the
   * operator until they choose System.
   * @returns {null | {settings: object, theme: object, from: string}}
   */
  const LEGACY_MAP = [
    // [label, test(settings), new theme id]
    ['Halloween', (s) => s.appTheme === 'halloween', 'potacat-dark'],
    ['Classic light', (s) => (!s.appTheme || s.appTheme === 'classic') && s.lightMode === true, 'potacat-light'],
    ['Classic dark (Charcoal)', (s) => (!s.appTheme || s.appTheme === 'classic') && s.darkVariant === 'charcoal', 'midnight'],
    ['Classic dark (Navy)', (s) => !s.appTheme || s.appTheme === 'classic', 'potacat-dark'],
  ];
  function migrateThemeSettings(s) {
    s = s || {};
    if (s.appearance === 'light' || s.appearance === 'dark' || s.appearance === 'system') return null;
    let t = findTheme(s.appTheme);
    let from = t ? t.name : null;
    if (!t) {
      const row = LEGACY_MAP.find((r) => r[1](s));
      // An id this build does not know: the look its lightMode said, never a surprise.
      t = findTheme(row ? row[2] : (s.lightMode === true ? 'potacat-light' : 'potacat-dark'));
      from = row ? row[0] : String(s.appTheme);
    }
    const mode = t.scheme;
    const settings = {
      appearance: mode,
      themeLight: mode === 'light' ? t.id : DEFAULTS.themeLight,
      themeDark: mode === 'dark' ? t.id : DEFAULTS.themeDark,
      appTheme: t.id,
      lightMode: mode === 'light',
      themeLegacy: {
        appTheme: s.appTheme === undefined ? null : s.appTheme,
        lightMode: s.lightMode === undefined ? null : s.lightMode,
        darkVariant: s.darkVariant === undefined ? null : s.darkVariant,
      },
    };
    return { settings, theme: t, from };
  }

  /** The one-time message after the migration. */
  function migrationNotice(name) {
    return 'Your theme is now ' + name + ', the same look as ECHOCAT. Change it in Settings > Display.';
  }

  /** 'light' or 'dark': the mode in force. systemDark: the OS asks for dark. */
  function modeFor(s, systemDark) {
    const a = normalAppearance(s && s.appearance);
    if (a === 'system') return systemDark ? 'dark' : 'light';
    return a;
  }

  /**
   * The attributes every window puts on <html>, from the settings.
   * Settings from before #376 resolve through the migration table, so a
   * window never paints a look the operator did not have.
   * @returns {{theme: 'light'|'dark', variant: 'navy', ds: string, appTheme: string, appearance: string}}
   */
  function resolveAppTheme(s, systemDark) {
    s = s || {};
    if (!s.appearance) {
      const m = migrateThemeSettings(s);
      if (m) s = Object.assign({}, s, m.settings);
    }
    const mode = modeFor(s, systemDark);
    const t = themeForMode(mode === 'light' ? s.themeLight : s.themeDark, mode);
    return { theme: t.scheme, variant: 'navy', ds: t.column, appTheme: t.id, appearance: normalAppearance(s.appearance) };
  }

  /** The settings a picker writes: the change plus the theme now in force. */
  function settingsFor(state, systemDark) {
    const out = {
      appearance: normalAppearance(state && state.appearance),
      themeLight: themeForMode(state && state.themeLight, 'light').id,
      themeDark: themeForMode(state && state.themeDark, 'dark').id,
    };
    const r = resolveAppTheme(out, systemDark);
    out.appTheme = r.appTheme;
    out.lightMode = r.theme === 'light';
    return out;
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

  /**
   * ECHOCAT Web keeps its look in the browser (localStorage), as the phone
   * keeps its own. get(key) reads one key. Before #376 the page had only
   * 'echocat-theme' = 'light' | 'dark' (the classic looks): light maps to
   * POTACAT Light, dark to POTACAT Dark, both fixed; nothing saved = System.
   */
  const WEB_KEYS = { appearance: 'echocat-appearance', themeLight: 'echocat-theme-light', themeDark: 'echocat-theme-dark', legacy: 'echocat-theme' };
  function webState(get) {
    const read = (k) => { try { return get(k); } catch (e) { return null; } };
    let appearance = read(WEB_KEYS.appearance);
    if (appearance !== 'light' && appearance !== 'dark' && appearance !== 'system') {
      const old = read(WEB_KEYS.legacy);
      appearance = old === 'light' || old === 'dark' ? old : DEFAULTS.appearance;
    }
    return {
      appearance,
      themeLight: themeForMode(read(WEB_KEYS.themeLight), 'light').id,
      themeDark: themeForMode(read(WEB_KEYS.themeDark), 'dark').id,
    };
  }

  /** Native window background before the page paints: each theme's --ds-bg. */
  const WINDOW_BG = { light: '#f4f5f7', sof: '#f6f1e7', night: '#07111b', dark: '#0b0d10', acid: '#000000', miami: '#0b0620' };

  return {
    APP_THEMES, LIGHT_THEMES, DARK_THEMES, APPEARANCES, DEFAULTS, WINDOW_BG,
    findTheme, themeForMode, modeFor, resolveAppTheme, settingsFor, applyToDocument,
    migrateThemeSettings, migrationNotice, WEB_KEYS, webState,
  };
});
