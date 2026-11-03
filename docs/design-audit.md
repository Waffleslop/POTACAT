# POTACAT desktop design audit — Phase 0 (2026-10-28)

Companion to `docs/design-system-plan.md`. Measured by script over `renderer/*.html`, each window's own `.js`, `renderer/app.js` (main window), `styles.css`, `remote.css` and `scripts/launcher.js`. Numbers are counts of declarations in source, not rendered elements.

## The headline finding: the desktop already has a theme system

This changes Phase 3 from "build" to "re-point".

- `styles.css` opens with a token block on `:root` and overrides it in four places: dark (default, "navy"), `[data-dark-variant="charcoal"]`, `[data-theme="light"]`, and the WCAG pair `[data-wcag]` / `[data-theme="light"][data-wcag]`. It defines 87 custom properties and uses `var(--…)` 1,900 times; `remote.css` 579 times.
- The token names already include a "mobile vocabulary" alias layer (`--bg`, `--bg-elevated`, `--text`, `--text-muted`, `--accent`, `--info`, `--ok`, `--warn`, `--bad`, `--*-subtle`) laid over the legacy dash names (`--bg-primary`, `--accent-red` …).
- Settings: `lightMode`, `darkVariant` (navy | charcoal), `wcagMode`. `applyTheme()` in `renderer/app.js` stamps `data-theme` / `data-dark-variant` on `<html>`.
- Pop-outs: `renderer/popout-theme-bootstrap.js` stamps the same attributes from the load URL before first paint (19 windows load it), and each pop-out's `_applyPopoutTheme` handles live changes.

So the mechanism the phone's handoff recommends (one attribute on `<html>`, every window repaints, pre-paint bootstrap) exists. What is missing is the phone's **values and roles**: the desktop's palette is its own (navy `#1a1a2e`, red `#e94560`), and its roles are coarser (one `--accent` red for brand, TX, danger and selection alike).

## Inventory

### Whole renderer

| Measure | Desktop | Phone after redesign |
|---|---|---|
| Distinct font sizes (px) | 21 in `styles.css`, 21 in `remote.css`, 52 across all files | 12 sizes, 21 named styles |
| Font-size declarations | 601 `styles.css`, 405 `remote.css`, ~1,000 more inline/JS | 80 via `TYPE`, 1,438 literals left |
| Font weights | 600 ×294, 700 ×211, `bold` ×90, `normal` ×24, 500 ×18, 400 ×12, 800 ×10, 900 ×2, 650 ×1 | 400 / 600 / 700 / 800 / 900 only |
| Font families | 14 distinct declarations | sans + mono |
| Letter-spacings | 29 distinct | carried by the styles |
| Border radii | 29 distinct (4px ×261, 3px ×214, 6px ×119, 8px ×87, 50% ×42, 10px ×35, 2px ×32, 12px, 5px, 999px, 0, 14px …) | 7 |
| Paddings | 217 distinct | 9 spacing steps |
| Hex colours | 305 distinct across files (183 in `styles.css`) | 57 roles |
| `#e94560` literal | 262, plus 303 `var(--accent-red)` / `var(--accent)` | split into brand / air / danger / tint |
| White-text literals (`color: #fff` / `white`) | 179 | 0, enforced by a scan test |
| Button-like CSS classes | 156 | 1 Button component, 4 kinds × 5 tones × 3 sizes |
| `style="…"` attributes in HTML | 1,191 in the main window alone | n/a |

`styles.css` font-size histogram: 12px 161, 11px 156, 13px 102, 10px 76, 14px 31, 9px 24, 16px 15, 15px 10, 18px 6, 22px 4, 20px 3, 36px 2, 13.5px 2, 19px 2, then one each of 12.5, 24, 28, 32, 48, 56, 72.

### Per window

`fsz` = font-size declarations, `sizes` = distinct sizes, `hex` = distinct hex colours, `inline` = `style="…"` attributes, `buttons` = `<button>` / created buttons. "Boot" = loads `popout-theme-bootstrap.js`.

| Window | fsz | sizes | hex | inline | buttons | Canvas | Boot | Notes |
|---|---|---|---|---|---|---|---|---|
| Main (`index` + `app.js`) | 311 | 10 | 117 | 1,191 | 493 | yes | yes | Settings, rig editor, every view; the biggest job by far |
| ECHOCAT Web (`remote`) | 162 | 7 | 58 | 388 | 317 | 35 uses | own | Own sheet `remote.css`; served to browsers |
| JTCAT (`jtcat-popout`) | 94 | 9 | 63 | 75 | 79 | 8 | yes | Waterfall, decode rows, JTTY/PSK panes |
| VFO (`vfo-popout`) | 83 | 14 | 85 | 35 | 57 | 2 | **no** | Self-contained 3,727-line HTML, no `styles.css`; 14 sizes is the worst ratio |
| SSTV (`sstv-popout`) | 63 | 8 | 22 | 13 | 51 | 18 | yes | Image canvases |
| JS8Call (`js8call-popout`) | 47 | 9 | 19 | 7 | 29 | 2 | yes | |
| QSO / Logbook (`qso-popout`) | 36 | 5 | 5 | 20 | 23 | no | yes | Already mostly on variables |
| Log QSO (`log-popout`) | 26 | 4 | 14 | 11 | 10 | no | yes | |
| Winlink (`winlink-popout`) | 26 | 5 | 14 | 11 | 29 | 1 | yes | |
| Pair (`pair-popout`) | 13 | 4 | 5 | 8 | 8 | no | yes | Small: a good first conversion |
| Mercury (`mercury-popout`) | 11 | 4 | 5 | 2 | 8 | no | yes | Small |
| Propagation (`prop-popout`) | 11 | 4 | 21 | 8 | 6 | no | yes | Map colours |
| Actmap share (`actmap-share`) | 10 | 9 | 4 | 0 | 0 | no | no | Off-screen share image; fixed 1080 px art, NOT themed (it is a picture) |
| Band Scope (`scope-popout`) | 10 | 5 | 16 | 6 | 13 | 7 | yes | Canvas colours |
| Cluster (`cluster-popout`) | 10 | 5 | 6 | 0 | 5 | no | yes | |
| Map (`map-popout`) | 10 | 3 | 56 | 13 | 5 | no | yes | 56 hex = map pins (source colours, fixed by rule) |
| Pair request (`pair-request-popout`) | 10 | 8 | 29 | 1 | 3 | no | **no** | No `styles.css`, its own palette |
| Spots (`spots-popout`) | 9 | 5 | 16 | 2 | 4 | no | yes | |
| Activation (`actmap-popout`) | 7 | 4 | 4 | 2 | 8 | no | yes | |
| Conditions (`conditions-popout`) | 6 | 3 | 0 | 7 | 4 | no | yes | Already clean |
| Bandspread (`bandspread-popout`) | 2 | 2 | 2 | 0 | 9 | 2 | yes | Canvas-drawn |
| JS8 map / JTCAT map | 1–2 | 1 | 3–4 | 1–3 | 3–4 | no | yes | |
| Audio bridges (`remote-audio`, `remote-audio-client`, `modem-audio-bridge`) | 0 | 0 | 0 | 0 | 0 | no | no | Hidden windows, no UI: out of scope |
| Remote Launcher page (`scripts/launcher.js`) | 9 | — | 13 | — | — | no | no | Inline HTML served on :7301 |

## What the numbers mean for the plan

1. **Colour is the cheap half, because the variables exist.** Map the phone's 57 roles onto the desktop's existing variable names (both vocabularies), add the four phone themes as new `[data-theme]` blocks, and every window already reading `var(--…)` repaints. The hard part is the phone's hardest part too: splitting `--accent` / `#e94560` (565 uses) into `brand`, `air`, `danger` and `tint` by intent, one use at a time.
2. **Type and spacing are the expensive half.** ~2,000 font-size declarations, 217 paddings, 29 radii, 156 button classes, and over 1,500 inline `style=` attributes. These only converge through shared components and type classes, never by search-and-replace.
3. **Two windows are outside the theme today**: the VFO window and the pair-request window load no shared stylesheet. They need the bootstrap and the token sheet first, or no theme reaches them.
4. **Canvas surfaces** (JTCAT waterfall, scope, bandspread, SSTV, VFO meters, ECHOCAT Web's 35 canvas uses) read colours in JavaScript; each needs the one resolved-colour helper the plan describes.
5. **Not themed by rule**: the share image (a fixed picture), map pins and source colours, waterfall palettes other than Tidepool, watch-group colours.

## Decisions taken (Casey, 2026-10-28 "go" on the recommendations)

1. Token file: a copy in this repo (`assets/design/tokens.json`) with a test that fails if it drifts from `potacat-app/docs/design-system/tokens.json`.
2. Density: compact (~28 px controls) for mouse windows, with a density setting for touch-screen shack PCs. PTT, HALT and Tune stay full size everywhere.
3. Band colours become themeable tokens (`band-160` … `band-6`); source colours stay fixed.
4. The Remote Launcher page gets copies of the same token and component sheets, written at install time.

## Conversion order (Phase 4)

Small and clean first, to prove the kit: Conditions, Pair, Mercury, Log QSO, QSO/Logbook, Cluster, Spots, Activation. Then the windows outside the theme (VFO, pair request). Then canvas-heavy windows (Band Scope, Bandspread, JTCAT, SSTV, JS8Call, Winlink). Then ECHOCAT Web. Main window last, section by section (top bar, spots table, Settings, rig editor). Launcher page with ECHOCAT Web.
