'use strict';
// Sound-card PTT through a CM108 GPIO (Digirig Lite + Baofeng, 2026-10-23).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/cm108-ptt');
assert.deepStrictEqual(C.report(true, 3), [0x00, 0x04, 0x04, 0x00], 'GPIO3 key — the bytes Dire Wolf/Hamlib write');
assert.deepStrictEqual(C.report(false, 3), [0x00, 0x00, 0x04, 0x00], 'GPIO3 unkey');
assert.deepStrictEqual(C.report(true, 1), [0x00, 0x01, 0x01, 0x00]);
assert.deepStrictEqual(C.report(true, 99), C.report(true, 3), 'a bad pin falls back to GPIO3');
assert.ok(C.isCm108(0x0d8c, 0x0012) && C.isCm108(0x0c76, 0x1605) && !C.isCm108(0x0c76, 0x0001) && !C.isCm108(0x046d, 1));
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
assert.ok(/if \(target\.ptt === 'cm108'\) \{[\s\S]{0,300}webContents\.send\('cm108-ptt'/.test(main), 'handleRemotePtt keys the sound card');
assert.ok(/setDevicePermissionHandler\(\(d\) => d\.deviceType === 'hid' && !!\(d\.device && Cm108Ptt\.isCm108/.test(main), 'only C-Media/SSS devices are granted');
assert.ok(/dev\.sendReport\(0, new Uint8Array\(window\.Cm108Ptt\.report\(state, gpio\)\)\)/.test(app));
assert.ok(/return \{ type: 'none', ptt: 'cm108', gpio:/.test(app), 'saved on the rig');
console.log('CM108 PTT: 9 passed, 0 failed');
