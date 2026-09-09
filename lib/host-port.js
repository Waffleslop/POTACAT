// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Casey Stanton
//
// A host field with the port pasted into it.
//
// N5ZC (2026-09-06) had "127.0.0.1:4532" in the Host box of a rigctld rig and
// 4532 in the Port box beside it. POTACAT dutifully dialled host
// "127.0.0.1:4532" port 4532, and the only trace was a DNS failure every 16
// seconds: `getaddrinfo ENOTFOUND 127.0.0.1:4532`. Read quickly that line looks
// like the address it names is simply unreachable, so it reads as a rigctld
// problem rather than a typo two fields up.
//
// It is an easy mistake to make — every piece of networking documentation in
// the world writes an endpoint as host:port, and the box is labelled Host. So
// accept it and say what we did, rather than failing in DNS.
//
// Pure and dependency-free so the parsing can be tested without a socket.

/**
 * Split a host field that may carry its own port.
 *
 * Rules, in order:
 *   - "[::1]:4532" / "[::1]"    → bracketed IPv6, port optional. The brackets
 *                                 exist precisely to disambiguate this case.
 *   - "host:4532"               → one colon and an all-digit tail: a pasted
 *                                 endpoint. Split it.
 *   - "fe80::1"                 → two or more colons and no brackets: a bare
 *                                 IPv6 literal, NOT host:port. Left alone,
 *                                 because splitting on the last colon here
 *                                 would silently mangle a valid address.
 *   - anything else             → returned untouched.
 *
 * The embedded port wins over `defaultPort` when both are present: the user
 * typed the pair, and honouring the half they typed while discarding the other
 * half is the one outcome nobody expects. Callers log `corrected` so a
 * disagreement between the two fields is visible rather than silent.
 *
 * @param {string} host        raw contents of the Host field
 * @param {number} defaultPort the Port field's value (or the type's default)
 * @returns {{host: string, port: number, corrected: boolean}}
 */
function splitHostPort(host, defaultPort) {
  const raw = String(host == null ? '' : host).trim();
  const fallbackPort = Number(defaultPort) || 0;
  const plain = { host: raw, port: fallbackPort, corrected: false };
  if (!raw) return plain;

  // Bracketed IPv6, with or without a port.
  const bracketed = raw.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : fallbackPort;
    if (bracketed[2] && !isUsablePort(port)) return plain;
    // Stripping the brackets is itself a correction — net.connect wants the
    // bare address — but only worth announcing when a port came off too.
    return { host: bracketed[1], port, corrected: !!bracketed[2] };
  }

  // Exactly one colon, digits after it: a pasted endpoint.
  if ((raw.match(/:/g) || []).length === 1) {
    const m = raw.match(/^(.+):(\d{1,5})$/);
    if (m) {
      const port = Number(m[2]);
      if (isUsablePort(port) && m[1]) return { host: m[1], port, corrected: true };
    }
  }

  return plain;
}

function isUsablePort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

module.exports = { splitHostPort };
