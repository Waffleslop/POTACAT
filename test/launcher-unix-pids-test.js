'use strict';
// Remote Launcher on Linux/macOS: the tray launcher (potacat.bin --launcher)
// and its Chromium helpers must not count as "POTACAT is running", and a real
// app next to them must (Discord report by edenundo, 2026-11-26).
const assert = require('assert');
const { unixAppPidsFromPs } = require('../scripts/launcher.js');
const ME = 100;

const linuxLauncherOnly = `
    1     0 /sbin/init
  100  1500 /opt/POTACAT/potacat.bin --launcher
  101   100 /opt/POTACAT/potacat.bin --type=zygote --no-zygote-sandbox
  102   101 /opt/POTACAT/potacat.bin --type=gpu-process --ozone-platform=x11
  103   100 /opt/POTACAT/potacat.bin --type=utility --utility-sub-type=network.mojom.NetworkService
  104   101 /opt/POTACAT/potacat.bin --type=zygote
 2000     1 bash
`;
assert.deepStrictEqual(unixAppPidsFromPs(linuxLauncherOnly, ME, false), [], 'linux: launcher and its helpers are not the app');

const linuxWithApp = linuxLauncherOnly + `
 3000  1500 /opt/POTACAT/potacat.bin
 3001  3000 /opt/POTACAT/potacat.bin --type=zygote
 3002  3000 /opt/POTACAT/potacat.bin --type=renderer
 3003  3001 /opt/POTACAT/potacat.bin --type=gpu-process
 3010  3000 /usr/bin/rigctld -m 1 -r /dev/ttyUSB0
`;
const lin = unixAppPidsFromPs(linuxWithApp, ME, false);
assert.strictEqual(lin[0], 3000, 'linux: the app main process is named first');
assert.deepStrictEqual([...lin].sort(), [3000, 3001, 3002, 3003], 'linux: only the app tree, not the launcher, not rigctld');
assert.ok(!lin.some(p => p >= 100 && p <= 104));

// Launcher run as Electron-as-Node on launcher.js: itself only.
assert.deepStrictEqual(unixAppPidsFromPs(`  100  1 /opt/POTACAT/potacat.bin /home/u/.config/POTACAT/launcher.js\n`, ME, false), []);
// Launcher under system node, app beside it.
assert.deepStrictEqual(unixAppPidsFromPs(`  100  1 node /home/u/.config/POTACAT/launcher.js\n  200 1 potacat.bin\n`, ME, false), [200]);
// Other launchers (not us) and their helpers are never the app.
assert.deepStrictEqual(unixAppPidsFromPs(`  900 1 /opt/POTACAT/potacat.bin --launcher\n  901 900 /opt/POTACAT/potacat.bin --type=gpu-process\n`, ME, false), []);
assert.deepStrictEqual(unixAppPidsFromPs('', ME, false), []);

const macLauncherOnly = `
    1     0 /sbin/launchd
  100   300 /Applications/POTACAT.app/Contents/MacOS/POTACAT --launcher
  101   100 /Applications/POTACAT.app/Contents/Frameworks/POTACAT Helper (GPU).app/Contents/MacOS/POTACAT Helper (GPU) --type=gpu-process
  102   100 /Applications/POTACAT.app/Contents/Frameworks/POTACAT Helper.app/Contents/MacOS/POTACAT Helper --type=utility
`;
assert.deepStrictEqual(unixAppPidsFromPs(macLauncherOnly, ME, true), [], 'mac: launcher and helpers are not the app');
const macWithApp = macLauncherOnly + `
 4000   300 /Applications/POTACAT.app/Contents/MacOS/POTACAT
 4001  4000 /Applications/POTACAT.app/Contents/Frameworks/POTACAT Helper (GPU).app/Contents/MacOS/POTACAT Helper (GPU) --type=gpu-process
`;
assert.deepStrictEqual(unixAppPidsFromPs(macWithApp, ME, true), [4000], 'mac: only the app main (helpers are not matched by name, as before)');

console.log('launcher-unix-pids-test: ok');
