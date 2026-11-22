#!/usr/bin/env bash
# The FT-710 scope helper finds and loads FTDI's LibFT4222 the way an
# operator's computer has it (GitHub #360). Stand-in libraries from
# test/fixtures/ft4222-stub/stub.c are built under FTDI's own file names:
#   macOS: libft4222.1.4.4.221.dylib + libftd2xx.dylib (FTDI's Mac package)
#   Linux: libft4222.so.1.4.4.221
# and the real helper is run against them with --list. Each case checks the
# helper's own words and runs them through lib/ft4222-library.js.
# Needs a C compiler (clang on macOS, gcc on Linux) and node. No radio.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUB="$ROOT/test/fixtures/ft4222-stub/stub.c"
HELPER="$WORK/yaesu-scope"
OS="$(uname -s)"
fail=0

if [ "$OS" = "Darwin" ]; then
  ARCH="$(uname -m)"
  cc -O2 -Wall -arch "$ARCH" -o "$HELPER" helpers/yaesu-scope/yaesu-scope.c -lpthread -lm
else
  gcc -O2 -Wall -o "$HELPER" helpers/yaesu-scope/yaesu-scope.c -ldl -lpthread -lm
fi

# run <case name> <dir> <expected exit> <regex the stderr must match> [classify key]
run() {
  local name="$1" dir="$2" want="$3" re="$4" key="${5:-}"
  local out rc=0
  out="$(cd "$WORK" && POTACAT_FTDI_DIR="$dir" "$HELPER" --list 2>&1 </dev/null)" || rc=$?
  if [ "$rc" != "$want" ] || ! printf '%s' "$out" | grep -Eq "$re"; then
    echo "FAIL $name: exit $rc (want $want), stderr:"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1; return
  fi
  if [ -n "$key" ]; then
    local got
    got="$(printf '%s' "$out" | node -e "const L=require('$ROOT/lib/ft4222-library.js');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=L.loaderError(s);console.log(e?L.classifyLoaderError(e.reason):'none')})")"
    if [ "$got" != "$key" ]; then
      echo "FAIL $name: lib/ft4222-library.js classified it as '$got', want '$key'. stderr:"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1; return
    fi
  fi
  echo "ok   $name"
  printf '%s\n' "$out" | sed 's/^/    /'
}

if [ "$OS" = "Darwin" ]; then
  # 1. FTDI's Mac files as shipped: versioned name, libftd2xx beside it.
  D1="$WORK/both"; mkdir -p "$D1"
  cc -dynamiclib -arch "$ARCH" -DSTUB_D2XX -install_name libftd2xx.dylib -o "$D1/libftd2xx.dylib" "$STUB"
  cc -dynamiclib -arch "$ARCH" -DSTUB_4222 -install_name libft4222.dylib -L"$D1" -lftd2xx -o "$D1/libft4222.1.4.4.221.dylib" "$STUB"
  echo "the stand-in links libftd2xx as:"; otool -L "$D1/libft4222.1.4.4.221.dylib" | sed 's/^/    /'
  run "mac: versioned libft4222 with libftd2xx beside it loads" "$D1" 0 "loaded .*libft4222.1.4.4.221.dylib"

  # 2. Only the library copied (ak6ma, #360): it exists and will not load; the reason is printed.
  D2="$WORK/alone"; mkdir -p "$D2"; cp "$D1/libft4222.1.4.4.221.dylib" "$D2/libft4222.dylib"
  run "mac: libft4222 without libftd2xx prints the loader's reason" "$D2" 2 "load failed: .*libft4222\.dylib: .*libftd2xx" missing-d2xx

  # 3. A library of the other architecture than the helper.
  OTHER=x86_64; [ "$ARCH" = "x86_64" ] && OTHER=arm64
  D3="$WORK/otherarch"; mkdir -p "$D3"
  cc -dynamiclib -arch "$OTHER" -DSTUB_D2XX -install_name libftd2xx.dylib -o "$D3/libftd2xx.dylib" "$STUB"
  cc -dynamiclib -arch "$OTHER" -DSTUB_4222 -install_name libft4222.dylib -L"$D3" -lftd2xx -o "$D3/libft4222.1.4.4.221.dylib" "$STUB"
  run "mac: a $OTHER-only library on the $ARCH helper names the architecture" "$D3" 2 "load failed: .*(incompatible|architecture)" arch
else
  # Linux: FTDI ships libft4222.so.<version>; one file carries the D2XX calls.
  D1="$WORK/linux"; mkdir -p "$D1"
  gcc -shared -fPIC -DSTUB_D2XX -DSTUB_4222 -o "$D1/libft4222.so.1.4.4.221" "$STUB"
  run "linux: versioned libft4222.so loads from POTACAT's folder" "$D1" 0 "loaded .*libft4222\.so\.1\.4\.4\.221"
  D2="$WORK/broken"; mkdir -p "$D2"; printf 'not a library' > "$D2/libft4222.so"
  run "linux: an unloadable file prints the loader's reason" "$D2" 2 "load failed: .*libft4222\.so: "
fi

D0="$WORK/empty"; mkdir -p "$D0"
run "no library anywhere says not found and lists what it tried" "$D0" 2 "libft4222 not found"

exit $fail
