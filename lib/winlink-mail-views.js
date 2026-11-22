'use strict';
/**
 * Which devices have a Winlink Mail view open (2026-11-15, ECHOCAT's ask).
 *
 * After a radio session the radio stays on the gateway while a mail view is
 * open, so the operator can look at the band (lib/winlink-return.js). That
 * used to mean the desktop's own Mail window only, so a session driven from a
 * phone's Mail tab put the dial back 1.5 s after it ended. A device now says
 * winlink-mail-view {open} (capability 'winlink-mail-view'); each one is
 * counted by its connection id, as lib/scope-watchers.js counts scope views,
 * and its count goes when its connection does.
 *
 * Pure: main.js asks it after each change; remote-server gives the ids.
 */

/**
 * A device's connection went away with its Mail tab open and nothing else
 * holds the radio. A phone that drops its link reconnects and says
 * winlink-mail-view {open: true} again after auth-ok, so the dial waits this
 * long before it goes back.
 */
const GONE_GRACE_MS = 30000;

function createMailViews() {
  const open = new Set();
  const key = (id) => (id == null || id === '' ? '' : String(id));

  /** A device says winlink-mail-view. Returns how many are open after it. */
  function set(id, isOpen) {
    const k = key(id);
    if (isOpen) open.add(k); else open.delete(k);
    return open.size;
  }
  /** A device's connection is gone, goodbye said or not. */
  function remove(id) { open.delete(key(id)); return open.size; }
  /** Every device is gone (the last client disconnected, the server stopped). */
  function clear() { open.clear(); return 0; }
  function has(id) { return open.has(key(id)); }
  function count() { return open.size; }
  function any() { return open.size > 0; }

  return { set, remove, clear, has, count, any };
}

/**
 * Is a mail view open anywhere? The desktop window and every device's Mail
 * tab count alike for the rule that keeps the radio on the gateway.
 */
function viewOpen({ windowOpen, devices } = {}) {
  return !!windowOpen || (Number(devices) || 0) > 0;
}

/**
 * A view closed: the desktop window, or a device left its Mail tab
 * (winlink-qsy-restore). 'return': nothing else is open, go back now (the
 * return rules then decide). 'keep': another view is still open, so the
 * radio stays until the last one closes.
 */
function atViewClose({ windowOpen, devices } = {}) {
  return viewOpen({ windowOpen, devices }) ? 'keep' : 'return';
}

/**
 * A device's connection went away while its Mail tab was open. 'wait': a
 * return is pending and nothing else is open, so go back after GONE_GRACE_MS
 * unless a view opens again. 'none': nothing to do (another view holds the
 * radio, a session runs and decides at its end, or nothing is pending).
 */
function atDeviceGone({ windowOpen, devices, sessionActive, pending } = {}) {
  if (viewOpen({ windowOpen, devices })) return 'none';
  if (sessionActive) return 'none';
  if (!pending || !pending.freqHz) return 'none';
  return 'wait';
}

module.exports = { GONE_GRACE_MS, createMailViews, viewOpen, atViewClose, atDeviceGone };
