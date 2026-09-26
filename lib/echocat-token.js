'use strict';

// The shared ECHOCAT Web token: the one an operator reads off the desktop and
// TYPES into a browser. Paired-device tokens are long, random and never typed;
// they do not come through here.
//
// A token used to be 6 hex characters, and a user read the 5 as an S (Casey,
// 2026-09-25) — the screen gives no way to tell 5 from S, 8 from B or 0 from
// D. New tokens use only characters with no look-alike in the set, and a typed
// token is compared after folding the usual confusions (O/0, I/L/1, Z/2, S/5,
// B/8), case, spaces and dashes — so the old hex tokens forgive the same
// mistakes. Pure: test/echocat-token-test.js.

const crypto = require('crypto');

// No 0 O 1 I L 2 Z 5 S 8 B (both halves of every confusable pair are out).
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const LENGTH = 6;

function generateToken(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const FOLD = { O: '0', I: '1', L: '1', Z: '2', S: '5', B: '8' };
function canonicalToken(t) {
  return String(t == null ? '' : t)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[OILZSB]/g, (c) => FOLD[c]);
}

/** Does what the operator typed match the stored token? */
function sameToken(typed, stored) {
  const a = canonicalToken(typed);
  const b = canonicalToken(stored);
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { ALPHABET, LENGTH, generateToken, canonicalToken, sameToken };
