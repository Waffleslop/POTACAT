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
# Usage: scripts/build-winlink-helpers.sh [pat] [ardop] [direwolf]   (default: all)
# Needs: git, go >= 1.24 for pat; make + gcc/clang (+ libasound2-dev on Linux,
#        MSYS2 MINGW64 on Windows, nothing extra on macOS — the ALSA calls are
#        compiled against helpers/alsa-stub) for ardop; + cmake, Hamlib
#        (libhamlib-dev on Linux; the official zip on Windows; `brew install
#        hamlib portaudio hidapi` on macOS) and patchelf (Linux) for direwolf.
#
# Both modems carry POTACAT's socket audio backend (device "tcp:<port>", see
# docs/modem-audio-bridge-plan.md): they never open a sound card, which is
# what makes the macOS builds possible at all.
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
  # LF checkouts on every OS: the Windows runner defaults to autocrlf=true, which turned
  # the sources CRLF and made the LF patch "not apply" (CI 2026-10-22).
  git -c core.autocrlf=false clone --quiet --depth 1 --branch "$2" "$1" "$4"
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
  {
    checkout "$ARDOP_REPO" "$ARDOP_TAG" "$ARDOP_SHA" "$WORK/ardop"
    # POTACAT patch (MIT allows it; recorded in third_party/ardopcf/README.md):
    # ardopcf's Windows device tables hold 16 names, and it copies EVERY
    # waveIn/waveOut name into them — a station with SmartSDR's DAX running
    # has ~40 capture devices, so it wrote past the end and crashed with
    # 0xC0000005 before opening any audio (K3SBP, 2026-10-22). Room for 64,
    # and the comma-joined device string sized for its leading comma.
    # (`sed -i.bak`: the one in-place spelling GNU and BSD sed share — a bare
    # `-i -e` made BSD sed take "-e" as the backup suffix on the first macOS build.)
    W="$WORK/ardop/src/windows/Waveout.c"
    sed -i.bak \
      -e 's/char CaptureNames\[16\]\[MAXPNAMELEN + 2\]/char CaptureNames[64][MAXPNAMELEN + 2]/' \
      -e 's/char PlaybackNames\[16\]\[MAXPNAMELEN + 2\]/char PlaybackNames[64][MAXPNAMELEN + 2]/' \
      -e 's/malloc((MAXPNAMELEN + 2) \* CaptureCount)/malloc((MAXPNAMELEN + 4) * (CaptureCount + 1))/' \
      -e 's/malloc((MAXPNAMELEN + 2) \* PlaybackCount)/malloc((MAXPNAMELEN + 4) * (PlaybackCount + 1))/' \
      "$W" && rm -f "$W.bak"
    grep -q 'CaptureNames\[64\]' "$W" && grep -q 'PlaybackNames\[64\]' "$W" && grep -q '(CaptureCount + 1)' "$W" \
      || { echo "::error::ardopcf device-table patch did not apply"; exit 1; }
    # POTACAT socket audio backend (third_party/ardopcf/src/SocketAudio.*,
    # hooked in by potacat-socket-audio.patch — regenerate with
    # scripts/gen-ardopcf-patch.py when the pin moves): device "tcp:<port>"
    # makes ardopcf take its receive audio from, and send its transmit audio
    # to, a loopback port POTACAT serves — no sound card, no DAX program.
    cp "$ROOT/third_party/ardopcf/src/SocketAudio.c" "$ROOT/third_party/ardopcf/src/SocketAudio.h" "$WORK/ardop/src/common/"
    git -C "$WORK/ardop" apply --ignore-whitespace "$ROOT/third_party/ardopcf/potacat-socket-audio.patch" || { echo "::error::potacat-socket-audio.patch did not apply to ardopcf $ARDOP_TAG"; exit 1; }
    grep -q 'sa_active' "$WORK/ardop/src/windows/Waveout.c" || { echo "::error::socket audio hook missing"; exit 1; }
    # The loops have no bound of their own: cap the device count at the table size.
    sed -i.bak -e 's/CaptureCount = waveInGetNumDevs();/CaptureCount = waveInGetNumDevs(); if (CaptureCount > 64) CaptureCount = 64;/' \
           -e 's/PlaybackCount = waveOutGetNumDevs();/PlaybackCount = waveOutGetNumDevs(); if (PlaybackCount > 64) PlaybackCount = 64;/' "$W" && rm -f "$W.bak"
    grep -q 'if (CaptureCount > 64)' "$W" || { echo "::error::ardopcf device-count cap did not apply"; exit 1; }
    mkdir -p "$ROOT/assets/ardopcf"
    # C17: GCC 15 (current MSYS2) defaults to C23, where ardopcf's old-style
    # "f()" declarations mean "no arguments" and ws_server.c fails to build;
    # its own releases use GCC 14. Static on Windows so no MinGW runtime DLL
    # has to ship beside it.
    if [ "$HOST" = win ]; then
      ( cd "$WORK/ardop" && make ardopcf CFLAGS="-g -MMD -std=gnu17" LDFLAGS="-Xlinker -Map=output.map -static" )
    elif [ "$HOST" = mac ]; then
      # macOS: ardopcf has no CoreAudio backend and needs none — POTACAT runs
      # it on the socket device only. Its Linux sources are POSIX apart from
      # <alsa/asoundlib.h>, so they compile against helpers/alsa-stub (every
      # snd_* call an inline no-op that fails cleanly; never reached on tcp:),
      # without -lrt -lasound, and without the GNU-ld -Map flag ld64 rejects.
      # -Wno-int-conversion: lib/rawhid/rawhid.c's non-Windows CM108 PTT path
      # hands a hid_device* to int parameters (a warning under GCC, an error
      # under Apple clang 16); POTACAT never gives ardopcf a PTT flag, so that
      # code is never reached.
      # zf_log statically asserts ZF_LOG_BUF_SZ (ardopcf's log.h: 4000) <= PIPE_BUF,
      # which is 4096 on Linux and 512 on macOS. The assert guards write()
      # atomicity to a PIPE; ardopcf logs to files and stderr, so on macOS the
      # line becomes a comment (first Mac build, run 39905899155).
      Z="$WORK/ardop/lib/zf_log/zf_log/zf_log.c"
      sed -i.bak 's|STATIC_ASSERT(buf_sz_less_than_pipe_buf, ZF_LOG_BUF_SZ <= PIPE_BUF);|/* POTACAT macOS: pipe-atomicity assert dropped (PIPE_BUF is 512 here; ardopcf logs to files) */|' "$Z" && rm -f "$Z.bak"
      grep -q 'POTACAT macOS: pipe-atomicity' "$Z" || { echo "::error::zf_log PIPE_BUF assert patch did not apply"; exit 1; }
      ( cd "$WORK/ardop" && make ardopcf CC=cc CFLAGS="-g -MMD -std=gnu17 -Wno-int-conversion -I$ROOT/helpers/alsa-stub" LDFLAGS="" LDLIBS="-lm -lpthread" )
    else
      ( cd "$WORK/ardop" && make ardopcf CFLAGS="-g -MMD -std=gnu17" )
    fi
    cp "$WORK/ardop/ardopcf$EXE" "$ROOT/assets/ardopcf/ardopcf$EXE"
    test -f "$ROOT/assets/ardopcf/ardopcf$EXE"
    if [ "$HOST" = mac ]; then
      # Nothing to bundle (system libraries only); this asserts the architecture.
      node "$ROOT/scripts/bundle-mac-deps.js" --expect-arch="$(uname -m)" "$ROOT/assets/ardopcf/ardopcf"
    fi
    cp "$WORK/ardop/LICENSE" "$ROOT/third_party/ardopcf/LICENSE"
    echo "ardopcf $ARDOP_TAG ($ARDOP_SHA) → assets/ardopcf/ardopcf$EXE"
  }
fi

if [[ " $want " == *" direwolf "* ]]; then
  {
    checkout "$DIREWOLF_REPO" "$DIREWOLF_TAG" "$DIREWOLF_SHA" "$WORK/direwolf"
    # POTACAT socket audio backend (third_party/direwolf/src/audio_tcp.*,
    # hooked into audio.c / audio_win.c / audio_portaudio.c + audio.h + the
    # CMake source list by potacat-socket-audio.patch — regenerate with
    # scripts/gen-direwolf-patch.py when the pin moves): `ADEVICE tcp:<port>`
    # makes Dire Wolf take its audio from, and send it to, POTACAT's loopback
    # modem audio server instead of a sound card. Dire Wolf's sources carry
    # trailing blanks on many lines; the patch is generated against
    # right-stripped copies, so strip the same five files first (sed -i.bak:
    # the one spelling GNU and BSD sed share).
    cp "$ROOT/third_party/direwolf/src/audio_tcp.c" "$ROOT/third_party/direwolf/src/audio_tcp.h" "$WORK/direwolf/src/"
    ( cd "$WORK/direwolf" && sed -i.bak 's/[ \t]*$//' src/audio.c src/audio_win.c src/audio_portaudio.c src/audio.h src/CMakeLists.txt && rm -f src/*.bak )
    git -C "$WORK/direwolf" apply --ignore-whitespace "$ROOT/third_party/direwolf/potacat-socket-audio.patch" || { echo "::error::potacat-socket-audio.patch did not apply to direwolf $DIREWOLF_TAG"; exit 1; }
    for f in audio.c audio_win.c audio_portaudio.c; do
      grep -q 'tcpaudio_open' "$WORK/direwolf/src/$f" || { echo "::error::socket audio hook missing from $f"; exit 1; }
    done
    grep -q 'audio_tcp.c' "$WORK/direwolf/src/CMakeLists.txt" || { echo "::error::audio_tcp.c is not in Dire Wolf's source list"; exit 1; }
    OUT="$ROOT/assets/direwolf"
    rm -rf "$OUT/"*.dll "$OUT/"*.so* "$OUT/"*.dylib "$OUT/direwolf" "$OUT/direwolf.exe" 2>/dev/null || true
    mkdir -p "$OUT" "$WORK/direwolf/build"
    if [ "$HOST" = mac ]; then
      # Dire Wolf's CMake requires PortAudio and hidapi on macOS even though
      # POTACAT's build opens no device through them; Hamlib for PTT RIG.
      # All three come from Homebrew; bundle-mac-deps ships the dylibs beside
      # the binary (@loader_path) and fails on a wrong architecture.
      ( cd "$WORK/direwolf/build" && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$(brew --prefix)" .. && make -j4 direwolf )
      cp "$WORK/direwolf/build/src/direwolf" "$OUT/"
      node "$ROOT/scripts/bundle-mac-deps.js" --expect-arch="$(uname -m)" "$OUT/direwolf"
    elif [ "$HOST" = win ]; then
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
    if [ "$HOST" = mac ]; then
      otool -L "$OUT/direwolf" | grep -qi 'libhamlib' || { echo "::error::direwolf was built without Hamlib"; exit 1; }
    else
      ldd "$OUT/direwolf$EXE" | grep -qi 'libhamlib' || { echo "::error::direwolf was built without Hamlib"; exit 1; }
    fi
    # And it must know the socket device (a wrong patch would have failed above; this proves the binary).
    "$OUT/direwolf$EXE" -h 2>&1 | head -1 >/dev/null || true
    cp "$WORK/direwolf/LICENSE" "$ROOT/third_party/direwolf/LICENSE"
    echo "direwolf $DIREWOLF_TAG ($DIREWOLF_SHA) → assets/direwolf/direwolf$EXE"
  }
fi
