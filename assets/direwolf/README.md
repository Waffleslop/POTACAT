# assets/direwolf — bundled Dire Wolf (populated at build time)

Staging area for Dire Wolf and its Hamlib runtime libraries. The release
workflow runs `scripts/build-winlink-helpers.sh direwolf` on Windows and Linux;
`package.json` → `build.extraResources` copies this folder to
`resources/direwolf/`. Binaries and libraries are not committed (`.gitignore`).
