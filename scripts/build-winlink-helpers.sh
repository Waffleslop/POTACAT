#!/usr/bin/env bash
# Build the Winlink sidecars from PINNED source into assets/ for packaging
# (docs/winlink-integration-plan.md):
#   pat      — the Winlink client (Go, MIT, LA5NTA)        → assets/pat/pat[.exe]
#   ardopcf  — the ARDOP modem (C, MIT, Muething/Wiseman/LaRue)
#                                                          → assets/ardopcf/ardopcf[.exe]
# Both are separate executables POTACAT runs and talks to over loopback TCP;
# neither is linked. Built from source (not upstream release binaries) because
# upstream ships no Windows x64 / macOS arm64 Pat and no macOS ardopcf, and a
# pinned commit is what the NOTICE and third_party/*/VERSION.txt promise.
#
# Usage: scripts/build-winlink-helpers.sh [pat] [ardop]   (default: both;
#        ardop is skipped on macOS — ardopcf has no CoreAudio backend)
# Needs: git, go >= 1.24 for pat; make + gcc (+ libasound2-dev on Linux,
#        MSYS2 MINGW64 on Windows) for ardop.
set -euo pipefail

PAT_REPO=https://github.com/la5nta/pat
PAT_TAG=v1.0.0
PAT_SHA=2e6a8d14baf0268f4e2aa4d01784a54ca935cf52
ARDOP_REPO=https://github.com/pflarue/ardop
ARDOP_TAG=1.0.4.1.3
ARDOP_SHA=96dec85fc96d7e6d3dd90379fd809ba6cf83b6cc

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/winlink-helpers"
mkdir -p "$WORK"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE=.exe; HOST=win ;;
  Darwin) EXE=; HOST=mac ;;
  *) EXE=; HOST=linux ;;
esac

want="${*:-pat ardop}"

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
  # CGO off: one static binary per OS/arch, no libax25 (AX.25 is not a
  # transport POTACAT offers). The web UI is committed at the tag (web/dist).
  ( cd "$WORK/pat" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$ROOT/assets/pat/pat$EXE" . )
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
    mkdir -p "$ROOT/assets/ardopcf"
    # Static on Windows so no MinGW runtime DLL has to ship beside it.
    if [ "$HOST" = win ]; then
      ( cd "$WORK/ardop" && make ardopcf LDFLAGS="-Xlinker -Map=output.map -static" )
    else
      ( cd "$WORK/ardop" && make ardopcf )
    fi
    cp "$WORK/ardop/ardopcf$EXE" "$ROOT/assets/ardopcf/ardopcf$EXE"
    test -f "$ROOT/assets/ardopcf/ardopcf$EXE"
    cp "$WORK/ardop/LICENSE" "$ROOT/third_party/ardopcf/LICENSE"
    echo "ardopcf $ARDOP_TAG ($ARDOP_SHA) → assets/ardopcf/ardopcf$EXE"
  fi
fi
