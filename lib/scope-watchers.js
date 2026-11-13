/**
 * Who is watching the shack's band scope from another device (#358).
 *
 * ECHOCAT phones, ECHOCAT Web browsers and a remote POTACAT each say
 * scope-subscribe on / off. The shack used to keep one shared "a remote
 * device is watching" switch, so one device leaving its scope view (or
 * disconnecting) stopped the scope for every other device. Each device is
 * counted here by its connection id instead; the scope stops only when the
 * last one leaves, by saying off or by its connection going away.
 *
 * The same goes for the digital view on a Flex pan (scope-digital-view): it
 * stays while any watching device asks for it.
 *
 * Pure: main.js asks it after each change; remote-server gives the ids.
 */
'use strict';

function createScopeWatchers() {
  // id -> { guest: boolean, digital: boolean }
  const watchers = new Map();
  // Digital view asked before (or without) a subscribe: kept per id, counted
  // only while that id is watching.
  const digitalAsk = new Set();

  const key = (id) => (id == null || id === '' ? '' : String(id));

  /** A device says scope-subscribe. Returns the summary after the change. */
  function subscribe(id, { on, guest } = {}) {
    const k = key(id);
    if (on) {
      watchers.set(k, { guest: !!guest });
    } else {
      watchers.delete(k);
      digitalAsk.delete(k);   // its digital view ends with its scope view
    }
    return summary();
  }

  /** A device says scope-digital-view. */
  function setDigital(id, on) {
    const k = key(id);
    if (on) digitalAsk.add(k); else digitalAsk.delete(k);
    return summary();
  }

  /** A device's connection is gone, goodbye said or not. */
  function remove(id) {
    const k = key(id);
    watchers.delete(k);
    digitalAsk.delete(k);
    return summary();
  }

  /** Every device is gone (the last client disconnected, the server stopped). */
  function clear() {
    watchers.clear();
    digitalAsk.clear();
    return summary();
  }

  function count() { return watchers.size; }
  function has(id) { return watchers.has(key(id)); }
  function anyDigital() {
    for (const k of digitalAsk) if (watchers.has(k)) return true;
    return false;
  }
  function anyGuest() {
    for (const w of watchers.values()) if (w.guest) return true;
    return false;
  }
  /** { wants, digital, guest, count } — what main's scope flags become. */
  function summary() {
    return { wants: watchers.size > 0, digital: anyDigital(), guest: anyGuest(), count: watchers.size };
  }

  return { subscribe, setDigital, remove, clear, count, has, anyDigital, anyGuest, summary };
}

module.exports = { createScopeWatchers };
