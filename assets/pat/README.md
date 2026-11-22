# assets/pat — bundled Pat binary (populated at build time)

Staging area for the Pat Winlink client, mirroring `assets/wsprd/`. The
release workflow runs `scripts/build-winlink-helpers.sh`, which builds the
pinned tag (see `third_party/pat/VERSION.txt`) with POTACAT's one source
patch (`third_party/pat/README.md`) into `pat` / `pat.exe` here;
`package.json` → `build.extraResources` copies it to `resources/bin/`.
The binary is not committed (`.gitignore`).
