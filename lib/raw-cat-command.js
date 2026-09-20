'use strict';

// Custom CAT button payloads: deciding whether what the operator typed is a
// run of raw bytes or an ASCII command, and rendering it the way each
// transport wants it.
//
// The two shapes an operator types are the two their radio's manual prints:
//
//   Icom CI-V    FE FE 80 E0 12 00 FD     (hex bytes)
//   Yaesu/Kenwood FA014074000;            (ASCII text)
//
// Direct serial gets the bytes and is simple. **rigctld is not**: its `w`
// (send_cmd) command takes binary as `\0xFE\0xFE…`, with a `0x` after the
// backslash. POTACAT sent `\xFE\xFE…` — no `0` — so hamlib's parser hit a
// backslash it could not read and answered `RPRT -1 (Invalid argument)`
// without sending anything to the radio (K8IKO, IC-7410, 2026-09-20; his
// command worked from CI-V Scout, which proved the bytes were right).
//
// Verified against the bundled hamlib 4.x rigctld: `w \0xfe\0xfe\0x80…` is
// echoed back parsed and byte-counted, while `w \xfe\xfe\x80…` is echoed back
// as the literal text, i.e. sent to the radio as the characters `\`, `x`,
// `f`, `e`.

/** The CI-V preamble every Icom frame starts with, and the byte it ends on. */
const CIV_PREAMBLE = 'fefe';
const CIV_END = 'fd';

/**
 * Decide whether the operator typed raw bytes, and if so which ones.
 *
 * Two accepted spellings, both unambiguous:
 *  1. Space-separated byte pairs — `FE FE 80 E0 12 00 FD`. Needs two or more,
 *     so a bare Kenwood/Yaesu token that happens to be valid hex (`AB`) stays
 *     text.
 *  2. One unbroken CI-V frame — `fefe80e01200fd`. Accepted only when it starts
 *     `FEFE` and ends `FD`, which no ASCII rig command does. K8IKO tried this
 *     spelling second when the spaced one failed, and it has to work too.
 *
 * @param {string} text - what the operator typed
 * @returns {number[]|null} the bytes, or null when this is an ASCII command
 */
function rawCatBytes(text) {
  const cmd = String(text == null ? '' : text).replace(/[\r\n]/g, '').trim();
  if (!cmd) return null;

  const parts = cmd.split(/\s+/);
  if (parts.length >= 2 && parts.every((p) => /^[0-9a-fA-F]{2}$/.test(p))) {
    return parts.map((p) => parseInt(p, 16));
  }

  if (parts.length === 1) {
    const one = parts[0].toLowerCase();
    if (/^[0-9a-f]+$/.test(one) && one.length % 2 === 0 && one.length >= 6
      && one.startsWith(CIV_PREAMBLE) && one.endsWith(CIV_END)) {
      return one.match(/../g).map((p) => parseInt(p, 16));
    }
  }

  return null;
}

/**
 * Render a custom command as the argument for rigctld's `w` / send_cmd.
 *
 * Binary becomes `\0xNN` per byte — NOT `\xNN`, which hamlib rejects outright
 * (see the module header). ASCII passes through with line endings stripped.
 *
 * @param {string} text
 * @returns {string} the text to place after `w `
 */
function rigctldRawArg(text) {
  const bytes = rawCatBytes(text);
  if (bytes) return bytes.map((b) => '\\0x' + b.toString(16).padStart(2, '0')).join('');
  return String(text == null ? '' : text).replace(/[\r\n]/g, '').trim();
}

module.exports = { rawCatBytes, rigctldRawArg };
