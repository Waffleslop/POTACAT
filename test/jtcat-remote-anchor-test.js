'use strict';
// LZ3AW 2026-10-23: web JTCAT TX started after the first spot click and never
// after the second or a typed frequency — the wrong-band guard's anchor did not
// follow ECHOCAT tunes, and its refusal reached only the desktop pop-out.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const at = main.indexOf("remoteServer.on('tune', ({ freqKhz, mode, bearing }) => {");
assert.ok(at > 0);
const body = main.slice(at, main.indexOf("remoteServer.on('ptt'", at));
assert.ok(/if \(_jtcatExpectedDialHz > 0 && \(!mode \|\| \/\^\(FT8\|FT4\|FT2\|DIGU/.test(body), 'an ECHOCAT digital or typed tune moves the anchor');
assert.ok(/_jtcatExpectedDialHz = hz;/.test(body));
assert.ok(/remoteServer\.broadcastJtcatQsoState\(\{ phase: 'error', error: dialMsg \}\)/.test(main), 'the refusal reaches the device');
console.log('JTCAT remote anchor: 3 passed, 0 failed');
