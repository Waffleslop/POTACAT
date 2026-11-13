'use strict';
// Gateway history (#254, Casey 2026-11-11: "a list of the gateways I've
// attempted and those I've connected with, so I can see that old gateway I
// worked last week and didn't save").
//
// The source is Pat's own event log (pat-events.json, one JSON object per
// line). Pat writes a "connect" event for every call it places, with the
// gateway URL and success or the error, and an "exchange" event for every
// mail exchange that follows a connect, with the messages sent and received.
// Reading it means no second record to keep in step, and the history reaches
// back to the first session without anyone saving anything.
//
// Pure: no fs, no Electron. main.js reads the file and passes the text.

const { freqToBand } = require('./bands');
const { historyResult } = require('./winlink-outcome');

const SCHEME_MODE = { ardop: 'ardop', varahf: 'vara', varafm: 'varafm', ax25: 'packet', 'ax25+agwpe': 'packet', 'ax25+serial-tnc': 'packet', 'ax25+linux': 'packet' };

/** "connect ardop:///KY4RY?bw=2000MAX&freq=7100.5" → { mode, call, khz } or null (telnet, unparsable). */
function parseOperation(op) {
  const m = /^connect\s+([a-z0-9+-]+):\/\/[^/]*\/([^?\s]+)(?:\?(\S*))?/i.exec(String(op || ''));
  if (!m) return null;
  const mode = SCHEME_MODE[m[1].toLowerCase()];
  if (!mode) return null;
  const call = decodeURIComponent(m[2]).split('/').filter(Boolean).pop();
  if (!call) return null;
  let khz = null;
  const q = new URLSearchParams(m[3] || '');
  const fq = parseFloat(q.get('freq'));
  if (fq > 0) khz = Math.round(fq * 10) / 10;
  // The URL Pat dialled, without the leading verb: it carries what the gateway
  // offers (ARDOP bw=2000MAX), so calling it again from History is the same call.
  const url = `${m[1].toLowerCase()}:///${call.toUpperCase()}${m[3] ? '?' + m[3] : ''}`;
  return { mode, call: call.toUpperCase(), khz, url };
}

/**
 * What happened, in the words every surface shows. The wording lives with
 * every other session ending (lib/winlink-outcome.js, #425): a call that
 * connected and did not finish is a dropped link, and Pat's own error text
 * never shows.
 */
function resultText(a) {
  return historyResult(a);
}

/**
 * Pat's event log → the radio attempts, oldest first:
 * { at, call, mode, khz, band, connected, exchanged, sent, received, error, result }.
 * Internet (telnet) sessions are left out: they have no gateway to go back to.
 */
function parseEvents(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const at = Date.parse(ev.log_time);
    if (ev.what === 'connect') {
      const op = parseOperation(ev.operation);
      if (!op) continue;
      out.push({ at: Number.isFinite(at) ? at : 0, call: op.call, mode: op.mode, khz: op.khz, url: op.url, band: op.khz ? (freqToBand(op.khz / 1000) || '') : '', connected: !!ev.success, exchanged: false, sent: 0, received: 0, error: ev.success ? '' : String(ev.error || '') });
    } else if (ev.what === 'exchange') {
      // Belongs to the latest connect to the same station.
      const who = String(ev.targetcall || ev.remote_addr || '').toUpperCase();
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].call === who && out[i].connected) {
          if (ev.success) { out[i].exchanged = true; out[i].sent = Array.isArray(ev.sent) ? ev.sent.length : 0; out[i].received = Array.isArray(ev.received) ? ev.received.length : 0; }
          else out[i].error = String(ev.error || 'exchange failed');
          break;
        }
      }
    }
  }
  for (const a of out) a.result = resultText(a);
  return out;
}

function gatewayKey(call, mode, khz) {
  return `${String(call || '').toUpperCase()}|${mode || ''}|${khz != null ? Number(khz).toFixed(1) : ''}`;
}

/**
 * One row per gateway, mode and dial, newest first:
 * { call, mode, khz, band, tries, good, lastAt, lastGoodAt, lastResult, lastOk }.
 */
function gateways(attempts) {
  const by = new Map();
  for (const a of attempts || []) {
    const k = gatewayKey(a.call, a.mode, a.khz);
    let g = by.get(k);
    if (!g) { g = { call: a.call, mode: a.mode, khz: a.khz, url: a.url || '', band: a.band, tries: 0, good: 0, lastAt: 0, lastGoodAt: 0, lastResult: '', lastOk: false }; by.set(k, g); }
    g.tries++;
    if (a.exchanged) { g.good++; if (a.at >= g.lastGoodAt) g.lastGoodAt = a.at; }
    if (a.at >= g.lastAt) { g.lastAt = a.at; g.lastResult = a.result; g.lastOk = !!a.exchanged; if (a.url) g.url = a.url; }
  }
  return [...by.values()].sort((x, y) => y.lastAt - x.lastAt);
}

module.exports = { parseOperation, parseEvents, resultText, gateways, gatewayKey };
