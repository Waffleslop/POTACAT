'use strict';
// Every serial port closes, and every native serial call finishes, before the
// app exits (#657). The serialport addon runs open/close/set/get/flush/drain/
// update/list as N-API AsyncWorkers. One that completes while Node is freeing
// its environment at quit cannot call back into JS; node-addon-api throws a C++
// exception there and the process aborts (macOS: SIGABRT in
// Napi::AsyncWorker::OnWorkComplete under node::FreeEnvironment).
//
// install() wraps the shared binding once, so every SerialPort in the app (CAT,
// CW key, PTT, rotor, WinKeyer, probes, port lists) is counted without touching
// each owner. settle() closes what is still open and waits, with a cap.

const TRACKED = ['close', 'set', 'get', 'getBaudRate', 'flush', 'drain', 'update', 'write'];

function createSerialQuit() {
  const open = new Set();      // port bindings that are open
  const pending = new Set();   // native calls in flight
  let waiters = [];

  function wake() {
    if (pending.size) return;
    const w = waiters; waiters = [];
    for (const fn of w) fn();
  }
  function track(promise) {
    pending.add(promise);
    const done = () => { pending.delete(promise); wake(); };
    promise.then(done, done);
    return promise;
  }
  function wrapPort(port) {
    for (const name of TRACKED) {
      const fn = port[name];
      if (typeof fn !== 'function') continue;
      port[name] = function (...args) {
        const p = Promise.resolve().then(() => fn.apply(port, args));
        if (name === 'close') open.delete(port);
        return track(p);
      };
    }
    open.add(port);
    return port;
  }
  function wrapList(list, self) {
    return function (...args) { return track(Promise.resolve().then(() => list.apply(self, args))); };
  }

  // serialport: { SerialPort } where SerialPort.binding is the detected binding
  // and SerialPort.list is a copy of binding.list taken at class definition.
  function install(serialport) {
    const SP = serialport && serialport.SerialPort;
    const binding = SP && SP.binding;
    if (!binding || binding.__potacatSerialQuit) return false;
    binding.__potacatSerialQuit = true;
    const openFn = binding.open;
    binding.open = function (...args) {
      return track(Promise.resolve().then(() => openFn.apply(binding, args)).then(wrapPort));
    };
    if (typeof binding.list === 'function') binding.list = wrapList(binding.list, binding);
    if (typeof SP.list === 'function') SP.list = wrapList(SP.list, SP);
    return true;
  }

  function busy() {
    for (const p of open) if (!p.isOpen) open.delete(p);
    return pending.size > 0 || open.size > 0;
  }

  // Close every open port, then wait for every native call (including closes
  // other code already started) to finish. Ports opened while waiting are
  // closed too. Resolves true when clean, false when the cap ran out.
  function settle({ timeoutMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const step = () => {
        for (const p of [...open]) {
          if (p.isOpen) { try { p.close().catch(() => {}); } catch {} } else open.delete(p);
        }
        if (!busy()) return resolve(true);
        const left = deadline - Date.now();
        if (left <= 0) return resolve(false);
        let fired = false;
        const t = setTimeout(() => { if (!fired) { fired = true; step(); } }, left);
        waiters.push(() => { if (!fired) { fired = true; clearTimeout(t); step(); } });
      };
      step();
    });
  }

  return { install, busy, settle, _state: () => ({ open: open.size, pending: pending.size }) };
}

const shared = createSerialQuit();
module.exports = { createSerialQuit, install: shared.install, busy: shared.busy, settle: shared.settle };
