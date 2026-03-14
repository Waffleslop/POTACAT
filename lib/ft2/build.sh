#!/bin/bash
# Build FT2 WASM modules using Emscripten
# Run from lib/ft2/ directory
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p wasm

FT8_LIB="ft8_lib"
COMMON_C="$FT8_LIB/ft8/message.c $FT8_LIB/ft8/text.c $FT8_LIB/ft8/encode.c $FT8_LIB/ft8/constants.c $FT8_LIB/ft8/crc.c"

echo "=== Building FT2 Encoder WASM ==="
emcc \
  -s EXPORT_NAME="'___ft2EncodeModule___'" \
  -I"$FT8_LIB" -I. \
  -sSTACK_SIZE=2MB \
  ft2_encode.c $COMMON_C \
  -o wasm/ft2_encode.js \
  -sEXPORTED_FUNCTIONS='["_ft2_exec_encode", "_free", "_malloc"]' \
  -sEXPORTED_RUNTIME_METHODS='["cwrap","HEAPF32","HEAPU8"]' \
  -s ASYNCIFY=1 \
  -s 'ASYNCIFY_IMPORTS=["_ft2_exec_encode"]' \
  --no-entry -flto \
  -s EXPORT_ES6=1 \
  -s NO_FILESYSTEM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s AUTO_NATIVE_LIBRARIES=0

echo "=== Building FT2 Decoder WASM ==="
emcc \
  -s EXPORT_NAME="'___ft2DecodeModule___'" \
  -I"$FT8_LIB" -I. \
  -sSTACK_SIZE=5MB \
  ft2_decode.c ft2_sync.c \
  $COMMON_C \
  $FT8_LIB/ft8/ldpc.c \
  $FT8_LIB/fft/kiss_fft.c $FT8_LIB/fft/kiss_fftr.c \
  -o wasm/ft2_decode.js \
  -sEXPORTED_FUNCTIONS='["_ft2_init_decode", "_ft2_exec_decode", "_free", "_malloc"]' \
  -sEXPORTED_RUNTIME_METHODS='["cwrap","HEAPF32","HEAPU8"]' \
  -s ASYNCIFY=1 \
  -s 'ASYNCIFY_IMPORTS=["_ft2_exec_decode"]' \
  --no-entry -flto \
  -s EXPORT_ES6=1 \
  -s NO_FILESYSTEM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s AUTO_NATIVE_LIBRARIES=0

echo "=== Build complete ==="
ls -la wasm/
