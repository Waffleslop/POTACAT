'use strict';
// Linux Chromium-sandbox compatibility decision (GitHub issue #37).
//
// Chromium prefers the unprivileged-user-namespace sandbox; the
// setuid-root chrome-sandbox helper is only a legacy fallback. Two
// system policies can deny userns to the app:
//
//   - Ubuntu 23.10+ ships kernel.apparmor_restrict_unprivileged_userns=1,
//     which denies userns to UNCONFINED binaries. Our deb/rpm ship an
//     AppArmor profile granting it (electron-builder 26+ does this by
//     default: templates/linux/apparmor-profile.tpl installed to
//     /etc/apparmor.d/<executable>), so installed copies get the full
//     sandbox with NO setuid binary. But an AppImage (FUSE-mounted,
//     path varies — can't be profiled, mount is nosuid), a dev run, or
//     an extracted dir has no profile: Chromium aborts with "chrome-
//     sandbox needs mode 4755", which reads like we require setuid root.
//
//   - Hardened Debian: kernel.unprivileged_userns_clone=0 denies userns
//     to all unprivileged processes regardless of AppArmor. Worse, the
//     deb postinst's fallback test (`unshare --user true`) runs as ROOT
//     — root can always create namespaces — so it wrongly leaves the
//     helper at 0755 and the installed app aborts on launch.
//
// decideSandboxFallback() returns 'no-sandbox' ONLY for configurations
// that would otherwise abort at launch: userns denied to this binary
// AND no usable setuid helper. Everything else returns 'ok' and the
// default (sandboxed) behavior is untouched.

/**
 * Pure decision — all environment probes are passed in so the matrix is
 * unit-testable off-Linux.
 *
 * @param {object} env
 * @param {boolean} env.apparmorRestricted  apparmor_restrict_unprivileged_userns == 1
 * @param {boolean} env.usernsDisabled      unprivileged_userns_clone == 0
 * @param {string}  env.execPath            process.execPath
 * @param {boolean} env.profileExists       /etc/apparmor.d/<basename(execPath)> exists
 * @param {boolean} env.isAppImage          process.env.APPIMAGE is set
 * @param {{uid:number, mode:number}|null} env.sandboxStat  stat of chrome-sandbox next to the binary, or null
 * @returns {{action:'ok'|'no-sandbox', reason:string}}
 */
function decideSandboxFallback(env) {
  let usernsDenied = !!env.usernsDisabled;
  let why = usernsDenied ? 'kernel.unprivileged_userns_clone=0' : '';
  if (!usernsDenied && env.apparmorRestricted) {
    // Denied unless an AppArmor profile grants userns to OUR binary.
    // The deb/rpm profile attaches to /opt/<product>/<executable>; a
    // matching file in /etc/apparmor.d plus an /opt path is the signal
    // that this install is covered.
    const profiled = String(env.execPath || '').startsWith('/opt/') && !!env.profileExists;
    if (!profiled) {
      usernsDenied = true;
      why = 'apparmor_restrict_unprivileged_userns=1 and no AppArmor profile covers this binary';
    }
  }
  if (!usernsDenied) return { action: 'ok', reason: 'user namespaces available' };

  // The setuid helper can still provide the sandbox — but never inside
  // an AppImage (the FUSE mount is nosuid even when the bits are set),
  // and only when it's actually root-owned with the setuid bit.
  const st = env.sandboxStat;
  const suidOk = !env.isAppImage && !!st && st.uid === 0 && (st.mode & 0o4000) !== 0;
  if (suidOk) return { action: 'ok', reason: why + ' but setuid chrome-sandbox is configured' };

  return { action: 'no-sandbox', reason: why + ', no usable setuid chrome-sandbox' };
}

/** Probe the live system (Linux only) and return the env for the decision. */
function gatherSandboxEnv(fs, path, process_) {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
  const execPath = process_.execPath || '';
  let sandboxStat = null;
  try {
    const st = fs.statSync(path.join(path.dirname(execPath), 'chrome-sandbox'));
    sandboxStat = { uid: st.uid, mode: st.mode };
  } catch { /* helper missing (dev runs sometimes) */ }
  return {
    apparmorRestricted: read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1',
    usernsDisabled: read('/proc/sys/kernel/unprivileged_userns_clone') === '0',
    execPath,
    profileExists: (() => {
      try { return fs.existsSync('/etc/apparmor.d/' + path.basename(execPath)); } catch { return false; }
    })(),
    isAppImage: !!process_.env.APPIMAGE,
    sandboxStat,
  };
}

module.exports = { decideSandboxFallback, gatherSandboxEnv };
