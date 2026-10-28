# POTACAT desktop + Remote Launcher design system — plan

Status: PLAN, 2026-10-28 (Casey: "a comprehensive review of POTACAT and the Launcher for design ... one beautiful consistent design ... Acid Burn on the desktop too ... themes match ... skin POTACAT professionally, custom designs folks bring in").

Source of truth for the system: the phone's handoff `potacat-app/docs/desktop-handoffs/design-system-for-desktop.md` (2026-10-28, from `potacat-app/docs/design-system/tokens.json`). Read its section 0 first: the tokens, four themes (POTACAT Light, Midnight, POTACAT Dark, Acid Burn), contrast tests and font scaling are BUILT on the phone; the shared component library and skin import are DESIGNED, not built. The phone's lesson: colour reached every screen through a key remap, type reached only redesigned screens (80 TYPE uses vs 1,438 literal sizes), because components were never shared. So the desktop builds the components first.

## Where the desktop stands (inventory, 2026-10-28)

| What | Count |
|---|---|
| Windows (`renderer/*.html`) | 26: main (`index.html`), ECHOCAT Web (`remote.html`), and 24 pop-outs/helpers: actmap, actmap-share, bandspread, cluster, conditions, js8-map, js8call, jtcat-map, jtcat, log, map, mercury, modem-audio-bridge, pair, pair-request, prop, qso, remote-audio(-client), scope, spots, sstv, vfo, winlink |
| Stylesheets | `styles.css` 10,672 lines, `remote.css` 4,458 lines, plus `<style>` blocks inside most pop-out HTML files |
| Distinct `font-size` values | 52 (12px 557 uses, 11px 530, 13px 291, 10px 190, 14px 113, 9px 54, 16px 53, 15px 43 ... down to 7px, 8px, 10.5px, 11.5px, 12.5px, 13.5px, 36px) |
| Distinct hex colours in CSS/HTML | 305 |
| CSS custom properties defined in `styles.css` | 87 (there is a `:root` and a `[data-theme="light"]` already: a two-theme dark/light base exists) |
| Existing scale hooks | `--ui-scale` (main window zoom, Settings > Display text size), `--bs-scale` / `--bl-scale` (band scope / bandspread), window zoom factor in localStorage |
| Launcher (`scripts/launcher.js`) | one inline HTML status page, 9 font-size literals, its own colours |

The phone's audit started from 33 sizes / 1,359 declarations; the desktop is 52 sizes over roughly 2,000, and 305 colours against the phone's 57 roles. Same disease, bigger patient.

## Goals (Casey's words, turned into checks)

1. One system: every window reads one generated `tokens.css` and draws with one component sheet. No window owns its own type scale or palette.
2. Themes match the phone: the same four theme ids and the same 57 colour values per theme, so Acid Burn on the phone and Acid Burn on the desktop are the same thing. A user may still pick a different mode/theme per device (per-device override), with the chosen ids synced through the cloud account.
3. Font size scales without bursting: one `--font-scale` on `:root`, chrome regions pinned (`--font-scale: 1` or a clamp), content regions flow (grow in height, truncate in width, scroll). Mouse-driven windows get a density setting, not new sizes.
4. Skins: a single-theme skin JSON (`{schema, id, name, author, base, corners, fonts, colors}`) is the import/export format on both apps, validated by shared code (33 contrast pairs, hue windows, base luminance, hex/rgba only, bundled fonts only). Bundled themes are generated from the same `tokens.json`.
5. Scan tests from day one: no hex / `rgb()` / raw `font-size` outside the generated file and the component sheet (frozen allowlist that only shrinks), no white-text literals, the 33 contrast pairs for every theme.

## Phases

**Phase 0: understanding (this document, then an audit).** A per-window audit table: purpose, chrome vs content regions, components it uses, its colours and sizes, canvas surfaces (scope, waterfall, map, meters), anything theme-detected by colour compare. Output: `docs/design-audit.md`. Also the Launcher's page.

**Phase 1: the source and the generator.** Copy `tokens.json` into `assets/design/tokens.json` with a parity test (hash compare against the phone's copy; a `potacat-design` package later if both repos want it). `scripts/gen-design-tokens-css.js` emits `renderer/tokens.css`: `[data-theme="<id>"]` blocks of `--ds-*` colours for every theme, `:root` space/radius/size/stroke/opacity, one class per type style using `calc(var(--font-scale) * <size>px)`. Add the desktop's own token groups to the file first (band-160..band-6, icon-sm/md/lg) so a skin can never be incomplete for one app. Tests: contrast pairs, resolution to literals, generator determinism.

**Phase 2: the component sheet.** `renderer/ds.css` (or a small set of web components): Button (filled/tinted/gray/plain, five tones, three sizes), Pill, Chip, Tag, Segmented, Toggle, TextField, SectionHeader, ListGroup, Sheet/Dialog, Banner (ON AIR), Meter, AppHeader, TabBar, SpotRow, ActionStrip, Toolbar, plus shared states (pressed, selected, disabled, focus ring, loading, empty). Every rule from the handoff's section 4, reading only `--ds-*`. A rendered gallery window (`renderer/ds-gallery.html`, dev only) showing every component in every theme, and the layout harness (`test/layout/`) extended to render it at two font scales and two densities.

**Phase 3: theme plumbing.** One setting (`settings.theme`: mode system/light/dark + a theme id per mode, GLOBAL_KEY), main broadcasts `theme-changed` to every BrowserWindow and sets `nativeTheme.themeSource`; each window sets `data-theme` on `<html>` and repaints; canvas surfaces resolve colours once per theme change through one helper (`getComputedStyle`), never per frame. Acid Burn's mono face applied through `fonts` in the theme, not a special case. Settings > Display gets the picker (Mode, dark theme, light theme) and Font size (Standard / Large, matching the phone) and Density. Cloud sync of `darkTheme`/`lightTheme` + per-device override = cloud handoff + phone handoff.

**Phase 4: convert windows to the components**, one window at a time, main window last (biggest), each conversion shrinking the allowlist. Order: the small pop-outs first to prove the kit (pair, qso, log, conditions), then VFO/scope/JTCAT (canvas + chrome rules), then ECHOCAT Web (shares the sheet), then the main window and the Launcher page.

**Phase 5: skins.** Skin file import/export, the shared validator (lifted from the phone's `designTokens.test.ts` + the hue/luminance rules), published skins at a potacat.com URL with date ranges (Halloween), the operator never switched without asking.

## Rules carried over, verbatim in spirit

- Weights 400/600/700/800/900 only; uppercase only on eyebrow, eyebrow-strip, tag; every column of digits tabular.
- Red = on the air or stop; green = good; amber = caution; tint = selected. PTT is the only control filled red at rest.
- Brand is identity only (active tab, tuned edge, watched star, Log letter), never a button fill, never a state. The desktop's `#e94560` is used for all of these today: inventory before touching it (the phone's hardest step was splitting `accent` into brand / air / danger / tint).
- No hard-coded white text: `on-*` tokens or `readableOn(fill)`.
- Dark themes are flat (no shadows); only the seven radii; only the nine spacing steps.
- Waterfall palettes are data, not theme (only Tidepool follows the theme). Source colours and watch-group colours are the same in every theme.
- Decide per region: chrome (fixed, OS scaling only) vs content (flows). Nothing in chrome auto-fits to leftover width.

## Open decisions for Casey

1. Where `tokens.json` lives: a copy in each repo with a parity test (fast), or a shared package (cleaner, one more repo).
2. Density default for mouse windows (28 px controls) vs touch-screen shack PCs (44 px): a setting, default by platform?
3. Whether the desktop's per-band colours become themed tokens (`band-160`..`band-6`) now, so Acid Burn can recolour the band chart, or stay fixed data like the source colours.
4. The Launcher page: same sheet served from the launcher (it cannot `require` the app), so it gets a copy of `tokens.css` + `ds.css` written at install time (like the launcher config), or stays plain.
