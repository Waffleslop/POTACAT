# POTACAT desktop — agent instructions

Read the workspace file first: `../AGENTS.md` (until the folder move it lives at
`D:\Projects\potacat\AGENTS.md`). It holds the product-line rules. This file is only what is
specific to this repo. This repo is public; nothing private goes in here.

## Layout
- main.js: the Electron main process, one large file (about 2.5 MB). Glue only; every rule lives in lib/.
- preload*.js: one contextBridge per window (main window, pop-outs, remote audio).
- renderer/: the windows. app.js is the main window; each pop-out has its own js/css/html.
  remote.js + remote.css are ECHOCAT Web (served by lib/remote-server.js to phones and browsers).
- lib/: pure modules, each with a test in test/. Dual-mode modules (`require` + `window.X`) are
  inlined into the web page by remote-server; change them once, every surface follows.
- lib/*_native/: N-API addons (FT8, JS8, FreeDV, RADE). `npm run build-natives`.
  `POTACAT_NO_NATIVE_FT8=1` makes tests use the WASM decoders.
- helpers/: tiny native helpers that are pipes (yaesu-scope). Protocol meaning stays in JS.
- test/: every test file is listed in scripts/run-tests.js, nowhere else. CI runs that list.
- docs/: plans, specs and decisions. docs/echocat-protocol.md is the wire contract with ECHOCAT.
  Read docs/JTCAT.md before touching FT8/FT4/JTTY/PSK/ULTRACAT.
- data/contests.json: the one contest catalog (the server resolves dates from it).
- release-notes/: vX.Y.Z.md + .title per release, written by the release skill.

## Run, test, build
- `npm start` (dev), `npm start -- --headless` (no GUI, ECHOCAT server only; packaged: `POTACAT --headless`).
- `npm test` = `node scripts/run-tests.js`. Add a new test file to that list. Layout and decode-contract
  tests need Electron plus a native build; they skip locally and run in CI (`layout-tests` job).
- `npm run build-natives` before anything that touches lib/*_native. `npm run dist:win` for a local installer.
- Node 22. The Windows main checkout is CRLF; worktrees are LF. Source-text tests must pass on both.

## Rules that have a guard test (read the test when it fails)
- Every QSO is logged one way: `logContact(entry)` + lib/qso-expand.js. No surface builds records.
- Every log write goes through lib/qso-log.js (`mutateLog`), which journals to the cloud.
- Every `remoteServer` listener is attached inside `onRemoteServer(fn)`.
- JTCAT pop-out to shack traffic is a row in lib/remote-bridge.js, never an `isRemoteMode()` branch.
- Settings secrets are declared in lib/settings-secrets.js, never stripped ad hoc.
- Vendor-specific UI (DAX, SmartSDR, RS-BA1, multi-slice) is gated by lib/rig-family.js or rig caps.
- Rig setup instructions come only from lib/rig-setup-notes.js.
- Never send `EX040101` to a Yaesu (it is MY CALL, not scope enable). Never send `atu clear` to a Flex.
- Map tints and badges use POTACAT colours: worked #4fc3f7, confirmed #4ecca3, never yellow.
- The spot-row and decode-row builders are shared modules; never hand-build cells in remote.js.
- Every visible window opens in the theme (`backgroundColor: getThemeWindowBg()`, `loadFile(..., { query: themeQuery() })`,
  a page that loads popout-theme-boot.js first) and remembers its place: a new window calls
  `rememberWindowPlace(win, '<name>Bounds', { minWidth, minHeight })` (test/window-rules-test.js).

## Releases
Only via the potacat-release skill (.claude/skills/potacat-release), only when Casey asks in this
conversation. Version = last tag + 0.0.1, decided by `.claude/skills/potacat-release/next-version.js`.
A release is public and every install auto-updates. CI release.yml builds Windows, macOS (x64 and
arm64) and Linux on a `v*` tag. Never edit the package.json version by hand. Release notes carry no
assistant attribution.

## Worktrees (parallel agents)
- One issue per worktree, branch `<type>/<issue>-<slug>`, from origin/master, LF
  (the workspace's scripts/new-worktree.ps1 does this).
- `npm ci` in the worktree. Never link node_modules from the main checkout.
- Rebase on origin/master before the PR. Small commits. Do not reorder or reformat main.js outside the change.
- After merge: `git worktree remove`, delete the remote branch.

## ECHOCAT and Cloud
The ECHOCAT protocol is ours: a change here means a handoff to the ECHOCAT repo (docs/handoffs/).
The cloud client lives in lib/cloud-*.js and lib/sync-*; server changes arrive as CLOUD_TO_DESKTOP
handoffs. Vendored copies: cloud carries lib/contests-db.js; tell cloud when its grammar changes.

## Style
Dark theme #1a1a2e / #16213e, accent #e94560, links #4fc3f7; POTA green #4ecca3, SOTA orange #f0a500,
cluster purple #e040fb. Concise, functional UI, no chrome. Text an 80-year-old can read.
