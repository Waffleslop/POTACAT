'use strict';
// How long a CW message really takes on the air, in standard Morse timing:
// dit 1, dah 3, 1 between elements, 3 between characters, 7 between words.
// The older 10-dits-a-character figure is fair for plain language and short
// for calls and digits (a 0 is 22 dits with its gap).

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..',
  J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....',
  7: '--...', 8: '---..', 9: '----.', '?': '..--..', '=': '-...-', '/': '-..-.', '.': '.-.-.-',
  ',': '--..--', '-': '-....-', '+': '.-.-.',
};

function cwAirtimeMs(text, wpm) {
  const ditMs = 1200 / Math.max(5, Number(wpm) || 20);
  let dits = 0;
  for (const word of String(text || '').toUpperCase().split(/\s+/).filter(Boolean)) {
    if (dits) dits += 7;
    for (let i = 0; i < word.length; i++) {
      if (i) dits += 3;
      const code = MORSE[word[i]];
      if (!code) { dits += 10; continue; }
      for (let k = 0; k < code.length; k++) dits += (code[k] === '-' ? 3 : 1) + (k ? 1 : 0);
    }
  }
  return Math.ceil(dits * ditMs);
}

module.exports = { cwAirtimeMs };
