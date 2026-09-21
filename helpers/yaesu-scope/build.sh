#!/bin/sh
# Build yaesu-scope for Linux or macOS. No FTDI SDK needed: the libraries are
# loaded at run time.
set -e
cd "$(dirname "$0")"
mkdir -p build
case "$(uname -s)" in
  Darwin) ${CC:-clang} -O2 -Wall -o build/yaesu-scope yaesu-scope.c -lpthread -lm ;;
  *)      ${CC:-gcc}   -O2 -Wall -o build/yaesu-scope yaesu-scope.c -ldl -lpthread -lm ;;
esac
echo "built build/yaesu-scope"
