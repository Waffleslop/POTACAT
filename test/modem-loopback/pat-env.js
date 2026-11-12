'use strict';
// The environment every test Pat runs in (#425): nothing of the PC's own Pat,
// and nothing reaching winlink.org.
//
// Pat keeps state outside --config/--mbox: XDG_STATE_HOME/pat (on Windows
// %LOCALAPPDATA%\pat by default; adrg/xdg v0.5.3 honours XDG_* on every OS).
// Before every connect upstream Pat asks winlink.org whether the callsign has
// an account (app/connect.go:46 promptUnconfirmedAccount) and, with no answer
// and an empty mailbox, waits up to 2 minutes for the operator to confirm. It
// skips that for 100 days after a confirmation stored as
// ".account-confirmed_<CALL>.json", and its daily version report the same way
// (".version_report_<CALL>.json"; app/winlink_api.go DoIfElapsed). So each
// test gets its own XDG folders with those two files written for the
// placeholder calls, and a web proxy on a closed port for anything else.

const fs = require('fs');
const path = require('path');

const ENV_NAME = 'POTACAT_ARDOP_ARQ_TIMEOUT';

function patTestEnv(dir, calls) {
  // Absolute, always: adrg/xdg ignores a relative XDG_* (as the XDG spec says) and falls back to the
  // PC's own folder. CI passes --logs as a relative path (winlink-helpers run 43312317124: every Pat
  // sat at the account prompt).
  dir = path.resolve(dir);
  const xdg = { XDG_STATE_HOME: path.join(dir, 'xdg-state'), XDG_DATA_HOME: path.join(dir, 'xdg-data'), XDG_CONFIG_HOME: path.join(dir, 'xdg-config') };
  for (const d of Object.values(xdg)) if (!path.isAbsolute(d)) throw new Error(`pat-env: ${d} is not absolute`);
  for (const d of Object.values(xdg)) fs.mkdirSync(path.join(d, 'pat'), { recursive: true });
  const now = JSON.stringify(new Date().toISOString()) + '\n';
  for (const call of calls) {
    for (const name of ['account-confirmed', 'version_report']) fs.writeFileSync(path.join(xdg.XDG_STATE_HOME, 'pat', `.${name}_${call}.json`), now);
  }
  const proxy = 'http://127.0.0.1:9';
  const env = { ...process.env, ...xdg, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  delete env[ENV_NAME];
  return env;
}

module.exports = { patTestEnv };
