#!/usr/bin/env bash
# Build the Winlink sidecars from PINNED source into assets/ for packaging
# (docs/winlink-integration-plan.md):
#   pat      — the Winlink client (Go, MIT, LA5NTA)        → assets/pat/pat[.exe]
#   ardopcf  — the ARDOP modem (C, MIT, Muething/Wiseman/LaRue)
#                                                          → assets/ardopcf/ardopcf[.exe]
#   direwolf — the AX.25 packet soft TNC (C, GPL-2.0, WB2OSZ), built WITH
#              Hamlib so it keys through POTACAT's rigctld shim
#                                                          → assets/direwolf/direwolf[.exe] (+ its Hamlib libs)
# All are separate executables POTACAT runs and talks to over loopback TCP;
# none is linked. Built from source (not upstream release binaries) because
# upstream ships no Windows x64 / macOS arm64 Pat and no macOS ardopcf, and a
# pinned commit is what the NOTICE and third_party/*/VERSION.txt promise.
#
# Usage: scripts/build-winlink-helpers.sh [pat] [ardop] [direwolf]   (default: all;
#        ardop and direwolf are skipped on macOS for now)
# Needs: git, go >= 1.24 for pat; make + gcc (+ libasound2-dev on Linux,
#        MSYS2 MINGW64 on Windows) for ardop; + cmake, Hamlib (libhamlib-dev on
#        Linux; the official zip on Windows) and patchelf (Linux) for direwolf.
set -euo pipefail

PAT_REPO=https://github.com/la5nta/pat
PAT_TAG=v1.0.0
PAT_SHA=2e6a8d14baf0268f4e2aa4d01784a54ca935cf52
ARDOP_REPO=https://github.com/pflarue/ardop
ARDOP_TAG=1.0.4.1.3
ARDOP_SHA=96dec85fc96d7e6d3dd90379fd809ba6cf83b6cc
DIREWOLF_REPO=https://github.com/wb2osz/direwolf
DIREWOLF_TAG=1.8.1
DIREWOLF_SHA=a231971a652bfb574a4bae9a5d875fbce53d2267
# Windows: Dire Wolf links the official Hamlib build (headers + MinGW import
# library) — the same 4.7.0 POTACAT already ships rigctld from. MSYS2 has no
# Hamlib package.
HAMLIB_WIN_ZIP=https://github.com/Hamlib/Hamlib/releases/download/4.7.0/hamlib-w64-4.7.0.zip
HAMLIB_WIN_SHA256=f8854ba06be5eac851113fd849b0737ae77e02ea78da246b469483e18b6483e0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/winlink-helpers"
mkdir -p "$WORK"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE=.exe; HOST=win ;;
  Darwin) EXE=; HOST=mac ;;
  *) EXE=; HOST=linux ;;
esac

want="${*:-pat ardop direwolf}"

checkout() { # repo tag sha dir
  rm -rf "$4"
  git clone --quiet --depth 1 --branch "$2" "$1" "$4"
  local got
  got="$(git -C "$4" rev-parse HEAD)"
  if [ "$got" != "$3" ]; then
    echo "::error::$1 tag $2 is $got, expected $3 — refusing to build an unpinned commit"
    exit 1
  fi
}

if [[ " $want " == *" pat "* ]]; then
  checkout "$PAT_REPO" "$PAT_TAG" "$PAT_SHA" "$WORK/pat"
  mkdir -p "$ROOT/assets/pat"
  # CGO off on Windows/Linux: one static binary, no libax25 (POTACAT's packet
  # goes through Dire Wolf's AGWPE port, not kernel AX.25). macOS needs CGO
  # on: the serial library Pat imports reads termios through cgo there (CI
  # 2026-10-22: "retrieveTermSettings undefined" with CGO off), and Pat's own
  # macOS builds are cgo builds. The web UI is committed at the tag (web/dist).
  CGO=0; [ "$HOST" = mac ] && CGO=1
  ( cd "$WORK/pat" && CGO_ENABLED=$CGO go build -trimpath -ldflags "-s -w" -o "$ROOT/assets/pat/pat$EXE" . )
  test -f "$ROOT/assets/pat/pat$EXE"
  "$ROOT/assets/pat/pat$EXE" version || true
  cp "$WORK/pat/LICENSE" "$ROOT/third_party/pat/LICENSE"
  echo "pat $PAT_TAG ($PAT_SHA) → assets/pat/pat$EXE"
fi

if [[ " $want " == *" ardop "* ]]; then
  if [ "$HOST" = mac ]; then
    echo "ardopcf: no macOS build (no CoreAudio backend) — skipped"
  else
    checkout "$ARDOP_REPO" "$ARDOP_TAG" "$ARDOP_SHA" "$WORK/ardop"
    # POTACAT patch (MIT allows it; recorded in third_party/ardopcf/README.md):
    # ardopcf's Windows device tables hold 16 names, and it copies EVERY
    # waveIn/waveOut name into them — a station with SmartSDR's DAX running
    # has ~40 capture devices, so it wrote past the end and crashed with
    # 0xC0000005 before opening any audio (K3SBP, 2026-10-22). Room for 64,
    # and the comma-joined device string sized for its leading comma.
    W="$WORK/ardop/src/windows/Waveout.c"
    sed -i \
      -e 's/char CaptureNames\[16\]\[MAXPNAMELEN + 2\]/char CaptureNames[64][MAXPNAMELEN + 2]/' \
      -e 's/char PlaybackNames\[16\]\[MAXPNAMELEN + 2\]/char PlaybackNames[64][MAXPNAMELEN + 2]/' \
      -e 's/malloc((MAXPNAMELEN + 2) \* CaptureCount)/malloc((MAXPNAMELEN + 4) * (CaptureCount + 1))/' \
      -e 's/malloc((MAXPNAMELEN + 2) \* PlaybackCount)/malloc((MAXPNAMELEN + 4) * (PlaybackCount + 1))/' \
      "$W"
    grep -q 'CaptureNames\[64\]' "$W" && grep -q 'PlaybackNames\[64\]' "$W" && grep -q '(CaptureCount + 1)' "$W" \
      || { echo "::error::ardopcf device-table patch did not apply"; exit 1; }
    # The loops have no bound of their own: cap the device count at the table size.
    sed -i -e 's/CaptureCount = waveInGetNumDevs();/CaptureCount = waveInGetNumDevs(); if (CaptureCount > 64) CaptureCount = 64;/' \
           -e 's/PlaybackCount = waveOutGetNumDevs();/PlaybackCount = waveOutGetNumDevs(); if (PlaybackCount > 64) PlaybackCount = 64;/' "$W"
    grep -q 'if (CaptureCount > 64)' "$W" || { echo "::error::ardopcf device-count cap did not apply"; exit 1; }
    mkdir -p "$ROOT/assets/ardopcf"
    # C17: GCC 15 (current MSYS2) defaults to C23, where ardopcf's old-style
    # "f()" declarations mean "no arguments" and ws_server.c fails to build;
    # its own releases use GCC 14. Static on Windows so no MinGW runtime DLL
    # has to ship beside it.
    if [ "$HOST" = win ]; then
      ( cd "$WORK/ardop" && make ardopcf CFLAGS="-g -MMD -std=gnu17" LDFLAGS="-Xlinker -Map=output.map -static" )
    else
      ( cd "$WORK/ardop" && make ardopcf CFLAGS="-g -MMD -std=gnu17" )
    fi
    cp "$WORK/ardop/ardopcf$EXE" "$ROOT/assets/ardopcf/ardopcf$EXE"
    test -f "$ROOT/assets/ardopcf/ardopcf$EXE"
    cp "$WORK/ardop/LICENSE" "$ROOT/third_party/ardopcf/LICENSE"
    echo "ardopcf $ARDOP_TAG ($ARDOP_SHA) → assets/ardopcf/ardopcf$EXE"
  fi
fi

if [[ " $want " == *" direwolf "* ]]; then
  if [ "$HOST" = mac ]; then
    echo "direwolf: not built on macOS yet — skipped"
  else
    checkout "$DIREWOLF_REPO" "$DIREWOLF_TAG" "$DIREWOLF_SHA" "$WORK/direwolf"
    OUT="$ROOT/assets/direwolf"
    rm -rf "$OUT/"*.dll "$OUT/"*.so* "$OUT/direwolf" "$OUT/direwolf.exe" 2>/dev/null || true
    mkdir -p "$OUT" "$WORK/direwolf/build"
    if [ "$HOST" = win ]; then
      curl -sSL -o "$WORK/hamlib.zip" "$HAMLIB_WIN_ZIP"
      echo "$HAMLIB_WIN_SHA256  $WORK/hamlib.zip" | sha256sum -c -
      rm -rf "$WORK/hamlib" && mkdir -p "$WORK/hamlib" && unzip -q "$WORK/hamlib.zip" -d "$WORK/hamlib"
      HL="$WORK/hamlib/hamlib-w64-4.7.0"
      # gnu17 for the same GCC 15 / C23 reason as ardopcf.
      ( cd "$WORK/direwolf/build" && CFLAGS="-std=gnu17" cmake -G "MSYS Makefiles" -DCMAKE_BUILD_TYPE=Release \
          -DHAMLIB_INCLUDE_DIR="$HL/include" -DHAMLIB_LIBRARY="$HL/lib/gcc/libhamlib.dll.a" .. && make -j4 direwolf )
      cp "$WORK/direwolf/build/src/direwolf.exe" "$OUT/"
      # Its runtime: Hamlib and what Hamlib needs, from the same zip.
      cp "$HL/bin/"*.dll "$OUT/"
      # And any MinGW runtime the build pulled in.
      for dll in $(ldd "$OUT/direwolf.exe" | awk '/mingw64/ {print $3}'); do cp "$dll" "$OUT/"; done
    else
      ( cd "$WORK/direwolf/build" && cmake -DCMAKE_BUILD_TYPE=Release .. && make -j4 direwolf )
      cp "$WORK/direwolf/build/src/direwolf" "$OUT/"
      # Ship the Hamlib it linked (and libusb) beside it; RPATH $ORIGIN.
      for lib in $(ldd "$OUT/direwolf" | awk '/libhamlib|libusb/ {print $3}'); do cp "$lib" "$OUT/"; done
      patchelf --set-rpath '$ORIGIN' "$OUT/direwolf"
      for lib in "$OUT/"*.so*; do [ -f "$lib" ] && patchelf --set-rpath '$ORIGIN' "$lib" 2>/dev/null || true; done
    fi
    test -f "$OUT/direwolf$EXE"
    # Must be LINKED to Hamlib, or it cannot key through POTACAT. (A build
    # without it still contains the "rebuild with hamlib" error text, so
    # grepping the binary's strings proves nothing.)
    ldd "$OUT/direwolf$EXE" | grep -qi 'libhamlib' || { echo "::error::direwolf was built without Hamlib"; exit 1; }
    cp "$WORK/direwolf/LICENSE" "$ROOT/third_party/direwolf/LICENSE"
    echo "direwolf $DIREWOLF_TAG ($DIREWOLF_SHA) → assets/direwolf/direwolf$EXE"
  fi
fi
