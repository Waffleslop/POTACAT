# third_party/mercury/

This directory holds the **Mercury HF data modem** binary that POTACAT launches
as a separate child process. It is currently a **scaffold** — the binary is not
yet bundled (Phase 1 ships the launcher/supervisor; the binary is dropped in
when a per-platform build exists).

## What Mercury is

[Mercury](https://github.com/Rhizomatica/mercury) — Rhizomatica / HERMES project.
An HF OFDM **data** modem (FreeDV/codec2 DATAC modes) with a VARA-compatible ARQ
TCP TNC. POTACAT talks to it only over that TCP interface (control port 8300,
data 8301) — it is **never linked into POTACAT**.

## License / distribution posture — READ BEFORE BUNDLING

Mercury is **GPL-3.0-or-later**. POTACAT is Apache-2.0 and ECHOCAT is proprietary.
Mercury is distributed here as an **independent separate program ("mere
aggregation")**, exactly like the bundled `wsprd` — invoked over a socket, never
linked. This keeps the GPL off POTACAT's Apache binary and never reaches ECHOCAT.

When a binary is added, this directory MUST contain, per the GPL:

- `mercury` / `mercury.exe` — the executable (per platform / in the platform build).
- `LICENSE` — the full GPL-3.0 text.
- Corresponding **source** for the exact built version: a pinned commit hash +
  `git` URL, or a source tarball. Record the pinned commit below.
- A matching entry in the repo-root `NOTICE` (mirror the `wsprd` entry: "independent,
  separate program … mere aggregation").
- An `electron-builder` `build.files` / `extraResources` entry so it packages into
  `resources/third_party/mercury/` (learn from the `data/` packaging miss — a
  missing `build.files` glob silently breaks the packaged app).

## Pinned upstream

- Repo: https://github.com/Rhizomatica/mercury
- Default branch: `mercuryv2`
- Pinned commit: _TBD when the binary is built_

## How POTACAT finds it

`lib/mercury-process.js` → `mercuryPathCandidates()` probes, in order:
`settings.mercuryPath` override → this bundled dir → common install dirs → PATH.
So a user can always point at their own build via the Mercury path setting.
