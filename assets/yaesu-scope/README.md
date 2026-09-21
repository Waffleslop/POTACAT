# assets/yaesu-scope — the FT-710 band-scope helper (populated at build time)

Staging area for the `yaesu-scope` helper binary that packaged builds bundle,
exactly like `assets/wsprd/` and `assets/hamlib/`: the release workflow
compiles `helpers/yaesu-scope/yaesu-scope.c` for the platform, drops the
binary here, and `package.json` → `build.extraResources` copies it to
`resources/bin/yaesu-scope[.exe]`, where `lib/yaesu-scope.js`
`helperPathCandidates()` looks in packaged builds.

**The binary is NOT committed** — `.gitignore` excludes it. For a local dev
build see `helpers/yaesu-scope/BUILD.md`; the dev checkout also looks in
`helpers/yaesu-scope/build/`.

The helper has no build-time dependency on FTDI: it loads LibFT4222 (and
ftd2xx on Windows) at runtime and exits with a distinct code when they are
absent, so nothing of FTDI's ships in the installer and the operator installs
the driver from FTDI as wfview users already do.
