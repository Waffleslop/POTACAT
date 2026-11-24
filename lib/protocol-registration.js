'use strict';
/**
 * Who may claim the potacat:// link handler (Casey, 2026-11-22).
 *
 * Every start used to call app.setAsDefaultProtocolClient('potacat') with no
 * arguments. In a development run that registers the bare Electron runtime
 * with no app folder ("electron.exe" "%1"), and because each worktree has its
 * own electron.exe, whichever development run started last took the handler:
 * on 2026-11-22 a scratch run in a worktree held it, so a potacat:// link
 * would have opened a blank Electron window instead of Casey's POTACAT.
 *
 * Rules:
 *  - a packaged POTACAT registers as before (no arguments);
 *  - a development run registers only when it uses the default user data
 *    folder (no --user-data-dir) and is not a git worktree, and then with its
 *    app path, so the command is "electron.exe" "<app folder>" "%1";
 *  - a worktree run or a scratch/test run (its own --user-data-dir) never
 *    claims it.
 */
const path = require('path');

/**
 * @param {object} o
 * @param {boolean} o.isPackaged
 * @param {string} o.execPath          process.execPath
 * @param {string} o.appPath           app.getAppPath() (the app folder in a dev run)
 * @param {string} o.userDataPath      app.getPath('userData')
 * @param {string} o.defaultUserDataPath  path.join(app.getPath('appData'), app.getName())
 * @param {boolean} o.hasUserDataSwitch   app.commandLine.hasSwitch('user-data-dir')
 * @param {boolean} o.appIsWorktree    the app folder's .git is a file (git worktree)
 * @returns {{ register: false, why: string } | { register: true, path?: string, args?: string[] }}
 */
function decideProtocolRegistration(o) {
  if (o.isPackaged) return { register: true };
  if (o.hasUserDataSwitch) return { register: false, why: 'a development run with its own user data folder' };
  const same = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
  if (!o.userDataPath || !same(o.userDataPath, o.defaultUserDataPath)) return { register: false, why: 'a development run with its own user data folder' };
  if (o.appIsWorktree) return { register: false, why: 'a development run from a git worktree' };
  if (!o.execPath || !o.appPath) return { register: false, why: 'a development run without its app path' };
  return { register: true, path: o.execPath, args: [path.resolve(o.appPath)] };
}

module.exports = { decideProtocolRegistration };
