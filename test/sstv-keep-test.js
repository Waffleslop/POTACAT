'use strict';
// A weak SSTV decode can look perfect (the gate judges sync pulses, not the
// picture), so the operator can Keep it (Barbara in Maine, 2026-10-23).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = rd('renderer/sstv-popout.html'), js = rd('renderer/sstv-popout.js'), pre = rd('preload-sstv-popout.js'), main = rd('main.js');
assert.ok(/id="rx-keep-btn"/.test(html), 'Keep button on the RX picture');
assert.ok(/keepBtn\.style\.display = \(data\.weak && !data\.saved\) \? '' : 'none';/.test(js), 'shown only for an unsaved weak decode');
assert.ok(/sstvKeepImage: \(d\) => ipcRenderer\.invoke\('sstv-keep-image', d\)/.test(pre));
assert.ok(/ipcMain\.handle\('sstv-keep-image'[\s\S]{0,400}saveSstvImage\(\{[^}]*weak: false \}\)/.test(main), 'saved as a normal picture');
assert.ok(/d\.imageData\.length !== d\.width \* d\.height \* 4/.test(main), 'the size is checked before writing');
console.log('SSTV Keep: 5 passed, 0 failed');
