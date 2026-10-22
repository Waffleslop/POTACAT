# Pat (Winlink client) — bundled as a separate executable

[Pat](https://github.com/la5nta/pat) by Martin Hebnes Pedersen (LA5NTA) is
the open-source Winlink client. POTACAT runs it as a **separate process**
(`pat http`, bound to 127.0.0.1) and drives it only over its local HTTP API
and websocket — it is never linked into POTACAT.

- License: MIT (`LICENSE`, copied from the pinned tag)
- Pinned: see `VERSION.txt`
- Built by `scripts/build-winlink-helpers.sh` in every release job
  (`CGO_ENABLED=0 go build`, Go >= 1.24), staged to `assets/pat/`, packaged
  to `resources/bin/pat[.exe]` by `package.json` → `build.extraResources`.
- In dev, `lib/winlink-pat.js` → `patPathCandidates()` looks in
  `assets/pat/`; run `scripts/build-winlink-helpers.sh pat` once (needs Go),
  or point Settings > Station > Winlink > Advanced at an installed Pat.

To move to a new Pat release: update `PAT_TAG`/`PAT_SHA` in the build script
and `VERSION.txt`, re-run `node test/winlink-pat-test.js`, and re-check the
API shapes in `lib/winlink-pat.js` against that release's `api/` and
`app/` sources.
