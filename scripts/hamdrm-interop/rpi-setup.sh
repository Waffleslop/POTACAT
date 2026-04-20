#!/bin/bash
# ---------------------------------------------------------------------------
# One-shot setup for a Raspberry Pi (or any Debian/Ubuntu box) to act as the
# reference decoder + instrumented TX for HamDRM interop testing.
#
#   curl -fsSL https://raw.githubusercontent.com/Waffleslop/POTACAT/master/scripts/hamdrm-interop/rpi-setup.sh | bash
#   # or: scp this file over, then:  bash rpi-setup.sh
#
# Idempotent: safe to re-run. Won't re-download / re-compile what already exists.
#
# Override the QSSTV fork/branch via environment:
#   QSSTV_REPO=https://github.com/willardharris/QSSTV bash rpi-setup.sh
#   QSSTV_BRANCH=master bash rpi-setup.sh
# sbitx operators: the stock ON4QZ build can't drive sbitx's custom audio
# backend — use the willardharris fork above (HA3HZ 2026-04-19).
#
# After this script:
#   ~/qsstv/            — cloned QSSTV source with our instrumentation patch
#   ~/qsstv/qsstv       — built binary, in PATH via a symlink at ~/.local/bin
#   ~/POTACAT/          — cloned POTACAT so you can run diff-dumps.js here
#   /tmp/qsstv-dump/    — where the instrumented QSSTV writes layer dumps
# ---------------------------------------------------------------------------

set -euo pipefail

QSSTV_REPO="${QSSTV_REPO:-https://github.com/ON4QZ/QSSTV}"
QSSTV_BRANCH="${QSSTV_BRANCH:-main}"
QSSTV_DIR="${HOME}/qsstv"
POTACAT_REPO="https://github.com/Waffleslop/POTACAT"
POTACAT_DIR="${HOME}/POTACAT"
DUMP_DIR="/tmp/qsstv-dump"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
hr()    { printf '%s\n' '----------------------------------------------------------------------'; }

hr; bold "[1/5] Installing system packages"
sudo apt update
sudo apt install -y \
  git build-essential \
  qtbase5-dev qt5-qmake qttools5-dev-tools qtmultimedia5-dev \
  libfftw3-dev libhamlib-dev libpulse-dev libasound2-dev \
  libopenjp2-7-dev libv4l-dev libusb-1.0-0-dev \
  python3 curl

# Node 14+ (our scripts only use ES2019 features). Prefer the distro's own
# package on armhf / other non-mainstream arches since NodeSource only
# ships amd64 + arm64 builds. On amd64/arm64 we use NodeSource for a newer
# LTS.
ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
NODE_MIN_MAJOR=14
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -v | sed 's/v//;s/\..*//')"
  if [[ "$cur" -ge "$NODE_MIN_MAJOR" ]]; then
    need_node=0
  fi
fi
if [[ "$need_node" = 1 ]]; then
  case "$ARCH" in
    amd64|arm64)
      bold "  installing Node.js 20.x from NodeSource (arch: $ARCH)"
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt install -y nodejs
      ;;
    *)
      bold "  installing distro nodejs (arch: $ARCH — NodeSource doesn't ship here)"
      sudo apt install -y nodejs npm
      ;;
  esac
fi
if ! command -v node >/dev/null 2>&1; then
  echo "  node install failed — apt install nodejs manually" >&2
  exit 1
fi
bold "  node: $(node -v)"

hr; bold "[2/5] Cloning QSSTV + POTACAT"
bold "  QSSTV repo:   $QSSTV_REPO"
bold "  QSSTV branch: $QSSTV_BRANCH"
if [[ -d "$QSSTV_DIR" ]]; then
  bold "  QSSTV already cloned at $QSSTV_DIR — pulling latest $QSSTV_BRANCH"
  git -C "$QSSTV_DIR" fetch origin "$QSSTV_BRANCH"
  git -C "$QSSTV_DIR" checkout "$QSSTV_BRANCH"
  git -C "$QSSTV_DIR" pull --ff-only
else
  git clone --depth 1 --branch "$QSSTV_BRANCH" "$QSSTV_REPO" "$QSSTV_DIR"
fi

if [[ -d "$POTACAT_DIR" ]]; then
  bold "  POTACAT already cloned at $POTACAT_DIR — pulling latest master"
  git -C "$POTACAT_DIR" pull --ff-only || true
else
  git clone --depth 1 "$POTACAT_REPO" "$POTACAT_DIR"
fi

hr; bold "[3/5] Applying instrumentation patch"
bash "$POTACAT_DIR/scripts/hamdrm-interop/qsstv-instrumentation.sh" "$QSSTV_DIR"

hr; bold "[4/5] Building QSSTV"
cd "$QSSTV_DIR"
if [[ ! -f Makefile ]]; then
  qmake
fi
# Parallel build, use all cores.
JOBS="$(nproc)"
make -j"$JOBS" 2>&1 | tail -20
if [[ ! -x "$QSSTV_DIR/qsstv" ]]; then
  echo "build failed — no qsstv binary in $QSSTV_DIR" >&2
  exit 1
fi
bold "  built: $QSSTV_DIR/qsstv"

mkdir -p "${HOME}/.local/bin"
ln -sf "$QSSTV_DIR/qsstv" "${HOME}/.local/bin/qsstv"
if ! echo "$PATH" | tr ':' '\n' | grep -qx "${HOME}/.local/bin"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${HOME}/.bashrc"
  bold "  added ~/.local/bin to PATH in ~/.bashrc (run: source ~/.bashrc or open a new shell)"
fi

hr; bold "[5/5] Preparing dump directory"
mkdir -p "$DUMP_DIR"
chmod 755 "$DUMP_DIR"

hr
bold "Setup complete. Two test flows from here:"
cat <<EOF

==================== FLOW A — Decode our WAV (Tier 1) ====================

On your local (POTACAT dev) machine, generate a WAV:

    node scripts/hamdrm-interop/encode-wav.js potacat-logo.jpg \\
      --label K3SBP --out /tmp/potacat.wav

Ship it to the pi and open QSSTV with X11 forwarding:

    scp /tmp/potacat.wav ${USER}@$(hostname).local:/tmp/
    ssh -X ${USER}@$(hostname).local   # then on the pi:
        qsstv

In QSSTV: switch to the **DRM** tab, *Input* → *File*, pick
/tmp/potacat.wav. If an image (even a garbled one) shows up, our port
is wire-compatible with QSSTV.

==================== FLOW B — Layer dumps (Tier 2) ====================

SSH into the pi with X11:

    ssh -X ${USER}@$(hostname).local

On the pi, generate reference dumps by running an instrumented TX:

    rm -rf /tmp/qsstv-dump/*
    qsstv                           # GUI opens
    # DRM TX tab: load the SAME image you'll run through our JS port
    #   operator label  = whatever you'll pass --label
    #   spectrum occup. = SO_1
    #   protection      = A
    #   interleaver     = Short
    #   MSC mode        = 4-QAM
    # Click TX and let it run one superframe (~1.2 s is enough).

Dumps land in /tmp/qsstv-dump/. Ship them back:

    scp -r ${USER}@$(hostname).local:/tmp/qsstv-dump /tmp/

On your local machine, emit our dumps with the SAME input:

    node scripts/hamdrm-interop/encode-wav.js <same image> \\
      --label <same label> --dump-dir /tmp/js-dump \\
      --out /dev/null   # WAV output optional here

And diff:

    node scripts/hamdrm-interop/diff-dumps.js /tmp/js-dump /tmp/qsstv-dump -v

The first DIFFER line tells you which port layer to fix. See
scripts/hamdrm-interop/README.md for interpretation of each layer.

==================== NOTE on VNC ====================

If X11 forwarding is too laggy for the QSSTV GUI, enable VNC on the pi:

    sudo raspi-config
    # Interface Options → VNC → Enable

Then connect from your Mac/Windows with any VNC client at vnc://$(hostname).local.
EOF
