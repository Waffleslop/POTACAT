// COMMENT-tag handling for logged QSOs (logCommentTags toggle + double-tag fix).
// Regression for KE4EST (tags out of COMMENT) and the phone-path double-tag.
// Run: node test/log-comment-test.js
'use strict';

const assert = require('assert');
const { stripSigTag, appendTag, ensureSigTag } = require('../lib/log-comment');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function eq(a, b, label) { check(a === b, `${label} → "${a}"`); }

console.log('stripSigTag removes the auto tag wherever it sits:');
eq(stripSigTag('note [POTA US-1234]', 'POTA', 'US-1234'), 'note', 'trailing short tag (desktop)');
eq(stripSigTag('[POTA US-1234] note', 'POTA', 'US-1234'), 'note', 'leading short tag (phone) — the bug');
eq(stripSigTag('note [POTA US-1234 US-GA Sweetwater Creek]', 'POTA', 'US-1234'), 'note', 'trailing FULL tag');
eq(stripSigTag('[POTA US-1234] note [POTA US-1234 US-GA Name]', 'POTA', 'US-1234'), 'note', 'BOTH tags (phone double-tag) stripped');
eq(stripSigTag('[POTA US-1234]', 'POTA', 'US-1234'), '', 'tag-only → empty');
eq(stripSigTag('', 'POTA', 'US-1234'), '', 'empty comment → empty');

console.log('stripSigTag is precise — leaves the operator\'s own brackets alone:');
eq(stripSigTag('[home station] hi', 'POTA', 'US-1234'), '[home station] hi', 'unrelated leading bracket kept');
eq(stripSigTag('gm [test] [POTA US-9999]', 'POTA', 'US-9999'), 'gm [test]', 'user bracket kept, auto tag removed');
eq(stripSigTag('note [SOTA W7/CF-001]', 'POTA', 'US-1234'), 'note [SOTA W7/CF-001]', 'different sig/ref not touched');
eq(stripSigTag('note', '', ''), 'note', 'no sig/sigInfo → passthrough (trimmed)');

console.log('appendTag joins cleanly:');
eq(appendTag('note', '[POTA US-1234 US-GA Name]'), 'note [POTA US-1234 US-GA Name]', 'base + tag');
eq(appendTag('', '[POTA US-1234]'), '[POTA US-1234]', 'empty base → tag only');
eq(appendTag('note', ''), 'note', 'no tag → base only');
eq(appendTag('', ''), '', 'both empty → empty');

console.log('end-to-end: strip-then-append models saveQsoRecord (ON), strip-only (OFF):');
{
  // ON, desktop: renderer put "note [POTA US-1234]", DB has the park.
  const on = appendTag(stripSigTag('note [POTA US-1234]', 'POTA', 'US-1234'), '[POTA US-1234 US-GA Sweetwater Creek]');
  eq(on, 'note [POTA US-1234 US-GA Sweetwater Creek]', 'ON: single canonical tag, no duplication');
  // ON, phone double-tag input collapses to one tag.
  const onPhone = appendTag(stripSigTag('[POTA US-1234] note', 'POTA', 'US-1234'), '[POTA US-1234 US-GA Sweetwater Creek]');
  eq(onPhone, 'note [POTA US-1234 US-GA Sweetwater Creek]', 'ON phone: no leading survivor');
  // OFF: strip, append nothing → operator text only.
  const off = appendTag(stripSigTag('[POTA US-1234] note', 'POTA', 'US-1234'), '');
  eq(off, 'note', 'OFF: comment is exactly what the operator typed');
}

console.log('ensureSigTag keeps the park in comment-only transports (WRL — N3VD):');
eq(ensureSigTag('TEST TEST TEST', 'POTA', 'US-7413'), 'TEST TEST TEST [POTA US-7413]', 'tags OFF: short tag appended for the WRL packet');
eq(ensureSigTag('', 'POTA', 'US-7413'), '[POTA US-7413]', 'empty comment → tag only');
eq(ensureSigTag('note [POTA US-7413 US-TX Name]', 'POTA', 'US-7413'), 'note [POTA US-7413 US-TX Name]', 'tags ON: full tag already there → untouched');
eq(ensureSigTag('worked him at us-7413', 'POTA', 'US-7413'), 'worked him at us-7413', 'operator already typed the ref (any case) → untouched');
eq(ensureSigTag('plain ragchew', '', ''), 'plain ragchew', 'no sig/sigInfo → passthrough');
eq(ensureSigTag(null, 'POTA', 'US-7413'), '[POTA US-7413]', 'null comment → tag only');

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'log-comment tests failed');
