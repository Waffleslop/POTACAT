#!/usr/bin/env node
'use strict';
/**
 * #773: the GPU state is in the session log, so a Report a Bug for
 * "WebGL2 is not available" shows whether the PC's GPU gave WebGL2 at all.
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('lib/gpu-status.js');
let G = null;
try { G = require('../lib/gpu-status'); } catch (e) { /* the checks below fail */ }
check('the module exists', () => assert.ok(G, 'lib/gpu-status.js'));
check('one line: webgl, webgl2, gpu_compositing and hardware acceleration', () => {
  const l = G.formatGpuStatusLine({ webgl: 'enabled', webgl2: 'unavailable_software', gpu_compositing: 'disabled_software', rasterization: 'x' }, true);
  assert.strictEqual(l, '[GPU] webgl=enabled webgl2=unavailable_software gpu_compositing=disabled_software hardware_acceleration=on');
  assert.ok(!/\n/.test(l));
});
check('hardware acceleration off, and a status that threw, still make a line', () => {
  assert.strictEqual(G.formatGpuStatusLine(null, false), '[GPU] webgl=unknown webgl2=unknown gpu_compositing=unknown hardware_acceleration=off (disabled)');
  assert.ok(/hardware_acceleration=unknown$/.test(G.formatGpuStatusLine({}, null)));
});
check('the scope window line names the window', () => {
  assert.strictEqual(G.formatNoWebgl2Line('Band Scope'), '[GPU] Band Scope: WebGL2 is not available, the waterfall cannot be drawn');
});

console.log('Wiring');
const main = readSrc(path.join(ROOT, 'main.js'));
const preload = readSrc(path.join(ROOT, 'preload-scope-popout.js'));
const popout = readSrc(path.join(ROOT, 'renderer/scope-popout.js'));
check('main logs the GPU line once at startup, after app ready', () => {
  const ready = main.indexOf("logStartupStage('app.whenReady fired');");
  const at = main.indexOf('GpuStatus.formatGpuStatusLine(');
  assert.ok(ready > 0 && at > ready, 'after app.whenReady');
  assert.strictEqual(main.split('GpuStatus.formatGpuStatusLine(').length, 2, 'once');
  assert.ok(/app\.getGPUFeatureStatus\(\)/.test(main));
  assert.ok(/app\.isHardwareAccelerationEnabled\(\)/.test(main));
});
check('the scope window reports no WebGL2 to main, which logs it', () => {
  assert.ok(/if \(!wf\.supported\) \{[^\n]*window\.api\.reportNoWebgl2\(\)/.test(popout));
  assert.ok(/reportNoWebgl2: \(\) => ipcRenderer\.send\('scope-no-webgl2'\)/.test(preload));
  assert.ok(/ipcMain\.on\('scope-no-webgl2', \(\) => sendCatLog\(GpuStatus\.formatNoWebgl2Line\('Band Scope'\)\)\);/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
