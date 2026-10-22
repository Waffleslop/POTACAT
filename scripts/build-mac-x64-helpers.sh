#!/bin/bash
# Build the helper binaries the Intel (x64) macOS DMG ships: rigctld, rotctld
# (Hamlib) and wsprd. Run from the repo root on an INTEL macOS runner
# (macos-15-intel).
#
# Until 2026-10-22 the x64 job ran on an Apple Silicon runner and took these
# from its Homebrew, which installs arm64: every Intel Mac got "rigctld
# Unknown system error -86" (bad CPU type), so no Hamlib, no Hamlib rotor and
# no WSPR decoding (KL4XQ, FT-818 on an Intel iMac). An x86_64 Homebrew under
# Rosetta is no longer possible ("Homebrew on macOS is only supported on
# Apple Silicon processors"), and Homebrew's Intel bottles target the runner's
# own macOS. So Hamlib and FFTW are built here from their official source
# releases (checksums pinned), statically, for macOS 12 (POTACAT's minimum).
# scripts/bundle-mac-deps.js then FAILS the build on any absolute library
# path or any helper that is not x86_64.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "build-mac-x64-helpers: needs an Intel macOS runner (macos-15-intel); this is $(uname -s) $(uname -m)" >&2
  exit 2
fi

export MACOSX_DEPLOYMENT_TARGET=12.0
JOBS="$(sysctl -n hw.ncpu)"
WORK="$(mktemp -d)"
ROOT="$(pwd)"

fetch() { # url sha256 dest
  curl -fsSL -o "$3" "$1"
  echo "$2  $3" | shasum -a 256 -c -
}

# --- Hamlib: rigctld + rotctld, static (no libhamlib/libusb dylibs to ship) ---
HAMLIB_VER=4.7.0
HAMLIB_SHA=24542b09cb2432458ba239b2ba8f5b7fb67cde64df6553f150e6eb8475a87a23
fetch "https://github.com/Hamlib/Hamlib/releases/download/${HAMLIB_VER}/hamlib-${HAMLIB_VER}.tar.gz" "$HAMLIB_SHA" "$WORK/hamlib.tar.gz"
tar xzf "$WORK/hamlib.tar.gz" -C "$WORK"
(
  cd "$WORK/hamlib-${HAMLIB_VER}"
  ./configure --prefix="$WORK/hamlib-out" --disable-shared --enable-static \
    --without-libusb --without-readline --without-cxx-binding --without-indi \
    --disable-winradio --disable-html-matrix \
    CFLAGS="-O2 -mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET}"
  make -j"$JOBS"
  make install
)
rm -f assets/hamlib/*.dll assets/hamlib/*.exe
cp "$WORK/hamlib-out/bin/rigctld" assets/hamlib/rigctld
cp "$WORK/hamlib-out/bin/rotctld" assets/hamlib/rotctld
node scripts/bundle-mac-deps.js --expect-arch=x86_64 assets/hamlib/rigctld assets/hamlib/rotctld
assets/hamlib/rigctld --version
assets/hamlib/rotctld --version
ls -la assets/hamlib/

# --- wsprd (WSPR decoder, GPLv3 separate executable) ---
FFTW_VER=3.3.10
FFTW_SHA=56c932549852cddcfafdab3820b0200c7742675be92179e59e6215b340e26467
fetch "https://www.fftw.org/fftw-${FFTW_VER}.tar.gz" "$FFTW_SHA" "$WORK/fftw.tar.gz"
tar xzf "$WORK/fftw.tar.gz" -C "$WORK"
(
  cd "$WORK/fftw-${FFTW_VER}"
  ./configure --prefix="$WORK/fftw-out" --enable-float --disable-shared --enable-static --disable-fortran \
    CFLAGS="-O2 -mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET}"
  make -j"$JOBS"
  make install
)
# GitHub's macOS images carry versioned gfortran (gfortran-13, -14 ...); the newest wins.
GFORTRAN="$(ls /usr/local/bin/gfortran-[0-9]* 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$GFORTRAN" ]; then
  brew install gcc
  GFORTRAN="$(brew --prefix gcc)/bin/gfortran"
fi
echo "using $GFORTRAN"
"$GFORTRAN" -O3 -mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET} -o assets/wsprd/wsprd \
  "$ROOT"/third_party/wsprd/src/*.c "$ROOT"/third_party/wsprd/src/*.f90 \
  -I"$WORK/fftw-out/include" "$WORK/fftw-out/lib/libfftw3f.a" -lm -static-libgfortran -static-libgcc
test -f assets/wsprd/wsprd
# -static-libgfortran/-static-libgcc do not cover libquadmath; the bundler
# ships it beside wsprd and rewrites the load command.
node scripts/bundle-mac-deps.js --expect-arch=x86_64 assets/wsprd/wsprd
