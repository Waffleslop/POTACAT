# ardopcf (ARDOP modem) — bundled as a separate executable

[ardopcf](https://github.com/pflarue/ardop) by Rick Muething, John Wiseman
and Peter LaRue is the open ARDOP modem Winlink gateways accept. POTACAT
launches it only for a Winlink ARDOP session and talks to it through Pat over
its loopback host port — never linked.

- License: MIT (`LICENSE`, copied from the pinned tag)
- Pinned: see `VERSION.txt`. Upstream has stopped development; this is a
  fixed, known-good version.
- Windows and Linux only: ardopcf has no macOS (CoreAudio) backend.
- Built by `scripts/build-winlink-helpers.sh` (make; MSYS2 MINGW64 on
  Windows, statically linked), staged to `assets/ardopcf/`, packaged to
  `resources/bin/ardopcf[.exe]`.
- **POTACAT never gives it a PTT or CAT flag** (`-p/-c/-g/-k/-u`): it only
  reports PTT to its host, Pat keys through POTACAT's rigctld shim, and
  POTACAT keys the radio. `lib/ardop-process.js` refuses those flags.
