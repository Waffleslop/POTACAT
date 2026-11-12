# Pat (Winlink client) — bundled as a separate executable

[Pat](https://github.com/la5nta/pat) by Martin Hebnes Pedersen (LA5NTA) is
the open-source Winlink client. POTACAT runs it as a **separate process**
(`pat http`, bound to 127.0.0.1) and drives it only over its local HTTP API
and websocket — it is never linked into POTACAT.

- License: MIT (`LICENSE`, copied from the pinned tag)
- Pinned: see `VERSION.txt`
- Built by `scripts/build-winlink-helpers.sh` in every release job, with
  one POTACAT source patch (next section)
  (`CGO_ENABLED=0 go build`, `CGO_ENABLED=1` on macOS, Go >= 1.24), staged to `assets/pat/`, packaged
  to `resources/bin/pat[.exe]` by `package.json` → `build.extraResources`.
- In dev, `lib/winlink-pat.js` → `patPathCandidates()` looks in
  `assets/pat/`; run `scripts/build-winlink-helpers.sh pat` once (needs Go),
  or point Settings > Station > Winlink > Advanced at an installed Pat.

## Patched in our build: the ARDOP link timeout (`potacat-arq-timeout.patch`)

The Pat that POTACAT ships is the pinned tag **plus one source patch**,
applied by `scripts/build-winlink-helpers.sh` before `go build`. It is not
upstream's binary, and problems with the patched part belong to POTACAT, not
to Pat's authors.

- **Why.** Pat sets the ARDOP modem's ARQ link timeout to 90 seconds every
  time it opens the modem, and Pat v1.0.0 has no setting for it. The value is
  in Pat's dependency wl2k-go v1.0.1 (the version Pat's `go.mod` pins):
  `transport/ardop/ardop.go` line 18, `DefaultARQTimeout = 90 * time.Second`,
  sent by `transport/ardop/tnc.go` line 145,
  `tnc.SetARQTimeout(DefaultARQTimeout)`, in `init()`. ardopcf's own default
  is 120 and its host command takes 30 to 240. On a path that fades, a link
  with nothing getting through for 90 seconds is ended by the modem
  (POTACAT issue #425).
- **What it changes.** Two files of Pat's own source, nothing else:
  - `app/connect.go`: one call added in `initARDOP()`, straight after the
    modem has been opened.
  - `app/potacat_arq_timeout.go` (new, marked as a POTACAT modification):
    reads the environment variable `POTACAT_ARDOP_ARQ_TIMEOUT`. A whole
    number of seconds from 30 to 240 is sent to the modem as a second
    `ARQTIMEOUT` command (wl2k-go's public `SetARQTimeout`), after the 90
    that opening the modem has already sent; the last one is the one in
    force. Anything else (below 30, above 240, not a whole number) is
    ignored with a line in Pat's log, and the modem stays at 90.
  - **Unset or empty, Pat sends exactly what upstream sends**: one
    `ARQTIMEOUT 90`.
- **What it does not change.** wl2k-go is not modified, vendored or
  replaced: it is the module `go.sum` pins, and the build stops if Pat's pin
  is no longer v1.0.1, if `go mod verify` fails, or if that module no longer
  has the 90 second default and `SetARQTimeout` the patch relies on. Pat's
  name and version string are unchanged, as its `internal/buildinfo` asks of
  builds that keep the name.
- **A patch that does not apply fails the build**, and so does a built
  binary without the variable's name in it.
- **How POTACAT uses it.** `lib/winlink-pat.js` (`ARDOP_ARQ_TIMEOUT`,
  `patSpawnEnv`): Settings > Station > Winlink > "ARDOP link timeout", 90 to
  180 seconds, 120 unless the operator changes it, put in Pat's environment
  when POTACAT starts Pat. Setting it to 90 gives upstream's behaviour.
- **Proof.** `test/modem-loopback/pat-arq-timeout.js`, run by the "winlink
  helpers" workflow on all five build targets: the built Pat against the
  built ardopcf with a recording relay between them and no radio. It checks
  what Pat sent, what the modem answered and what the modem's log shows, for
  the variable unset, valid, at both ends of the range, and invalid.
- **Licence.** Pat is MIT (`LICENSE`, Copyright (c) 2020 Martin Hebnes
  Pedersen LA5NTA); wl2k-go is MIT (Copyright (c) 2014-2017 the same
  author) and is used unmodified. MIT allows modified copies provided the
  copyright and permission notice stay with them: `LICENSE` here is Pat's,
  copied from the pinned tag at build time, and the root `NOTICE` names Pat
  and this modification. The patch is offered under the same MIT terms.
- **To make the patch again** after moving the pin: check out the new tag,
  make the same two edits, and write `git diff` (with the new file added by
  `git add -N`) to `potacat-arq-timeout.patch` with LF line endings.

To move to a new Pat release: update `PAT_TAG`/`PAT_SHA` (and
`WL2K_GO_VERSION`, after re-reading the two wl2k-go lines named above) in the
build script and `VERSION.txt`, remake the patch if it no longer applies, re-run `node test/winlink-pat-test.js`, and re-check the
API shapes in `lib/winlink-pat.js` against that release's `api/` and
`app/` sources.
