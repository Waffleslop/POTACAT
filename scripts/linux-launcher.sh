#!/bin/sh
# POTACAT launcher — Chromium sandbox compatibility (GitHub issue #37).
#
# Chromium prefers the unprivileged-user-namespace sandbox; the
# setuid-root chrome-sandbox helper is only a fallback. Some systems
# deny user namespaces to this binary:
#   - Ubuntu 23.10+ (apparmor_restrict_unprivileged_userns=1) unless an
#     AppArmor profile covers it — our deb/rpm install one, but an
#     AppImage or extracted dir can't be profiled, and
#   - kernels with unprivileged_userns_clone=0 (hardened Debian).
# In those configurations, with no usable setuid helper, Chromium
# aborts BEFORE any application JavaScript runs (verified in CI:
# startup.log never gets created), so this decision cannot live in
# main.js — it has to happen out here, in the process that execs
# Electron. Installed as the app's entry point by
# scripts/linux-after-pack.js, which renames the real binary to
# <name>.bin.
#
# Decision matrix mirrors lib/linux-sandbox.js decideSandboxFallback()
# (unit-tested spec) — keep the two in sync.

set -u
NAME=$(basename "$0")
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$DIR/$NAME.bin"

# Operator already chose — pass through untouched.
case " $* " in
  *" --no-sandbox "*) exec "$BIN" "$@" ;;
esac

read_sys() { cat "$1" 2>/dev/null || echo ""; }

userns_denied=""
if [ "$(read_sys /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then
  userns_denied="kernel.unprivileged_userns_clone=0"
elif [ "$(read_sys /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "1" ]; then
  # Covered by the AppArmor profile our deb/rpm install (it attaches to
  # /opt/<product>/<name>.bin)? Outside /opt — AppImage, extracted dir,
  # dev — no profile can cover us.
  covered=""
  case "$DIR" in
    /opt/*) [ -f "/etc/apparmor.d/$NAME" ] && covered=1 ;;
  esac
  [ -n "$covered" ] || userns_denied="apparmor_restrict_unprivileged_userns=1 with no AppArmor profile for this install"
fi

if [ -n "$userns_denied" ]; then
  # The setuid helper can still provide the sandbox — but never inside
  # an AppImage (the FUSE mount is nosuid), and only when it's actually
  # root-owned with the setuid bit.
  suid_ok=""
  if [ -z "${APPIMAGE:-}" ] && [ -u "$DIR/chrome-sandbox" ] \
     && [ "$(stat -c %u "$DIR/chrome-sandbox" 2>/dev/null)" = "0" ]; then
    suid_ok=1
  fi
  if [ -z "$suid_ok" ]; then
    echo "POTACAT: this system denies the user-namespace sandbox ($userns_denied)" >&2
    echo "POTACAT: and no setuid chrome-sandbox is available - launching with --no-sandbox." >&2
    echo "POTACAT: better fixes: install the .deb (full sandbox via AppArmor profile, no setuid)," >&2
    echo "POTACAT: or opt in: sudo chown root:root '$DIR/chrome-sandbox' && sudo chmod 4755 '$DIR/chrome-sandbox'" >&2
    echo "POTACAT: details: https://github.com/Waffleslop/POTACAT/issues/37" >&2
    exec "$BIN" --no-sandbox "$@"
  fi
fi

exec "$BIN" "$@"
