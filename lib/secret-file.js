'use strict';
/**
 * Files that hold a private key or a secret (the ECHOCAT TLS key, settings
 * with passwords and tokens) are readable by their owner only: mode 0600.
 *
 * On Linux and macOS a plain writeFileSync leaves a new file at 0644 (under
 * the usual umask), readable by every account on the computer. Windows keeps
 * per-user profile folders private through ACLs and ignores POSIX modes, so
 * the chmod is skipped there; the mode option is still passed (harmless).
 *
 * `mode` on writeFileSync applies only when the file is created, so an
 * existing file is chmod'ed as well.
 */
const nodeFs = require('fs');

const SECRET_MODE = 0o600;

/** chmod an existing file to 0600 (POSIX only). Never throws; returns true when it changed the mode. */
function tightenSecretFile(p, opts = {}) {
  const fs = opts.fs || nodeFs;
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return false;
  try {
    const st = fs.statSync(p);
    if ((st.mode & 0o777) === SECRET_MODE) return false;
    fs.chmodSync(p, SECRET_MODE);
    return true;
  } catch { return false; }
}

/** writeFileSync with mode 0600, then chmod in case the file already existed. Throws like writeFileSync. */
function writeSecretFile(p, data, opts = {}) {
  const fs = opts.fs || nodeFs;
  fs.writeFileSync(p, data, { mode: SECRET_MODE });
  tightenSecretFile(p, opts);
}

module.exports = { SECRET_MODE, tightenSecretFile, writeSecretFile };
