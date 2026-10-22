// Electron main for test/layout-alignment-test.js. Renders the REAL row
// builders (lib/spot-row.js, lib/decode-row.js) with the REAL stylesheets in
// hidden windows, measures every cell, and prints one JSON line:
//   LAYOUT_JSON:{...}
// Run by the test, not by hand: `npx electron test/layout/harness.js`.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const fx = require('./fixtures');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Each render opens and destroys its own window; with none left Electron
// starts quitting by default, which cancels the NEXT window's page load
// (ERR_FAILED -2 with no did-fail-load). The harness exits by itself.
app.on('window-all-closed', () => {});

// The JTCAT window's own styles: styles.css plus every inline <style> block.
function jtcatCss() {
  const html = read('renderer/jtcat-popout.html');
  const inline = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  return read('renderer/styles.css') + '\n' + inline;
}

const MEASURE = `
(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left * 10) / 10, top: Math.round(b.top * 10) / 10, width: Math.round(b.width * 10) / 10, height: Math.round(b.height * 10) / 10 }; };
  const out = {};
  for (const list of document.querySelectorAll('[data-list]')) {
    const rows = [...list.querySelectorAll(list.dataset.rowSelector)];
    out[list.dataset.list] = rows.map(row => ({
      id: row.dataset.fixture || '',
      box: r(row),
      cells: [...row.children].map(c => ({ cls: c.className, text: c.textContent, ...r(c) })),
    }));
  }
  return out;
})()`;

async function render(width, css, body, scripts) {
  const w = new BrowserWindow({ show: false, width, height: 900, webPreferences: { offscreen: true, sandbox: false } });
  const html = `<!doctype html><html${body.theme ? ` data-theme="${body.theme}"` : ''}><head><meta charset="utf-8">
<style>${css}</style>${scripts.map(s => `<script>${s}</script>`).join('')}</head><body>${body.html}</body></html>`;
  try {
    try {
      await w.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
    } catch (e) {
      if (process.env.LAYOUT_DUMP) fs.writeFileSync(process.env.LAYOUT_DUMP, html);
      throw new Error(`could not load the ${width}px page (${html.length} chars): ${e.message.slice(0, 60)}`);
    }
    await w.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    return await w.webContents.executeJavaScript(MEASURE);
  } finally {
    w.destroy();
  }
}

app.whenReady().then(async () => {
  const SpotRow = require(path.join(ROOT, 'lib', 'spot-row.js'));
  const DecodeRow = require(path.join(ROOT, 'lib', 'decode-row.js'));
  const libScripts = [read('lib/spot-row.js'), read('lib/decode-row.js')];
  const webCss = read('renderer/remote.css');
  const results = {};
  try {
    for (const theme of ['dark', 'light']) {
      for (const width of [390, 1100]) {
        // ECHOCAT Web spot table, two column sets.
        for (const [setName, colShow] of Object.entries(fx.COLUMN_SETS)) {
          const grid = SpotRow.computeSpotGrid(SpotRow.DEFAULT_COL_ORDER, colShow);
          const rows = fx.SPOTS.map(f => SpotRow.spotRowHtml(f.spot, f.v, { colOrder: SpotRow.DEFAULT_COL_ORDER, colShow })
            .replace('<div class="spot-card', `<div data-fixture="${f.id}" class="spot-card`)).join('');
          const body = { theme: theme === 'light' ? 'light' : '', html: `<div id="spot-list" data-list="spots" data-row-selector=".spot-card" style="--spot-grid:${grid}">${rows}</div>` };
          Object.assign(results, prefixKeys(await render(width, webCss, body, libScripts), `web-${theme}-${width}-${setName}-`));
        }
        // ECHOCAT Web FT8/FT4/FT2 decode list.
        const decodeRows = fx.DECODES.map(f => `<div class="ft8-row${f.tx ? ' ft8-tx' : ''}" data-fixture="${f.id}">${f.tx
          ? DecodeRow.txRowInner(f.text, 'ft8')
          : DecodeRow.webRowInner(f.d, f.d.text, f.badges || '', f.entity ? `<span class="ft8-entity">${f.entity}</span>` : '')}</div>`).join('');
        const dbody = { theme: theme === 'light' ? 'light' : '', html: `<div id="ft8-decode-log" data-list="decodes" data-row-selector=".ft8-row">${decodeRows}</div>` };
        Object.assign(results, prefixKeys(await render(width, webCss, dbody, libScripts), `web-${theme}-${width}-`));
      }
    }
    // Desktop JTCAT window: Band Activity (no time cell) and My Activity (time cell).
    for (const width of [520, 900]) {
      const band = fx.DECODES.map(f => `<div class="jp-row${f.tx ? ' jp-tx' : ''}" data-fixture="${f.id}">${f.tx
        ? DecodeRow.txRowInner(f.text, 'jp', '--')
        : DecodeRow.popoutRowInner(f.d, { text: f.d.text, badgesHtml: f.badges || '', entityHtml: f.entity ? `<span class="jp-entity">${f.entity}</span>` : '' })}</div>`).join('');
      const mine = fx.DECODES.filter(f => !f.tx).map(f => `<div class="jp-row jp-cq" data-fixture="${f.id}">${DecodeRow.popoutRowInner(f.d, { time: '12:30:45', text: f.d.text })}</div>`).join('');
      const body = { html: `<div id="jp-band-activity" data-list="band" data-row-selector=".jp-row">${band}</div><div id="jp-my-activity" data-list="mine" data-row-selector=".jp-row">${mine}</div>` };
      Object.assign(results, prefixKeys(await render(width, jtcatCss(), body, libScripts), `jtcat-${width}-`));
    }
    process.stdout.write('LAYOUT_JSON:' + JSON.stringify(results) + '\n');
  } catch (e) {
    process.stdout.write('LAYOUT_ERROR:' + (e && e.stack || e) + '\n');
  }
  app.exit(0);
});

function prefixKeys(obj, prefix) {
  const out = {};
  for (const k of Object.keys(obj)) out[prefix + k] = obj[k];
  return out;
}
