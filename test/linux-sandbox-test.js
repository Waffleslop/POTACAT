// decideSandboxFallback — decision matrix for GitHub issue #37.
// The fallback must fire ONLY in configurations that would otherwise
// abort at launch ("chrome-sandbox needs 4755"), and never weaken a
// system where either Chromium sandbox works.
// Run: node test/linux-sandbox-test.js

'use strict';

const { decideSandboxFallback } = require('../lib/linux-sandbox');

let passed = 0, failed = 0;
function check(env, expected, label) {
  const v = decideSandboxFallback(env);
  if (v.action === expected) { passed++; console.log('  ✓ ' + label + ' → ' + v.action); }
  else { failed++; console.log(`  ✗ FAIL: ${label} (expected ${expected}, got ${v.action} — ${v.reason})`); }
}

const SUID = { uid: 0, mode: 0o104755 };   // root-owned, setuid
const PLAIN = { uid: 0, mode: 0o100755 };  // root-owned, no setuid
const USER = { uid: 1000, mode: 0o104755 }; // setuid bit but not root-owned

console.log('=== linux sandbox fallback matrix ===');

// Normal modern distro: userns available → never touch anything.
check({ apparmorRestricted: false, usernsDisabled: false, execPath: '/opt/POTACAT/POTACAT', profileExists: false, isAppImage: false, sandboxStat: PLAIN },
  'ok', 'unrestricted system (Fedora/Arch/Pi OS), deb install');
check({ apparmorRestricted: false, usernsDisabled: false, execPath: '/home/u/Apps/x.AppImage.mount/potacat', profileExists: false, isAppImage: true, sandboxStat: null },
  'ok', 'unrestricted system, AppImage');

// Ubuntu 24.04 (apparmor restriction):
check({ apparmorRestricted: true, usernsDisabled: false, execPath: '/opt/POTACAT/POTACAT', profileExists: true, isAppImage: false, sandboxStat: PLAIN },
  'ok', 'Ubuntu 24.04 deb WITH AppArmor profile — namespace sandbox works');
check({ apparmorRestricted: true, usernsDisabled: false, execPath: '/tmp/.mount_potacat/potacat', profileExists: false, isAppImage: true, sandboxStat: SUID },
  'no-sandbox', 'Ubuntu 24.04 AppImage (mshappe scenario) — suid bits meaningless on nosuid FUSE mount');
check({ apparmorRestricted: true, usernsDisabled: false, execPath: '/home/u/dev/node_modules/electron/dist/electron', profileExists: false, isAppImage: false, sandboxStat: PLAIN },
  'no-sandbox', 'Ubuntu 24.04 dev run (npm start) — no profile, no suid');
check({ apparmorRestricted: true, usernsDisabled: false, execPath: '/home/u/potacat-extracted/POTACAT', profileExists: false, isAppImage: false, sandboxStat: SUID },
  'ok', 'Ubuntu 24.04 extracted dir where user opted in to setuid helper');

// Hardened Debian (userns_clone=0): the AppArmor profile cannot help.
check({ apparmorRestricted: false, usernsDisabled: true, execPath: '/opt/POTACAT/POTACAT', profileExists: true, isAppImage: false, sandboxStat: PLAIN },
  'no-sandbox', 'hardened Debian deb — postinst root-test left helper 0755');
check({ apparmorRestricted: false, usernsDisabled: true, execPath: '/opt/POTACAT/POTACAT', profileExists: true, isAppImage: false, sandboxStat: SUID },
  'ok', 'hardened Debian deb with operator-opted setuid helper');

// Guards on the suid check itself:
check({ apparmorRestricted: true, usernsDisabled: false, execPath: '/x/POTACAT', profileExists: false, isAppImage: false, sandboxStat: USER },
  'no-sandbox', 'setuid bit without root ownership is not a usable helper');
check({ apparmorRestricted: true, usernsDisabled: false, execPath: '/x/POTACAT', profileExists: false, isAppImage: false, sandboxStat: null },
  'no-sandbox', 'missing chrome-sandbox helper');

// A profile on disk does not cover a binary outside /opt (profile is
// path-attached to /opt/<product>/<executable>).
check({ apparmorRestricted: true, usernsDisabled: false, execPath: '/home/u/POTACAT', profileExists: true, isAppImage: false, sandboxStat: PLAIN },
  'no-sandbox', 'profile exists but binary runs outside /opt — not covered');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
