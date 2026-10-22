# assets/ardopcf — bundled ARDOP modem (populated at build time)

Staging area for ardopcf, mirroring `assets/wsprd/`. The release workflow runs
`scripts/build-winlink-helpers.sh` on Windows and Linux (no macOS build
exists) to build the pinned tag (see `third_party/ardopcf/VERSION.txt`) into
`ardopcf` / `ardopcf.exe` here; `package.json` → `build.extraResources`
copies it to `resources/bin/`. The binary is not committed (`.gitignore`).
