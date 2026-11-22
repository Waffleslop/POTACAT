'use strict';
// Open a folder in Explorer / Finder / the file manager, making it first (#546).
//
// shell.openPath() on a folder that does not exist resolves with an error
// string and opens nothing, so an "Open folder" button that handed it a path
// straight did nothing at all. Every such button in main goes through here:
// the folder is made (recursive) off the main thread with a time limit, then
// opened, and a failure comes back as one sentence the window can show.
//
// openFolder(dir, { fsp, shell, timeoutMs, label })
//   -> { ok: true, dir, created }   created = the folder was missing and is now made
//   -> { ok: false, dir, error }    error = plain words for the operator

function reasonFor(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return 'POTACAT is not allowed to write there';
  if (code === 'ENOENT') return 'the drive or a folder above it is not there';
  if (code === 'ENOTDIR' || code === 'EEXIST') return 'a file with that name is in the way';
  if (code === 'EROFS') return 'that drive is read-only';
  if (code === 'ENOSPC') return 'that drive is full';
  return (err && err.message) || String(err || 'unknown error');
}

async function openFolder(dir, deps) {
  const { fsp, shell, timeoutMs = 5000, label = 'folder' } = deps || {};
  const name = String(label);
  if (!dir || typeof dir !== 'string') {
    return { ok: false, dir: dir || '', error: `POTACAT does not know where the ${name} is.` };
  }
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  let made;
  try {
    made = await Promise.race([fsp.mkdir(dir, { recursive: true }).then((first) => ({ first })), timeout]);
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, dir, error: `Could not make the ${name} ${dir}: ${reasonFor(err)}.` };
  }
  clearTimeout(timer);
  if (made === 'timeout') {
    return { ok: false, dir, error: `The ${name} ${dir} did not answer in ${Math.round(timeoutMs / 1000)} seconds. Check that its drive is connected.` };
  }
  let failure = '';
  try {
    failure = await shell.openPath(dir);
  } catch (err) {
    failure = (err && err.message) || String(err);
  }
  if (failure) {
    return { ok: false, dir, error: `Your computer could not open the ${name} ${dir}: ${failure}` };
  }
  // mkdir({ recursive: true }) returns the first folder it made, or undefined
  // when the whole path was already there.
  return { ok: true, dir, created: !!(made && made.first) };
}

module.exports = { openFolder, reasonFor };
