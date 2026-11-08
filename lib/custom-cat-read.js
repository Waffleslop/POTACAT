'use strict';
/**
 * Reads the radio's state for custom CAT toggles that carry their own read
 * command (GitHub #242, LZ3AW TS-480: SPLIT on at start showed OFF, so the
 * first click re-sent ON and seemed to do nothing).
 *
 * Each toggle may name a read command and an "ON when" rule
 * (lib/custom-cat-follow.js parseOnRule). This module decides WHEN to send
 * the reads and keeps the results; main.js supplies the transport
 * (cat.queryRaw) and broadcasts the results with the rig state as
 * customCatStates { [readKey]: true | false | null }.
 *
 * Reads are deliberately sparse — the CAT link is shared with the poll:
 *   - once at connect,
 *   - once shortly after a press of a toggle that has a read,
 *   - when the operator opens the panel (at most once per PANEL_MIN_MS).
 * Never while transmitting: a read that comes due during TX waits, and runs
 * once the radio is back on receive. One read at a time; two toggles with the
 * same command and rule share one read.
 */
const Follow = require('./custom-cat-follow');

const AFTER_PRESS_MS = 400;   // let the radio act on the command before asking
const PANEL_MIN_MS = 5000;    // reopening the panel does not re-read every time

/**
 * @param {object} o
 * @param {() => object[]} o.getSlots          the saved custom CAT slots
 * @param {(cmd: string) => Promise<string>} o.query   send a read, resolve with the reply
 * @param {() => boolean} o.isTransmitting
 * @param {(states: object) => void} [o.onChange]       a result changed
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {Function} [o.setTimeout]
 * @param {Function} [o.clearTimeout]
 */
function createCustomCatReader(o) {
  const now = o.now || Date.now;
  const later = o.setTimeout || setTimeout;
  const cancel = o.clearTimeout || clearTimeout;
  const log = o.log || (() => {});
  const states = Object.create(null);
  const queue = [];          // read keys waiting, oldest first
  let busy = false;
  let gen = 0;               // bumped by reset(): a reply from before it is dropped
  let heldForTx = false;
  let lastPanelRead = -Infinity;
  const pressTimers = new Set();

  function reads() {
    const out = new Map();
    for (const slot of (o.getSlots() || [])) {
      const r = Follow.slotRead(slot);
      if (r && !out.has(r.key)) out.set(r.key, r);
    }
    return out;
  }

  function enqueue(key) {
    if (!queue.includes(key)) queue.push(key);
  }

  function pump() {
    if (busy || !queue.length) return;
    if (o.isTransmitting()) { heldForTx = true; return; }
    const key = queue.shift();
    const r = reads().get(key);
    if (!r) { pump(); return; }   // the slot was edited away meanwhile
    busy = true;
    const g = gen;
    let p;
    try { p = Promise.resolve(o.query(r.command)); } catch (e) { p = Promise.reject(e); }
    p.then((reply) => Follow.matchOnRule(r.rule, reply), (e) => {
      log(`[CAT] custom toggle read ${r.command} got no answer (${e && e.message ? e.message : e}) — shown as unknown`);
      return null;
    }).then((v) => {
      busy = false;
      if (g !== gen) { pump(); return; }
      if (states[key] !== v) {
        states[key] = v;
        if (o.onChange) o.onChange(snapshot());
      }
      pump();
    });
  }

  function snapshot() {
    const out = {};
    for (const k of Object.keys(states)) out[k] = states[k];
    return out;
  }

  /** Read every toggle that has a read. reason: 'connect' | 'panel' | other. */
  function readAll(reason) {
    if (reason === 'panel') {
      if (now() - lastPanelRead < PANEL_MIN_MS) return false;
      lastPanelRead = now();
    }
    const all = reads();
    if (!all.size) return false;
    for (const k of all.keys()) enqueue(k);
    pump();
    return true;
  }

  /** A command was just sent: re-read every toggle whose On/Off command it is. */
  function afterPress(command) {
    const c = String(command || '').trim();
    if (!c) return false;
    const keys = [];
    for (const slot of (o.getSlots() || [])) {
      const r = Follow.slotRead(slot);
      if (!r) continue;
      if (String(slot.command || '').trim() === c || String(slot.commandOff || '').trim() === c) {
        if (!keys.includes(r.key)) keys.push(r.key);
      }
    }
    if (!keys.length) return false;
    const t = later(() => {
      pressTimers.delete(t);
      for (const k of keys) enqueue(k);
      pump();
    }, AFTER_PRESS_MS);
    pressTimers.add(t);
    return true;
  }

  /** The radio is back on receive: run the reads that waited for it. */
  function txEnded() {
    if (!heldForTx) return;
    heldForTx = false;
    pump();
  }

  /** Link down: every result is unknown again, nothing pending. */
  function reset() {
    for (const t of pressTimers) cancel(t);
    pressTimers.clear();
    queue.length = 0;
    heldForTx = false;
    lastPanelRead = -Infinity;
    gen++;
    const had = Object.keys(states).length > 0;
    for (const k of Object.keys(states)) delete states[k];
    if (had && o.onChange) o.onChange(snapshot());
  }

  return { readAll, afterPress, txEnded, reset, states: snapshot, _queue: queue };
}

module.exports = { createCustomCatReader, AFTER_PRESS_MS, PANEL_MIN_MS };
