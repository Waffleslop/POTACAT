# TQSL / LoTW Integration Plan

**Status: scoped 2026-07-02, saved for later. Nothing built.**

Upload logged QSOs to ARRL Logbook of the World by shelling out to the user's
existing TQSL install. We do NOT bundle TQSL (it's ARRL's, tied to the user's
callsign certificate) — a local install is a prerequisite, like N3FJP/DXKeeper
integrations assume their apps.

## Verified on Casey's machine (2026-07-02)

- TQSL **2.8.6** at `C:\Program Files (x86)\TrustedQSL\tqsl.exe`; config in
  `%APPDATA%\TrustedQSL` (NOT LocalAppData).
- Batch mode **prints to stdout headlessly** (`--version` captured cleanly) —
  we can parse results + exit codes. `--help` is GUI-only; the batch flags are
  the documented 2.x set.
- `uploaded.db` present → **TQSL dedups already-uploaded QSOs itself**;
  re-signing the same QSOs is idempotent/safe. K3SBP cert present (`K3SBP.tq5`).
- **No `station_data` file → Casey has NO Station Location defined yet.**
  Batch signing requires one (`-l <name>`). Creating one is his prerequisite:
  TQSL → Station Location → Add (K3SBP cert, DXCC US, grid FN20jb, state/county,
  zones auto — verify CQ 5 / ITU 8), name it `Home`. `tqsl.exe -s` jumps
  straight to the editor.

## Core mechanism

`execFile` (argv array, no shell) →

```
tqsl -x -d -a compliant -l "<StationLocation>" -u [-p <pwd>] <temp.adi>
```

- `-x` batch/no GUI · `-d` suppress date-range dialog · `-a compliant` sign
  what LoTW understands, skip unknown-mode QSOs instead of aborting ·
  `-l` station location · `-u` sign AND upload · `-p` optional key password.
- Temp `.adi` written from our log via existing `buildAdifRecord`/`ADIF_HEADER`
  helpers, deleted after.
- Map documented exit codes: `0` success · `8` some skipped (dupes/date range)
  but rest uploaded = success · `7` nothing new / all dupes = success
  ("already up to date") · anything else = surfaced error with stdout/stderr.
  Parse the "N QSOs" counts from stdout for the toast.

## Decisions (locked 2026-07-02, per what DXKeeper/Log4OM/ACLog/JTAlert do)

1. **Upload scope — per-QSO sent flag, hybrid.** Standard ADIF fields
   `LOTW_QSL_SENT` (`U` on upload) + `LOTW_QSLSDATE` written back into our own
   ADIF log via `rewriteAdifFile` after a successful upload; each upload
   selects only unsent QSOs. TQSL's `uploaded.db` dedup is the backstop, so a
   corrupted flag can't double-post. Include a "force re-upload all" escape
   hatch. (DXKeeper QSL-queue → U → Y model; Log4OM similar.)
2. **Auto-upload — Phase 2, opt-in, debounced.** Batch everything unsent ~60s
   after the last logged QSO; never one tqsl spawn per contact (POTA pileup =
   15 forks). Manual button ships first. (ACLog/JTAlert auto is the norm, but
   theirs is per-QSO; we debounce.)
3. **Password — optional cert-key password field, blank default.** Most users
   don't password their key. On the password-failure exit code, surface "your
   TQSL key is password-protected — enter it in Settings." LoTW *website*
   login creds are NOT needed for upload (cert is the auth) — only for Phase 3
   confirmation downloads (what ACLog stores them for).

## Phasing

- **Phase 1** — Settings section: TQSL path auto-detect per-OS
  (`Program Files (x86)` Win / `.app` binary macOS / PATH Linux) + manual
  override + "Test" button (`tqsl -v`); Station Location dropdown read from
  `station_data` (with "Set up in TQSL" button → `tqsl -s` → re-read; match
  location callsign to QSOs' STATION_CALLSIGN). Manual **"Upload to LoTW"**
  button (unsent-only; date-range option) with parsed result feedback.
  Unit-test the two pure pieces: **argv builder** and **exit-code→status
  mapper** (new lib module, e.g. `lib/tqsl.js`).
- **Phase 2** — opt-in debounced auto-upload on log; per-activation upload
  (activation ADIF writer already exists).
- **Phase 3 (separate)** — LoTW confirmation DOWNLOAD to feed the DXCC tracker.
  Different auth (LoTW web login, not the cert), different mechanism (LoTW web
  report query, not tqsl). We already parse confirmed ADIF for DXCC.

## ADIF gotchas

- **MODE must be the on-air mode** (FT8/SSB/CW), never a rig data-mode label
  like PKTUSB from the SSB-over-DATA path. Add a small mode-sanitization map;
  `-a compliant` skips non-LoTW modes rather than failing the batch.
- **STATION_CALLSIGN must match the cert/location** or TQSL warns — matters
  for activations under a portable/club call (needs a matching location).
- POTA/SIG fields ride along harmlessly (LoTW ignores unknown fields).

## First step when resumed

Casey creates the `Home` Station Location, then smoke-test the full pipeline
against a scratch ADIF on his machine (`tqsl -x -d -a compliant -l Home -u`)
BEFORE writing feature code.
