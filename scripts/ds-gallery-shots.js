// Electron main: render renderer/ds-gallery.html in every theme (and Large
// font + touch density for the default theme) and write full-page PNGs.
// Run: npx electron scripts/ds-gallery-shots.js <outDir> [width]
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || path.join(__dirname, '..', 'ds-shots');
const width = parseInt(process.argv[3], 10) || 1100;
const SHOTS = [
  { name: 'night', q: 'ds=night' },
  { name: 'dark', q: 'ds=dark' },
  { name: 'acid', q: 'ds=acid' },
  { name: 'light', q: 'ds=light' },
  { name: 'night-large-touch', q: 'ds=night&scale=1.3&density=touch' },
];

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(__dirname, '..', 'renderer', 'ds-gallery.html');
  for (const s of SHOTS) {
    const w = new BrowserWindow({ show: false, width, height: 900, webPreferences: { offscreen: false, sandbox: true } });
    await w.loadFile(file, { search: s.q });
    const h = await w.webContents.executeJavaScript('document.documentElement.scrollHeight');
    const dbg = await w.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(outDir, s.name + '.png'), Buffer.from(shot.data, 'base64'));
    const overflow = await w.webContents.executeJavaScript(`[...document.querySelectorAll('.ds-btn,.ds-pill,.ds-chip,.ds-tag,.ds-tab,.ds-tool,.ds-macro,.ds-action,.ds-spotrow__call,.ds-spotrow__freq')].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis').map(e => e.className + ': ' + e.textContent.trim()).slice(0, 20)`);
    console.log(s.name, h + 'px', overflow.length ? 'OVERFLOW ' + JSON.stringify(overflow) : 'no overflow');
    dbg.detach();
    w.destroy();
  }
  app.exit(0);
});
