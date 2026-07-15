// Entry point for scripts/shot-mercury-phase1.mjs: point userData at the
// driver's throwaway dir BEFORE main.js runs (same trick as psk-macros-entry).
const { app } = require('electron');
const path = require('path');
if (!process.env.POTACAT_TEST_UD) throw new Error('POTACAT_TEST_UD not set');
app.setPath('userData', process.env.POTACAT_TEST_UD);
require(path.join(__dirname, '..', 'main.js'));
