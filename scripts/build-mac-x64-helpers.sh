#!/bin/bash
# Build the helper binaries the Intel (x64) macOS DMG ships: rigctld, rotctld
# (Hamlib) and wsprd. Run from the repo root on a macOS CI runner.
#
# The runner is Apple Silicon. Its Homebrew (/opt/homebrew) installs arm64
# bottles, and until 2026-10-22 that is what the Intel DMG shipped: every Intel
# Mac got "rigctld Unknown system error -86" (bad CPU type), so no Hamlib, no
# Hamlib rotor and no WSPR decoding (KL4XQ, FT-818 on an Intel iMac). Here a
# second, Intel Homebrew under Rosetta (/usr/local, its own prefix, the one
# Intel Macs use) supplies x86_64 bottles and an x86_64 gfortran.
# scripts/bundle-mac-deps.js then FAILS the build if anything is not x86_64.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-mac-x64-helpers: macOS only" >&2
  exit 2
fi

# Rosetta is on GitHub's Apple Silicon images; install it if a runner lacks it.
if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  /usr/sbin/softwareupdate --install-rosetta --agree-to-license
fi

BREW_X86=/usr/local/bin/brew
if [ ! -x "$BREW_X86" ]; then
  NONINTERACTIVE=1 arch -x86_64 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
brew_x86() { arch -x86_64 "$BREW_X86" "$@"; }
brew_x86 --version
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1

# --- Hamlib: rigctld + rotctld ---
brew_x86 install hamlib
HAMLIB_PREFIX="$(brew_x86 --prefix hamlib)"
rm -f assets/hamlib/*.dll assets/hamlib/*.exe
cp "$HAMLIB_PREFIX/bin/rigctld" assets/hamlib/rigctld
cp "$HAMLIB_PREFIX/bin/rotctld" assets/hamlib/rotctld
lipo -archs assets/hamlib/rigctld
node scripts/bundle-mac-deps.js --expect-arch=x86_64 assets/hamlib/rigctld assets/hamlib/rotctld
ls -la assets/hamlib/

# --- wsprd (WSPR decoder, GPLv3 separate executable) ---
brew_x86 install fftw gcc
FFTW_PREFIX="$(brew_x86 --prefix fftw)"
GFORTRAN="$(brew_x86 --prefix gcc)/bin/gfortran"
arch -x86_64 "$GFORTRAN" -O3 -o assets/wsprd/wsprd \
  third_party/wsprd/src/*.c third_party/wsprd/src/*.f90 \
  -I"$FFTW_PREFIX/include" "$FFTW_PREFIX/lib/libfftw3f.a" -lm -static-libgfortran -static-libgcc
test -f assets/wsprd/wsprd
lipo -archs assets/wsprd/wsprd
# -static-libgfortran/-static-libgcc do not cover libquadmath; the bundler
# ships it beside wsprd and rewrites the load command.
node scripts/bundle-mac-deps.js --expect-arch=x86_64 assets/wsprd/wsprd

# A last look: the Intel helpers must answer on this machine under Rosetta.
arch -x86_64 assets/hamlib/rigctld --version
arch -x86_64 assets/hamlib/rotctld --version
