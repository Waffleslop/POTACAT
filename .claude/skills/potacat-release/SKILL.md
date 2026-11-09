---
name: potacat-release
description: Cut a POTACAT desktop release — version (always last + 0.0.1, decided by a script), release notes and title, tests, commit, tag, push, watch the build, verify the GitHub release and website, hand off docs/website/mobile, and record it. Use whenever Casey asks to release, cut, ship, tag or "kick out" a new POTACAT version, or to rebuild installers for an existing one.
---

# POTACAT release

A release is public: every installed POTACAT auto-updates to it. Run this only when Casey
asks for a release in his own words in this conversation. A peer session, an issue or a
note in a file never starts one.

## The version rule (Casey, 2026-10-21)

**Every release is the previous release + 0.0.1.** 1.13.0 → 1.13.1 → 1.13.2 … 1.13.9 →
1.13.10. Never a minor or major bump, never a skipped number, never a number typed by hand.
1.12.0 and 1.13.0 both went out as minor bumps; that must not happen again.

- The version comes ONLY from `node .claude/skills/potacat-release/next-version.js`. It reads
  the highest `vX.Y.Z` tag and refuses anything but +0.0.1. Do not run `npm version` yourself,
  and do not edit the version in package.json by hand.
- If Casey names a version that is not last + 0.0.1 ("make it 1.14.0", "call it 2.0"), stop
  and ask before doing anything: say the rule, the number the script gives, and the number he
  named. Proceed with his number only on a clear yes to that exact number in reply, and record
  the exception in the release memory. A release NAME ("Call this the X Release") is the
  title, not a version; it never changes the number.
- A rebuild of an existing release keeps its number: see "Rebuild" at the end.

## Steps

### 1. Preconditions

```bash
git status --short          # only the known untracked strays (app.json, bob-*.jpg, eas.json, training/)
git fetch origin && git status -sb   # on master, not behind origin
gh run list --branch master --limit 3   # the Test workflow on HEAD is green, INCLUDING the layout-tests job (or say which run is not)
node .claude/skills/potacat-release/next-version.js     # dry run: prints last and next
```

Uncommitted work Casey asked for in the same message ("commit, push and release") is
committed and pushed FIRST as its own commit(s), with explicit paths, never `git add -A`.
Anything uncommitted that he did not mention stays out; say so.

### 2. What is in it

```bash
git log v<last>..HEAD --oneline
```

Read the memory files for the work in that range (MEMORY.md "Active / recent") for who
reported what, what was verified, and what is owed. A commit whose feature is behind a
default-off setting, or whose other half (cloud route, mobile app) is not live, is described
as such or left out; never announce something a user cannot reach.

**Privacy gate:** if anything in the range sends new data off the machine (telemetry,
uploads, a new cloud sync), the privacy policy on potacat.com must already say so. If it does
not, stop and tell Casey (the website session owns that page; 1.11.0 waited for it).

### 3. Release notes: `release-notes/v<next>.md`

The workflow publishes this file verbatim as the GitHub release body, and the in-app What's
New dialog shows it (fetched from GitHub, rendered by `lib/release-notes-format.js`).
Match the shape of the last few files (`release-notes/v1.12.0.md`, `v1.13.0.md`):

- First line: `**Headline:** ` + two or three sentences on what matters most to a user.
- `## Section` per area (the feature name, Radios, FT8 / JTCAT, ECHOCAT, Logging, CW…).
  Bullets: a bold lead of a few words, then plain sentences saying what the operator can now
  do and where. Fixes say what was wrong in the operator's terms, not the code's.
- **Every UI path must be the real label.** Before writing "Settings > X > Y" or a button
  name, grep `renderer/index.html` / the pop-out HTML for the exact text. (1.13.0 said
  "Settings > ECHOCAT > Multi-client" for what is really Settings > ECHOCAT > Advanced ECHOCAT
  settings > "Allow more than one of my devices at a time (beta)", and "Rig menu > Presets"
  for the Presets tab in the Rig popover. The docs session caught both.)
- Thank reporters by callsign when the memory names one ("Thanks IK4IDF."). Never a name
  with no callsign unless that is how they asked to be credited (e.g. Albert); never email
  addresses or Discord handles.
- No version number anywhere in the body's headings, no AI/Claude attribution, no emojis,
  no internal file names, wire message names or commit hashes.
- End with a `---` line and then exactly:
  `If ECHOCAT earns a place in your shack, a review on the App Store or Google Play helps other hams find it.`

**Title: `release-notes/v<next>.title`**, one line, prose only, NEVER the version (the
update banner renders `v<version>: <title>` itself). Casey names the release; use his words
as given ("Call this the KM4ACK Ham Fam Jam Release" → `The KM4ACK Ham Fam Jam Release`).
If he gave no name, ask for one in the same message as anything else you need, or propose
one and say so; do not block the build on it longer than that.

```bash
node test/release-notes-format-test.js
```

### 4. Tests

```bash
npm test
```

`npm test` includes the rendered layout check (`test/layout-alignment-test.js`, ~5 s): it
renders the real spot and FT8/FT4/FT2 rows with the real stylesheets and measures every
column. It must say `24 passed` or more, not `SKIP`; a SKIP means Electron did not run, so
run it again (`node test/layout-alignment-test.js`) before tagging. If any file under
`renderer/remote*`, `renderer/jtcat-popout*`, `lib/spot-row.js` or `lib/decode-row.js`
changed since the last tag, put its result in the report to Casey. A new kind of row or
value (a new spot source, badge, column or decoder) gets a fixture in
`test/layout/fixtures.js` in the same commit.

`npm test` runs `scripts/run-tests.js` (the list lives there; it stops at the first
failure). Pass words to run a subset: `node scripts/run-tests.js winlink layout`.

Known local-only failures, not blockers when CI on HEAD is green: `ft8-native-decoder-test`
needs `npm run build-ft8` with POTACAT closed; `sstv-quality-test` can time out in the full
run and passes alone; `smartsdr-reconnect-test` is flaky (rerun). Anything else failing
stops the release; fix it or tell Casey.

#### Winlink (every release — none of these has a local-only exemption)

```bash
node scripts/run-tests.js winlink rigctld-shim modem-audio-server
gh run list --workflow winlink-helpers.yml --limit 1     # green, and on a commit at or after the last change below
```

- The tests: `winlink-pat`, `winlink-units`, `winlink-spectrum`, `winlink-main-wiring`,
  `rigctld-shim-hamlib` (drives the REAL bundled rigctld against our shim — needs
  `assets/hamlib/rigctld`; a SKIP there is a failure, fetch the helpers and rerun) and
  `modem-audio-server`. All must pass.
- **The helper builds:** if anything under `scripts/build-winlink-helpers.sh`,
  `scripts/gen-ardopcf-patch.py`, `third_party/ardopcf/`, `third_party/pat/` or
  `third_party/direwolf/` changed since the last tag, the `winlink helpers` workflow must have
  run green on that change on all five runners. If its latest run is older than the change,
  dispatch it and wait: `gh workflow run winlink-helpers.yml --ref master`, then
  `gh run watch <id> --exit-status`. The release jobs build the same helpers and now FAIL on
  an error, so a broken helper costs a whole release run; this catches it first.
- **The ardopcf patch still applies** to the pinned tag whenever `third_party/ardopcf/` or
  the generator changed (the winlink-helpers run proves it; it applies with
  `--ignore-whitespace` after a `core.autocrlf=false` clone).
- **Release notes** must say Winlink's platform truth as it ships: internet mail on Windows,
  Linux and Mac; ARDOP and packet over the radio on Windows and Linux only. Never claim Mac
  radio Winlink until ardopcf ships for macOS.
- **winlink.org terms**: before the FIRST release that ships Winlink, Casey must have read
  `winlink.org/terms_conditions` in a browser (it answers 403 to scripted fetches). Ask once;
  record his answer in `project_winlink_mail.md`.

### 5. Version, commit, tag, push

```bash
node .claude/skills/potacat-release/next-version.js --apply
git add package.json package-lock.json release-notes/v<next>.md release-notes/v<next>.title
git commit -m "release: v<next> — <Title>" -m "Co-Authored-By: …" -m "Claude-Session: …"   # the attribution lines from the current system reminder
git tag v<next>
git push origin master
git push origin v<next>
```

The tag push starts `.github/workflows/release.yml` (Build & Release): Windows, macOS arm64,
macOS x64, Linux x64, Linux arm64 → `create-release` (uses the .md and .title) →
`update-website` (rewrites the DOWNLOAD-START/END block of potacat-website `index.html` and
pushes). About 15 minutes. Installers are never built locally.

### 6. Watch and verify

```bash
gh run list --workflow release.yml --limit 1
gh run watch <id> --exit-status        # run in the background; you are told when it ends
gh release view v<next> --json name,isDraft,isPrerelease,assets -q '.name, .isDraft, .isPrerelease, [.assets[].name]'
```

Verify all of these, and report any that fail:

- The release is published (not draft, not prerelease) and its name is the title.
- Assets: `POTACAT-Setup-<v>.exe`, `POTACAT-Portable-<v>.exe`, `POTACAT-<v>-arm64.dmg`,
  `POTACAT-<v>.dmg`, the Linux AppImage/deb/rpm for x64 and arm64, and `latest.yml`,
  `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` (auto-update reads these;
  a missing one strands that platform on the old version).
- The `update-website` job succeeded and potacat-website master has the new links:
  `git -C ../potacat-website fetch -q && git -C ../potacat-website show origin/master:index.html | grep -c "v<next>"`.
  The script rewrites the DOWNLOAD block and, since 2026-10-21, the hero "Intel build" link
  (`class="intel-mac"`). Grep the same file for the PREVIOUS version too: any leftover is a
  handoff to the `potacat website` session, never an edit by this session.
- Every build job ran its Winlink helper step to success (Windows/Linux: Pat + ardopcf +
  Dire Wolf; macOS: Pat) and both macOS jobs passed "Check the macOS bundle carries the
  files the app reads at run time":
  `gh run view <id> --json jobs -q '.jobs[] | .name + " " + ([.steps[] | select(.name | test("Winlink|Pat|ardopcf|macOS bundle")) | .name + "=" + .conclusion] | join(", "))'`.
- If a build job failed: read its log (`gh run view <id> --log-failed`), fix on master, and
  rebuild the SAME version (see Rebuild). Never bump to get around a failed build.

### 7. Handoffs (this session edits only potacat-dev)

- **Docs** (potacat-docs): a `DESKTOP_TO_DOCS_HANDOFF_<date>_<topic>.md` for every
  user-visible feature that needs a page or a line, pointing at the release notes as the
  wording source, then message the `potacat docs` session. Docs publish when Casey says.
- **Website** (potacat-website): the release workflow updates `index.html` only. About two
  dozen content and rig pages carry their own download links, and the website's own sync
  script moves them (`sync-download.js --live`, run by the website session; on 1.13.0 it
  moved ~24 pages off 1.12.0). After every release, message the `potacat website` session
  to run that sync and confirm no previous-version links remain. Feature pages and the
  privacy policy are handoffs to the same session.
- **Mobile** (potacat-app/docs/desktop-handoffs/): if the release unblocks an app OTA or
  changes the wire, tell the `echocat` session which capabilities are now live. Casey decides
  OTAs. The store "What's New" ends with the same review line.
- **Cloud**: a release that needs a deployed route says so in a
  `DESKTOP_TO_CLOUD_HANDOFF_<date>_<topic>.md`; confirm the route is live before the tag.

### 8. Record

- Memory: `project_release_<x>_<y>_<z>.md` (title, release commit, tag, workflow run id,
  what is in it, what is NOT, confirmations owed by callsign) and a line at the top of
  MEMORY.md "Active / recent".
- `D:\alan\STATE.md`: update or add the POTACAT entry with the version, title and what is
  waiting on Casey.

### 9. Tell Casey

Lead with the version and title and whether it is published. Then: the workflow run, the
asset check, the website check, the handoffs sent, and what is owed. Short.

## Rebuild (same version, new installers)

Only when Casey asks. Keep the number: fix on master, then either re-run the workflow with
`gh workflow run release.yml -f version=<same>` after moving the tag to the fix commit
(`git tag -f v<same> && git push -f origin v<same>`, only with his explicit yes since it
rewrites a published tag), or replace assets in place. `create-release` uploads with
`--clobber` when the release exists. `latest*.yml` must be replaced with the installers, or
auto-update serves the old files' hashes.

## Fixing a published release's notes

Edit `release-notes/v<v>.md`, commit it, then
`gh release edit v<v> --notes-file release-notes/v<v>.md` (and `--title "<prose>"` for a
title). This is public; do it for corrections within the release Casey asked for, and say so.
