'use strict';
// Message text for the WASM FT8/FT4/FT2 encoders (the fallback when the
// native ft8_lib addon does not load, and always for FT2).
//
// JTCAT writes a nonstandard call the WSJT-X way, in angle brackets:
// "<HS0GWL/M> VK4KTW -10". The native packer reads the brackets as "send
// this call as a hash". The stock ft8_lib inside ft8js, ft4 and ft2 does not
// know brackets: it prints "Cannot parse message!" and returns null, so the
// rig never keyed (VK4KTW, 2026-11-13). Given the same text without brackets
// it hashes the nonstandard call itself, and the result is the same 77 bits
// the native packer sends for the bracketed text (checked sample for sample
// for FT8, and the native decoder reads FT4's back as "<HS0GWL/M> ...").
//
// Only the WASM path uses this. The native encoder keeps the brackets; they
// carry meaning there (which of two calls is hashed in a type 4 message).
function forWasmEncoder(text) {
  return String(text == null ? '' : text).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { forWasmEncoder };
