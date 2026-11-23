'use strict';
// The frame every visible POTACAT window opens with (#345).
//
// POTACAT draws its own title bar, so its windows are frameless. On macOS they
// use titleBarStyle 'hiddenInset' so the system traffic lights stay (#866). On
// Linux a frameless window has no window-manager title bar, so its window menu
// (move to another workspace, always on top) is missing; the operator can opt
// into the system frame there (settings.linuxNativeFrame, off by default). The
// pages then hide their own window buttons (renderer/native-frame.css), told
// by the loadFile query frame=native.
//
// Windows and macOS ignore the setting.

function usesNativeFrame(platform, settings) {
  return platform === 'linux' && !!settings && settings.linuxNativeFrame === true;
}

function windowFrameFor(platform, settings) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  if (usesNativeFrame(platform, settings)) return { frame: true };
  return { frame: false };
}

module.exports = { windowFrameFor, usesNativeFrame };
