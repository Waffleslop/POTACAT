'use strict';
// lib/gpu-status.js — one session-log line with the GPU state Chromium gave
// POTACAT (#773). "WebGL2 is not available" in the scope, Winlink and SSTV
// waterfalls comes from the PC's graphics driver; without this line a bug
// report cannot tell a blocklisted GPU from a disabled one.
//
// Pure: main passes app.getGPUFeatureStatus() and
// app.isHardwareAccelerationEnabled(); no Electron here.

/** The features that decide whether a waterfall can draw. */
const FEATURES = ['webgl', 'webgl2', 'gpu_compositing'];

function featureValue(status, key) {
  const v = status && typeof status === 'object' ? status[key] : undefined;
  return v == null || v === '' ? 'unknown' : String(v).replace(/\s+/g, '_');
}

/**
 * "[GPU] webgl=enabled webgl2=enabled gpu_compositing=enabled hardware_acceleration=on"
 * @param {object} status   app.getGPUFeatureStatus() (may be null if it threw)
 * @param {boolean|null} hwAccel  app.isHardwareAccelerationEnabled(); null = unknown
 */
function formatGpuStatusLine(status, hwAccel) {
  const parts = FEATURES.map((k) => `${k}=${featureValue(status, k)}`);
  parts.push(`hardware_acceleration=${hwAccel === true ? 'on' : hwAccel === false ? 'off (disabled)' : 'unknown'}`);
  return '[GPU] ' + parts.join(' ');
}

/** The line a waterfall window logs when it has no WebGL2. */
function formatNoWebgl2Line(windowName) {
  return `[GPU] ${windowName || 'A window'}: WebGL2 is not available, the waterfall cannot be drawn`;
}

module.exports = { FEATURES, formatGpuStatusLine, formatNoWebgl2Line };
