// Runs before `electron .` in `npm start`. On Windows, switch the console
// the app will print into to UTF-8 (code page 65001). POTACAT's log lines are
// UTF-8 ("→", "—"); a console left on the OEM code page (437) shows each one
// as three wrong characters — "ΓåÆ" for an arrow, "ΓÇö" for a dash.
// session.log was always correct; only the terminal misread it.
//
// This has to happen HERE, in a console-subsystem process: electron.exe is a
// GUI-subsystem binary, so a chcp spawned from the main process can land in
// a new hidden console instead of the terminal's. The code page belongs to
// the console, not the process, so it holds after this script exits.
// No-op everywhere but Windows; never fails the start.
if (process.platform === 'win32') {
  try {
    require('child_process').spawnSync('chcp.com', ['65001'], { stdio: 'ignore' });
  } catch {}
}
