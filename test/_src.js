'use strict';
/**
 * Read a repo file as text with LF line endings, for every test that reads
 * source (main.js, renderer/*, lib/*) or a text fixture.
 *
 * Casey's checkout uses core.autocrlf=true, so files are CRLF on disk there,
 * and source-text tests that split on "\n" or match "...;\n  else ..." failed
 * there while passing in an LF worktree: the suite had never run clean on the
 * real checkout (review of the 1.13.11 chain). Normalising here makes every
 * test see the same text on both. The encoding argument is accepted and
 * ignored (always UTF-8).
 */
const fs = require('fs');

function readSrc(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

module.exports = { readSrc };
